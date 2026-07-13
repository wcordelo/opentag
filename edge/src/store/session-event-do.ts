import { DurableObject } from "cloudflare:workers";
import type { SqlCursor, SqlExecutor, SqlValue } from "./sql.js";

/**
 * `SessionEventDO` — the "mini api-rs" described in SPEC.md §3.2/§4.1.
 *
 * Centaur's `services/api-rs/` (~60.4k LOC Rust) exposes a session contract to
 * `slackbotv2`: create a session per thread, execute inputs idempotently,
 * replay the event log from a cursor, and interrupt a running execution. We
 * need that *contract* — not the K8s-backed sandbox orchestration behind it.
 * This Durable Object reimplements the contract directly over DO SQLite:
 *
 *   - `events` table: an append-only log of `input | output | error | done`
 *     rows per `execution_id`, replayable from any `afterEventId` cursor —
 *     this is what lets a crashed Worker isolate reconstruct a thread's state
 *     (see the render-obligation alarm in `conversation-state-do.ts`).
 *   - DO KV slots (`session:created` / `session:executing` / `session:interrupted`)
 *     track the small amount of "current session" state that doesn't belong
 *     in the append-only log.
 *
 * Deliberately NOT ported: warm pools, capacity management, multi-tenant
 * permission checks, or an HTTP surface — callers talk to this DO exclusively
 * through RPC (DO stubs), matching the rest of the store layer.
 *
 * `harnessType` mismatch on `create()` mirrors centaur's "409 → restart on
 * harness mismatch" semantics (SPEC.md §3.6): rather than silently continuing
 * a session under a different harness, the event log and KV slots are wiped
 * and a fresh session is created. Callers are expected to re-feed thread
 * context (e.g. Slack transcript) after a `restarted: true` response.
 */

// ── DDL ──────────────────────────────────────────────────────────────────

/**
 * Schema for the per-thread session event log (SPEC.md §3.2). Self-contained
 * here rather than folded into `schema.ts` — this DO owns a completely
 * separate SQLite database from `ConversationStateDO`'s StateStore tables.
 */
