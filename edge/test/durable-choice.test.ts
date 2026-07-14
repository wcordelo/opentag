/**
 * Cross-isolate HITL: persist + poll must resolve when awaitChoice waiter is absent.
 */
import { describe, it, expect, vi } from "vitest";
import type { Renderable } from "@copilotkit/channels-ui";
import {
  awaitChoiceDurable,
  cancelHitlChoice,
  clearHitlChoice,
  hitlChoiceKey,
  hitlIdKey,
  persistHitlChoice,
  pollHitlChoice,
  readHitlChoice,
} from "../src/hitl/durable-choice.js";
import type { StateStore } from "../src/store/state-store-contract.js";

function memoryStore(): StateStore {
  const map = new Map<string, { value: unknown; exp?: number }>();
  const set = (key: string, value: unknown, ttlMs?: number) => {
    map.set(key, {
      value,
      exp: ttlMs != null ? Date.now() + ttlMs : undefined,
    });
  };
  return {
    kv: {
      async get<T>(key: string) {
        const e = map.get(key);
        if (!e) return undefined;
        if (e.exp != null && Date.now() > e.exp) {
          map.delete(key);
          return undefined;
        }
        return e.value as T;
      },
      async set<T>(key: string, value: T, ttlMs?: number) {
        set(key, value, ttlMs);
      },
      async delete(key: string) {
        map.delete(key);
      },
    },
    hitl: {
      async prepareChoice(args) {
        if (map.has(args.cancelledKey)) {
          return { status: "cancelled", record: map.get(args.choiceKey)!.value };
        }
        map.delete(args.choiceKey);
        return { status: "ready" };
      },
      async consumeChoice(args) {
        const receipt = map.get(args.choiceKey);
        if (!receipt) return { status: "pending" };
        if (!map.has(args.cancelledKey)) map.delete(args.choiceKey);
        return {
          status: map.has(args.cancelledKey) ? "cancelled" : "choice",
          record: receipt.value,
        };
      },
      async persistChoiceUnlessCancelled(args) {
        if (map.has(args.cancelledKey)) return "cancelled";
        set(args.choiceKey, args.record, args.ttlMs);
        return "persisted";
      },
      async cancelChoice(args) {
        set(args.choiceKey, args.denial, args.ttlMs);
        set(args.cancelledKey, true, args.ttlMs);
      },
    },
    list: {
      async append() {
        return 0;
      },
      async range() {
        return [];
      },
      async trim() {},
      async delete() {},
    },
    lock: {
      async acquire() {
        return { token: "t" };
      },
      async release() {},
    },
    dedup: {
      async seen() {
        return false;
      },
    },
    queue: {
      async enqueue() {
        return 0;
      },
      async dequeue() {
        return undefined;
      },
      async depth() {
        return 0;
      },
    },
  };
}

const fakeUi = { type: "actions" } as Renderable;

