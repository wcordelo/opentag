import { DurableObject } from "cloudflare:workers";
import type { SqlCursor, SqlExecutor, SqlValue, TransactionRunner } from "./sql.js";

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
 *   - SQL `executions`, `cancelled_executions`, and `events` are authoritative
 *     for admission, terminal state, interruption, replay, and dedup. The sole
 *     KV record `session:created` is compatibility metadata for harness/model
 *     selection; legacy executing/interrupted keys are cleanup-only.
 *
 * Deliberately NOT ported: warm pools, capacity management, multi-tenant
 * permission checks, or an HTTP surface — callers talk to this DO exclusively
 * through RPC (DO stubs), matching the rest of the store layer.
 *
 * `harnessType` mismatch on `create()` mirrors centaur's "409 → restart on
 * harness mismatch" semantics (SPEC.md §3.6): rather than silently continuing
 * a session under a different harness, the event log and KV slots are wiped
 * and compatibility metadata is replaced. Callers are expected to re-feed thread
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
/** Legacy compatibility keys: never read as source of truth. */
const KEY_EXECUTING = "session:executing";
const KEY_INTERRUPTED = "session:interrupted";

/** Sentinel used when a caller doesn't pin a harness explicitly. */
const DEFAULT_HARNESS = "default";
export const SESSION_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const SESSION_EVENT_RECENT_EXECUTIONS = 256;
// ── KV seam ─────────────────────────────────────────────────────────────────

/**
 * The narrow slice of `DurableObjectStorage` this DO needs for compatibility metadata
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
  /** Crash-atomic runner. Production must supply storage.transactionSync. */
  tx: TransactionRunner;
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
  private readonly tx: TransactionRunner;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SessionEventEngineDeps) {
    this.sql = deps.sql;
    this.kv = deps.kv;
    this.tx = deps.tx;
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
      // authoritative SQL history + compatibility metadata, then restart.
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
    forwardedMessageId: string;
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean; cancelled?: boolean }> {
    if (!args.forwardedMessageId || !args.forwardedMessageId.trim()) {
      throw new Error("forwarded_message_id_required");
    }
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

    // Exact pre-admission cancellation is keyed by executionId above. Never
    // consume a generic "cancel next" marker here: an idle Stop must not
    // poison a later, unrelated turn. The lifecycle publishes the active-turn
    // record before this RPC, so a racing Stop has the exact executionId.
    const createdAt = this.now();
    this.tx(() => {
      this.sql.exec(
        `INSERT INTO executions
           (execution_id, forwarded_message_id, started_at, terminal_at)
         VALUES (?, ?, ?, NULL)`,
        args.executionId,
        args.forwardedMessageId,
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
    });

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
    const row = this.tx(() => {
      const inserted = this.sql
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
      }
      return inserted;
    });

    if (args.kind === "done") await this.kv.delete(KEY_EXECUTING);

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
    const interrupted = this.tx(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO cancelled_executions (execution_id, cancelled_at)
         VALUES (?, ?)`,
        executionId,
        cancelledAt,
      );
      const executing = this.activeExecution();
      if (executing?.executionId !== executionId) return false;

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
      return true;
    });
    if (!interrupted) return { interrupted: false, cancelled: true };
    await this.kv.delete(KEY_EXECUTING);
    return { interrupted: true, cancelled: true };
  }

  /**
   * Compact only terminal history that is both older than the retention cutoff
   * and at/below a caller-proven replay cursor. The newest bounded execution
   * window, every active execution, and newer cancellation tombstones survive.
   */
  compact(args: {
    safeThroughEventId: number;
    retentionMs?: number;
    retainRecentExecutions?: number;
  }): { eventsDeleted: number; executionsDeleted: number; tombstonesDeleted: number } {
    const cutoff = this.now() - (args.retentionMs ?? SESSION_EVENT_RETENTION_MS);
    const retain = Math.max(1, args.retainRecentExecutions ?? SESSION_EVENT_RECENT_EXECUTIONS);
    return this.tx(() => {
      this.sql.exec(
        `DELETE FROM events
         WHERE id <= ? AND created_at < ? AND execution_id IN (
           SELECT execution_id FROM executions
           WHERE terminal_at IS NOT NULL AND terminal_at < ?
             AND execution_id NOT IN (
               SELECT execution_id FROM executions
               WHERE terminal_at IS NOT NULL
               ORDER BY terminal_at DESC, execution_id DESC LIMIT ?
             )
         )`,
        args.safeThroughEventId,
        cutoff,
        cutoff,
        retain,
      );
      const eventsDeleted = this.changes();
      this.sql.exec(
        `DELETE FROM executions
         WHERE terminal_at IS NOT NULL AND terminal_at < ?
           AND execution_id NOT IN (SELECT DISTINCT execution_id FROM events)
           AND execution_id NOT IN (
             SELECT execution_id FROM cancelled_executions WHERE cancelled_at >= ?
           )`,
        cutoff,
        cutoff,
      );
      const executionsDeleted = this.changes();
      this.sql.exec(
        `DELETE FROM cancelled_executions
         WHERE cancelled_at < ?
           AND execution_id NOT IN (
             SELECT execution_id FROM executions WHERE terminal_at IS NULL
           )`,
        cutoff,
      );
      const tombstonesDeleted = this.changes();
      return { eventsDeleted, executionsDeleted, tombstonesDeleted };
    });
  }

  private changes(): number {
    return this.sql.exec<{ n: number }>(`SELECT changes() AS n`).one().n;
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    const executing = this.activeExecution();
    // Non-exact fallback is only allowed to stop work that is already
    // admitted. When the session is idle this is a true no-op; creating a
    // singleton tombstone here would cancel whichever unrelated execution
    // happened to arrive next.
    if (!executing) return { interrupted: false };
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
 * authoritative SQL vs. compatibility-metadata split.
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

    this.engine = new SessionEventEngine({
      sql,
      kv,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
    });
  }

  /**
   * Idempotent by `(threadKey, harnessType)`: same harness on an existing
   * session returns the existing `sessionId` unchanged. A different harness
   * wipes authoritative SQL history and replaces compatibility metadata (`restarted: true`) —
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
   * that's already in SQL `executions` or already produced an `input` event is
   * a no-op (`duplicate: true`). Otherwise atomically inserts the execution and
   * every input row. Prior cancellation remains queryable in SQL.
   */
  async execute(args: {
    executionId: string;
    forwardedMessageId: string;
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
   * Append one event row. Only `done` atomically terminalizes the SQL execution;
   * `error` remains non-terminal so the pinned `error` then `done` stream is valid.
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

  async compact(args: {
    safeThroughEventId: number;
    retentionMs?: number;
    retainRecentExecutions?: number;
  }): Promise<{ eventsDeleted: number; executionsDeleted: number; tombstonesDeleted: number }> {
    return this.engine.compact(args);
  }

  /**
   * If an execution is in flight: atomically insert its cancellation tombstone,
   * append `done`, and terminalize the SQL execution. No-op if idle.
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

  async healthCheck(): Promise<{ ok: true; storage: "sqlite" }> {
    this.ctx.storage.sql.exec(`SELECT 1 AS ok`).one();
    return { ok: true, storage: "sqlite" };
  }
}

// Re-exported for test shims that build a `SqlExecutor` over `node:sqlite`
// (mirrors `test/sqlite-state-store.ts`'s relationship to `sql-state-engine.ts`).
export type { SqlCursor, SqlExecutor, SqlValue };
