/**
 * Unit tests for CloudflareSlackAdapter ingress (no live Slack).
 */
import { describe, expect, it, vi } from "vitest";
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

describe("CloudflareSlackAdapter", () => {
  it("start stores sink; handleEventsBody emits onTurn for app_mention", async () => {
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
  });

  it("handleCommandBody uses thread_ts for threaded slash commands", async () => {
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
  });

  it("handleInteractionPayload decodes block_actions", async () => {
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
    const evt = sink.interactions[0] as { id: string; conversationKey: string };
    expect(evt.id).toBe("ck:abc");
    expect(evt.conversationKey).toBe("C1::9.0");
  });

  it("getSink throws before start", () => {
    const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test" });
    expect(() => adapter.getSink()).toThrow(/sink not set/);
  });

  // silence unused
  void vi;
});