describe("durable HITL choice", () => {
  it("preserves the id-less conversation-key fallback without the atomic extension", async () => {
    const store = memoryStore();
    delete store.hitl;
    expect(await persistHitlChoice(store, "legacy-ck", { confirmed: true }))
      .toBe("persisted");
    expect(await readHitlChoice(store, { conversationKey: "legacy-ck" }))
      .toEqual({ confirmed: true });
  });

  it("persists under choiceId even when conversationKey mismatches", async () => {
    const store = memoryStore();
    const choiceId = "choice-1";
    await persistHitlChoice(store, "wrong-ck", {
      confirmed: true,
      choiceId,
    });
    expect(await store.kv.get(hitlIdKey(choiceId))).toBeTruthy();
    expect(
      await readHitlChoice(store, { choiceId }),
    ).toEqual({ confirmed: true, choiceId });
    await clearHitlChoice(store, { choiceId, conversationKey: "wrong-ck" });
    expect(await readHitlChoice(store, { choiceId })).toBeUndefined();
    expect(await store.kv.get(hitlChoiceKey("wrong-ck"))).toBeUndefined();
  });

  it("pollHitlChoice resolves via choiceId from another isolate", async () => {
    const store = memoryStore();
    const choiceId = "choice-2";
    const pending = pollHitlChoice(store, {
      choiceId,
      conversationKey: "turn-ck",
      timeoutMs: 2_000,
      pollMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    // Click lands with a different conversationKey than the waiting turn.
    await persistHitlChoice(store, "click-ck", {
      confirmed: true,
      choiceId,
    });
    await expect(pending).resolves.toEqual({ confirmed: true, choiceId });
  });

  it("awaitChoiceDurable wins via DO when in-memory waiter never fires", async () => {
    const store = memoryStore();
    const choiceId = "choice-3";
    const thread = {
      conversationKey: "c3",
      awaitChoice: vi.fn(async (_ui: Renderable) => {
        return new Promise<never>(() => {});
      }),
    };

    const pending = awaitChoiceDurable<{ confirmed: boolean }>(
      thread,
      store,
      fakeUi,
      { choiceId, timeoutMs: 2_000, pollMs: 20, unsafeAllowMissingExecutionContextTestOnly: true },
    );

    await new Promise((r) => setTimeout(r, 40));
    expect(thread.awaitChoice).toHaveBeenCalled();
    await persistHitlChoice(store, "other-ck", { confirmed: true, choiceId });
    await expect(pending).resolves.toEqual({ confirmed: true, choiceId });
  });

  it("awaitChoiceDurable wins via memory waiter without needing DO", async () => {
    const store = memoryStore();
    const thread = {
      conversationKey: "c4",
      awaitChoice: async <T = unknown>(_ui: Renderable): Promise<T> =>
        ({ confirmed: true }) as T,
    };

    await expect(
      awaitChoiceDurable<{ confirmed: boolean }>(thread, store, fakeUi, {
        choiceId: "choice-4",
        pollMs: 20,
        unsafeAllowMissingExecutionContextTestOnly: true,
      }),
    ).resolves.toEqual({ confirmed: true });
  });

  it("fails closed before rendering when production HITL has no exact execution context", async () => {
    const store = memoryStore();
    let pickerCalls = 0;
    const thread = {
      conversationKey: "missing-exact",
      async awaitChoice<T = unknown>(): Promise<T> {
        pickerCalls += 1;
        return { confirmed: true } as T;
      },
    };
    await expect(awaitChoiceDurable(thread, store, fakeUi, {
      choiceId: "choice-missing-exact",
    })).rejects.toThrow("exact_execution_context_required_for_hitl");
    expect(pickerCalls).toBe(0);
  });

  it("can require the exact durable receipt even when the memory waiter is affirmative", async () => {
    const store = memoryStore();
    const choiceId = "choice-durable-only";
    const thread = {
      conversationKey: "durable-only",
      awaitChoice: async <T = unknown>(_ui: Renderable): Promise<T> =>
        ({ confirmed: true, choiceId }) as T,
    };
    const pending = awaitChoiceDurable<{ confirmed: boolean; choiceId: string }>(
      thread,
      store,
      fakeUi,
      { choiceId, timeoutMs: 2_000, pollMs: 5, requireDurableReceipt: true, unsafeAllowMissingExecutionContextTestOnly: true },
    );
    await new Promise((r) => setTimeout(r, 20));
    await persistHitlChoice(store, "other-isolate", { confirmed: true, choiceId });
    await expect(pending).resolves.toEqual({ confirmed: true, choiceId });
  });

  it("cancellation wakes the waiter and makes a later approval a no-op", async () => {
    const store = memoryStore();
    const choiceId = "choice-stopped";
    const pending = pollHitlChoice(store, {
      choiceId,
      conversationKey: "stopped-ck",
      timeoutMs: 2_000,
      pollMs: 5,
    });
    await cancelHitlChoice(store, {
      choiceId,
      conversationKey: "stopped-ck",
    });
    await expect(pending).resolves.toEqual({ confirmed: false, choiceId });

    await persistHitlChoice(store, "stopped-ck", {
      confirmed: true,
      choiceId,
    });
    expect(await readHitlChoice(store, { choiceId })).toEqual({
      confirmed: false,
      choiceId,
    });
  });

  it("returns a Stop-before-prepare denial immediately without posting a card", async () => {
    const store = memoryStore();
    const choiceId = "choice-stop-before-prepare";
    await cancelHitlChoice(store, { choiceId, conversationKey: "stopped" });
    const thread = {
      conversationKey: "stopped",
      awaitChoice: vi.fn(async () => new Promise<never>(() => {})),
    };

    const started = Date.now();
    await expect(awaitChoiceDurable(thread, store, fakeUi, {
      choiceId,
      timeoutMs: 600_000,
      requireDurableReceipt: true,
      unsafeAllowMissingExecutionContextTestOnly: true,
    })).resolves.toEqual({ confirmed: false, choiceId });
    expect(Date.now() - started).toBeLessThan(100);
    expect(thread.awaitChoice).not.toHaveBeenCalled();
  });

  it("does not return a stale affirmative when Stop wins before consume", async () => {
    const store = memoryStore();
    const choiceId = "choice-stop-before-consume";
    let releaseConsume!: () => void;
    const consumeGate = new Promise<void>((resolve) => { releaseConsume = resolve; });
    let enteredConsume!: () => void;
    const consumeEntered = new Promise<void>((resolve) => { enteredConsume = resolve; });
    const consume = store.hitl!.consumeChoice;
    store.hitl!.consumeChoice = async (args) => {
      enteredConsume();
      await consumeGate;
      return consume(args);
    };
    const thread = {
      conversationKey: "race",
      awaitChoice: vi.fn(async () => new Promise<never>(() => {})),
    };
    const pending = awaitChoiceDurable(thread, store, fakeUi, {
      choiceId,
      timeoutMs: 2_000,
      pollMs: 1,
      requireDurableReceipt: true,
      unsafeAllowMissingExecutionContextTestOnly: true,
    });
    await consumeEntered;
    expect(await persistHitlChoice(store, "race", {
      confirmed: true,
      choiceId,
    })).toBe("persisted");
    await cancelHitlChoice(store, { choiceId, conversationKey: "race" });
    releaseConsume();

    await expect(pending).resolves.toEqual({ confirmed: false, choiceId });
  });

  it("may consume an affirmative only when consume linearizes before later Stop", async () => {
    const store = memoryStore();
    const choiceId = "choice-consume-before-stop";
    expect(await store.hitl!.prepareChoice({
      choiceKey: hitlIdKey(choiceId),
      cancelledKey: `hitl-cancelled:${choiceId}`,
    })).toEqual({ status: "ready" });
    await persistHitlChoice(store, "race", { confirmed: true, choiceId });
    const granted = await pollHitlChoice(store, {
      choiceId,
      timeoutMs: 100,
      pollMs: 1,
      choiceIdOnly: true,
    });
    await cancelHitlChoice(store, { choiceId, conversationKey: "race" });

    expect(granted).toEqual({ confirmed: true, choiceId });
    await expect(pollHitlChoice(store, {
      choiceId,
      timeoutMs: 100,
      pollMs: 1,
      choiceIdOnly: true,
    })).resolves.toEqual({ confirmed: false, choiceId });
  });

  it("makes Stop authoritative in both exact-id click/cancel orderings", async () => {
    for (const order of ["click-first", "cancel-first"] as const) {
      const store = memoryStore();
      const choiceId = `choice-${order}`;
      if (order === "click-first") {
        expect(await persistHitlChoice(store, "ck", {
          confirmed: true,
          choiceId,
        })).toBe("persisted");
      }
      await cancelHitlChoice(store, { choiceId, conversationKey: "ck" });
      if (order === "cancel-first") {
        expect(await persistHitlChoice(store, "ck", {
          confirmed: true,
          choiceId,
        })).toBe("cancelled");
      }
      expect(await readHitlChoice(store, { choiceId })).toEqual({
        confirmed: false,
        choiceId,
      });
    }
  });

  it("fails closed for modern exact-id choices without the atomic RPC", async () => {
    const store = memoryStore();
    delete store.hitl;
    await expect(persistHitlChoice(store, "ck", {
      confirmed: true,
      choiceId: "choice-no-atomic-store",
    })).rejects.toThrow("atomic_hitl_unavailable");
    await expect(cancelHitlChoice(store, {
      choiceId: "choice-no-atomic-store",
      conversationKey: "ck",
    })).rejects.toThrow("atomic_hitl_unavailable");
  });
});
