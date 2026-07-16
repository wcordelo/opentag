import type {
  LifecycleStateStore,
  StateStore,
} from "../../src/store/state-store-contract.js";
import {
  activeTurnDeliveryCancellationKey,
  ACTIVE_TURN_TTL_MS,
} from "../../src/slack/active-turn-registry.js";
import type {
  ActiveTurnRecord,
  ActiveTurnSnapshot,
} from "../../src/store/active-turn-types.js";

type OptionalObligation = {
  set(args: Parameters<LifecycleStateStore["obligation"]["set"]>[0]): Promise<void>;
  clear(args: Parameters<LifecycleStateStore["obligation"]["clear"]>[0]): Promise<void>;
  get(threadKey: string): ReturnType<LifecycleStateStore["obligation"]["get"]>;
};

/**
 * Explicit in-memory lifecycle adapter for unit tests that intentionally do
 * not boot ConversationStateDO. Production code must use
 * DurableObjectStateStore; keeping this adapter under test/helpers prevents a
 * plain StateStore from silently disabling render/cancellation fencing.
 */
export function withTestLifecycleStore<T extends StateStore>(
  base: T,
): T & LifecycleStateStore {
  const existingObligation = (base as T & { obligation?: OptionalObligation }).obligation;
  const obligations = new Map<
    string,
    Awaited<ReturnType<LifecycleStateStore["obligation"]["get"]>>
  >();
  const obligation: LifecycleStateStore["obligation"] = existingObligation ?? {
    set: async (args) => {
      obligations.set(args.threadKey, {
        ...args,
        deadline: Date.now() + (args.timeoutMs ?? ACTIVE_TURN_TTL_MS),
        attempt: 0,
      });
    },
    clear: async ({ threadKey, executionId }) => {
      if (!executionId || obligations.get(threadKey)?.executionId === executionId) {
        obligations.delete(threadKey);
      }
    },
    get: async (threadKey) => obligations.get(threadKey),
  };

  const rows = new Map<string, ActiveTurnSnapshot>();
  const renderTokens = new Map<string, string>();
  const effectTokens = new Map<string, string>();
  const choices = new Map<string, Set<string>>();
  let tokenSequence = 0;
  const exact = (threadKey: string, executionId: string) => {
    const row = rows.get(threadKey);
    return row?.record.executionId === executionId ? row : undefined;
  };
  const clear = async (threadKey: string, executionId: string) => {
    rows.delete(threadKey);
    renderTokens.delete(threadKey);
    effectTokens.delete(threadKey);
    choices.delete(threadKey);
    await obligation.clear({ threadKey, executionId });
  };

  const activeTurn: LifecycleStateStore["activeTurn"] = {
    register: async (record) => {
      const current = rows.get(record.threadKey);
      if (current) {
        return {
          accepted: false,
          duplicate: current.record.executionId === record.executionId,
        };
      }
      rows.set(record.threadKey, {
        record,
        status: "pending",
        liveMessage: {
          state: record.liveClientMessageId ? "reserved" : "unreserved",
          ...(record.liveClientMessageId
            ? { clientMessageId: record.liveClientMessageId }
            : {}),
        },
        updatedAt: Date.now(),
      });
      return { accepted: true, duplicate: false };
    },
    registerWithObligation: async ({ record, obligation: args }) => {
      const registered = await activeTurn.register(record);
      if (registered.accepted) {
        await obligation.set({
          threadKey: record.threadKey,
          executionId: record.executionId,
          ...args,
        });
      }
      return registered;
    },
    refresh: async (record) => Boolean(exact(record.threadKey, record.executionId)),
    get: async (threadKey) => rows.get(threadKey),
    confirmLiveMessage: async ({ threadKey, executionId, clientMessageId, ts }) => {
      const row = exact(threadKey, executionId);
      if (row?.liveMessage.clientMessageId !== clientMessageId) return false;
      row.liveMessage = { state: "posted", clientMessageId, ts };
      return true;
    },
    markLiveMessageAbsent: async ({ threadKey, executionId, clientMessageId }) => {
      const row = exact(threadKey, executionId);
      if (
        row?.liveMessage.clientMessageId !== clientMessageId ||
        row.liveMessage.state !== "reserved"
      ) return false;
      row.liveMessage = { state: "absent", clientMessageId };
      return true;
    },
    latest: async (channelId) => [...rows.values()]
      .filter((row) => row.record.channelId === channelId)
      .sort((a, b) => b.record.registeredAt - a.record.registeredAt)[0],
    claimCancellation: async ({ threadKey, executionId, stopEventId }) => {
      const row = exact(threadKey, executionId);
      if (!row) return "missing";
      if (renderTokens.has(threadKey) || effectTokens.has(threadKey)) {
        row.stopEventId ??= stopEventId;
        return effectTokens.has(threadKey) ? "effect_in_flight" : "in_flight";
      }
      if (row.status === "cancelled" || row.status === "cancel_controlled") {
        return "retry";
      }
      if (row.status !== "pending") return "committed";
      row.status = "cancelled";
      row.stopEventId = stopEventId;
      row.updatedAt = Date.now();
      return "claimed";
    },
    markCancelControlled: async ({ threadKey, executionId }) => {
      const row = exact(threadKey, executionId);
      if (!row || (row.status !== "cancelled" && row.status !== "cancel_controlled")) {
        return false;
      }
      row.status = "cancel_controlled";
      row.updatedAt = Date.now();
      return true;
    },
    beginCancelAck: async ({ threadKey, executionId }) =>
      exact(threadKey, executionId)?.status === "cancel_controlled",
    failCancelAck: async ({ threadKey, executionId }) =>
      exact(threadKey, executionId)?.status === "cancel_controlled",
    confirmCancellationAndClear: async ({ threadKey, executionId }) => {
      if (!exact(threadKey, executionId)) return false;
      await clear(threadKey, executionId);
      return true;
    },
    beginRender: async ({ threadKey, executionId }) => {
      let row = exact(threadKey, executionId);
      // Direct agent-turn unit tests bypass the production lifecycle wrapper;
      // explicitly admit their output-only fence inside this test adapter.
      if (!row) {
        const cancelled = await base.kv.get(
          activeTurnDeliveryCancellationKey(threadKey, executionId),
        );
        if (cancelled) return { status: "cancelled" };
        const record: ActiveTurnRecord = {
          channelId: "test",
          threadKey,
          conversationKey: "test",
          executionId,
          registeredAt: Date.now(),
        };
        const created: ActiveTurnSnapshot = {
          record,
          status: "pending",
          liveMessage: { state: "unreserved" },
          updatedAt: Date.now(),
        };
        rows.set(threadKey, created);
        row = created;
      }
      if (row.status !== "pending" || row.stopEventId) return { status: "cancelled" };
      if (renderTokens.has(threadKey)) return { status: "in_flight" };
      const token = `test-render-${++tokenSequence}`;
      renderTokens.set(threadKey, token);
      return { status: "claimed", token };
    },
    confirmRender: async ({ threadKey, executionId, token, final, output }) => {
      const row = exact(threadKey, executionId);
      if (!row || renderTokens.get(threadKey) !== token) return false;
      renderTokens.delete(threadKey);
      void output;
      row.updatedAt = Date.now();
      if (!final && row.stopEventId) row.status = "cancelled";
      if (final) await clear(threadKey, executionId);
      return true;
    },
    failRender: async ({ threadKey, executionId, token }) => {
      if (!exact(threadKey, executionId) || renderTokens.get(threadKey) !== token) {
        return false;
      }
      renderTokens.delete(threadKey);
      return true;
    },
    beginEffect: async ({ threadKey, executionId, effectName }) => {
      const row = exact(threadKey, executionId);
      if (!row) return { status: "missing" };
      if (row.status !== "pending" || row.stopEventId) return { status: "cancelled" };
      if (renderTokens.has(threadKey) || effectTokens.has(threadKey)) {
        return { status: "in_flight" };
      }
      const token = `test-effect-${++tokenSequence}`;
      effectTokens.set(threadKey, token);
      row.effectToken = token;
      row.effectName = effectName;
      return { status: "claimed", token };
    },
    confirmEffect: async ({ threadKey, executionId, token }) => {
      const row = exact(threadKey, executionId);
      if (!row || effectTokens.get(threadKey) !== token) return false;
      effectTokens.delete(threadKey);
      delete row.effectToken;
      delete row.effectName;
      if (row.stopEventId) row.status = "cancelled";
      return true;
    },
    failEffect: async ({ threadKey, executionId, token }) => {
      const row = exact(threadKey, executionId);
      if (!row || effectTokens.get(threadKey) !== token) return false;
      effectTokens.delete(threadKey);
      delete row.effectToken;
      delete row.effectName;
      return true;
    },
    lifecycleComplete: async ({ threadKey, executionId }) => {
      if (!exact(threadKey, executionId)) return false;
      await clear(threadKey, executionId);
      return true;
    },
    abandonPristine: async ({ threadKey, executionId }) => {
      const row = exact(threadKey, executionId);
      if (
        !row || row.status !== "pending" || row.renderToken || row.effectToken ||
        row.stopEventId
      ) return false;
      await clear(threadKey, executionId);
      return true;
    },
    discardInterruptedRedelivery: async ({ threadKey, executionId }) => {
      if (!exact(threadKey, executionId)) return false;
      await clear(threadKey, executionId);
      return true;
    },
    registerChoice: async ({ threadKey, executionId, choiceId }) => {
      const row = exact(threadKey, executionId);
      if (!row) return "missing";
      if (row.status !== "pending") return "cancelled";
      const owned = choices.get(threadKey) ?? new Set<string>();
      owned.add(choiceId);
      choices.set(threadKey, owned);
      return "registered";
    },
    unregisterChoice: async ({ threadKey, executionId, choiceId }) =>
      Boolean(exact(threadKey, executionId) && choices.get(threadKey)?.delete(choiceId)),
    cancelRegisteredChoices: async ({ threadKey, executionId }) => {
      if (!exact(threadKey, executionId)) return [];
      const result = [...(choices.get(threadKey) ?? [])];
      choices.delete(threadKey);
      for (const choiceId of result) {
        await base.hitl?.cancelChoice({
          choiceKey: `hitl-id:${choiceId}`,
          cancelledKey: `hitl-cancelled:${choiceId}`,
          denial: {
            value: { confirmed: false, choiceId },
            at: Date.now(),
          },
          ttlMs: 10 * 60_000,
        });
      }
      return result;
    },
  };

  const handoffs = new Map<string, Awaited<
    ReturnType<LifecycleStateStore["sessionHandoff"]["start"]>
  >>();
  const sessionHandoff: LifecycleStateStore["sessionHandoff"] = {
    start: async (args) => {
      const existing = handoffs.get(args.threadKey);
      if (existing) return existing;
      const now = Date.now();
      const row = {
        ...args,
        status: "pending" as const,
        dueAt: now + (args.delayMs ?? 0),
        attempt: 0,
        expiresAt: now + 24 * 60 * 60_000,
      };
      handoffs.set(args.threadKey, row);
      return row;
    },
    get: async (threadKey) => handoffs.get(threadKey),
    clear: async ({ threadKey, executionId }) => {
      if (handoffs.get(threadKey)?.executionId !== executionId) return false;
      return handoffs.delete(threadKey);
    },
  };

  return Object.assign(base, { obligation, activeTurn, sessionHandoff });
}
