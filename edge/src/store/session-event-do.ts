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
      // Harness mismatch: centaur's "409 → restart" semantics. Wipe the
      // event log + KV slots and start a fresh session under the new harness.
      this.sql.exec(`DELETE FROM events`);
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
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    // Dedup key discipline (GOAL.md house rule 3): an executionId that's
    // already the in-flight execution, or that already produced an 'input'
    // row, must be a no-op redelivery.
    const executing = await this.kv.get<ExecutingSlot>(KEY_EXECUTING);
    if (executing) {
      if (executing.executionId === args.executionId) {
        return { accepted: false, duplicate: true };
      }
      // A different execution is already in flight — never overwrite it.
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

    const createdAt = this.now();
    for (const line of args.inputLines) {
      this.sql.exec(
        `INSERT INTO events (execution_id, kind, payload, created_at) VALUES (?, 'input', ?, ?)`,
        args.executionId,
        JSON.stringify(line),
        createdAt,
      );
    }

    await this.kv.put<ExecutingSlot>(KEY_EXECUTING, {
      executionId: args.executionId,
      startedAt: createdAt,
    });
    await this.kv.delete(KEY_INTERRUPTED);

    return { accepted: true, duplicate: false };
  }

  async appendEvent(args: {
    executionId: string;
    kind: Exclude<EventKind, "input">;
    payload: unknown;
  }): Promise<{ id: number }> {
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

    if (args.kind === "done" || args.kind === "error") {
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

  /**
   * Re-mark a session executing after a non-terminal harness failure when the
   * caller continues the same `executionId` on another runtime (AG-UI fallback).
   */
  async resumeExecuting(args: { executionId: string }): Promise<void> {
    await this.kv.put<ExecutingSlot>(KEY_EXECUTING, {
      executionId: args.executionId,
      startedAt: this.now(),
    });
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    const executing = await this.kv.get<ExecutingSlot>(KEY_EXECUTING);
    if (!executing) return { interrupted: false };

    // Route through appendEvent so the "clear session:executing on done"
    // behavior stays in one place.
    await this.appendEvent({
      executionId: executing.executionId,
      kind: "done",
      payload: { interrupted: true },
    });
    await this.kv.put(KEY_INTERRUPTED, true);
    return { interrupted: true };
  }

  async getState(): Promise<{
    sessionId?: string;
    executing?: { executionId: string; startedAt: number };
    interrupted: boolean;
  }> {
    const [created, executing, interrupted] = await Promise.all([
      this.kv.get<CreatedSlot>(KEY_CREATED),
      this.kv.get<ExecutingSlot>(KEY_EXECUTING),
      this.kv.get<boolean>(KEY_INTERRUPTED),
    ]);
    return {
      sessionId: created?.sessionId,
      executing,
      interrupted: interrupted ?? false,
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
   * `input` event per line, marks the session executing, and clears any
   * prior interrupt flag.
   */
  async execute(args: {
    executionId: string;
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    return this.engine.execute(args);
  }

  /**
   * Append one event row. `done`/`error` clear `session:executing` — those
   * are the two kinds that terminate an execution.
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

  /** See {@link SessionEventEngine.resumeExecuting}. */
  async resumeExecuting(args: { executionId: string }): Promise<void> {
    return this.engine.resumeExecuting(args);
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
  }> {
    return this.engine.getState();
  }
}

// Re-exported for test shims that build a `SqlExecutor` over `node:sqlite`
// (mirrors `test/sqlite-state-store.ts`'s relationship to `sql-state-engine.ts`).
export type { SqlCursor, SqlExecutor, SqlValue };
