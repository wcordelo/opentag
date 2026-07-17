import { describe, expect, it } from "vitest";
import type { LifecycleStateStore } from "../src/store/state-store-contract.js";
import type { ActiveTurnRecord } from "../src/store/active-turn-types.js";
import {
  ACTIVE_TURN_TTL_MS,
  activeTurnDeliveryStateKey,
  claimActiveTurnCancellation,
  deliverActiveTurnOutput,
  markActiveTurnCancelConfirmed,
  markActiveTurnCancelControlled,
  registerActiveTurn,
} from "../src/slack/active-turn-registry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryStore() {
  const values = new Map<string, unknown>();
  const expiries = new Map<string, number>();
  const locks = new Map<string, string>();
  let now = 0;
  const records = new Map<string, ActiveTurnRecord>();
  const delivery = new Map<string, {
    status: "pending" | "cancelled" | "cancel_controlled";
    token?: string;
  }>();
  const store: LifecycleStateStore = {
    sessionHandoff: {
      start: async (args) => ({
        ...args,
        status: "pending",
        dueAt: now,
        attempt: 0,
        expiresAt: now + 1,
      }),
      get: async () => undefined,
      clear: async () => true,
    },
    kv: {
      get: async <T>(key: string) => {
        if ((expiries.get(key) ?? Infinity) <= now) {
          values.delete(key);
          return undefined;
        }
        return values.get(key) as T | undefined;
      },
      set: async (key: string, value: unknown, ttlMs?: number) => {
        values.set(key, value);
        if (ttlMs) expiries.set(key, now + ttlMs);
      },
      delete: async (key: string) => { values.delete(key); },
    },
    list: {
      append: async () => 0,
      range: async () => [],
      trim: async () => undefined,
      delete: async () => undefined,
    },
    lock: {
      acquire: async (key: string) => {
        if (locks.has(key)) return null;
        const token = crypto.randomUUID();
        locks.set(key, token);
        return { token };
      },
      release: async (key: string, token: string) => {
        if (locks.get(key) === token) locks.delete(key);
      },
    },
    dedup: { seen: async () => false },
    queue: {
      enqueue: async () => 0,
      dequeue: async () => undefined,
      depth: async () => 0,
    },
    obligation: {
      set: async () => undefined,
      clear: async () => undefined,
      get: async () => undefined,
    },
    activeTurn: {
      register: async (entry) => {
        const current = records.get(entry.threadKey);
        if (current) {
          return {
            accepted: false,
            duplicate: current.executionId === entry.executionId,
          };
        }
        records.set(entry.threadKey, entry);
        delivery.set(entry.threadKey, { status: "pending" });
        await store.kv.set(
          `active-turn:thread:${entry.threadKey}`,
          entry,
          ACTIVE_TURN_TTL_MS,
        );
        await store.kv.set(
          activeTurnDeliveryStateKey(entry.threadKey, entry.executionId),
          { status: "pending", updatedAt: now },
          ACTIVE_TURN_TTL_MS,
        );
        return { accepted: true, duplicate: false };
      },
      registerWithObligation: async ({ record, obligation }) => {
        const result = await store.activeTurn.register(record);
        if (result.accepted) {
          await store.obligation.set({
            threadKey: record.threadKey,
            executionId: record.executionId,
            ...obligation,
          });
        }
        return result;
      },
      refresh: async (entry) => records.get(entry.threadKey)?.executionId === entry.executionId,
      get: async (threadKey) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        return entry && state
          ? { record: entry, status: state.status, liveMessage: { state: "unreserved" }, updatedAt: now }
          : undefined;
      },
      latest: async (channelId) => {
        const entry = [...records.values()]
          .filter((candidate) => candidate.channelId === channelId)
          .sort((a, b) => b.registeredAt - a.registeredAt)[0];
        if (!entry) return undefined;
        const state = delivery.get(entry.threadKey)!;
        return { record: entry, status: state.status, liveMessage: { state: "unreserved" }, updatedAt: now };
      },
      confirmLiveMessage: async () => true,
      markLiveMessageAbsent: async () => true,
      claimCancellation: async ({ threadKey, executionId }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || !state) return "missing";
        if (state.token) return "in_flight";
        if (state.status === "cancelled" || state.status === "cancel_controlled") {
          return "retry";
        }
        state.status = "cancelled";
        return "claimed";
      },
      markCancelControlled: async ({ threadKey, executionId }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || state?.status !== "cancelled") {
          return false;
        }
        state.status = "cancel_controlled";
        return true;
      },
      beginCancelAck: async () => true,
      failCancelAck: async () => true,
      confirmCancellationAndClear: async ({ threadKey, executionId }) => {
        if (records.get(threadKey)?.executionId !== executionId) return false;
        records.delete(threadKey);
        delivery.delete(threadKey);
        return true;
      },
      beginRender: async ({ threadKey, executionId }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || !state) {
          return { status: "missing" as const };
        }
        if (state.status !== "pending") return { status: "cancelled" as const };
        if (state.token) return { status: "in_flight" as const };
        state.token = crypto.randomUUID();
        return { status: "claimed" as const, token: state.token };
      },
      confirmRender: async ({ threadKey, executionId, token, final }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || state?.token !== token) return false;
        state.token = undefined;
        if (final) {
          records.delete(threadKey);
          delivery.delete(threadKey);
        }
        return true;
      },
      failRender: async ({ threadKey, executionId, token }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || state?.token !== token) return false;
        state.token = undefined;
        return true;
      },
      beginEffect: async ({ threadKey, executionId }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || !state) {
          return { status: "missing" as const };
        }
        if (state.status !== "pending") return { status: "cancelled" as const };
        if (state.token) return { status: "in_flight" as const };
        state.token = crypto.randomUUID();
        return { status: "claimed" as const, token: state.token };
      },
      confirmEffect: async ({ threadKey, executionId, token }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || state?.token !== token) return false;
        state.token = undefined;
        return true;
      },
      failEffect: async ({ threadKey, executionId, token }) => {
        const entry = records.get(threadKey);
        const state = delivery.get(threadKey);
        if (!entry || entry.executionId !== executionId || state?.token !== token) return false;
        state.token = undefined;
        return true;
      },
      lifecycleComplete: async () => false,
      abandonPristine: async () => false,
      discardInterruptedRedelivery: async () => false,
      registerChoice: async () => "registered",
      unregisterChoice: async () => true,
      cancelRegisteredChoices: async () => [],
    },
  };
  return { store, values, advance: (ms: number) => { now += ms; } };
}

