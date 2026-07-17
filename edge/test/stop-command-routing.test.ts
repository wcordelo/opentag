/**
 * Unit tests for stop-command routing (GOAL.md Phase A2 Task 1).
 *
 * `extractStopCommandEvent` is pure and tested directly. `handleStopCommand`
 * is exercised against fake `BOT_STATE` / `SESSION_EVENTS` Durable Object
 * namespaces (same "fake namespace with idFromName + get" shape used by
 * `test/render-obligation.test.ts`'s `makeFakeSessionEvents`) plus a mocked
 * `fetch`, so no real Durable Object or live Slack call is involved.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * `stop-routing.ts` pulls in `create-bot-store.js` -> `store/index.js` ->
 * `conversation-state-do.js`, which imports the real `DurableObject` base
 * class from the `cloudflare:workers` built-in module (only resolves inside
 * `workerd`). This suite runs under the plain Node suite instead — same
 * stub approach `test/render-obligation.test.ts` and
 * `test/session-event-do.test.ts` use — so the module is replaced with a
 * minimal base class before `stop-routing.ts` is imported.
 */
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/bot-engine.js", () => ({
  getOrCreateBot: vi.fn(async () => ({
    adapter: { abortConversation: vi.fn() },
  })),
}));

const { extractStopCommandEvent, handleStopCommand } = await import(
  "../src/slack/stop-routing.js"
);
const {
  deliverActiveTurnOutput,
  getActiveTurnForThread,
  getLatestActiveTurn,
  registerActiveTurn,
} = await import("../src/slack/active-turn-registry.js");
type SlackEventCallbackPayload =
  import("../src/slack/stop-routing.js").SlackEventCallbackPayload;
type SlackStopEvent = import("../src/slack/stop-routing.js").SlackStopEvent;
import type { Env } from "../src/env.js";

// ── extractStopCommandEvent (pure detection logic) ─────────────────────────

function eventCallback(event: SlackStopEvent): SlackEventCallbackPayload {
  return { type: "event_callback", event_id: "EvTest", team_id: "T1", event };
}

describe("extractStopCommandEvent", () => {
  it("matches a stop phrase on a message event", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      user: "U1",
      text: "please stop",
      ts: "1.0",
      thread_ts: "1.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBe(event);
  });

  it("matches a stop phrase on an app_mention event", () => {
    const event: SlackStopEvent = {
      type: "app_mention",
      channel: "C1",
      user: "U1",
      text: "cancel it",
      ts: "2.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBe(event);
  });

  it("returns undefined for ordinary text that fails the stop-phrase check", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      user: "U1",
      text: "what's the status of the deploy?",
      ts: "3.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("returns undefined for bot-authored messages", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      user: "U1",
      bot_id: "B123",
      text: "stop",
      ts: "4.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("returns undefined for event types other than message/app_mention", () => {
    const event: SlackStopEvent = {
      type: "reaction_added",
      channel: "C1",
      text: "stop",
      ts: "5.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only text", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      text: "   ",
      ts: "6.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("returns undefined for payloads that are not event_callback (e.g. url_verification)", () => {
    const payload: SlackEventCallbackPayload = {
      type: "url_verification",
      event: { type: "message", channel: "C1", text: "stop", ts: "7.0" },
    };
    expect(extractStopCommandEvent(payload)).toBeUndefined();
  });

  it("rejects subtype messages so automation cannot acquire Stop authority", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      subtype: "thread_broadcast",
      text: "stop",
      ts: "8.0",
      thread_ts: "8.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("ignores channel-level message stops without an app_mention", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      text: "stop",
      ts: "8.1",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });
});

// ── handleStopCommand (dedup + interrupt + obligation + Slack calls) ──────

/** Fake `env.BOT_STATE` namespace — routes by the `idFromName` string, like
 * `render-obligation.test.ts`'s `makeFakeSessionEvents`. Backs the two
 * `DurableObjectStateStore` calls `handleStopCommand` makes:
 * `dedup.seen()` -> `dedupSeen` and `obligation.clear()` -> `obligationClear`.
 */
