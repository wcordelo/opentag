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
        map.set(key, {
          value,
          exp: ttlMs != null ? Date.now() + ttlMs : undefined,
        });
      },
      async delete(key: string) {
        map.delete(key);
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
      { choiceId, timeoutMs: 2_000, pollMs: 20 },
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
      }),
    ).resolves.toEqual({ confirmed: true });
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
    expect(await readHitlChoice(store, { choiceId })).toBeUndefined();
  });
});
