/**
 * Unit tests for CloudflareSlackAdapter ingress (no live Slack).
 */
import { describe, expect, it, vi } from "vitest";
import { CloudflareSlackAdapter } from "../src/slack/cloudflare-slack-adapter.js";
import type { IngressSink } from "@copilotkit/channels";
import { requireRequestContext } from "../src/request-context.js";
import type { LifecycleStateStore } from "../src/store/state-store-contract.js";

function makeSink(): IngressSink & {
  turns: unknown[];
  commands: unknown[];
  interactions: unknown[];
} {
  const turns: unknown[] = [];
  const commands: unknown[] = [];
  const interactions: unknown[] = [];
  return {
    turns,
    commands,
    interactions,
    onTurn: async (t) => {
      turns.push(t);
    },
    onCommand: async (c) => {
      commands.push(c);
    },
    onInteraction: async (e) => {
      interactions.push(e);
    },
    onThreadStarted: async () => {},
    onReaction: async () => {},
    onModalSubmit: async () => {},
    onModalClose: async () => {},
  };
}

/**
 * Canned Slack Web API responses for tests that construct a
 * CloudflareSlackAdapter WITHOUT an explicit `botUserId` — `start()` then
 * calls `ensureBotUserId()`, which hits `auth.test` for real. Node's
 * fetch (undici) hangs indefinitely on a POST with an empty-string body,
 * and `web-api.ts` sends `auth.test` with no params (empty body) — so any
 * unmocked call here would hang the test suite rather than fail fast.
 * Mocking keeps this file's "no live Slack" contract intact.
 */
