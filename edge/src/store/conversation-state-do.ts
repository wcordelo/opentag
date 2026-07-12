import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { SqlStateEngine } from "./sql-state-engine.js";
import { migrate } from "./schema.js";
import type { SqlExecutor } from "./sql.js";
import type { SessionEventDO } from "./session-event-do.js";

/**
 * How often the background alarm sweeps expired rows. Lazy expiry already keeps
 * reads correct; this just reclaims space for keys that are never read again.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h

/**
 * Default render-obligation timeout (SPEC.md §3.1 / GOAL.md Phase A2). MUST
 * exceed `bot-engine.ts`'s `createBot({ store: { lockTtl } })` turn lock
 * (15 minutes) — otherwise the alarm could fire and "recover" a turn that is
 * still legitimately running (e.g. mid-HITL wait), producing a double post.
 */
const DEFAULT_OBLIGATION_TIMEOUT_MS = 20 * 60_000;

/** Retry backoff for a failed fallback post; capped at {@link OBLIGATION_MAX_ATTEMPTS}. */
const OBLIGATION_RETRY_DELAY_MS = 60_000;
const OBLIGATION_MAX_ATTEMPTS = 3;
/** Re-arm delay when the session reports the execution is still live (not crashed). */
const OBLIGATION_LIVE_DEFER_MS = 2 * 60_000;

/** DO storage KV key tracking when the next GC sweep is due (survives restarts). */
const NEXT_SWEEP_KEY = "__nextSweepAt";

interface ListOpts {
  maxLen?: number;
  ttlMs?: number;
}
interface QueueOpts {
  maxSize?: number;
  onFull?: "drop-oldest" | "drop-newest";
}

/**
 * The narrow slice of `env` this DO actually reads. `DurableObject`'s `env`
 * generic defaults to `Cloudflare.Env` (an empty ambient interface unless a
 * project declares it), so it arrives here effectively untyped — this local
 * shape is what we cast to at the two call sites that need bindings
 * (`SLACK_BOT_TOKEN` for the fallback post, `SESSION_EVENTS` for replay). The
 * store engine itself (`SqlStateEngine`, `RenderObligationEngine`) stays
 * env-agnostic.
 */
interface ConversationStateDoEnv {
  SLACK_BOT_TOKEN?: string;
  SESSION_EVENTS?: DurableObjectNamespace<SessionEventDO>;
}

/**
 * The two `SessionEventDO` RPC calls the obligation alarm (and
 * `bot-engine.ts`'s obligation write) actually make, typed by hand instead of
 * via `DurableObjectStub<SessionEventDO>`. Cloudflare's RPC `Provider<T>`
 * mapped type resolves a method's return type through a compile-time
 * `Serializable<T>` check; `replay()`'s `payload: unknown` field doesn't
 * structurally satisfy that check (even though `unknown` serializes to JSON
 * fine at runtime), which collapses `Provider<SessionEventDO>["replay"]` to
 * `never`. Exported so `bot-engine.ts` can reuse the identical cast instead
 * of duplicating this workaround.
 */
export interface SessionEventsRpc {
  getState(): Promise<{
    sessionId?: string;
    executing?: { executionId: string; startedAt: number };
    interrupted: boolean;
  }>;
  replay(afterEventId?: number): Promise<
    Array<{
      id: number;
      executionId: string;
      kind: string;
      payload: unknown;
      createdAt: number;
    }>
  >;
}

export interface RenderObligationRow {
  threadKey: string;
  executionId: string;
  afterEventId: number;
  channel: string;
  threadTs?: string;
  deadline: number;
  attempt: number;
}

function mapObligationRow(row: {
  thread_key: string;
  execution_id: string;
  after_event_id: number;
  channel: string;
  thread_ts: string | null;
  deadline: number;
  attempt: number;
}): RenderObligationRow {
  return {
    threadKey: row.thread_key,
    executionId: row.execution_id,
    afterEventId: row.after_event_id,
    channel: row.channel,
    threadTs: row.thread_ts ?? undefined,
    deadline: row.deadline,
    attempt: row.attempt,
  };
}

const OBLIGATION_COLUMNS =
  "thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt";

