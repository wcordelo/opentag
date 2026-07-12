import type {
  DurableObjectNamespace,
  DurableObjectStub,
} from "@cloudflare/workers-types";
import type { StateStore } from "./state-store-contract.js";
import type {
  ConversationStateDO,
  RenderObligationRow,
} from "./conversation-state-do.js";
import { singleGlobal, type Partitioner } from "./partition.js";

export interface DurableObjectStoreOptions {
  /** The Durable Object namespace binding (from `env`). */
  namespace: DurableObjectNamespace<ConversationStateDO>;
  /**
   * How keys map to Durable Object instances. Defaults to {@link singleGlobal}
   * (one DO for everything). Use {@link byConversationKey} to shard per-thread.
   */
  partition?: Partitioner;
}

type Stub = DurableObjectStub<ConversationStateDO>;

/**
 * A `StateStore` implemented on Cloudflare Durable Objects + embedded SQLite.
 *
 * This object lives in the Worker and is a thin RPC forwarder: each call routes
 * through {@link Partitioner} to a Durable Object instance (`getByName`) and
 * invokes the matching method on {@link ConversationStateDO}, which runs the SQL
 * locally and durably. Pass it to `createBot({ store: { adapter } })`.
 *
 * Drop-in replacement for the in-memory / Redis stores: same contract, but state
 * is co-located edge SQLite instead of a separate Redis hop — the "Centaur-less"
 * edge-native target.
 */
export class DurableObjectStateStore implements StateStore {
  private readonly ns: DurableObjectNamespace<ConversationStateDO>;
  private readonly route: Partitioner;

  constructor(opts: DurableObjectStoreOptions) {
    this.ns = opts.namespace;
    this.route = opts.partition ?? singleGlobal;
  }

  /**
   * Resolve the owning Durable Object stub for `key`.
   *
   * Prefer `getByName` (Workers runtime ≥ 2024). Older local Miniflare builds
   * (e.g. wrangler 3.x `wrangler dev`) only expose `idFromName` + `get` — without
   * this fallback `/debug/store` and local dev smoke tests 500.
   */
  private stub(key: string): Stub {
    const name = this.route(key);
    const ns = this.ns as DurableObjectNamespace<ConversationStateDO> & {
      getByName?: (n: string) => Stub;
    };
    if (typeof ns.getByName === "function") return ns.getByName(name);
    return ns.get(ns.idFromName(name));
  }

  kv: StateStore["kv"] = {
    get: async <T>(key: string): Promise<T | undefined> =>
      (await this.stub(key).kvGet(key)) as T | undefined,
    set: async <T>(key: string, value: T, ttlMs?: number): Promise<void> => {
      await this.stub(key).kvSet(key, value, ttlMs);
    },
    delete: async (key: string): Promise<void> => {
      await this.stub(key).kvDelete(key);
    },
  };

  list: StateStore["list"] = {
    append: async <T>(
      key: string,
      value: T,
      opts?: { maxLen?: number; ttlMs?: number },
    ): Promise<number> => this.stub(key).listAppend(key, value, opts),
    range: async <T>(key: string, start?: number, stop?: number): Promise<T[]> =>
      (await this.stub(key).listRange(key, start, stop)) as T[],
    trim: async (key: string, maxLen: number): Promise<void> => {
      await this.stub(key).listTrim(key, maxLen);
    },
    delete: async (key: string): Promise<void> => {
      await this.stub(key).listDelete(key);
    },
  };

  lock: StateStore["lock"] = {
    acquire: async (
      key: string,
      opts?: { ttlMs?: number },
    ): Promise<{ token: string } | null> =>
      this.stub(key).lockAcquire(key, opts?.ttlMs),
    release: async (key: string, token: string): Promise<void> => {
      await this.stub(key).lockRelease(key, token);
    },
  };

  dedup: StateStore["dedup"] = {
    seen: async (key: string, ttlMs: number): Promise<boolean> =>
      this.stub(key).dedupSeen(key, ttlMs),
  };

  queue: StateStore["queue"] = {
    enqueue: async <T>(
      key: string,
      value: T,
      opts?: { maxSize?: number; onFull?: "drop-oldest" | "drop-newest" },
    ): Promise<number> => this.stub(key).queueEnqueue(key, value, opts),
    dequeue: async <T>(key: string): Promise<T | undefined> =>
      (await this.stub(key).queueDequeue(key)) as T | undefined,
    depth: async (key: string): Promise<number> => this.stub(key).queueDepth(key),
  };

  /**
   * Render-obligation client (SPEC.md §3.1 / §4.2), not part of the base
   * `StateStore` contract. Routes through the same {@link Partitioner} as
   * every other namespace here (`stub(threadKey)`), so `bot-engine.ts`
   * writing an obligation and `ConversationStateDO`'s alarm serving it always
   * land on the identical Durable Object instance.
   */
  obligation = {
    set: async (args: {
      threadKey: string;
      executionId: string;
      afterEventId: number;
      channel: string;
      threadTs?: string;
      timeoutMs?: number;
    }): Promise<void> => {
      await this.stub(args.threadKey).obligationSet(args);
    },
    clear: async (args: {
      threadKey: string;
      executionId?: string;
    }): Promise<void> => {
      await this.stub(args.threadKey).obligationClear(args);
    },
    get: async (threadKey: string): Promise<RenderObligationRow | undefined> =>
      this.stub(threadKey).obligationGet({ threadKey }),
  };
}

/**
 * Factory mirroring `createRedisStore({ url })`. Returns a `StateStore` ready to
 * hand to `createBot({ store: { adapter: createDurableObjectStore(env.BOT_STATE) } })`.
 */
export function createDurableObjectStore(
  namespace: DurableObjectNamespace<ConversationStateDO>,
  opts?: { partition?: Partitioner },
): DurableObjectStateStore {
  return new DurableObjectStateStore({ namespace, partition: opts?.partition });
}