const record = {
  channelId: "C1",
  threadKey: "slack:C1:1.0",
  conversationKey: "C1::1.0",
  executionId: "exec-a",
  threadTs: "1.0",
  registeredAt: 1,
};

describe("exact active-turn delivery state machine", () => {
  it("suppresses completion when Stop durably claims pending delivery", async () => {
    const { store } = memoryStore();
    await registerActiveTurn(store, record);
    expect(await claimActiveTurnCancellation(store, record)).toBe("claimed");
    expect(await deliverActiveTurnOutput(store, record, async () => {
      throw new Error("must not deliver");
    })).toBe("cancelled");
    expect(await markActiveTurnCancelControlled(store, record)).toBe(true);
    expect(await markActiveTurnCancelConfirmed(store, record)).toBe(true);
  });

  it("does not hold a lease across a stalled Slack delivery", async () => {
    const { store } = memoryStore();
    await registerActiveTurn(store, record);
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const delivery = deliverActiveTurnOutput(store, record, async () => {
      entered.resolve();
      await release.promise;
      order.push("success");
    });
    await entered.promise;

    // The delivery lock has already been released. Stop observes the durable
    // irreversible state and must not claim/acknowledge cancellation, even if
    // Slack remains stalled longer than the former 30-second lease.
    expect(await claimActiveTurnCancellation(store, record)).toBe("render_in_flight");
    release.resolve();
    await expect(delivery).resolves.toBe("delivered");
    expect(order).toEqual(["success"]);
  });

  it("keeps exact routing and delivery state beyond a 20-minute turn", async () => {
    const { store, advance } = memoryStore();
    await registerActiveTurn(store, record);
    advance(21 * 60_000);
    expect(ACTIVE_TURN_TTL_MS).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(await store.kv.get(`active-turn:thread:${record.threadKey}`))
      .toMatchObject({ executionId: record.executionId });
    expect(await store.kv.get(activeTurnDeliveryStateKey(
      record.threadKey,
      record.executionId,
    ))).toMatchObject({ status: "pending" });
    expect(await claimActiveTurnCancellation(store, record)).toBe("claimed");
    expect(await deliverActiveTurnOutput(store, record, async () => undefined))
      .toBe("cancelled");
  });

  it("keeps concurrent execution ids independent", async () => {
    const { store } = memoryStore();
    expect(await claimActiveTurnCancellation(store, record)).toBe("committed");
    const other = {
      ...record,
      threadKey: "slack:C1:2.0",
      executionId: "exec-b",
    };
    await registerActiveTurn(store, other);
    expect(await deliverActiveTurnOutput(store, other, async () => undefined))
      .toBe("delivered");
  });
});