const EVENTS_DDL = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     execution_id TEXT NOT NULL,
     kind TEXT NOT NULL,      -- 'input' | 'output' | 'error' | 'done'
     payload TEXT NOT NULL,   -- JSON
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS events_execution ON events(execution_id, id)`,
  `CREATE TABLE IF NOT EXISTS executions (
     execution_id TEXT PRIMARY KEY,
     forwarded_message_id TEXT UNIQUE,
     started_at INTEGER NOT NULL,
     terminal_at INTEGER
   )`,
  `INSERT OR IGNORE INTO executions
     (execution_id, forwarded_message_id, started_at, terminal_at)
   SELECT execution_id, NULL, MIN(created_at),
          MAX(CASE WHEN kind = 'done' THEN created_at ELSE NULL END)
   FROM events
   GROUP BY execution_id`,
  `CREATE TABLE IF NOT EXISTS cancelled_executions (
     execution_id TEXT PRIMARY KEY,
     cancelled_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS pending_cancellation (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     cancelled_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
];

/** Create the events table + index. Idempotent; safe on every DO construction. */
function migrateEvents(sql: SqlExecutor): void {
  for (const stmt of EVENTS_DDL) sql.exec(stmt);
}

// ── KV slot shapes ──────────────────────────────────────────────────────────

type EventKind = "input" | "output" | "error" | "done";

interface CreatedSlot {
  sessionId: string;
  harnessType: string;
  model?: string;
  threadKey: string;
}

interface ExecutingSlot {
  executionId: string;
  startedAt: number;
}

const KEY_CREATED = "session:created";
const KEY_EXECUTING = "session:executing";
const KEY_INTERRUPTED = "session:interrupted";

/** Sentinel used when a caller doesn't pin a harness explicitly. */
const DEFAULT_HARNESS = "default";
/** Covers Slack ingress/registry interleavings without poisoning a quiet thread. */
export const PENDING_CANCELLATION_TTL_MS = 30_000;

// ── KV seam ─────────────────────────────────────────────────────────────────

/**
 * The narrow slice of `DurableObjectStorage` this DO needs for its KV slots
 * (as opposed to the SQL-backed `events` table). Depending on this local
 * shape — rather than the full `DurableObjectStorage` type — keeps
 * {@link SessionEventEngine} portable: it can run against `ctx.storage` in
 * production *and* an in-memory shim in unit tests, mirroring how
 * `SqlExecutor` decouples `SqlStateEngine` from `workerd` (see `sql.ts`,
 * `sql-state-engine.ts`).
 */
export interface KvExecutor {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

// ── Engine (pure logic, backend-blind) ──────────────────────────────────────

export interface SessionEventEngineDeps {
  sql: SqlExecutor;
  kv: KvExecutor;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id source. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/**
 * The actual event-log implementation, expressed over the {@link SqlExecutor}
 * / {@link KvExecutor} seams so it can be exercised outside `workerd` (see
 * `test/session-event-do.test.ts`), exactly as `SqlStateEngine` is tested
 * against `node:sqlite` in `test/engine.test.ts`. `SessionEventDO` is a thin
 * RPC wrapper around this class.
 */
export class SessionEventEngine {
  private readonly sql: SqlExecutor;
  private readonly kv: KvExecutor;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SessionEventEngineDeps) {
    this.sql = deps.sql;
    this.kv = deps.kv;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  async create(args: {
    threadKey: string;
    harnessType?: string;
    model?: string;
  }): Promise<{ sessionId: string; restarted: boolean }> {
    const harnessType = args.harnessType ?? DEFAULT_HARNESS;
    const existing = await this.kv.get<CreatedSlot>(KEY_CREATED);

    if (existing) {
      if (existing.harnessType === harnessType) {
        // Idempotent: same harness, same session — no-op.
        return { sessionId: existing.sessionId, restarted: false };
      }
      const executing = this.activeExecution();
      if (executing) {
        throw new Error(`harness_change_while_executing:${executing.executionId}`);
      }
      // Harness mismatch: centaur's "409 → restart" semantics. Wipe the
      // event log + KV slots and start a fresh session under the new harness.
      this.sql.exec(`DELETE FROM events`);
      this.sql.exec(`DELETE FROM executions`);
      await this.kv.delete(KEY_CREATED);
      await this.kv.delete(KEY_EXECUTING);
      await this.kv.delete(KEY_INTERRUPTED);

      const sessionId = this.newId();
      await this.kv.put<CreatedSlot>(KEY_CREATED, {
        sessionId,
        harnessType,
        model: args.model,
        threadKey: args.threadKey,
      });
      return { sessionId, restarted: true };
    }

    const sessionId = this.newId();
    await this.kv.put<CreatedSlot>(KEY_CREATED, {
      sessionId,
      harnessType,
      model: args.model,
      threadKey: args.threadKey,
    });
    return { sessionId, restarted: false };
  }

  async execute(args: {
    executionId: string;
    forwardedMessageId?: string;
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean; cancelled?: boolean }> {
    // Cancellation and admission live in this DO and run without an await
    // between the check and insert. A Stop that arrives before this RPC leaves
    // a durable tombstone; a Stop that arrives after it sees the admitted row.
    // There is therefore no cross-DO check/claim window.
    const cancelled = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM cancelled_executions WHERE execution_id = ?`,
        args.executionId,
      )
      .one().n;
    if (cancelled > 0) {
      return { accepted: false, duplicate: false, cancelled: true };
    }

    // Dedup key discipline (GOAL.md house rule 3): an executionId that's
    // already the in-flight execution, or that already produced an 'input'
    // row, must be a no-op redelivery.
    const executing = this.activeExecution();
    if (executing?.executionId === args.executionId) {
      return { accepted: false, duplicate: true };
    }

    // A session owns exactly one active execution. A different delivery must
    // not replace the active slot: doing so loses the only handle Stop has to
    // the in-flight container request.
    if (executing) {
      return { accepted: false, duplicate: false };
    }

    const seen = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events WHERE execution_id = ? AND kind = 'input'`,
        args.executionId,
      )
      .one().n;
    if (seen > 0) {
      return { accepted: false, duplicate: true };
    }
    const existingExecution = this.sql
      .exec<{ execution_id: string }>(
        `SELECT execution_id FROM executions WHERE execution_id = ?`,
        args.executionId,
      )
      .toArray();
    if (existingExecution.length > 0) {
      return { accepted: false, duplicate: true };
    }

    if (args.forwardedMessageId) {
      const forwarded = this.sql
        .exec<{ execution_id: string }>(
          `SELECT execution_id FROM executions WHERE forwarded_message_id = ?`,
          args.forwardedMessageId,
        )
        .toArray();
      if (forwarded.length > 0) {
        return { accepted: false, duplicate: true };
      }
    }

    // A non-exact Stop can beat BOT_STATE publication. Consume its short-lived
    // admission barrier in the same synchronous SQLite turn as admission.
    const now = this.now();
    this.sql.exec(`DELETE FROM pending_cancellation WHERE expires_at <= ?`, now);
    const pending = this.sql
      .exec<{ expires_at: number }>(
        `DELETE FROM pending_cancellation WHERE singleton = 1 RETURNING expires_at`,
      )
      .toArray()[0];
    if (pending) return { accepted: false, duplicate: false, cancelled: true };

    const createdAt = now;
    this.sql.exec(
      `INSERT INTO executions
         (execution_id, forwarded_message_id, started_at, terminal_at)
       VALUES (?, ?, ?, NULL)`,
      args.executionId,
      args.forwardedMessageId ?? null,
      createdAt,
    );
    for (const line of args.inputLines) {
      this.sql.exec(
        `INSERT INTO events (execution_id, kind, payload, created_at) VALUES (?, 'input', ?, ?)`,
        args.executionId,
        JSON.stringify(line),
        createdAt,
      );
    }

    return { accepted: true, duplicate: false };
  }

  private activeExecution(): ExecutingSlot | undefined {
    const row = this.sql
      .exec<{ execution_id: string; started_at: number }>(
        `SELECT execution_id, started_at FROM executions
         WHERE terminal_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      )
      .toArray()[0];
    return row
      ? { executionId: row.execution_id, startedAt: row.started_at }
      : undefined;
  }

  async appendEvent(args: {
    executionId: string;
    kind: Exclude<EventKind, "input">;
    payload: unknown;
  }): Promise<{ id: number }> {
    const terminal = this.sql
      .exec<{ terminal_at: number | null }>(
        `SELECT terminal_at FROM executions WHERE execution_id = ?`,
        args.executionId,
      )
      .toArray()[0];
    if (!terminal) {
      throw new Error(`execution_not_found:${args.executionId}`);
    }
    if (terminal.terminal_at !== null) {
      throw new Error(`execution_already_terminal:${args.executionId}`);
    }

    const executing = this.activeExecution();
    if (executing?.executionId !== args.executionId) {
      throw new Error(`execution_not_active:${args.executionId}`);
    }

    const createdAt = this.now();
    const row = this.sql
      .exec<{ id: number }>(
        `INSERT INTO events (execution_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?) RETURNING id`,
        args.executionId,
        args.kind,
        JSON.stringify(args.payload),
        createdAt,
      )
      .one();

    if (args.kind === "done") {
      this.sql.exec(
        `UPDATE executions SET terminal_at = ? WHERE execution_id = ?`,
        createdAt,
        args.executionId,
      );
      await this.kv.delete(KEY_EXECUTING);
    }

    return { id: row.id };
  }

  async replay(afterEventId?: number): Promise<
    Array<{
      id: number;
      executionId: string;
      kind: string;
      payload: unknown;
      createdAt: number;
    }>
  > {
    const after = afterEventId ?? 0;
    return this.sql
      .exec<{
        id: number;
        execution_id: string;
        kind: string;
        payload: string;
        created_at: number;
      }>(
        `SELECT id, execution_id, kind, payload, created_at
         FROM events WHERE id > ? ORDER BY id ASC`,
        after,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        executionId: r.execution_id,
        kind: r.kind,
        payload: JSON.parse(r.payload) as unknown,
        createdAt: r.created_at,
      }));
  }

  async interruptExpected(executionId: string): Promise<{ interrupted: boolean; cancelled: true }> {
    const cancelledAt = this.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO cancelled_executions (execution_id, cancelled_at)
       VALUES (?, ?)`,
      executionId,
      cancelledAt,
    );
    const executing = this.activeExecution();
    if (executing?.executionId !== executionId) {
      return { interrupted: false, cancelled: true };
    }

    // Terminalize synchronously with the tombstone. appendEvent is not used
    // here because its KV await would reopen a cancellation/terminal window.
    this.sql.exec(
      `INSERT INTO events (execution_id, kind, payload, created_at)
       VALUES (?, 'done', ?, ?)`,
      executionId,
      JSON.stringify({ interrupted: true }),
      cancelledAt,
    );
    this.sql.exec(
      `UPDATE executions SET terminal_at = ?
       WHERE execution_id = ? AND terminal_at IS NULL`,
      cancelledAt,
      executionId,
    );
    await this.kv.delete(KEY_EXECUTING);
    return { interrupted: true, cancelled: true };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    const executing = this.activeExecution();
    if (!executing) {
      const cancelledAt = this.now();
      this.sql.exec(
        `INSERT INTO pending_cancellation (singleton, cancelled_at, expires_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           cancelled_at = excluded.cancelled_at,
           expires_at = excluded.expires_at`,
        cancelledAt,
        cancelledAt + PENDING_CANCELLATION_TTL_MS,
      );
      return { interrupted: false };
    }
    const result = await this.interruptExpected(executing.executionId);
    return { interrupted: result.interrupted };
  }

  async getState(): Promise<{
    sessionId?: string;
    executing?: { executionId: string; startedAt: number };
    interrupted: boolean;
    interruptedExecutionId?: string;
  }> {
    const created = await this.kv.get<CreatedSlot>(KEY_CREATED);
    const executing = this.activeExecution();
    const cancelled = this.sql
      .exec<{ execution_id: string }>(
        `SELECT execution_id FROM cancelled_executions
         ORDER BY cancelled_at DESC LIMIT 1`,
      )
      .toArray()[0];
    const interruptedExecutionId = cancelled?.execution_id;
    return {
      sessionId: created?.sessionId,
      executing,
      // A later execution may start before the stopped client's next poll.
      // Preserve the stopped execution id without making the new execution's
      // obligation look interrupted.
      interrupted:
        Boolean(interruptedExecutionId) &&
        (!executing || interruptedExecutionId === executing.executionId),
      interruptedExecutionId,
    };
  }
}

// ── Durable Object (thin RPC wrapper) ───────────────────────────────────────

/**
 * The Durable Object that owns one private, embedded SQLite database holding
 * a single thread's session event log. One instance per Slack thread (or
 * equivalent conversation key) — the DO's single-threaded execution model is
 * what makes `execute()`'s idempotency check atomic without an external lock,
 * the same guarantee `ConversationStateDO` leans on for its StateStore.
 *
 * See the module-level jsdoc above for the centaur `api-rs` lineage and the
 * KV-slot vs. SQL-table split.
 */
export class SessionEventDO extends DurableObject {
  private readonly engine: SessionEventEngine;

  constructor(ctx: DurableObjectState, env: unknown) {
    // `env` is opaque to this DO — it never reads bindings — so we hand the
    // base class whatever it was given. The cast bridges the generic `Env`.
    super(ctx, env as never);
    const sql = this.ctx.storage.sql as unknown as SqlExecutor;
    const kv = this.ctx.storage as unknown as KvExecutor;

    // Build the schema before any request can touch the engine.
    // blockConcurrencyWhile delays inbound RPC until migration resolves, so
    // nothing sees a partial schema.
    void this.ctx.blockConcurrencyWhile(async () => {
      migrateEvents(sql);
    });

    this.engine = new SessionEventEngine({ sql, kv });
  }

  /**
   * Idempotent by `(threadKey, harnessType)`: same harness on an existing
   * session returns the existing `sessionId` unchanged. A different harness
   * wipes the event log + KV slots and starts fresh (`restarted: true`) —
   * see the module jsdoc for why this mirrors centaur's 409 semantics.
   */
  async create(args: {
    threadKey: string;
    harnessType?: string;
    model?: string;
  }): Promise<{ sessionId: string; restarted: boolean }> {
    return this.engine.create(args);
  }

  /**
   * Idempotent by `executionId`: a redelivered execute with an `executionId`
   * that's already in flight (`session:executing`) or that already produced
   * an `input` event is a no-op (`duplicate: true`). Otherwise appends one
   * `input` event per line and marks the session executing. The prior
   * interrupted execution id remains available to its streaming client.
   */
  async execute(args: {
    executionId: string;
    forwardedMessageId?: string;
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean; cancelled?: boolean }> {
    return this.engine.execute(args);
  }

  /** Persist cancellation for this exact id, even if execute has not arrived. */
  async interruptExpected(
    executionId: string,
  ): Promise<{ interrupted: boolean; cancelled: true }> {
    return this.engine.interruptExpected(executionId);
  }

  /**
   * Append one event row. Only `done` clears `session:executing`; `error`
   * remains non-terminal so the pinned `error` then `done` stream is valid.
   */
  async appendEvent(args: {
    executionId: string;
    kind: "output" | "error" | "done";
    payload: unknown;
  }): Promise<{ id: number }> {
    return this.engine.appendEvent(args);
  }

  /** All events with `id > (afterEventId ?? 0)`, ascending, payload parsed. */
  async replay(afterEventId?: number): Promise<
    Array<{
      id: number;
      executionId: string;
      kind: string;
      payload: unknown;
      createdAt: number;
    }>
  > {
    return this.engine.replay(afterEventId);
  }

  /**
   * If an execution is in flight: append a `done` event
   * (`{ interrupted: true }`), clear `session:executing`, and set
   * `session:interrupted`. No-op (`interrupted: false`) if nothing was running.
   */
  async interrupt(): Promise<{ interrupted: boolean }> {
    return this.engine.interrupt();
  }

  /** Convenience snapshot for callers (worker stop path, obligation alarm). */
  async getState(): Promise<{
    sessionId?: string;
    executing?: { executionId: string; startedAt: number };
    interrupted: boolean;
    interruptedExecutionId?: string;
  }> {
    return this.engine.getState();
  }
}

// Re-exported for test shims that build a `SqlExecutor` over `node:sqlite`
// (mirrors `test/sqlite-state-store.ts`'s relationship to `sql-state-engine.ts`).
export type { SqlCursor, SqlExecutor, SqlValue };
