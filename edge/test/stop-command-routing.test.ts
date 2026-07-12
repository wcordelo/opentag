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

  it("ignores event.subtype — a stop message with a subtype still matches", () => {
    const event: SlackStopEvent = {
      type: "message",
      channel: "C1",
      subtype: "thread_broadcast",
      text: "stop",
      ts: "8.0",
    };
    expect(extractStopCommandEvent(eventCallback(event))).toBe(event);
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
  const seenKeys = new Set<string>();
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
    },
    kvGet: async <T>(key: string): Promise<T | undefined> =>
      kvStore.get(key) as T | undefined,
    kvSet: async <T>(key: string, value: T): Promise<void> => {
      kvStore.set(key, value);
    },
    kvDelete: async (key: string): Promise<void> => {
      kvStore.delete(key);
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
  };
}

/** Fake `env.SESSION_EVENTS` namespace — only `interrupt()` is exercised here. */
function makeFakeSessionEvents() {
  const interruptCalls: string[] = [];
  return {
    namespace: {
      idFromName: (name: string) => ({ toString: () => name, name }),
      get: (id: { name: string }) => ({
        interrupt: async () => {
          interruptCalls.push(id.name);
          return { interrupted: true };
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

  it("interrupts the session, clears the obligation, clears status, and posts a confirmation", async () => {
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
    expect(sessionEvents.interruptCalls).toEqual([threadKey]);
    expect(botState.obligationClearCalls).toEqual([{ threadKey }]);

    const statusCall = fetchCalls.find((c) =>
      c.url.includes("assistant.threads.setStatus"),
    );
    expect(statusCall).toBeDefined();
    expect((statusCall!.body as Record<string, string>).status).toBe("");

    const postCall = fetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    expect((postCall!.body as Record<string, string>).text).toBe("🛑 Stopped.");
    expect((postCall!.body as Record<string, string>).channel).toBe("C1");
    expect((postCall!.body as Record<string, string>).thread_ts).toBe("10.0");
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
    expect(sessionEvents.interruptCalls).toHaveLength(1);
    expect(botState.obligationClearCalls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(2); // setStatus + postMessage

    // Redelivery of the exact same event_id — must not interrupt / clear /
    // post again.
    await handleStopCommand(env, event, "EvDupe");
    expect(sessionEvents.interruptCalls).toHaveLength(1);
    expect(botState.obligationClearCalls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(2);
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
    expect(sessionEvents.interruptCalls).toEqual(["slack:D9:D9"]);
    expect(botState.obligationClearCalls).toEqual([
      { threadKey: "slack:D9:D9" },
    ]);
  });
});