function makeFakeBotState() {
  const dedupSeenCalls: Array<{ key: string; ttlMs: number }> = [];
  const obligationClearCalls: Array<{
    threadKey: string;
    executionId?: string;
  }> = [];
  const kvStore = new Map<string, unknown>();
  const listStore = new Map<string, unknown[]>();
  const obligations = new Map<string, {
    threadKey: string;
    executionId: string;
    channel: string;
    threadTs?: string;
  }>();
  const seenKeys = new Set<string>();
  const activeTurns = new Map<string, {
    record: import("../src/store/active-turn-types.js").ActiveTurnRecord;
    status: string;
    renderToken?: string;
    effectToken?: string;
    effectName?: string;
    effectResource?: import("../src/store/active-turn-types.js").ActiveTurnEffectResource;
    stopEventId?: string;
    confirmedOutput?: boolean;
    updatedAt: number;
  }>();
  const activeChoices = new Map<string, Set<string>>();
  let renderSequence = 0;
  let effectSequence = 0;
  const stub = {
    dedupSeen: async (key: string, ttlMs: number) => {
      dedupSeenCalls.push({ key, ttlMs });
      if (seenKeys.has(key)) return true;
      seenKeys.add(key);
      return false;
    },
    obligationClear: async (args: {
      threadKey: string;
      executionId?: string;
    }) => {
      obligationClearCalls.push(args);
      const current = obligations.get(args.threadKey);
      if (current && (!args.executionId || current.executionId === args.executionId)) {
        obligations.delete(args.threadKey);
      }
    },
    obligationGet: async ({ threadKey }: { threadKey: string }) =>
      obligations.get(threadKey),
    kvGet: async <T>(key: string): Promise<T | undefined> =>
      kvStore.get(key) as T | undefined,
    kvSet: async <T>(key: string, value: T): Promise<void> => {
      kvStore.set(key, value);
    },
    kvDelete: async (key: string): Promise<void> => {
      kvStore.delete(key);
    },
    listAppend: async (key: string, value: unknown) => {
      const values = listStore.get(key) ?? [];
      values.push(value);
      listStore.set(key, values);
      return values.length;
    },
    listRange: async (key: string) => listStore.get(key) ?? [],
    lockAcquire: async () => ({ token: crypto.randomUUID() }),
    lockRelease: async () => undefined,
    activeTurnRegister: async (record: import("../src/store/active-turn-types.js").ActiveTurnRecord) => {
      const current = activeTurns.get(record.threadKey);
      if (current) return {
        accepted: false,
        duplicate: current.record.executionId === record.executionId,
      };
      activeTurns.set(record.threadKey, {
        record,
        status: "pending",
        updatedAt: Date.now(),
      });
      return { accepted: true, duplicate: false };
    },
    activeTurnRefresh: async (record: import("../src/store/active-turn-types.js").ActiveTurnRecord) =>
      activeTurns.get(record.threadKey)?.record.executionId === record.executionId,
    activeTurnGet: async ({ threadKey }: { threadKey: string }) => {
      const row = activeTurns.get(threadKey);
      return row ? { ...row, record: row.record } : undefined;
    },
    activeTurnLatest: async ({ channelId }: { channelId: string }) => {
      const rows = [...activeTurns.values()]
        .filter((row) => row.record.channelId === channelId)
        .sort((a, b) => b.record.registeredAt - a.record.registeredAt);
      return rows[0] ? { ...rows[0], record: rows[0].record } : undefined;
    },
    activeTurnRegisterChoice: async (args: {
      threadKey: string; executionId: string; choiceId: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId) return "missing";
      if (row.status !== "pending") return "cancelled";
      const choices = activeChoices.get(args.threadKey) ?? new Set<string>();
      choices.add(args.choiceId);
      activeChoices.set(args.threadKey, choices);
      return "registered";
    },
    activeTurnUnregisterChoice: async (args: {
      threadKey: string; executionId: string; choiceId: string;
    }) => activeChoices.get(args.threadKey)?.delete(args.choiceId) ?? false,
    activeTurnCancelRegisteredChoices: async (args: {
      threadKey: string; executionId: string;
    }) => {
      const choices = [...(activeChoices.get(args.threadKey) ?? [])];
      for (const choiceId of choices) {
        kvStore.set(`hitl-id:${choiceId}`, {
          value: { confirmed: false, choiceId },
          at: Date.now(),
        });
        kvStore.set(`hitl-cancelled:${choiceId}`, true);
      }
      activeChoices.delete(args.threadKey);
      return choices;
    },
    activeTurnClaimCancellation: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId) return "missing";
      if (row.renderToken) return "in_flight";
      if (row.effectToken) {
        row.stopEventId ??= args.stopEventId;
        return "effect_in_flight";
      }
      if (row.status === "pending") {
        row.status = "cancelled";
        row.stopEventId = args.stopEventId;
        return "claimed";
      }
      if (row.stopEventId === args.stopEventId) {
        return row.status === "cancel_ack_in_flight" ? "ack_retry" : "retry";
      }
      if (row.status === "cancel_ack_in_flight") return "committed";
      if (row.status === "cancelled" || row.status === "cancel_controlled") {
        row.status = "cancelled";
        row.stopEventId = args.stopEventId;
        return "claimed";
      }
      return "committed";
    },
    activeTurnMarkCancelControlled: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId ||
          row.stopEventId !== args.stopEventId ||
          (row.status !== "cancelled" && row.status !== "cancel_controlled")) return false;
      row.status = "cancel_controlled";
      return true;
    },
    activeTurnBeginCancelAck: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId ||
          row.stopEventId !== args.stopEventId || row.status !== "cancel_controlled") return false;
      row.status = "cancel_ack_in_flight";
      return true;
    },
    activeTurnFailCancelAck: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId ||
          row.stopEventId !== args.stopEventId || row.status !== "cancel_ack_in_flight") return false;
      row.status = "cancel_controlled";
      return true;
    },
    activeTurnConfirmCancellationAndClear: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId ||
          row.stopEventId !== args.stopEventId || row.status !== "cancel_ack_in_flight") return false;
      obligations.delete(args.threadKey);
      obligationClearCalls.push({ threadKey: args.threadKey, executionId: args.executionId });
      activeTurns.delete(args.threadKey);
      return true;
    },
    activeTurnBeginRender: async (args: { threadKey: string; executionId: string }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId) return { status: "missing" };
      if (row.status !== "pending") return { status: "cancelled" };
      if (row.renderToken) return { status: "in_flight" };
      row.renderToken = `render-${++renderSequence}`;
      return { status: "claimed", token: row.renderToken };
    },
    activeTurnConfirmRender: async (args: {
      threadKey: string; executionId: string; token: string; final: boolean; output: boolean;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId || row.renderToken !== args.token) return false;
      if (args.final) {
        obligations.delete(args.threadKey);
        obligationClearCalls.push({ threadKey: args.threadKey, executionId: args.executionId });
        activeTurns.delete(args.threadKey);
      } else {
        row.renderToken = undefined;
        if (args.output) row.confirmedOutput = true;
      }
      return true;
    },
    activeTurnFailRender: async (args: { threadKey: string; executionId: string; token: string }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId || row.renderToken !== args.token) return false;
      row.renderToken = undefined;
      return true;
    },
    activeTurnBeginEffect: async (args: {
      threadKey: string; executionId: string; effectName: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId) return { status: "missing" };
      if (row.status !== "pending") return { status: "cancelled" };
      if (row.renderToken || row.effectToken) return { status: "in_flight" };
      row.effectToken = `effect-${++effectSequence}`;
      row.effectName = args.effectName;
      return { status: "claimed", token: row.effectToken };
    },
    activeTurnConfirmEffect: async (args: {
      threadKey: string; executionId: string; token: string;
      resource?: import("../src/store/active-turn-types.js").ActiveTurnEffectResource;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId || row.effectToken !== args.token) {
        return false;
      }
      row.effectToken = undefined;
      row.effectName = undefined;
      row.effectResource = args.resource;
      if (row.stopEventId) row.status = "cancelled";
      return true;
    },
    activeTurnFailEffect: async (args: {
      threadKey: string; executionId: string; token: string;
    }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId || row.effectToken !== args.token) {
        return false;
      }
      row.effectToken = undefined;
      row.effectName = undefined;
      if (row.stopEventId) row.status = "cancelled";
      return true;
    },
    activeTurnLifecycleComplete: async (args: { threadKey: string; executionId: string }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId || !row.confirmedOutput) return false;
      obligations.delete(args.threadKey);
      activeTurns.delete(args.threadKey);
      return true;
    },
    activeTurnDiscardInterruptedRedelivery: async (args: { threadKey: string; executionId: string }) => {
      const row = activeTurns.get(args.threadKey);
      if (!row || row.record.executionId !== args.executionId || row.status !== "pending") return false;
      obligations.delete(args.threadKey);
      activeTurns.delete(args.threadKey);
      return true;
    },
  };
  return {
    namespace: {
      idFromName: (name: string) => ({ toString: () => name, name }),
      get: (_id: { name: string }) => stub,
    },
    dedupSeenCalls,
    obligationClearCalls,
    kvStore,
    listStore,
    obligations,
    activeTurns,
    activeChoices,
    stub,
  };
}