export interface RenderObligationEngineDeps {
  sql: SqlExecutor;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Pure SQL half of the render-obligation store (SPEC.md §3.1). Split out from
 * {@link ConversationStateDO} the same way `SqlStateEngine` and
 * `SessionEventEngine` are — a backend-blind class over {@link SqlExecutor}
 * that can be exercised directly against `node:sqlite` in tests
 * (`test/render-obligation.test.ts`), while the DO wraps it with the
 * alarm-scheduling / fetch / `SESSION_EVENTS` orchestration that only makes
 * sense inside `workerd`.
 */
export class RenderObligationEngine {
  private readonly sql: SqlExecutor;
  private readonly now: () => number;

  constructor(deps: RenderObligationEngineDeps) {
    this.sql = deps.sql;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Upsert by `threadKey` — a fresh write always supersedes a stale one. */
  set(args: {
    threadKey: string;
    executionId: string;
    afterEventId: number;
    channel: string;
    threadTs?: string;
    timeoutMs?: number;
  }): { deadline: number } {
    const deadline =
      this.now() + (args.timeoutMs ?? DEFAULT_OBLIGATION_TIMEOUT_MS);
    this.sql.exec(
      `INSERT INTO render_obligations (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(thread_key) DO UPDATE SET
         execution_id   = excluded.execution_id,
         after_event_id = excluded.after_event_id,
         channel        = excluded.channel,
         thread_ts      = excluded.thread_ts,
         deadline       = excluded.deadline,
         attempt        = 0`,
      args.threadKey,
      args.executionId,
      args.afterEventId,
      args.channel,
      args.threadTs ?? null,
      deadline,
    );
    return { deadline };
  }

  /**
   * Delete by `threadKey`. If `executionId` is given, only delete when it
   * matches the stored row — a newer turn's obligation for the same thread
   * must survive a stale clear from an older, already-superseded turn.
   */
  clear(args: { threadKey: string; executionId?: string }): void {
    if (args.executionId !== undefined) {
      this.sql.exec(
        `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
        args.threadKey,
        args.executionId,
      );
    } else {
      this.sql.exec(
        `DELETE FROM render_obligations WHERE thread_key = ?`,
        args.threadKey,
      );
    }
  }

  get(threadKey: string): RenderObligationRow | undefined {
    const row = this.sql
      .exec<{
        thread_key: string;
        execution_id: string;
        after_event_id: number;
        channel: string;
        thread_ts: string | null;
        deadline: number;
        attempt: number;
      }>(
        `SELECT ${OBLIGATION_COLUMNS} FROM render_obligations WHERE thread_key = ?`,
        threadKey,
      )
      .toArray()[0];
    return row ? mapObligationRow(row) : undefined;
  }

  /** Obligations whose deadline has passed, earliest first. */
  due(now: number): RenderObligationRow[] {
    return this.sql
      .exec<{
        thread_key: string;
        execution_id: string;
        after_event_id: number;
        channel: string;
        thread_ts: string | null;
        deadline: number;
        attempt: number;
      }>(
        `SELECT ${OBLIGATION_COLUMNS} FROM render_obligations WHERE deadline <= ? ORDER BY deadline ASC`,
        now,
      )
      .toArray()
      .map(mapObligationRow);
  }

  /** `MIN(deadline)` across every row, or `undefined` if the table is empty. */
  earliestDeadline(): number | undefined {
    const row = this.sql
      .exec<{ d: number | null }>(
        `SELECT MIN(deadline) AS d FROM render_obligations`,
      )
      .one();
    return row.d ?? undefined;
  }

  /** Unconditional delete-by-identity — used by the alarm's delete-then-post step. */
  delete(threadKey: string, executionId: string): void {
    this.sql.exec(
      `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`,
      threadKey,
      executionId,
    );
  }

  /**
   * Re-insert a row that failed to post, with a short retry deadline and an
   * incremented attempt count. Guarded so a stale retry can never clobber a
   * *newer* obligation that a fresh turn wrote for the same `threadKey` while
   * this one was in flight (the `WHERE` on the conflict clause makes the
   * update a no-op — and the insert a no-op — when the current row's
   * `execution_id` no longer matches what we're retrying).
   */
  reinsertForRetry(row: RenderObligationRow, retryDelayMs: number): void {
    const deadline = this.now() + retryDelayMs;
    const attempt = row.attempt + 1;
    this.sql.exec(
      `INSERT INTO render_obligations (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET
         execution_id   = excluded.execution_id,
         after_event_id = excluded.after_event_id,
         channel        = excluded.channel,
         thread_ts      = excluded.thread_ts,
         deadline       = excluded.deadline,
         attempt        = excluded.attempt
       WHERE render_obligations.execution_id = excluded.execution_id`,
      row.threadKey,
      row.executionId,
      row.afterEventId,
      row.channel,
      row.threadTs ?? null,
      deadline,
      attempt,
    );
  }
}

/** `kind === 'output'` events, concatenated in order, from a `SessionEventDO.replay()` result. */
export function reconstructMarkdown(
  events: Array<{ kind: string; payload: unknown }>,
): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.kind !== "output") continue;
    const p = e.payload;
    if (typeof p === "string") {
      parts.push(p);
      continue;
    }
    if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      const text = rec.text ?? rec.markdown ?? rec.content;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}

/**
 * The Durable Object that owns one private, embedded SQLite database holding
 * bot session/conversation state, plus the render-obligation table that
 * backs the "never-silent" guarantee (SPEC.md §3.1). One instance per
 * partition (see `partition.ts`); the default is a single `"global"`
 * instance, and you can shard per-conversation for locality + isolation
 * without touching the engine.
 *
 * Why a Durable Object:
 *   • The SQLite DB is co-located in the same thread — reads/writes are
 *     effectively zero-latency, no network hop like Redis.
 *   • The DO is single-threaded with input/output gates, so RPC methods don't
 *     interleave mid-operation; combined with `transactionSync`, the lock/dedup/
 *     queue mutations the bot relies on are genuinely atomic.
 *   • Storage is strongly durable (writes are replicated before they're ack'd).
 *
 * Values cross the RPC boundary as structured-cloned JS, and are JSON-encoded
 * to TEXT here — a single serialization seam that honors the StateStore
 * "JSON-serializable values" contract.
 *
 * **This DO has exactly one alarm**, shared by two jobs: the pre-existing
 * hourly GC sweep (`sweepExpired`) and serving any render obligation whose
 * deadline has passed. `alarm()` runs whichever of those is due, then
 * reschedules itself to `min(next sweep time, earliest remaining obligation
 * deadline)`. The next-sweep timestamp lives in DO storage KV
 * ({@link NEXT_SWEEP_KEY}) so it survives a DO restart between alarm fires.
 */
export class ConversationStateDO extends DurableObject {
  private readonly engine: SqlStateEngine;
  private readonly obligations: RenderObligationEngine;

  constructor(ctx: DurableObjectState, env: unknown) {
    // `env` is opaque to the store — it never reads bindings — so we hand the
    // base class whatever it was given. The cast bridges the generic `Env`.
    super(ctx, env as never);
    const sql = this.ctx.storage.sql as unknown as SqlExecutor;

    // Build the schema before any request can touch the engine. blockConcurrencyWhile
    // delays inbound RPC until the migration resolves, so nothing sees a partial schema.
    void this.ctx.blockConcurrencyWhile(async () => {
      migrate(sql);
      if ((await this.ctx.storage.get<number>(NEXT_SWEEP_KEY)) === undefined) {
        await this.ctx.storage.put(NEXT_SWEEP_KEY, Date.now() + SWEEP_INTERVAL_MS);
      }
      if ((await this.ctx.storage.getAlarm()) === null) {
        const nextSweepAt =
          (await this.ctx.storage.get<number>(NEXT_SWEEP_KEY)) ??
          Date.now() + SWEEP_INTERVAL_MS;
        await this.ctx.storage.setAlarm(nextSweepAt);
      }
    });

    this.engine = new SqlStateEngine({
      sql,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
    });
    this.obligations = new RenderObligationEngine({ sql });
  }

  /**
   * The DO's single alarm. Runs the GC sweep if its interval has elapsed,
   * serves any render obligation whose deadline has passed, then reschedules
   * itself for whichever comes first next.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let nextSweepAt =
      (await this.ctx.storage.get<number>(NEXT_SWEEP_KEY)) ??
      now + SWEEP_INTERVAL_MS;

    if (now >= nextSweepAt) {
      this.engine.sweepExpired();
      nextSweepAt = now + SWEEP_INTERVAL_MS;
      await this.ctx.storage.put(NEXT_SWEEP_KEY, nextSweepAt);
    }

    await this.serveDueObligations(now);

    const earliest = this.obligations.earliestDeadline();
    const next = earliest !== undefined ? Math.min(nextSweepAt, earliest) : nextSweepAt;
    await this.ctx.storage.setAlarm(next);
  }

  // ── render obligations (SPEC.md §3.1 / §4.2) ────────────────────────────

  /**
   * Upsert by `threadKey`. Default timeout is 16 minutes — deliberately
   * longer than `bot-engine.ts`'s 15-minute turn lock, so the alarm never
   * fires while a turn is still legitimately mid-flight (e.g. waiting on a
   * HITL confirmation).
   */
  async obligationSet(args: {
    threadKey: string;
    executionId: string;
    afterEventId: number;
    channel: string;
    threadTs?: string;
    timeoutMs?: number;
  }): Promise<void> {
    this.obligations.set(args);
    await this.rescheduleAlarm();
  }

  /**
   * Delete; if `executionId` is given, only delete when it matches (a newer
   * turn's obligation for the same thread must survive a stale clear).
   */
  async obligationClear(args: {
    threadKey: string;
    executionId?: string;
  }): Promise<void> {
    this.obligations.clear(args);
    await this.rescheduleAlarm();
  }

  async obligationGet(args: {
    threadKey: string;
  }): Promise<RenderObligationRow | undefined> {
    return this.obligations.get(args.threadKey);
  }

  /** Recompute `min(next sweep, earliest obligation deadline)` and reschedule the alarm to it. */
  private async rescheduleAlarm(): Promise<void> {
    const nextSweepAt =
      (await this.ctx.storage.get<number>(NEXT_SWEEP_KEY)) ??
      Date.now() + SWEEP_INTERVAL_MS;
    const earliest = this.obligations.earliestDeadline();
    const next = earliest !== undefined ? Math.min(nextSweepAt, earliest) : nextSweepAt;
    await this.ctx.storage.setAlarm(next);
  }

  /**
   * Serve every obligation whose deadline has passed. Delete-then-post: the
   * row is removed from the table *before* we attempt to post, so a crash or
   * failed fetch never leaves a row that a subsequent alarm could serve a
   * second time. On failure, re-insert with a short retry deadline (capped at
   * {@link OBLIGATION_MAX_ATTEMPTS}); never throws out of this method — a
   * throwing alarm retries forever, which is worse than dropping a render.
   */
  private async serveDueObligations(now: number): Promise<void> {
    const due = this.obligations.due(now);
    if (due.length === 0) return;

    const env = this.env as unknown as ConversationStateDoEnv;

    for (const ob of due) {
      this.obligations.delete(ob.threadKey, ob.executionId);
      try {
        await this.serveObligation(ob, env);
      } catch (err) {
        console.error(
          JSON.stringify({
            metric: "obligation_serve_error",
            threadKey: ob.threadKey,
            executionId: ob.executionId,
            attempt: ob.attempt,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        if (ob.attempt + 1 < OBLIGATION_MAX_ATTEMPTS) {
          this.obligations.reinsertForRetry(ob, OBLIGATION_RETRY_DELAY_MS);
        }
      }
    }
  }

  /** Reconstruct-and-post (or silently clear) a single due obligation. */
  private async serveObligation(
    ob: RenderObligationRow,
    env: ConversationStateDoEnv,
  ): Promise<void> {
    if (env.SESSION_EVENTS) {
      const sessionDo = env.SESSION_EVENTS.get(
        env.SESSION_EVENTS.idFromName(ob.threadKey),
      ) as unknown as SessionEventsRpc;

      // Respect a user-issued stop: posting "please retry" would be wrong
      // when the user explicitly asked the turn to stop.
      const state = await sessionDo.getState().catch(() => undefined);
      if (state?.interrupted) {
        console.log(
          JSON.stringify({
            metric: "obligation_silent_clear",
            threadKey: ob.threadKey,
            executionId: ob.executionId,
          }),
        );
        return;
      }

      // Execution still live (long HITL wait / slow harness, not a crash):
      // posting now would double-post next to the turn's own eventual answer.
      // Re-arm instead; the attempt cap still bounds a genuinely hung turn.
      if (state?.executing && state.executing.executionId === ob.executionId) {
        console.log(
          JSON.stringify({
            metric: "obligation_deferred_live",
            threadKey: ob.threadKey,
            executionId: ob.executionId,
            attempt: ob.attempt,
          }),
        );
        if (ob.attempt + 1 < OBLIGATION_MAX_ATTEMPTS) {
          this.obligations.reinsertForRetry(ob, OBLIGATION_LIVE_DEFER_MS);
          await this.rescheduleAlarm();
        }
        return;
      }

      const events = await sessionDo.replay(ob.afterEventId).catch(() => []);
      const content = reconstructMarkdown(events);
      if (content) {
        await this.postFallback(
          ob,
          env,
          `_Recovered after an interrupted turn:_\n${content}`,
          "fallback_sent",
        );
        return;
      }
    }

    await this.postFallback(
      ob,
      env,
      "⚠️ This turn was interrupted before an answer could be delivered. Please retry.",
      "error_visible",
    );
  }

  /** POST to `chat.postMessage`. Logs and drops (no throw) if the bot token is missing. */
  private async postFallback(
    ob: RenderObligationRow,
    env: ConversationStateDoEnv,
    text: string,
    outcome: "fallback_sent" | "error_visible",
  ): Promise<void> {
    if (!env.SLACK_BOT_TOKEN) {
      console.error(
        JSON.stringify({
          metric: "obligation_no_token",
          threadKey: ob.threadKey,
          executionId: ob.executionId,
        }),
      );
      return;
    }

    const body: Record<string, unknown> = { channel: ob.channel, text };
    if (ob.threadTs) body.thread_ts = ob.threadTs;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || json.ok !== true) {
      // Thrown here on purpose: the caller (`serveDueObligations`) catches
      // this per-obligation and decides whether to retry.
      throw new Error(`chat.postMessage failed: ${json.error ?? res.status}`);
    }

    console.log(
      JSON.stringify({
        metric: outcome,
        threadKey: ob.threadKey,
        executionId: ob.executionId,
      }),
    );
  }

  // ── RPC surface (mirrors StateStore, async at the boundary) ─────────────────
  // JSON (de)serialization happens here so the engine stays pure-SQL.

  async kvGet(key: string): Promise<unknown> {
    const raw = this.engine.kvGet(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }
  async kvSet(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.engine.kvSet(key, JSON.stringify(value), ttlMs);
  }
  async kvDelete(key: string): Promise<void> {
    this.engine.kvDelete(key);
  }

  async listAppend(
    key: string,
    value: unknown,
    opts?: ListOpts,
  ): Promise<number> {
    return this.engine.listAppend(key, JSON.stringify(value), opts);
  }
  async listRange(
    key: string,
    start?: number,
    stop?: number,
  ): Promise<unknown[]> {
    return this.engine
      .listRange(key, start, stop)
      .map((v) => JSON.parse(v) as unknown);
  }
  async listTrim(key: string, maxLen: number): Promise<void> {
    this.engine.listTrim(key, maxLen);
  }
  async listDelete(key: string): Promise<void> {
    this.engine.listDelete(key);
  }

  async lockAcquire(
    key: string,
    ttlMs?: number,
  ): Promise<{ token: string } | null> {
    return this.engine.lockAcquire(key, ttlMs);
  }
  async lockRelease(key: string, token: string): Promise<void> {
    this.engine.lockRelease(key, token);
  }

  async dedupSeen(key: string, ttlMs: number): Promise<boolean> {
    return this.engine.dedupSeen(key, ttlMs);
  }

  async queueEnqueue(
    key: string,
    value: unknown,
    opts?: QueueOpts,
  ): Promise<number> {
    return this.engine.queueEnqueue(key, JSON.stringify(value), opts);
  }
  async queueDequeue(key: string): Promise<unknown> {
    const raw = this.engine.queueDequeue(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }
  async queueDepth(key: string): Promise<number> {
    return this.engine.queueDepth(key);
  }
}