function mockSlackApi(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("auth.test")) {
      return Response.json({ ok: true, user_id: "UBOTMOCK" });
    }
    if (u.includes("users.info")) {
      return Response.json({
        ok: true,
        user: { id: "U1", real_name: "Test User", name: "testuser" },
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

describe("CloudflareSlackAdapter", () => {
  it.each(["profile", "file"] as const)(
    "suppresses pre-admitted handoff when Stop lands during %s preparation",
    async (barrier) => {
      let status: "pending" | "cancelled" = "pending";
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const record = {
        channelId: "C1",
        threadKey: "slack:C1:1.0",
        conversationKey: "C1::1.0",
        executionId: "ot1e_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        threadTs: "1.0",
        registeredAt: 1,
      };
      const stateStore = {
        activeTurn: {
          get: vi.fn(async () => ({ record, status, updatedAt: Date.now() })),
        },
      } as unknown as LifecycleStateStore;
      const orig = globalThis.fetch;
      const entered = vi.fn();
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value.includes("users.info")) {
          if (barrier === "profile") {
            entered();
            await blocked;
          }
          return Response.json({ ok: true, user: { id: "U1", name: "ada" } });
        }
        if (value === "https://files.slack.test/note") {
          entered();
          await blocked;
          return new Response("notes", { status: 200 });
        }
        return Response.json({ ok: true });
      }) as typeof fetch;
      try {
        const adapter = new CloudflareSlackAdapter({
          botToken: "xoxb-test",
          botUserId: "UBOT",
          stateStore,
        });
        const sink = makeSink();
        await adapter.start(sink);
        const handedOff = vi.fn();
        const pending = adapter.handleEventsBody({
          team_id: "T1",
          event_id: `Ev-${barrier}`,
          event: {
            type: "app_mention",
            channel: "C1",
            user: "U1",
            text: "<@UBOT> inspect",
            ts: "1.1",
            thread_ts: "1.0",
            ...(barrier === "file" ? {
              files: [{
                id: "F1",
                name: "note.txt",
                mimetype: "text/plain",
                url_private: "https://files.slack.test/note",
              }],
            } : {}),
          },
        }, {
          preAdmittedTurn: { record },
          onTurnHandoff: handedOff,
        });
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
        status = "cancelled";
        release();
        await expect(pending).resolves.toEqual({ handled: true });
        expect(handedOff).not.toHaveBeenCalled();
        expect(sink.turns).toHaveLength(0);
      } finally {
        globalThis.fetch = orig;
      }
    },
  );

  it("start stores sink; handleEventsBody emits onTurn for app_mention", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);

      const result = await adapter.handleEventsBody({
        team_id: "T1",
        event_id: "Ev123",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@UBOT> hello world",
          ts: "1.0",
          thread_ts: "1.0",
        },
      });

      expect(result.handled).toBe(true);
      expect(sink.turns).toHaveLength(1);
      const turn = sink.turns[0] as {
        conversationKey: string;
        userText: string;
        eventId?: string;
        platform: string;
      };
      expect(turn.platform).toBe("slack");
      expect(turn.userText).toBe("hello world");
      expect(turn.conversationKey).toBe("C1::1.0");
      expect(turn.eventId).toBe("Ev123");
    } finally {
      restoreFetch();
    }
  });

  it("ignores bot-only messages", async () => {
    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
    });
    const sink = makeSink();
    await adapter.start(sink);
    const result = await adapter.handleEventsBody({
      event: {
        type: "message",
        channel: "C1",
        user: "UBOT",
        text: "echo",
        ts: "2.0",
      },
    });
    expect(result.handled).toBe(false);
    expect(sink.turns).toHaveLength(0);
  });

  it("admits an exact trusted rich mention as automation without users.info", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => {
      throw new Error("Slack API lookup must not run for automation");
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const adapter = new CloudflareSlackAdapter({
        unsafeAllowUnfencedTestOnly: true,
        botToken: "xoxb-test",
        botUserId: "UOPENTAG",
        trustedTriggerConfig: {
          botUserId: "UOPENTAG",
          actors: new Set(["bot:BALERT"]),
          valid: true,
        },
      });
      const sink = makeSink();
      await adapter.start(sink);
      const result = await adapter.handleEventsBody({
        team_id: "T1",
        event_id: "Ev-alert",
        event: {
          type: "message",
          subtype: "bot_message",
          channel: "C1",
          ts: "3.0",
          bot_id: "BALERT",
          attachments: [{
            pretext: "<@UOPENTAG> inspect elevated checkout errors",
          }],
        },
      });
      expect(result.handled).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      const turn = sink.turns[0] as {
        user: object;
        userText: string;
        conversationKey: string;
      };
      expect(turn.userText).toBe("inspect elevated checkout errors");
      expect(turn.conversationKey).toBe("C1::3.0");
      expect(requireRequestContext(turn.user)).toMatchObject({
        actor: { kind: "slack_automation", botId: "BALERT" },
        requesterId: "bot:BALERT",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handleCommandBody emits onCommand", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);
      const result = await adapter.handleCommandBody({
        command: "/research",
        text: "durable objects",
        channel_id: "C9",
        user_id: "U9",
        trigger_id: "trig1",
        team_id: "T9",
      });
      expect(result.handled).toBe(true);
      expect(sink.commands).toHaveLength(1);
      const cmd = sink.commands[0] as {
        command: string;
        text: string;
        conversationKey: string;
        eventId?: string;
        user: object;
      };
      expect(cmd.command).toBe("research");
      expect(cmd.text).toBe("durable objects");
      expect(cmd.conversationKey).toBe("C9::C9");
      expect(cmd.eventId).toBe("/research:U9:trig1");
      expect(requireRequestContext(cmd.user).inbound).toMatchObject({
        channel: "C9",
        ts: "/research:U9:trig1",
        identity: "/research:U9:trig1",
      });
    } finally {
      restoreFetch();
    }
  });

  it("handleCommandBody uses thread_ts for threaded slash commands", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);
      const result = await adapter.handleCommandBody({
        command: "/research",
        text: "edge computing",
        channel_id: "C9",
        user_id: "U9",
        trigger_id: "trig1",
        team_id: "T9",
        thread_ts: "999.111",
      });
      expect(result.handled).toBe(true);
      const cmd = sink.commands[0] as {
        conversationKey: string;
        replyTarget: { threadTs?: string };
      };
      expect(cmd.conversationKey).toBe("C9::999.111");
      expect(cmd.replyTarget.threadTs).toBe("999.111");
      expect(requireRequestContext((cmd as unknown as { user: object }).user).inbound)
        .toMatchObject({
          channel: "C9",
          ts: "/research:U9:trig1",
          threadTs: "999.111",
          identity: "/research:U9:trig1",
        });
    } finally {
      restoreFetch();
    }
  });

  it("handleCommandBody DM slash commands use the DM scope (matches pre-admission)", async () => {
    // preAdmissionIdentityForCommand derives D…::dm; the adapter MUST agree
    // or the turn lifecycle throws pre_admitted_turn_identity_mismatch and
    // every DM slash command fails.
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);
      const result = await adapter.handleCommandBody({
        command: "/agent",
        text: "hello",
        channel_id: "D9",
        user_id: "U9",
        trigger_id: "trigDm",
        team_id: "T9",
      });
      expect(result.handled).toBe(true);
      const cmd = sink.commands[0] as { conversationKey: string };
      expect(cmd.conversationKey).toBe("D9::dm");
      const { preAdmissionIdentityForCommand } = await import(
        "../src/slack/pre-admit-turn.js"
      );
      expect(
        preAdmissionIdentityForCommand({
          command: "/agent",
          channel_id: "D9",
          user_id: "U9",
          trigger_id: "trigDm",
          team_id: "T9",
        })?.conversationKey,
      ).toBe(cmd.conversationKey);
    } finally {
      restoreFetch();
    }
  });

  it("rejects slash commands without Slack's stable trigger identity", async () => {
    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
    });
    const sink = makeSink();
    await adapter.start(sink);
    expect(await adapter.handleCommandBody({
      command: "/agent",
      text: "do work",
      channel_id: "C9",
      user_id: "U9",
      team_id: "T9",
    })).toEqual({ handled: false });
    expect(sink.commands).toHaveLength(0);
  });

  it("binds identical command identity and partition on Slack redelivery", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);
      const body = {
        command: "/agent",
        text: "do work",
        channel_id: "C9",
        user_id: "U9",
        trigger_id: "stable-trigger",
        team_id: "T9",
      };
      await adapter.handleCommandBody(body);
      await adapter.handleCommandBody(body);
      const commands = sink.commands as Array<{
        eventId?: string;
        conversationKey: string;
        user: object;
      }>;
      expect(commands.map((cmd) => cmd.eventId)).toEqual([
        "/agent:U9:stable-trigger",
        "/agent:U9:stable-trigger",
      ]);
      expect(commands.map((cmd) => cmd.conversationKey)).toEqual(["C9::C9", "C9::C9"]);
      expect(commands.map((cmd) => requireRequestContext(cmd.user).inbound?.identity))
        .toEqual(["/agent:U9:stable-trigger", "/agent:U9:stable-trigger"]);
    } finally {
      restoreFetch();
    }
  });

  it("handleInteractionPayload decodes block_actions", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);
      const result = await adapter.handleInteractionPayload({
        type: "block_actions",
        trigger_id: "trig",
        user: { id: "U1" },
        channel: { id: "C1" },
        message: { ts: "10.0", thread_ts: "9.0" },
        actions: [
          {
            action_id: "ck:abc",
            value: '{"confirmed":true}',
            action_ts: "10.1",
          },
        ],
      });
      expect(result.handled).toBe(true);
      expect(sink.interactions).toHaveLength(1);
      const evt = sink.interactions[0] as {
        id: string;
        conversationKey: string;
      };
      expect(evt.id).toBe("ck:abc");
      expect(evt.conversationKey).toBe("C1::9.0");
    } finally {
      restoreFetch();
    }
  });

  it("fails closed without invoking the in-memory sink when durable HITL persistence fails", async () => {
    const persistError = new Error("BOT_STATE unavailable");
    const stateStore = {
      kv: {
        get: async () => undefined,
        set: async () => { throw persistError; },
        delete: async () => undefined,
      },
      hitl: {
        persistChoiceUnlessCancelled: async () => { throw persistError; },
        cancelChoice: async () => undefined,
      },
    } as unknown as LifecycleStateStore;
    const adapter = new CloudflareSlackAdapter({
      botToken: "xoxb-test",
      botUserId: "UBOT",
      stateStore,
    });
    const sink = makeSink();
    await adapter.start(sink);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(adapter.handleInteractionPayload({
        type: "block_actions",
        trigger_id: "trig-failed-persist",
        user: { id: "U1" },
        channel: { id: "C1" },
        message: { ts: "10.0", thread_ts: "9.0" },
        actions: [{
          action_id: "ck:remote-git",
          value: JSON.stringify({ confirmed: true, choiceId: "remote-git-choice" }),
          action_ts: "10.1",
        }],
      })).rejects.toThrow("BOT_STATE unavailable");
      expect(sink.interactions).toHaveLength(0);
    } finally {
      logged.mockRestore();
    }
  });

  it.each(["persisted", "cancelled"] as const)(
    "does not invoke an isolate-local waiter for a modern exact-id choice that is %s",
    async (result) => {
      const persistChoiceUnlessCancelled = vi.fn(async () => result);
      const stateStore = {
        kv: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
        hitl: {
          persistChoiceUnlessCancelled,
          cancelChoice: async () => undefined,
        },
      } as unknown as LifecycleStateStore;
      const adapter = new CloudflareSlackAdapter({
        botToken: "xoxb-test",
        botUserId: "UBOT",
        stateStore,
      });
      const sink = makeSink();
      await adapter.start(sink);

      await expect(adapter.handleInteractionPayload({
        type: "block_actions",
        trigger_id: `trig-${result}`,
        user: { id: "U1" },
        channel: { id: "C1" },
        message: { ts: "10.0", thread_ts: "9.0" },
        actions: [{
          action_id: "ck:remote-git",
          value: JSON.stringify({ confirmed: true, choiceId: "remote-git-choice" }),
          action_ts: "10.1",
        }],
      })).resolves.toEqual({ handled: true });
      expect(persistChoiceUnlessCancelled).toHaveBeenCalledOnce();
      expect(sink.interactions).toHaveLength(0);
    },
  );

  it("thread_reply stores inbound ts so reactions can target it", async () => {
    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
    });
    const sink = makeSink();
    await adapter.start(sink);
    const reactions: unknown[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("reactions.add")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        reactions.push({
          channel: params.get("channel"),
          timestamp: params.get("timestamp"),
          name: params.get("name"),
        });
        return Response.json({ ok: true });
      }
      if (String(url).includes("users.info")) {
        return Response.json({
          ok: true,
          user: { id: "U1", real_name: "Ada", name: "ada" },
        });
      }
      return Response.json({ ok: false });
    }) as typeof fetch;
    try {
      const result = await adapter.handleEventsBody({
        team_id: "T1",
        event_id: "EvThread",
        event: {
          type: "message",
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          text: "ok great thank you",
          ts: "55.5",
          thread_ts: "50.0",
        },
      });
      expect(result.handled).toBe(true);
      expect(sink.turns).toHaveLength(1);
      const turn = sink.turns[0] as { user: object };
      const context = requireRequestContext(turn.user);
      expect(context).toMatchObject({
        teamId: "T1",
        requesterId: "U1",
        inbound: { channel: "C1", ts: "55.5", threadTs: "50.0" },
      });
      const ok = await adapter.react("C1::50.0", "heart", context.inbound);
      expect(ok).toBe(true);
      expect(reactions[0]).toMatchObject({
        channel: "C1",
        timestamp: "55.5",
        name: "heart",
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("getSink throws before start", () => {
    const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
    expect(() => adapter.getSink()).toThrow(/sink not set/);
  });

  it("ensureBotUserId caches auth.test user_id", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("auth.test")) {
        return Response.json({ ok: true, user_id: "UBOT123" });
      }
      return Response.json({ ok: false });
    }) as typeof fetch;
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      const sink = makeSink();
      await adapter.start(sink);
      expect(adapter.getBotUserId()).toBe("UBOT123");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("getMessages maps conversations.replies", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("auth.test")) {
        return Response.json({ ok: true, user_id: "UBOT" });
      }
      if (String(url).includes("conversations.replies")) {
        return Response.json({
          ok: true,
          messages: [
            { text: "hi", ts: "1.0", user: "U1" },
            { text: "yo", ts: "1.1", bot_id: "B1" },
          ],
        });
      }
      if (String(url).includes("users.info")) {
        return Response.json({
          ok: true,
          user: { id: "U1", real_name: "Ada", name: "ada" },
        });
      }
      return Response.json({ ok: false });
    }) as typeof fetch;
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
      await adapter.start(makeSink());
      const msgs = await adapter.getMessages({
        channel: "C1",
        threadTs: "1.0",
      });
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.text).toBe("hi");
      expect(msgs[0]!.user?.name).toBe("Ada");
      expect(msgs[1]!.isBot).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("accepts channel thread replies without re-mention", async () => {
    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
    });
    const sink = makeSink();
    await adapter.start(sink);
    const result = await adapter.handleEventsBody({
      event_id: "EvThread",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "follow up without mention",
        ts: "2.0",
        thread_ts: "1.0",
      },
    });
    expect(result.handled).toBe(true);
    expect(sink.turns).toHaveLength(1);
  });
});