/** Fake `env.SESSION_EVENTS` namespace — only `interrupt()` is exercised here. */
function makeFakeSessionEvents() {
  const interruptCalls: string[] = [];
  return {
    namespace: {
      idFromName: (name: string) => ({ toString: () => name, name }),
      get: (id: { name: string }) => ({
        getState: async () => ({ executing: { executionId: "active", startedAt: 1 } }),
        interrupt: async () => {
          interruptCalls.push(id.name);
          return { interrupted: true };
        },
        interruptExpected: async (_executionId: string) => {
          interruptCalls.push(id.name);
          return { interrupted: true, cancelled: true as const };
        },
      }),
    },
    interruptCalls,
  };
}

describe("handleStopCommand", () => {
  const origFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const params = new URLSearchParams(String(init?.body ?? ""));
      fetchCalls.push({
        url: String(url),
        body: Object.fromEntries(params.entries()),
      });
      return Response.json({ ok: true, ts: "9.9" });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("keeps an idle threaded Stop silent and does not create cancel-next state", async () => {
    const botState = makeFakeBotState();
    const sessionEvents = makeFakeSessionEvents();
    const env = {
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessionEvents.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env;

    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      user: "U1",
      text: "please stop",
      ts: "10.0",
      thread_ts: "10.0",
    };

    await handleStopCommand(env, event, "Ev1");

    const threadKey = "slack:C1:10.0";
    expect(sessionEvents.interruptCalls).toEqual([]);
    expect(botState.obligationClearCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(botState.kvStore.size).toBe(0);
  });

  it("is a total no-op on a redelivered event_id", async () => {
    const botState = makeFakeBotState();
    const sessionEvents = makeFakeSessionEvents();
    const env = {
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessionEvents.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env;

    const event: SlackStopEvent = {
      type: "message",
      channel: "C2",
      text: "kill it now",
      ts: "11.0",
    };

    await handleStopCommand(env, event, "EvDupe");
    expect(sessionEvents.interruptCalls).toHaveLength(0);
    expect(botState.obligationClearCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);

    // Redelivery of the exact same event_id — must not interrupt / clear /
    // post again.
    await handleStopCommand(env, event, "EvDupe");
    expect(sessionEvents.interruptCalls).toHaveLength(0);
    expect(botState.obligationClearCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("normal (non-stop) text never reaches handleStopCommand — the worker.ts routing gate is extractStopCommandEvent", () => {
    // handleStopCommand has no text-matching logic of its own; the guard
    // lives entirely in extractStopCommandEvent (tested above). This test
    // documents that split: worker.ts only calls handleStopCommand when
    // extractStopCommandEvent returned a match.
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      text: "please deploy the new build",
      ts: "12.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("bot-authored messages are ignored before handleStopCommand is ever invoked", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      bot_id: "B1",
      text: "stop",
      ts: "13.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBeUndefined();
  });

  it("app-authored messages without bot_id can never issue Stop", () => {
    expect(extractStopCommandEvent(eventCallback({
      type: "message",
      channel: "D1",
      app_id: "A123",
      text: "stop",
      ts: "1.0",
    }))).toBeUndefined();
  });

  it("does nothing (no throw) when channel or thread timestamp is missing", async () => {
    const botState = makeFakeBotState();
    const env = {
      BOT_STATE: botState.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env;

    await expect(
      handleStopCommand(env, { type: "message", text: "stop" }, "EvNoChannel"),
    ).resolves.toBeUndefined();
    expect(botState.obligationClearCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("DM stop (even unthreaded) keys on the channel — same partition the turn wrote", async () => {
    // DMs are one conversation (conversationKey scope is the literal "dm"),
    // so slackObligationThreadKey keys them on the channel. An unthreaded
    // "stop" in a DM must interrupt/clear the exact key the obligation
    // writer derived for the active turn.
    const botState = makeFakeBotState();
    const sessionEvents = makeFakeSessionEvents();
    await handleStopCommand(
      {
        BOT_STATE: botState.namespace,
        SESSION_EVENTS: sessionEvents.namespace,
        SLACK_BOT_TOKEN: "xoxb-test",
      } as unknown as Env,
      { type: "message", channel: "D9", user: "U1", text: "stop", ts: "44.4" },
      "EvDm1",
    );
    expect(sessionEvents.interruptCalls).toEqual([]);
    expect(botState.obligationClearCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it("keeps two thread records independent in either completion order", async () => {
    const records = [
      {
        channelId: "C7", threadKey: "slack:C7:70.0", conversationKey: "C7::70.0",
        executionId: "exec-a", threadTs: "70.0", registeredAt: 1,
      },
      {
        channelId: "C7", threadKey: "slack:C7:71.0", conversationKey: "C7::71.0",
        executionId: "exec-b", threadTs: "71.0", registeredAt: 2,
      },
    ] as const;

    for (const completionOrder of [[0, 1], [1, 0]] as const) {
      const botState = makeFakeBotState();
      const env = { BOT_STATE: botState.namespace } as unknown as Env;
      const stateStore = (await import("../src/create-bot-store.js"))
        .createBotStoreAdapter(env.BOT_STATE);
      await registerActiveTurn(stateStore, records[0]);
      await registerActiveTurn(stateStore, records[1]);

      await deliverActiveTurnOutput(
        stateStore,
        records[completionOrder[0]],
        async () => undefined,
      );
      expect((await getLatestActiveTurn(stateStore, "C7"))?.executionId)
        .toBe(records[completionOrder[1]].executionId);
      await deliverActiveTurnOutput(
        stateStore,
        records[completionOrder[1]],
        async () => undefined,
      );
      expect(await getLatestActiveTurn(stateStore, "C7")).toBeUndefined();
    }
  });

  it("routes an unthreaded Stop to the newest authoritative channel turn", async () => {
    const botState = makeFakeBotState();
    const sessionEvents = makeFakeSessionEvents();
    const env = {
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessionEvents.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env;
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(env.BOT_STATE);
    await registerActiveTurn(stateStore, {
      channelId: "C8", threadKey: "slack:C8:80.0", conversationKey: "C8::80.0",
      executionId: "exec-old", threadTs: "80.0", registeredAt: 1,
    });
    await registerActiveTurn(stateStore, {
      channelId: "C8", threadKey: "slack:C8:81.0", conversationKey: "C8::81.0",
      executionId: "exec-new", threadTs: "81.0", registeredAt: 2,
    });

    await handleStopCommand(env, {
      type: "message", channel: "C8", user: "U1", text: "stop", ts: "82.0",
    }, "EvUnthreaded");

    expect(sessionEvents.interruptCalls).toEqual(["slack:C8:81.0"]);
    expect(botState.obligationClearCalls).toEqual([{
      threadKey: "slack:C8:81.0",
      executionId: "exec-new",
    }]);
    const post = fetchCalls.find((call) => call.url.includes("chat.postMessage"));
    expect((post?.body as Record<string, string>).thread_ts).toBe("81.0");
  });

  it("acks only after exact durable and container interrupts are accepted", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C9", threadKey: "slack:C9:90.0", conversationKey: "C9::90.0",
      executionId: "exec-order", threadTs: "90.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    const order: string[] = [];
    const env = {
      BOT_STATE: botState.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
      HARNESS_AUTH_TOKEN: "secret",
      HARNESS_URL: "https://harness.test",
      HARNESS: {
        fetch: async () => {
          order.push("container-interrupt");
          return Response.json({ interrupted: false, approvalRevoked: true });
        },
      },
      SESSION_EVENTS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          interruptExpected: async (executionId: string) => {
            expect(executionId).toBe(active.executionId);
            order.push("durable-interrupt");
            return { interrupted: false, cancelled: true as const };
          },
          getState: async () => ({ sessionId: "sess-order" }),
        }),
      },
    } as unknown as Env;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("chat.postMessage")) order.push("stopped-ack");
      return priorFetch(url, init);
    }) as typeof fetch;

    await handleStopCommand(env, {
      type: "message", channel: "C9", user: "U1", text: "stop",
      ts: "91.0", thread_ts: "90.0",
    }, "EvOrder");

    expect(order).toEqual([
      "durable-interrupt",
      "container-interrupt",
      "stopped-ack",
    ]);
    expect(fetchCalls.find((call) => call.url.includes("chat.postMessage")))
      .toMatchObject({ body: expect.objectContaining({ text: "🛑 Stopped." }) });
    expect((fetchCalls.find((call) => call.url.includes("chat.postMessage"))?.body as {
      client_msg_id?: string;
    }).client_msg_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("does not claim Stopped when the exact container control request fails", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C10", threadKey: "slack:C10:100.0", conversationKey: "C10::100.0",
      executionId: "exec-fail", threadTs: "100.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    const env = {
      BOT_STATE: botState.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
      HARNESS_AUTH_TOKEN: "secret",
      HARNESS: { fetch: async () => new Response("no", { status: 503 }) },
      SESSION_EVENTS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          interruptExpected: async () => ({ interrupted: true, cancelled: true as const }),
          getState: async () => ({ sessionId: "sess-fail" }),
        }),
      },
    } as unknown as Env;
    await handleStopCommand(env, {
      type: "message", channel: "C10", user: "U1", text: "stop",
      ts: "101.0", thread_ts: "100.0",
    }, "EvFail");

    expect(fetchCalls.some((call) => call.url.includes("chat.postMessage"))).toBe(false);
    expect((await getActiveTurnForThread(
      stateStore,
      active.threadKey,
    ))?.executionId).toBe(active.executionId);
  });

  it("replays the identical Stop identity after control failure and acknowledges once", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C12", threadKey: "slack:C12:120.0", conversationKey: "C12::120.0",
      executionId: "exec-retry", threadTs: "120.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    let attempts = 0;
    const env = {
      BOT_STATE: botState.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
      HARNESS_AUTH_TOKEN: "secret",
      HARNESS: {
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response("no", { status: 503 })
            : Response.json({ interrupted: true });
        },
      },
      SESSION_EVENTS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          interruptExpected: async () => ({ interrupted: true, cancelled: true as const }),
          getState: async () => ({ sessionId: "sess-retry" }),
        }),
      },
    } as unknown as Env;
    const event = {
      type: "message", channel: "C12", user: "U1", text: "stop",
      ts: "121.0", thread_ts: "120.0",
    };

    await handleStopCommand(env, event, "EvSame");
    expect(fetchCalls.filter((call) => call.url.includes("chat.postMessage")))
      .toHaveLength(0);
    await handleStopCommand(env, event, "EvSame");
    expect(fetchCalls.filter((call) => call.url.includes("chat.postMessage")))
      .toHaveLength(1);
    await handleStopCommand(env, event, "EvSame");
    expect(fetchCalls.filter((call) => call.url.includes("chat.postMessage")))
      .toHaveLength(1);
  });

  it("lets a new Stop event adopt a retryable control failure", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C13", threadKey: "slack:C13:130.0", conversationKey: "C13::130.0",
      executionId: "exec-adopt", threadTs: "130.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    let controls = 0;
    const env = {
      BOT_STATE: botState.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
      HARNESS_AUTH_TOKEN: "secret",
      HARNESS: {
        fetch: async () => {
          controls += 1;
          return controls === 1
            ? new Response("no", { status: 503 })
            : Response.json({ interrupted: true });
        },
      },
      SESSION_EVENTS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          interruptExpected: async () => ({ interrupted: true, cancelled: true as const }),
          getState: async () => ({ sessionId: "sess-adopt" }),
        }),
      },
    } as unknown as Env;
    const event = {
      type: "message", channel: "C13", user: "U1", text: "stop",
      ts: "131.0", thread_ts: "130.0",
    };
    await handleStopCommand(env, event, "EvOld");
    await handleStopCommand(env, event, "EvNew");
    expect(fetchCalls.filter((call) => call.url.includes("chat.postMessage")))
      .toHaveLength(1);
    expect(await getActiveTurnForThread(stateStore, active.threadKey))
      .toBeUndefined();
  });

  it("replays the same idempotent acknowledgement after all cleanup retries fail, excluding a distinct Stop", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C14", threadKey: "slack:C14:140.0", conversationKey: "C14::140.0",
      executionId: "exec-cleanup", threadTs: "140.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    const originalConfirm = botState.stub.activeTurnConfirmCancellationAndClear;
    let confirmationAttempts = 0;
    botState.stub.activeTurnConfirmCancellationAndClear = async (args) => {
      confirmationAttempts += 1;
      if (confirmationAttempts <= 3) throw new Error("transient DO RPC failure");
      return originalConfirm(args);
    };
    let interruptAttempts = 0;
    const env = {
      BOT_STATE: botState.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          interruptExpected: async () => {
            interruptAttempts += 1;
            return { interrupted: false, cancelled: true as const };
          },
          getState: async () => ({}),
        }),
      },
    } as unknown as Env;
    const event = {
      type: "message", channel: "C14", user: "U1", text: "stop",
      ts: "141.0", thread_ts: "140.0",
    };
    await handleStopCommand(env, event, "EvCleanup");
    expect(confirmationAttempts).toBe(3);
    expect(interruptAttempts).toBe(1);
    expect(await getActiveTurnForThread(stateStore, active.threadKey)).toBeDefined();

    // A distinct event cannot steal an acknowledgement whose visible outcome
    // is already committed but whose atomic cleanup still needs retrying.
    await handleStopCommand(env, event, "EvDistinct");
    expect(confirmationAttempts).toBe(3);
    expect(interruptAttempts).toBe(1);

    // Slack may answer the same client_msg_id replay with an explicit
    // duplicate instead of the original timestamp. Treat it as already
    // visible, then retry only the atomic confirm+clear operation.
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("chat.postMessage")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        fetchCalls.push({ url: String(url), body: Object.fromEntries(params.entries()) });
        return Response.json({ ok: false, error: "duplicate_message" });
      }
      return priorFetch(url, init);
    }) as typeof fetch;
    await handleStopCommand(env, event, "EvCleanup");

    expect(confirmationAttempts).toBe(4);
    expect(interruptAttempts).toBe(1);
    const acknowledgements = fetchCalls.filter((call) => call.url.includes("chat.postMessage"));
    expect(acknowledgements).toHaveLength(2);
    expect((acknowledgements[0]!.body as Record<string, string>).client_msg_id)
      .toBe((acknowledgements[1]!.body as Record<string, string>).client_msg_id);
    expect(await getActiveTurnForThread(stateStore, active.threadKey))
      .toBeUndefined();
  });

  it("does not acknowledge Stop after completion commits a stalled delivery", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C11", threadKey: "slack:C11:110.0", conversationKey: "C11::110.0",
      executionId: "exec-stalled", threadTs: "110.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const delivery = deliverActiveTurnOutput(stateStore, active, async () => {
      entered();
      await releasePromise;
    });
    await enteredPromise;
    const sessions = makeFakeSessionEvents();
    await handleStopCommand({
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessions.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env, {
      type: "message", channel: "C11", user: "U1", text: "stop",
      ts: "111.0", thread_ts: "110.0",
    }, "EvStalled");
    expect(sessions.interruptCalls).toEqual([]);
    expect(fetchCalls.some((call) => call.url.includes("chat.postMessage"))).toBe(false);
    release();
    await expect(delivery).resolves.toBe("delivered");
  });

  it("never acknowledges Stop while a tool mutation is unresolved and retries after definitive completion", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C-effect", threadKey: "slack:C-effect:120.0",
      conversationKey: "C-effect::120.0", executionId: "exec-effect",
      threadTs: "120.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    const effect = await stateStore.activeTurn.beginEffect({
      threadKey: active.threadKey,
      executionId: active.executionId,
      effectName: "start_task",
    });
    expect(effect.status).toBe("claimed");
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    const sessions = makeFakeSessionEvents();
    const env = {
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessions.namespace,
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env;
    const event = {
      type: "message", channel: "C-effect", user: "U1", text: "stop",
      ts: "121.0", thread_ts: "120.0",
    };

    const stop = handleStopCommand(env, event, "EvEffectPending");
    // Let the first claim publish its durable pending-Stop intent, then make
    // the mutation definitive while the same Stop delivery is polling.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await stateStore.activeTurn.confirmEffect({
      threadKey: active.threadKey,
      executionId: active.executionId,
      token: effect.token,
    });
    await stop;
    expect(sessions.interruptCalls).toEqual([active.threadKey]);
    expect(fetchCalls.filter((call) => call.url.includes("chat.postMessage")))
      .toHaveLength(1);
  });

  it("requires exact research-task quiescence before request-time control or acknowledgement", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C-research", threadKey: "slack:C-research:130.0",
      conversationKey: "C-research::130.0", executionId: "exec-research",
      threadTs: "130.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    const effect = await stateStore.activeTurn.beginEffect({
      threadKey: active.threadKey,
      executionId: active.executionId,
      effectName: "start_task",
    });
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    await stateStore.activeTurn.confirmEffect({
      threadKey: active.threadKey,
      executionId: active.executionId,
      token: effect.token,
      resource: {
        kind: "research_task",
        teamId: "T-research",
        taskId: "task-research",
        threadKey: active.threadKey,
      },
    });
    const researchFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        cancelled: true,
        quiescent: false,
        taskId: "task-research",
      }))
      .mockResolvedValueOnce(Response.json({
        cancelled: true,
        quiescent: true,
        taskId: "task-research",
      }));
    const sessions = makeFakeSessionEvents();
    const env = {
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessions.namespace,
      RESEARCH_TASKS: { fetch: researchFetch },
      INTERNAL_SECRET: "internal-test",
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env;
    const event = {
      type: "message", channel: active.channelId, user: "U1", text: "stop",
      ts: "131.0", thread_ts: active.threadTs,
    };

    await handleStopCommand(env, event, "EvResearch");
    expect(sessions.interruptCalls).toEqual([]);
    expect(fetchCalls.some((call) => call.url.includes("chat.postMessage"))).toBe(false);
    expect(botState.activeTurns.get(active.threadKey)?.status).toBe("cancelled");

    await handleStopCommand(env, event, "EvResearch");
    expect(sessions.interruptCalls).toEqual([active.threadKey]);
    expect(fetchCalls.filter((call) => call.url.includes("chat.postMessage"))).toHaveLength(1);
    expect(researchFetch).toHaveBeenCalledTimes(2);
    const [, init] = researchFetch.mock.calls[0]! as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer internal-test");
    expect(JSON.parse(String(init.body))).toEqual({
      teamId: "T-research",
      threadKey: active.threadKey,
    });
  });

  it("keeps a persisted research Stop retryable and silent when auth is missing", async () => {
    const botState = makeFakeBotState();
    const stateStore = (await import("../src/create-bot-store.js"))
      .createBotStoreAdapter(botState.namespace as never);
    const active = {
      channelId: "C-noauth", threadKey: "slack:C-noauth:140.0",
      conversationKey: "C-noauth::140.0", executionId: "exec-noauth",
      threadTs: "140.0", registeredAt: 1,
    };
    await registerActiveTurn(stateStore, active);
    const effect = await stateStore.activeTurn.beginEffect({
      threadKey: active.threadKey,
      executionId: active.executionId,
      effectName: "start_task",
    });
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    await stateStore.activeTurn.confirmEffect({
      threadKey: active.threadKey,
      executionId: active.executionId,
      token: effect.token,
      resource: {
        kind: "research_task", teamId: "T1", taskId: "task-noauth",
        threadKey: active.threadKey,
      },
    });
    const sessions = makeFakeSessionEvents();
    const researchFetch = vi.fn();
    await handleStopCommand({
      BOT_STATE: botState.namespace,
      SESSION_EVENTS: sessions.namespace,
      RESEARCH_TASKS: { fetch: researchFetch },
      SLACK_BOT_TOKEN: "xoxb-test",
    } as unknown as Env, {
      type: "message", channel: active.channelId, user: "U1", text: "stop",
      ts: "141.0", thread_ts: active.threadTs,
    }, "EvNoAuth");

    expect(researchFetch).not.toHaveBeenCalled();
    expect(sessions.interruptCalls).toEqual([]);
    expect(fetchCalls.some((call) => call.url.includes("chat.postMessage"))).toBe(false);
    expect(botState.activeTurns.get(active.threadKey)?.status).toBe("cancelled");
  });
});
