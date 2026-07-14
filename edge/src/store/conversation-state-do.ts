import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { SqlStateEngine } from "./sql-state-engine.js";
import { ActiveTurnEngine } from "./active-turn-engine.js";
import {
  ACTIVE_TURN_TTL_MS,
  type ActiveTurnEffectResource,
  type ActiveTurnRecord,
} from "./active-turn-types.js";
import { migrate } from "./schema.js";
import type { SqlExecutor } from "./sql.js";
import type { SessionEventDO } from "./session-event-do.js";
import { interruptHarnessTurn } from "../harness/client.js";
import type { Env } from "../env.js";

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

/** Retry backoff for a definitive failed fallback post; capped at {@link OBLIGATION_MAX_ATTEMPTS}. */
const OBLIGATION_RETRY_DELAY_MS = 60_000;
const OBLIGATION_MAX_ATTEMPTS = 3;
/** Re-arm delay when the session reports the execution is still live (not crashed). */
const OBLIGATION_LIVE_DEFER_MS = 2 * 60_000;
/** Re-arm delay while a render's outcome is ambiguous and its token is fenced. */
const OBLIGATION_AMBIGUOUS_DEFER_MS = 2 * 60_000;
const STOP_CONTINUATION_RETRY_MS = 60_000;

class ObligationDeferredError extends Error {
  constructor(readonly delayMs: number, readonly reason: string) {
    super(reason);
    this.name = "ObligationDeferredError";
  }
}

function isSlackDuplicateMessage(error: unknown): boolean {
  return error === "duplicate_message" || error === "duplicate_client_msg_id";
}

async function stableObligationClientMessageId(ob: {
  threadKey: string;
  executionId: string;
}): Promise<string> {
  const input = `obligation:${ob.threadKey}:${ob.executionId}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  ).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function stableStopClientMessageId(stopEventId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stopEventId)),
  ).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  HARNESS?: Fetcher;
  HARNESS_URL?: string;
  HARNESS_AUTH_TOKEN?: string;
  RESEARCH_TASKS?: Fetcher;
  INTERNAL_SECRET?: string;
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
    interruptedExecutionId?: string;
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
  execute(args: {
    executionId: string;
    forwardedMessageId?: string;
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean; cancelled?: boolean }>;
  appendEvent(args: {
    executionId: string;
    kind: "output" | "error" | "done";
    payload: unknown;
  }): Promise<{ id: number }>;
  interruptExpected(
    executionId: string,
  ): Promise<{ interrupted: boolean; cancelled: true }>;
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

  /**
   * Re-arm a live or ambiguous render without spending its finite budget for
   * definitive Slack rejections. The exact execution guard prevents a stale
   * defer from replacing a newer turn on the same conversation.
   */
  reinsertForDefer(row: RenderObligationRow, deferDelayMs: number): void {
    const deadline = this.now() + deferDelayMs;
    this.sql.exec(
      `INSERT INTO render_obligations (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET
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
      row.attempt,
    );
  }
}

/** Whether replay already has a successful terminal event for this execution. */
export function hasSuccessfulTerminal(
  events: Array<{ executionId: string; kind: string; payload: unknown }>,
  executionId: string,
): boolean {
  for (const e of events) {
    if (e.executionId !== executionId || e.kind !== "done") continue;
    const payload = e.payload;
    if (payload && typeof payload === "object") {
      const rec = payload as Record<string, unknown>;
      if (rec.interrupted === true || rec.ok === false) continue;
    }
    return true;
  }
  return false;
}

