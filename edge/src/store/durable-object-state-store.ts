import type {
  DurableObjectNamespace,
  DurableObjectStub,
} from "@cloudflare/workers-types";
import type { LifecycleStateStore, StateStore } from "./state-store-contract.js";
import type {
  ConversationStateDO,
  RenderObligationRow,
} from "./conversation-state-do.js";
import { singleGlobal, type Partitioner } from "./partition.js";
import type { ActiveTurnEffectResource, ActiveTurnRecord } from "./active-turn-types.js";

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
const LIFECYCLE_DO_NAME = "opentag-global-lifecycle-v1";

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
export class DurableObjectStateStore implements LifecycleStateStore {
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

  /**
   * Active-turn routing, channel-latest lookup, and render obligations are one
   * correctness domain. Keep them in a dedicated global DO even when callers
   * select a sharded partitioner for ordinary StateStore keys.
   */
  private lifecycleStub(): Stub {
    const ns = this.ns as DurableObjectNamespace<ConversationStateDO> & {
      getByName?: (n: string) => Stub;
    };
    if (typeof ns.getByName === "function") return ns.getByName(LIFECYCLE_DO_NAME);
    return ns.get(ns.idFromName(LIFECYCLE_DO_NAME));
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

  hitl: NonNullable<StateStore["hitl"]> = {
    prepareChoice: async (args) =>
      this.lifecycleStub().hitlPrepareChoice(args),
    consumeChoice: async (args) =>
      this.lifecycleStub().hitlConsumeChoice(args),
    persistChoiceUnlessCancelled: async (args) =>
      this.lifecycleStub().hitlPersistChoiceUnlessCancelled(args),
    cancelChoice: async (args): Promise<void> => {
      await this.lifecycleStub().hitlCancelChoice(args);
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

  readonly sessionHandoff: LifecycleStateStore["sessionHandoff"] = {
    start: async (args) => this.lifecycleStub().sessionHandoffStart(args),
    get: async (threadKey) => this.lifecycleStub().sessionHandoffGet({ threadKey }),
    clear: async (args) => this.lifecycleStub().sessionHandoffClear(args),
  };

  /**
   * Render-obligation client (SPEC.md §3.1 / §4.2), not part of the base
   * `StateStore` contract. Routes through the same {@link Partitioner} as
   * every other namespace here (`stub(threadKey)`), so `bot-engine.ts`
   * writing an obligation and every active-turn/channel index always land on
   * the dedicated lifecycle Durable Object, independent of the KV partitioner.
   */
  obligation = {
    set: async (args: {
      threadKey: string;
      executionId: string;
      afterEventId: number;
      channel: string;
      threadTs?: string;
      liveClientMessageId?: string;
      timeoutMs?: number;
    }): Promise<void> => {
      await this.lifecycleStub().obligationSet(args);
    },
    clear: async (args: {
      threadKey: string;
      executionId?: string;
    }): Promise<void> => {
      await this.lifecycleStub().obligationClear(args);
    },
    get: async (threadKey: string): Promise<RenderObligationRow | undefined> =>
      this.lifecycleStub().obligationGet({ threadKey }),
  };

  /** Transactional exact-turn state machine; each method is one DO RPC. */
  readonly activeTurn = {
    register: async (record: ActiveTurnRecord) =>
      this.lifecycleStub().activeTurnRegister(record),
    registerWithObligation: async (args: {
      record: ActiveTurnRecord;
      obligation: {
        afterEventId: number;
        channel: string;
        threadTs?: string;
        liveClientMessageId?: string;
        liveMessageTs?: string;
        liveMessageState: "unreserved" | "reserved" | "posted" | "absent";
        timeoutMs: number;
      };
    }) => this.lifecycleStub().activeTurnRegisterWithObligation(args),
    refresh: async (record: ActiveTurnRecord) =>
      this.lifecycleStub().activeTurnRefresh(record),
    get: async (threadKey: string) =>
      this.lifecycleStub().activeTurnGet({ threadKey }),
    confirmLiveMessage: async (args: {
      threadKey: string; executionId: string; clientMessageId: string; ts: string;
    }) => this.lifecycleStub().activeTurnConfirmLiveMessage(args),
    markLiveMessageAbsent: async (args: {
      threadKey: string; executionId: string; clientMessageId: string;
    }) => this.lifecycleStub().activeTurnMarkLiveMessageAbsent(args),
    latest: async (channelId: string) =>
      this.lifecycleStub().activeTurnLatest({ channelId }),
    registerChoice: async (args: {
      threadKey: string; executionId: string; choiceId: string;
    }) => this.lifecycleStub().activeTurnRegisterChoice(args),
    unregisterChoice: async (args: {
      threadKey: string; executionId: string; choiceId: string;
    }) => this.lifecycleStub().activeTurnUnregisterChoice(args),
    cancelRegisteredChoices: async (args: {
      threadKey: string; executionId: string;
    }) => this.lifecycleStub().activeTurnCancelRegisteredChoices(args),
    claimCancellation: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => this.lifecycleStub().activeTurnClaimCancellation(args),
    markCancelControlled: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => this.lifecycleStub().activeTurnMarkCancelControlled(args),
    beginCancelAck: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => this.lifecycleStub().activeTurnBeginCancelAck(args),
    failCancelAck: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => this.lifecycleStub().activeTurnFailCancelAck(args),
    confirmCancellationAndClear: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => this.lifecycleStub().activeTurnConfirmCancellationAndClear(args),
    beginRender: async (args: { threadKey: string; executionId: string }) =>
      this.lifecycleStub().activeTurnBeginRender(args),
    confirmRender: async (args: {
      threadKey: string; executionId: string; token: string; final: boolean; output: boolean;
    }) => this.lifecycleStub().activeTurnConfirmRender(args),
    failRender: async (args: {
      threadKey: string; executionId: string; token: string;
    }) => this.lifecycleStub().activeTurnFailRender(args),
    beginEffect: async (args: {
      threadKey: string; executionId: string; effectName: string;
    }) => this.lifecycleStub().activeTurnBeginEffect(args),
    confirmEffect: async (args: {
      threadKey: string; executionId: string; token: string; resource?: ActiveTurnEffectResource;
    }) => this.lifecycleStub().activeTurnConfirmEffect(args),
    failEffect: async (args: {
      threadKey: string; executionId: string; token: string;
    }) => this.lifecycleStub().activeTurnFailEffect(args),
    lifecycleComplete: async (args: { threadKey: string; executionId: string }) =>
      this.lifecycleStub().activeTurnLifecycleComplete(args),
    abandonPristine: async (args: { threadKey: string; executionId: string }) =>
      this.lifecycleStub().activeTurnAbandonPristine(args),
    discardInterruptedRedelivery: async (args: {
      threadKey: string; executionId: string;
    }) => this.lifecycleStub().activeTurnDiscardInterruptedRedelivery(args),
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
