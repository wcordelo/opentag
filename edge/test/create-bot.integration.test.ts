/**
 * Integration test against real `@copilotkit/channels` createBot + Sqlite store.
 */
import { describe, it, expect } from "vitest";
import { createBot, FakeAdapter, FakeAgent } from "@copilotkit/channels";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

describe("createBot integration (@copilotkit/channels)", () => {
  it("drives the SQLite StateStore: lock, dedup, thread state", async () => {
    const { store } = makeSqliteStateStore();
    const adapter = new FakeAdapter();
    const instance = createBot({
      adapters: [adapter],
      agent: () => new FakeAgent([]),
      store: { adapter: store },
    });

    instance.onMention(async ({ thread }) => {
      const prev = ((await thread.state()) as { hits?: number } | undefined) ?? {
        hits: 0,
      };
      await thread.setState({ hits: (prev.hits ?? 0) + 1 });
    });

    await instance.start();
    const sink = adapter.getSink();

    await sink.onTurn({
      conversationKey: "C1",
      replyTarget: { channel: "C1" },
      userText: "hi",
      platform: "fake",
      eventId: "e1",
    });
    expect(await store.kv.get("threadstate:C1")).toEqual({ hits: 1 });

    const lk = await store.lock.acquire("turn:C1");
    expect(lk).not.toBeNull();
    if (lk) await store.lock.release("turn:C1", lk.token);

    await sink.onTurn({
      conversationKey: "C1",
      replyTarget: { channel: "C1" },
      userText: "again",
      platform: "fake",
      eventId: "e1",
    });
    expect(await store.kv.get("threadstate:C1")).toEqual({ hits: 1 });

    await sink.onTurn({
      conversationKey: "C1",
      replyTarget: { channel: "C1" },
      userText: "more",
      platform: "fake",
      eventId: "e2",
    });
    expect(await store.kv.get("threadstate:C1")).toEqual({ hits: 2 });

    await instance.stop();
  });
});