/** `kind === 'output'` events for one execution, concatenated in order. */
export function reconstructMarkdown(
  events: Array<{ executionId: string; kind: string; payload: unknown }>,
  executionId: string,
): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.executionId !== executionId || e.kind !== "output") continue;
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
  private readonly activeTurns: ActiveTurnEngine;

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
    this.activeTurns = new ActiveTurnEngine(
      sql,
      (fn) => this.ctx.storage.transactionSync(fn),
    );
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

    await this.servePendingStopContinuations();
    await this.serveDueObligations(now);

    const earliest = this.obligations.earliestDeadline();
    const stopRetryAt = this.activeTurns.pendingStopContinuations().length > 0
      ? now + STOP_CONTINUATION_RETRY_MS
      : undefined;
    const obligationOrSweep = earliest !== undefined ? Math.min(nextSweepAt, earliest) : nextSweepAt;
    const next = stopRetryAt !== undefined
      ? Math.min(obligationOrSweep, stopRetryAt)
      : obligationOrSweep;
    await this.ctx.storage.setAlarm(next);
  }

  // ── render obligations (SPEC.md §3.1 / §4.2) ────────────────────────────

  /**
   * Upsert by `threadKey`. Default timeout is 20 minutes — deliberately
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

  // ── exact active-turn / render fencing ─────────────────────────────────

  async activeTurnRegister(record: ActiveTurnRecord) {
    return this.activeTurns.register(record, ACTIVE_TURN_TTL_MS);
  }

  async activeTurnRegisterWithObligation(args: {
    record: ActiveTurnRecord;
    obligation: {
      afterEventId: number;
      channel: string;
      threadTs?: string;
      timeoutMs: number;
    };
  }) {
    const result = this.activeTurns.register(
      args.record,
      ACTIVE_TURN_TTL_MS,
      args.obligation,
    );
    if (result.accepted) await this.rescheduleAlarm();
    return result;
  }

  async activeTurnRefresh(record: ActiveTurnRecord): Promise<boolean> {
    return this.activeTurns.refresh(record, ACTIVE_TURN_TTL_MS);
  }

  async activeTurnGet(args: { threadKey: string }) {
    return this.activeTurns.get(args.threadKey);
  }

  async activeTurnLatest(args: { channelId: string }) {
    return this.activeTurns.latest(args.channelId);
  }

  async activeTurnRegisterChoice(args: {
    threadKey: string;
    executionId: string;
    choiceId: string;
  }) {
    return this.activeTurns.registerChoice(
      args.threadKey,
      args.executionId,
      args.choiceId,
    );
  }

  async activeTurnUnregisterChoice(args: {
    threadKey: string;
    executionId: string;
    choiceId: string;
  }): Promise<boolean> {
    return this.activeTurns.unregisterChoice(
      args.threadKey,
      args.executionId,
      args.choiceId,
    );
  }

  async activeTurnCancelRegisteredChoices(args: {
    threadKey: string;
    executionId: string;
  }): Promise<string[]> {
    return this.activeTurns.cancelRegisteredChoices(
      args.threadKey,
      args.executionId,
    );
  }

  async activeTurnClaimCancellation(args: {
    threadKey: string;
    executionId: string;
    stopEventId: string;
  }) {
    const result = this.activeTurns.claimCancellation(
      args.threadKey,
      args.executionId,
      args.stopEventId,
    );
    if (result !== "missing" && result !== "committed") {
      // Stop ownership must survive the request that observed it. Tokens in
      // flight are excluded by the continuation scan; their definitive CAS
      // schedules another immediate alarm when they clear.
      await this.ctx.storage.setAlarm(Date.now());
    }
    return result;
  }

  async activeTurnMarkCancelControlled(args: {
    threadKey: string;
    executionId: string;
    stopEventId: string;
  }): Promise<boolean> {
    return this.activeTurns.markCancelControlled(
      args.threadKey,
      args.executionId,
      args.stopEventId,
    );
  }

  async activeTurnBeginCancelAck(args: {
    threadKey: string;
    executionId: string;
    stopEventId: string;
  }): Promise<boolean> {
    return this.activeTurns.beginCancelAck(
      args.threadKey,
      args.executionId,
      args.stopEventId,
    );
  }

  async activeTurnFailCancelAck(args: {
    threadKey: string;
    executionId: string;
    stopEventId: string;
  }): Promise<boolean> {
    return this.activeTurns.failCancelAck(
      args.threadKey,
      args.executionId,
      args.stopEventId,
    );
  }

  async activeTurnConfirmCancellationAndClear(args: {
    threadKey: string;
    executionId: string;
    stopEventId: string;
  }): Promise<boolean> {
    const confirmed = this.activeTurns.confirmCancellationAndClear(
      args.threadKey,
      args.executionId,
      args.stopEventId,
    );
    if (confirmed) await this.rescheduleAlarm();
    return confirmed;
  }

  async activeTurnBeginRender(args: {
    threadKey: string;
    executionId: string;
  }) {
    return this.activeTurns.beginRender(args.threadKey, args.executionId);
  }

  async activeTurnConfirmRender(args: {
    threadKey: string;
    executionId: string;
    token: string;
    final: boolean;
    output: boolean;
  }): Promise<boolean> {
    const confirmed = this.activeTurns.confirmRender(
      args.threadKey,
      args.executionId,
      args.token,
      args.final,
      args.output,
    );
    if (confirmed) {
      if (args.final) {
        await this.rescheduleAlarm();
      } else {
        const snapshot = this.activeTurns.get(args.threadKey);
        if (snapshot?.stopEventId && snapshot.status === "cancelled") {
          await this.ctx.storage.setAlarm(Date.now());
        }
      }
    }
    return confirmed;
  }

  async activeTurnFailRender(args: {
    threadKey: string;
    executionId: string;
    token: string;
  }): Promise<boolean> {
    const failed = this.activeTurns.failRender(
      args.threadKey,
      args.executionId,
      args.token,
    );
    if (failed) {
      const snapshot = this.activeTurns.get(args.threadKey);
      if (snapshot?.stopEventId && snapshot.status === "cancelled") {
        await this.ctx.storage.setAlarm(Date.now());
      }
    }
    return failed;
  }

  async activeTurnBeginEffect(args: {
    threadKey: string;
    executionId: string;
    effectName: string;
  }) {
    return this.activeTurns.beginEffect(
      args.threadKey,
      args.executionId,
      args.effectName,
    );
  }

  async activeTurnConfirmEffect(args: {
    threadKey: string;
    executionId: string;
    token: string;
    resource?: ActiveTurnEffectResource;
  }): Promise<boolean> {
    const confirmed = this.activeTurns.confirmEffect(
      args.threadKey,
      args.executionId,
      args.token,
      args.resource,
    );
    if (confirmed) {
      const snapshot = this.activeTurns.get(args.threadKey);
      if (snapshot?.stopEventId && snapshot.status === "cancelled") {
        await this.ctx.storage.setAlarm(Date.now());
      }
    }
    return confirmed;
  }

  async activeTurnFailEffect(args: {
    threadKey: string;
    executionId: string;
    token: string;
  }): Promise<boolean> {
    const failed = this.activeTurns.failEffect(
      args.threadKey,
      args.executionId,
      args.token,
    );
    if (failed) {
      const snapshot = this.activeTurns.get(args.threadKey);
      if (snapshot?.stopEventId && snapshot.status === "cancelled") {
        await this.ctx.storage.setAlarm(Date.now());
      }
    }
    return failed;
  }

  async activeTurnLifecycleComplete(args: {
    threadKey: string;
    executionId: string;
  }): Promise<boolean> {
    const completed = this.activeTurns.lifecycleComplete(
      args.threadKey,
      args.executionId,
    );
    if (completed) await this.rescheduleAlarm();
    return completed;
  }

  async activeTurnAbandonPristine(args: {
    threadKey: string;
    executionId: string;
  }): Promise<boolean> {
    const cleared = this.activeTurns.abandonPristine(
      args.threadKey,
      args.executionId,
    );
    if (cleared) await this.rescheduleAlarm();
    return cleared;
  }

  async activeTurnDiscardInterruptedRedelivery(args: {
    threadKey: string;
    executionId: string;
  }): Promise<boolean> {
    const cleared = this.activeTurns.discardInterruptedRedelivery(
      args.threadKey,
      args.executionId,
    );
    if (cleared) await this.rescheduleAlarm();
    return cleared;
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

  /** Resume Stops that outlived the Worker request which first observed an effect. */
  private async servePendingStopContinuations(): Promise<void> {
    const pending = this.activeTurns.pendingStopContinuations();
    if (pending.length === 0) return;
    const env = this.env as unknown as ConversationStateDoEnv;

    for (const snapshot of pending) {
      const { record, stopEventId } = snapshot;
      if (!stopEventId) continue;
      try {
        if (snapshot.status === "cancelled") {
          if (!env.SESSION_EVENTS) continue;
          const sessionDo = env.SESSION_EVENTS.get(
            env.SESSION_EVENTS.idFromName(record.threadKey),
          ) as unknown as SessionEventsRpc;
          const interrupted = await sessionDo.interruptExpected(record.executionId);
          if (interrupted.cancelled !== true) continue;
          const state = await sessionDo.getState();
          if (state.sessionId) {
            const harnessInterrupt = await interruptHarnessTurn(env as Env, {
              sessionId: state.sessionId,
              threadKey: record.threadKey,
              executionId: record.executionId,
            });
            // The harness endpoint returns success only after its exact
            // process/git/GitHub control barrier is quiescent. Any missing
            // binding, rejection, malformed response, or transport ambiguity
            // leaves the durable row cancelled for the next alarm.
            if (!harnessInterrupt.accepted) continue;
          }
          this.activeTurns.cancelRegisteredChoices(
            record.threadKey,
            record.executionId,
          );
          if (!this.activeTurns.markCancelControlled(
            record.threadKey,
            record.executionId,
            stopEventId,
          )) continue;
        }

        const current = this.activeTurns.get(record.threadKey);
        if (!current || current.record.executionId !== record.executionId) continue;
        if (current.effectResource) {
          if (!env.RESEARCH_TASKS || !env.INTERNAL_SECRET) continue;
          const resource = current.effectResource;
          const response = await env.RESEARCH_TASKS.fetch(
            `https://research/internal/tasks/${encodeURIComponent(resource.taskId)}/cancel`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.INTERNAL_SECRET}`,
              },
              body: JSON.stringify({
                teamId: resource.teamId,
                threadKey: resource.threadKey,
              }),
            },
          );
          if (!response.ok) continue;
          let result: unknown;
          try {
            result = await response.json();
          } catch {
            continue;
          }
          if (
            !result ||
            typeof result !== "object" ||
            (result as { cancelled?: unknown }).cancelled !== true ||
            (result as { quiescent?: unknown }).quiescent !== true ||
            (result as { taskId?: unknown }).taskId !== resource.taskId
          ) continue;
        }
        if (!env.SLACK_BOT_TOKEN) continue;
        if (current.status === "cancel_controlled") {
          if (!this.activeTurns.beginCancelAck(
            record.threadKey,
            record.executionId,
            stopEventId,
          )) continue;
        } else if (current.status !== "cancel_ack_in_flight") {
          continue;
        }

        const form = new URLSearchParams({
          channel: record.channelId,
          text: "🛑 Stopped.",
          client_msg_id: await stableStopClientMessageId(stopEventId),
        });
        if (record.threadTs) form.set("thread_ts", record.threadTs);
        const response = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          },
          body: form.toString(),
        });
        const json = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || (json.ok !== true && !isSlackDuplicateMessage(json.error))) {
          if (json.ok === false) {
            this.activeTurns.failCancelAck(
              record.threadKey,
              record.executionId,
              stopEventId,
            );
          }
          continue;
        }
        this.activeTurns.confirmCancellationAndClear(
          record.threadKey,
          record.executionId,
          stopEventId,
        );
      } catch (err) {
        console.error(JSON.stringify({
          metric: "stop_continuation_error",
          threadKey: record.threadKey,
          executionId: record.executionId,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }

  /**
   * Serve every obligation whose deadline has passed. Delete-then-post: the
   * row is removed from the table *before* each attempt. Definitive Slack
   * rejections consume a finite retry budget. Live executions and ambiguous
   * render outcomes retain their fenced token and are durably re-armed without
   * consuming that budget; every retry uses the same Slack client_msg_id.
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
        if (err instanceof ObligationDeferredError) {
          console.log(
            JSON.stringify({
              metric: "obligation_deferred",
              threadKey: ob.threadKey,
              executionId: ob.executionId,
              attempt: ob.attempt,
              reason: err.reason,
            }),
          );
          this.obligations.reinsertForDefer(ob, err.delayMs);
          continue;
        }
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
    if (!env.SESSION_EVENTS) {
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "session_events_unavailable",
      );
    }
    let sessionDo: SessionEventsRpc;
    try {
      sessionDo = env.SESSION_EVENTS.get(
        env.SESSION_EVENTS.idFromName(ob.threadKey),
      ) as unknown as SessionEventsRpc;
    } catch {
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "session_events_binding_unavailable",
      );
    }

    // A failed state read is unknown, never evidence of interruption/crash.
    // Preserve the obligation and its retry budget until the durable session
    // gives an affirmative answer.
    let state: Awaited<ReturnType<SessionEventsRpc["getState"]>>;
    try {
      state = await sessionDo.getState();
    } catch {
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "session_state_unavailable",
      );
    }
    // Respect a user-issued Stop only when the durable tombstone names this
    // exact execution. An older execution's interrupted flag must not erase a
    // newer obligation sharing the conversation DO.
    if (state.interruptedExecutionId === ob.executionId) {
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
    // Re-arm without spending the finite definitive-failure budget — but ONLY
    // while the active-turn row (which live turns refresh and a crashed
    // isolate cannot) still names this execution. An `executing` slot that
    // outlived its active-turn TTL is a crash orphan its dead owner can never
    // terminalize; deferring on it forever would be permanent silence, so
    // fall through to recovery instead (the render fence still serializes
    // any residual writer).
    if (state.executing && state.executing.executionId === ob.executionId) {
      const active = this.activeTurns.get(ob.threadKey);
      if (active?.record.executionId === ob.executionId) {
        throw new ObligationDeferredError(
          OBLIGATION_LIVE_DEFER_MS,
          "live_execution",
        );
      }
      console.log(
        JSON.stringify({
          metric: "obligation_stale_execution",
          threadKey: ob.threadKey,
          executionId: ob.executionId,
        }),
      );
    }

    let events: Awaited<ReturnType<SessionEventsRpc["replay"]>>;
    try {
      events = await sessionDo.replay(ob.afterEventId);
    } catch {
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "session_replay_unavailable",
      );
    }
    const successfulTerminal = hasSuccessfulTerminal(events, ob.executionId);
    const content = reconstructMarkdown(events, ob.executionId);
    if (content) {
      await this.postFallback(
        ob,
        env,
        successfulTerminal
          ? `_Recovered completed turn:_\n${content}`
          : `_Recovered after an interrupted turn:_\n${content}`,
        "fallback_sent",
      );
      return;
    }

    await this.postFallback(
      ob,
      env,
      "⚠️ This turn was interrupted before an answer could be delivered. Please retry.",
      "error_visible",
    );
  }

  /** POST to `chat.postMessage`; missing config is transient and re-armed. */
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
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "slack_bot_token_unavailable",
      );
    }

    const render = this.activeTurns.beginRender(ob.threadKey, ob.executionId);
    if (render.status === "cancelled" || render.status === "committed") return;
    if (render.status === "in_flight") {
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "render_in_flight",
      );
    }
    // Missing means the active row reached its TTL. No Stop can subsequently
    // claim that exact execution, so obligation recovery may still proceed.
    const token = render.status === "claimed" ? render.token : undefined;

    const body = new URLSearchParams({
      channel: ob.channel,
      text,
      client_msg_id: await stableObligationClientMessageId(ob),
    });
    if (ob.threadTs) body.set("thread_ts", ob.threadTs);

    let res: Response;
    try {
      res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        },
        body: body.toString(),
      });
    } catch (err) {
      // Ambiguous transport failure: retain the render token so Stop cannot
      // acknowledge after Slack may have applied this fallback. Replays use
      // the same client_msg_id and do not consume the rejection retry budget.
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "render_transport_ambiguous",
      );
    }
    let json: {
      ok?: boolean;
      error?: string;
    };
    try {
      json = await res.json() as { ok?: boolean; error?: string };
    } catch {
      throw new ObligationDeferredError(
        OBLIGATION_AMBIGUOUS_DEFER_MS,
        "render_response_ambiguous",
      );
    }
    const duplicate = isSlackDuplicateMessage(json.error);
    if (!duplicate && (!res.ok || json.ok !== true)) {
      if (json.ok !== false) {
        throw new ObligationDeferredError(
          OBLIGATION_AMBIGUOUS_DEFER_MS,
          "render_response_ambiguous",
        );
      }
      if (token) this.activeTurns.failRender(ob.threadKey, ob.executionId, token);
      // Thrown here on purpose: the caller (`serveDueObligations`) catches
      // this per-obligation and decides whether to retry.
      throw new Error(`chat.postMessage failed: ${json.error ?? res.status}`);
    }

    if (token && !this.activeTurns.confirmRender(
      ob.threadKey,
      ob.executionId,
      token,
      true,
      true,
    )) {
      throw new Error("obligation_final_confirmation_failed");
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

  async hitlPrepareChoice(args: {
    choiceKey: string;
    cancelledKey: string;
  }): Promise<
    | { status: "ready" }
    | { status: "cancelled"; record: unknown }
  > {
    const result = this.engine.hitlPrepareChoice(
      args.choiceKey,
      args.cancelledKey,
    );
    return result.status === "ready"
      ? result
      : { status: result.status, record: JSON.parse(result.record) as unknown };
  }

  async hitlConsumeChoice(args: {
    choiceKey: string;
    cancelledKey: string;
  }): Promise<
    | { status: "pending" }
    | { status: "choice" | "cancelled"; record: unknown }
  > {
    const result = this.engine.hitlConsumeChoice(
      args.choiceKey,
      args.cancelledKey,
    );
    return result.status === "pending"
      ? result
      : { status: result.status, record: JSON.parse(result.record) as unknown };
  }

  async hitlPersistChoiceUnlessCancelled(args: {
    choiceKey: string;
    cancelledKey: string;
    record: unknown;
    ttlMs: number;
  }): Promise<"persisted" | "cancelled"> {
    return this.engine.hitlPersistChoiceUnlessCancelled(
      args.choiceKey,
      args.cancelledKey,
      JSON.stringify(args.record),
      args.ttlMs,
    );
  }

  async hitlCancelChoice(args: {
    choiceKey: string;
    cancelledKey: string;
    denial: unknown;
    ttlMs: number;
  }): Promise<void> {
    this.engine.hitlCancelChoice(
      args.choiceKey,
      args.cancelledKey,
      JSON.stringify(args.denial),
      args.ttlMs,
    );
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
