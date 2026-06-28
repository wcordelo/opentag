import { DurableObject } from "cloudflare:workers";
import { SqlStateEngine } from "./sql-state-engine.js";
import { migrate } from "./schema.js";
import type { SqlExecutor } from "./sql.js";

/**
 * How often the background alarm sweeps expired rows. Lazy expiry already keeps
 * reads correct; this just reclaims space for keys that are never read again.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h

interface ListOpts {
  maxLen?: number;
  ttlMs?: number;
}
interface QueueOpts {
  maxSize?: number;
  onFull?: "drop-oldest" | "drop-newest";
}

/**
 * The Durable Object that owns one private, embedded SQLite database holding bot
 * session/conversation state. One instance per partition (see `partition.ts`);
 * the default is a single `"global"` instance, and you can shard per-conversation
 * for locality + isolation without touching the engine.
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
 */
export class ConversationStateDO extends DurableObject {
  private readonly engine: SqlStateEngine;

  constructor(ctx: DurableObjectState, env: unknown) {
    // `env` is opaque to the store — it never reads bindings — so we hand the
    // base class whatever it was given. The cast bridges the generic `Env`.
    super(ctx, env as never);
    const sql = this.ctx.storage.sql as unknown as SqlExecutor;

    // Build the schema before any request can touch the engine. blockConcurrencyWhile
    // delays inbound RPC until the migration resolves, so nothing sees a partial schema.
    void this.ctx.blockConcurrencyWhile(async () => {
      migrate(sql);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }
    });

    this.engine = new SqlStateEngine({
      sql,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
    });
  }

  /** Periodic GC of expired rows; reschedules itself. */
  override async alarm(): Promise<void> {
    this.engine.sweepExpired();
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
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
