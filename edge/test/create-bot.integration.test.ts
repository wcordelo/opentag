import { describe, it, expect } from "vitest";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

/**
 * Integration test against the REAL `@copilotkit/bot` `createBot`, proving the
 * store is driven correctly by the actual engine (turn lock, event dedup,
 * `thread.setState`) — not just the StateStore contract in isolation.
 *
 * It auto-skips when `@copilotkit/bot` can't be resolved (the default today —
 * the packages aren't co-installable from npm yet; see README "Upstream status").
 * It becomes a live test the moment the package is installable (e.g. run inside
 * the CopilotKit monorepo, or once a coherent 0.1.x set publishes). The exact
 * flow was verified against `@copilotkit/bot@0.1.0` built from source:
 *
 *   PASS  thread.setState persisted to StateStore.kv
 *   PASS  turn lock released after turn
 *   PASS  duplicate eventId deduped via StateStore.dedup
 *   PASS  distinct eventId runs again (state advances)
 *
 * The store here is backed by the SAME `SqlStateEngine` the Durable Object runs;
 * `store.workers.test.ts` proves that engine in workerd, so the two together
 * cover: real engine in the real runtime + real bot driving the real contract.
 */

// Computed specifiers so the bundler/tsc don't try to statically resolve a
// package that isn't a dependency of this workspace.
const BOT = "@copilotkit/" + "bot";
const FAKE_ADAPTER = BOT + "/testing/fake-adapter";
const FAKE_AGENT = BOT + "/testing/fake-agent";

async function tryImport(spec: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ spec);
  } catch {
    return undefined;
  }
}

const bot = await tryImport(BOT);
const adapterMod = bot ? await tryImport(FAKE_ADAPTER) : undefined;
const agentMod = bot ? await tryImport(FAKE_AGENT) : undefined;
const available = Boolean(bot && adapterMod && agentMod);

describe.skipIf(!available)("createBot integration (real @copilotkit/bot)", () => {
  it("drives the SQLite StateStore: lock, dedup, thread state", async () => {
    // Loosely typed: these come from a dynamically-resolved optional package.
    const { createBot } = bot as { createBot: (o: unknown) => any };
    const { FakeAdapter } = adapterMod as { FakeAdapter: new () => any };
    const { FakeAgent } = agentMod as { FakeAgent: new (s: unknown[]) => any };

    const { store } = makeSqliteStateStore();
    const adapter = new FakeAdapter();
    const instance = createBot({
      adapters: [adapter],
      agent: () => new FakeAgent([]),
      store: { adapter: store },
    });

    instance.onMention(async ({ thread }: { thread: any }) => {
      const prev = (await thread.state()) ?? { hits: 0 };
      await thread.setState({ hits: prev.hits + 1 });
    });

    await instance.start();
    const sink = adapter.getSink();

    await sink.onTurn({ conversationKey: "C1", replyTarget: {}, userText: "hi", platform: "fake", eventId: "e1" });
    expect(await store.kv.get("threadstate:C1")).toEqual({ hits: 1 });

    const lk = await store.lock.acquire("turn:C1");
    expect(lk).not.toBeNull();
    if (lk) await store.lock.release("turn:C1", lk.token);

    // Duplicate eventId is dropped (state unchanged).
    await sink.onTurn({ conversationKey: "C1", replyTarget: {}, userText: "again", platform: "fake", eventId: "e1" });
    expect(await store.kv.get("threadstate:C1")).toEqual({ hits: 1 });

    // Distinct eventId runs again.
    await sink.onTurn({ conversationKey: "C1", replyTarget: {}, userText: "more", platform: "fake", eventId: "e2" });
    expect(await store.kv.get("threadstate:C1")).toEqual({ hits: 2 });

    await instance.stop();
  });
});
