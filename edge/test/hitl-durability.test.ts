/**
 * HITL durability: ActionStore snapshots in StateStore.kv survive bot restart.
 */
import { describe, it, expect } from "vitest";
import { createBot, FakeAdapter, FakeAgent } from "@copilotkit/channels";
import type { BotNode } from "@copilotkit/channels-ui";
import { Actions, Button } from "@copilotkit/channels-ui";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function findNode(nodes: BotNode[] | BotNode, type: string): BotNode | undefined {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    if (n.type === type) return n;
    const kids = (n.props as { children?: unknown } | undefined)?.children;
    if (Array.isArray(kids)) {
      const found = findNode(kids as BotNode[], type);
      if (found) return found;
    } else if (kids && typeof kids === "object" && "type" in (kids as object)) {
      const found = findNode(kids as BotNode, type);
      if (found) return found;
    }
  }
  return undefined;
}

describe("HITL ActionStore durability", () => {
  it("persists action snapshot to StateStore and keeps it after recreate", async () => {
    const { store } = makeSqliteStateStore();
    const adapter = new FakeAdapter();
    const bot = createBot({
      adapters: [adapter],
      agent: () => new FakeAgent([]),
      store: { adapter: store },
    });

    let choicePromise: Promise<unknown> | undefined;
    bot.onMention(async ({ thread }) => {
      // Match upstream create-bot.test pattern (function-call IR, not jsx).
      choicePromise = thread.awaitChoice(
        Actions({
          children: [
            Button({
              value: { confirmed: true },
              onClick: () => {},
              children: "Confirm",
            }),
          ],
        }),
      );
    });

    await bot.start();
    adapter.emitTurn({ userText: "decide", conversationKey: "c1" });
    await tick();

    expect(adapter.posted.length).toBeGreaterThan(0);
    const button = findNode(adapter.posted[0]!, "button");
    expect(button).toBeTruthy();
    const actionId = (button!.props.onClick as { id?: string } | undefined)?.id;
    expect(actionId).toBeTruthy();

    const snap = await store.kv.get(`action:${actionId}`);
    expect(snap).toBeTruthy();

    adapter.emitInteraction({
      id: actionId!,
      conversationKey: "c1",
      value: { confirmed: true },
    });
    await tick();
    expect(choicePromise).toBeDefined();
    await expect(choicePromise!).resolves.toEqual({ confirmed: true });

    await bot.stop();

    const adapter2 = new FakeAdapter();
    const bot2 = createBot({
      adapters: [adapter2],
      agent: () => new FakeAgent([]),
      store: { adapter: store },
    });
    await bot2.start();
    expect(await store.kv.get(`action:${actionId}`)).toBeTruthy();
    await bot2.stop();
  });
});
