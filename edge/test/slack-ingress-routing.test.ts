import { describe, expect, it } from "vitest";
import { normalizeSlackEvent } from "../src/slack/ingress-normalize.js";

describe("Slack ingress routing", () => {
  it("classifies top-level channel messages without requiring a mention", () => {
    expect(normalizeSlackEvent({
      event_id: "Ev-channel",
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "what is happening in the channel?",
        ts: "10.1",
      },
    }, "UBOT")).toMatchObject({
      kind: "turn",
      source: "channel_message",
      channel: "C1",
      ts: "10.1",
      userText: "what is happening in the channel?",
    });
  });

  it("treats group DMs as direct messages", () => {
    expect(normalizeSlackEvent({
      event_id: "Ev-mpim",
      event: {
        type: "message",
        channel_type: "mpim",
        channel: "G1",
        user: "U1",
        text: "hello",
        ts: "10.2",
      },
    }, "UBOT")).toMatchObject({
      kind: "turn",
      source: "direct_message",
      channel: "G1",
      userText: "hello",
    });
  });

  it("keeps threaded replies distinct from top-level messages", () => {
    expect(normalizeSlackEvent({
      event_id: "Ev-thread",
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "what is the status?",
        ts: "10.3",
        thread_ts: "10.0",
      },
    }, "UBOT")).toMatchObject({
      kind: "turn",
      source: "thread_reply",
      threadTs: "10.0",
    });
  });

  it("never routes a bot-only message into a turn", () => {
    expect(normalizeSlackEvent({
      event_id: "Ev-bot",
      event: {
        type: "message",
        subtype: "bot_message",
        channel_type: "channel",
        channel: "C1",
        bot_id: "B1",
        text: "status update",
        ts: "10.4",
      },
    }, "UBOT")).toBeUndefined();
  });
});
