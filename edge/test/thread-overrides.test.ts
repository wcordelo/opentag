/**
 * Sticky thread-level model/harness/reasoning overrides (GOAL.md Phase A3,
 * SPEC §2.2 + §5 Phase A3). `resolveThreadOverrides` is the pure, unit-testable
 * helper agent-turn.ts calls; store is mocked with an in-memory Map like the
 * other tests in this suite (see test/durable-choice.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  resolveThreadOverrides,
  threadOverridesKey,
} from "../src/store/thread-overrides.js";
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
        map.set(key, { value, exp: ttlMs != null ? Date.now() + ttlMs : undefined });
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

describe("resolveThreadOverrides", () => {
  it("uses the documented sticky key shape thread:overrides:<conversationKey>", () => {
    expect(threadOverridesKey("C1::1.0")).toBe("thread:overrides:C1::1.0");
  });

  it("resolves explicit > sticky > channel > deployment per field without persisting channel defaults", async () => {
    const store = memoryStore();
    const key = "C1::1.0";
    const channelDefaults = {
      harnessType: "claudecode" as const,
      model: "claude-channel",
    };
    const channel = await resolveThreadOverrides(
      store,
      key,
      "hello",
      channelDefaults,
    );
    expect(channel).toMatchObject({
      effectiveHarnessType: "claudecode",
      effectiveModel: "claude-channel",
      harnessSource: "channel",
      modelSource: "channel",
    });
    expect(await store.kv.get(threadOverridesKey(key))).toBeUndefined();

    const explicit = await resolveThreadOverrides(
      store,
      key,
      "--opus hello",
      channelDefaults,
    );
    expect(explicit).toMatchObject({
      effectiveModel: "claude-opus-4-8",
      modelSource: "explicit",
      harnessSource: "explicit",
    });

    const sticky = await resolveThreadOverrides(
      store,
      key,
      "follow up",
      { harnessType: "claudecode", model: "claude-new-channel" },
    );
    expect(sticky).toMatchObject({
      effectiveModel: "claude-opus-4-8",
      modelSource: "sticky",
      harnessSource: "sticky",
    });

    const deployment = await resolveThreadOverrides(
      store,
      "C2::2.0",
      "hello",
    );
    expect(deployment).toMatchObject({
      harnessSource: "deployment",
      modelSource: "deployment",
    });
  });

  it("a flag on turn 1 persists to turn 2 with no flag", async () => {
    const store = memoryStore();
    const key = "C1::1.0";

    const turn1 = await resolveThreadOverrides(store, key, "--opus Hello");
    expect(turn1.effectiveModel).toBe("claude-opus-4-8");
    expect(turn1.effectiveHarnessType).toBe("claudecode");
    expect(turn1.cleanedText).toBe("Hello");
    expect(turn1.hasMessageFlags).toBe(true);

    const turn2 = await resolveThreadOverrides(store, key, "What's next?");
    expect(turn2.effectiveModel).toBe("claude-opus-4-8");
    expect(turn2.effectiveHarnessType).toBe("claudecode");
    expect(turn2.cleanedText).toBe("What's next?");
    expect(turn2.hasMessageFlags).toBe(false);

    const persisted = await store.kv.get(threadOverridesKey(key));
    expect(persisted).toMatchObject({ model: "claude-opus-4-8", harnessType: "claudecode" });
  });

  it("turn 3 with a different flag overwrites the sticky value", async () => {
    const store = memoryStore();
    const key = "C1::1.0";

    await resolveThreadOverrides(store, key, "--opus Hello");
    await resolveThreadOverrides(store, key, "No flag here");
    const turn3 = await resolveThreadOverrides(store, key, "--sonnet New direction");

    expect(turn3.effectiveModel).toBe("claude-sonnet-5");
    expect(turn3.effectiveHarnessType).toBe("claudecode");
    expect(turn3.cleanedText).toBe("New direction");

    const turn4 = await resolveThreadOverrides(store, key, "Still sonnet?");
    expect(turn4.effectiveModel).toBe("claude-sonnet-5");
  });

  it("a field absent this turn keeps the previously stored value (partial overwrite)", async () => {
    const store = memoryStore();
    const key = "C1::1.0";

    await resolveThreadOverrides(store, key, "--opus Hello");
    // This turn only sets reasoning; model/harness should be untouched.
    const turn2 = await resolveThreadOverrides(store, key, "-rsn high Think hard");

    expect(turn2.effectiveModel).toBe("claude-opus-4-8");
    expect(turn2.effectiveHarnessType).toBe("claudecode");
    expect(turn2.effectiveReasoning).toBe("high");

    const persisted = await store.kv.get<{ model?: string; reasoning?: string }>(
      threadOverridesKey(key),
    );
    expect(persisted?.model).toBe("claude-opus-4-8");
    // Reasoning is a per-turn knob (matches centaur) — never persisted.
    expect(persisted?.reasoning).toBeUndefined();
  });

  it("reasoning does not stick to later turns", async () => {
    const store = memoryStore();
    const key = "C1::1.0";
    await resolveThreadOverrides(store, key, "-rsn high Think hard");
    const turn2 = await resolveThreadOverrides(store, key, "Follow-up question");
    expect(turn2.effectiveReasoning).toBeUndefined();
  });

  it("different threads (different conversationKey) do not share sticky state", async () => {
    const store = memoryStore();
    await resolveThreadOverrides(store, "C1::1.0", "--opus Hello");
    const other = await resolveThreadOverrides(store, "C2::1.0", "Hi there");
    expect(other.effectiveModel).toBeUndefined();
  });

  it("a message with no flags and no prior sticky state resolves undefined overrides", async () => {
    const store = memoryStore();
    const result = await resolveThreadOverrides(store, "C1::1.0", "Just chatting");
    expect(result.effectiveModel).toBeUndefined();
    expect(result.effectiveHarnessType).toBeUndefined();
    expect(result.effectiveReasoning).toBeUndefined();
    expect(result.cleanedText).toBe("Just chatting");
  });

  it("store failures degrade to message-only overrides (best-effort, no throw)", async () => {
    const failingStore: StateStore = {
      ...memoryStore(),
      kv: {
        get: async () => {
          throw new Error("boom");
        },
        set: async () => {
          throw new Error("boom");
        },
        delete: async () => {},
      },
    };
    const result = await resolveThreadOverrides(failingStore, "C1::1.0", "--opus Hi");
    expect(result.effectiveModel).toBe("claude-opus-4-8");
    expect(result.cleanedText).toBe("Hi");
  });

  it("does not persist a sticky merge that would mismatch harness and model", async () => {
    const store = memoryStore();
    const key = "C1::1.0";

    await store.kv.set(threadOverridesKey(key), {
      harnessType: "claudex",
      model: "gpt-5.6-sol",
      updatedAt: Date.now(),
    });

    const result = await resolveThreadOverrides(store, key, "--claude hello");
    expect(result.effectiveHarnessType).toBe("claudecode");
    expect(result.effectiveModel).toBe("gpt-5.6-sol");

    const persisted = await store.kv.get(threadOverridesKey(key));
    expect(persisted).toMatchObject({
      harnessType: "claudex",
      model: "gpt-5.6-sol",
    });
  });
});
