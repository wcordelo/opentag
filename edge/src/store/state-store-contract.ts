/**
 * The `StateStore` contract, mirrored from `@copilotkit/channels`
 * (`src/state/state-store.ts`).
 *
 * We keep a local copy so this Worker package type-checks standalone. Because
 * TypeScript is structural, a {@link DurableObjectStateStore} that satisfies
 * *this* interface is also assignable to
 * `createBot({ store: { adapter } })`'s `StateStore`. Keep in sync with upstream.
 *
 * JSON-serialization contract: all values round-trip through `JSON.stringify` /
 * `JSON.parse` on remote backends, so `T` must be JSON-serializable.
 */
import type {
  ActiveTurnCancellationResult,
  ActiveTurnEffectResource,
  ActiveTurnRecord,
  ActiveTurnRenderClaim,
  ActiveTurnSnapshot,
} from "./active-turn-types.js";
import type { SessionHandoffRow } from "./session-handoff-engine.js";

export interface StateStore {
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
    delete(key: string): Promise<void>;
  };
  list: {
    append<T>(
      key: string,
      value: T,
      opts?: { maxLen?: number; ttlMs?: number },
    ): Promise<number>;
    range<T>(key: string, start?: number, stop?: number): Promise<T[]>;
    trim(key: string, maxLen: number): Promise<void>;
    delete(key: string): Promise<void>;
  };
  lock: {
    acquire(
      key: string,
      opts?: { ttlMs?: number },
    ): Promise<{ token: string } | null>;
    release(key: string, token: string): Promise<void>;
  };
  dedup: {
    seen(key: string, ttlMs: number): Promise<boolean>;
  };
  queue: {
    enqueue<T>(
      key: string,
      value: T,
      opts?: { maxSize?: number; onFull?: "drop-oldest" | "drop-newest" },
    ): Promise<number>;
    dequeue<T>(key: string): Promise<T | undefined>;
    depth(key: string): Promise<number>;
  };
  /**
   * Optional durable HITL transaction surface. The Durable Object adapter
   * implements each method as one RPC and one SQLite transaction so a Stop
   * tombstone and an affirmative click cannot race through separate kv calls.
   * Other StateStore implementations may omit it; id-less legacy choices keep
   * using the base kv contract.
   */
  hitl?: {
    prepareChoice(args: {
      choiceKey: string;
      cancelledKey: string;
    }): Promise<
      | { status: "ready" }
      | { status: "cancelled"; record: unknown }
    >;
    consumeChoice(args: {
      choiceKey: string;
      cancelledKey: string;
    }): Promise<
      | { status: "pending" }
      | { status: "choice" | "cancelled"; record: unknown }
    >;
    persistChoiceUnlessCancelled(args: {
      choiceKey: string;
      cancelledKey: string;
      record: unknown;
      ttlMs: number;
    }): Promise<"persisted" | "cancelled">;
    cancelChoice(args: {
      choiceKey: string;
      cancelledKey: string;
      denial: unknown;
      ttlMs: number;
    }): Promise<void>;
  };
}

/**
 * The durable state machine required by every production Slack turn.
 *
 * This is deliberately separate from the upstream-compatible {@link StateStore}:
 * active-turn ownership and its render obligation must live in the same
 * transactional Durable Object.  Accepting a plain StateStore at a delivery
 * fence would make a missing production binding silently degrade to unfenced
 * KV bookkeeping.
 */
export interface LifecycleStateStore extends StateStore {
  sessionHandoff: {
    start(args: {
      threadKey: string;
      executionId: string;
      forwardedMessageId: string;
      inputLines: string[];
      delayMs?: number;
    }): Promise<SessionHandoffRow>;
    get(threadKey: string): Promise<SessionHandoffRow | undefined>;
    clear(args: { threadKey: string; executionId: string }): Promise<boolean>;
  };
  obligation: {
    set(args: {
      threadKey: string;
      executionId: string;
      afterEventId: number;
      channel: string;
      threadTs?: string;
      liveClientMessageId?: string;
      timeoutMs?: number;
    }): Promise<void>;
    clear(args: { threadKey: string; executionId?: string }): Promise<void>;
    get(threadKey: string): Promise<
      | {
          threadKey: string;
          executionId: string;
          afterEventId: number;
          channel: string;
          threadTs?: string;
          deadline: number;
          attempt: number;
        }
      | undefined
    >;
  };
  activeTurn: {
    register(record: ActiveTurnRecord): Promise<{ accepted: boolean; duplicate: boolean }>;
    registerWithObligation(args: {
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
    }): Promise<{ accepted: boolean; duplicate: boolean }>;
    refresh(record: ActiveTurnRecord): Promise<boolean>;
    get(threadKey: string): Promise<ActiveTurnSnapshot | undefined>;
    confirmLiveMessage(args: {
      threadKey: string;
      executionId: string;
      clientMessageId: string;
      ts: string;
    }): Promise<boolean>;
    markLiveMessageAbsent(args: {
      threadKey: string;
      executionId: string;
      clientMessageId: string;
    }): Promise<boolean>;
    latest(channelId: string): Promise<ActiveTurnSnapshot | undefined>;
    claimCancellation(args: {
      threadKey: string;
      executionId: string;
      stopEventId: string;
    }): Promise<ActiveTurnCancellationResult>;
    markCancelControlled(args: {
      threadKey: string;
      executionId: string;
      stopEventId: string;
    }): Promise<boolean>;
    beginCancelAck(args: {
      threadKey: string;
      executionId: string;
      stopEventId: string;
    }): Promise<boolean>;
    failCancelAck(args: {
      threadKey: string;
      executionId: string;
      stopEventId: string;
    }): Promise<boolean>;
    confirmCancellationAndClear(args: {
      threadKey: string;
      executionId: string;
      stopEventId: string;
    }): Promise<boolean>;
    beginRender(args: {
      threadKey: string;
      executionId: string;
    }): Promise<ActiveTurnRenderClaim>;
    confirmRender(args: {
      threadKey: string;
      executionId: string;
      token: string;
      final: boolean;
      output: boolean;
    }): Promise<boolean>;
    failRender(args: {
      threadKey: string;
      executionId: string;
      token: string;
    }): Promise<boolean>;
    beginEffect(args: {
      threadKey: string;
      executionId: string;
      effectName: string;
    }): Promise<ActiveTurnRenderClaim>;
    confirmEffect(args: {
      threadKey: string;
      executionId: string;
      token: string;
      resource?: ActiveTurnEffectResource;
    }): Promise<boolean>;
    failEffect(args: {
      threadKey: string;
      executionId: string;
      token: string;
    }): Promise<boolean>;
    lifecycleComplete(args: {
      threadKey: string;
      executionId: string;
    }): Promise<boolean>;
    abandonPristine(args: {
      threadKey: string;
      executionId: string;
    }): Promise<boolean>;
    discardInterruptedRedelivery(args: {
      threadKey: string;
      executionId: string;
    }): Promise<boolean>;
    registerChoice(args: {
      threadKey: string;
      executionId: string;
      choiceId: string;
    }): Promise<"registered" | "cancelled" | "missing">;
    unregisterChoice(args: {
      threadKey: string;
      executionId: string;
      choiceId: string;
    }): Promise<boolean>;
    cancelRegisteredChoices(args: {
      threadKey: string;
      executionId: string;
    }): Promise<string[]>;
  };
}
