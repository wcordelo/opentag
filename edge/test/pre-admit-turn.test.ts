import { describe, expect, it } from "vitest";
import {
  preAdmissionIdentityForCommand,
  preAdmissionIdentityForEvent,
} from "../src/slack/pre-admit-turn.js";
import { slackTurnIdentity } from "../src/request-context.js";
import { slackTurnIdentitySync } from "../src/request-context.js";
import { makeWireTurnIdentity, makeWireTurnIdentitySync } from "../src/harness/wire-id.js";

describe("Slack turn pre-admission identity", () => {
  it("derives byte-identical retry-stable wire ids synchronously before registration", async () => {
    const tuples = [
      ["T1", "C1", "1.0", "1.1", "Ev1"],
      ["équipe", "D⚡", "", "1700.001", "quick:α:β"],
      ["", "C2", "root", "/agent:U:trigger", "/agent:U:trigger"],
    ];
    for (const tuple of tuples) {
      expect(makeWireTurnIdentitySync("slack-event", tuple)).toEqual(
        await makeWireTurnIdentity("slack-event", tuple),
      );
    }
    const context = {
      teamId: "T1",
      requesterId: "U1",
      inbound: { channel: "C1", ts: "1.1", threadTs: "1.0", identity: "Ev1" },
    };
    expect(slackTurnIdentitySync(context, "C1")).toEqual(
      await slackTurnIdentity(context, "C1"),
    );
  });
  it("extracts a mention's exact thread and stable envelope identity without lookup", async () => {
    const identity = preAdmissionIdentityForEvent({
      team_id: "T1",
      event_id: "Ev-mention",
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@UBOT> do work",
        ts: "10.2",
        thread_ts: "10.1",
      },
    });
    expect(identity).toEqual({
      teamId: "T1",
      channelId: "C1",
      conversationKey: "C1::10.1",
      threadTs: "10.1",
      requesterId: "U1",
      inboundTs: "10.2",
      eventId: "Ev-mention",
    });
    await expect(slackTurnIdentity({
      teamId: identity!.teamId,
      requesterId: identity!.requesterId,
      inbound: {
        channel: identity!.channelId,
        ts: identity!.inboundTs,
        threadTs: identity!.threadTs,
        identity: identity!.eventId,
      },
    }, "C1")).resolves.toMatchObject({
      executionId: expect.stringMatching(/^ot1e_/),
      forwardedMessageId: expect.stringMatching(/^ot1m_/),
    });
  });

  it("covers DM and ordinary channel thread turns, including file_share", () => {
    expect(preAdmissionIdentityForEvent({
      team_id: "T1",
      event_id: "Ev-dm",
      event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "hello", ts: "11.0" },
    })?.conversationKey).toBe("D1::dm");
    expect(preAdmissionIdentityForEvent({
      team_id: "T1",
      event_id: "Ev-file",
      event: { type: "message", subtype: "file_share", channel: "C1", user: "U1", text: "", files: [{}], ts: "12.1", thread_ts: "12.0" },
    })?.conversationKey).toBe("C1::12.0");
  });

  it("extracts every lifecycle command and uses trigger_id as immutable ingress ts", () => {
    expect(preAdmissionIdentityForCommand({
      command: "/agent",
      channel_id: "C9",
      user_id: "U9",
      trigger_id: "trigger-1",
      team_id: "T9",
      thread_ts: "9.0",
    })).toMatchObject({
      conversationKey: "C9::9.0",
      inboundTs: "/agent:U9:trigger-1",
      eventId: "/agent:U9:trigger-1",
    });
    expect(preAdmissionIdentityForCommand({
      command: "/research",
      channel_id: "C9",
      user_id: "U9",
      trigger_id: "trigger-2",
    })).toMatchObject({
      conversationKey: "C9::C9",
      eventId: "/research:U9:trigger-2",
    });
    expect(preAdmissionIdentityForCommand({
      command: "/config",
      channel_id: "C9",
      user_id: "U9",
      trigger_id: "trigger-3",
    })).toMatchObject({ eventId: "/config:U9:trigger-3" });
    expect(preAdmissionIdentityForCommand({
      command: "/unknown",
      channel_id: "C9",
      user_id: "U9",
      trigger_id: "trigger-4",
    })).toBeUndefined();
  });

  it("does not reserve empty or bot-only deliveries", () => {
    expect(preAdmissionIdentityForEvent({
      event_id: "Ev-empty",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT>", ts: "1.0" },
    })).toBeUndefined();
    expect(preAdmissionIdentityForEvent({
      event_id: "Ev-bot",
      event: { type: "message", channel_type: "im", channel: "D1", bot_id: "B1", text: "echo", ts: "1.0" },
    })).toBeUndefined();
  });
});
