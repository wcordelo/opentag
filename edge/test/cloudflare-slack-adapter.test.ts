/**
 * Unit tests for CloudflareSlackAdapter ingress (no live Slack).
 */
import { describe, expect, it } from "vitest";
import { CloudflareSlackAdapter } from "../src/slack/cloudflare-slack-adapter.js";
import type { IngressSink } from "@copilotkit/channels";

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
  it("start stores sink; handleEventsBody emits onTurn for app_mention", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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

  it("handleCommandBody emits onCommand", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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
      const cmd = sink.commands[0] as { command: string; text: string };
      expect(cmd.command).toBe("research");
      expect(cmd.text).toBe("durable objects");
    } finally {
      restoreFetch();
    }
  });

  it("handleCommandBody uses thread_ts for threaded slash commands", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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
    } finally {
      restoreFetch();
    }
  });

  it("handleInteractionPayload decodes block_actions", async () => {
    const restoreFetch = mockSlackApi();
    try {
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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

  it("thread_reply stores inbound ts so reactions can target it", async () => {
    const adapter = new CloudflareSlackAdapter({
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
      const ok = await adapter.react("C1::50.0", "heart");
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
    const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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
      const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
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
