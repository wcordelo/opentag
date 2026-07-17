import { describe, expect, it } from "vitest";
import {
  preAdmitSlackTurnResult,
  preAdmissionIdentityForCommand,
  preAdmissionIdentityForEvent,
} from "../src/slack/pre-admit-turn.js";
import { slackTurnIdentity } from "../src/request-context.js";
import { slackTurnIdentitySync } from "../src/request-context.js";
import { makeWireTurnIdentity, makeWireTurnIdentitySync } from "../src/harness/wire-id.js";
import { parseTrustedTriggerConfig } from "../src/slack/trusted-trigger.js";

describe("Slack turn pre-admission identity", () => {
  it("preserves accepted, exact-duplicate, and distinct-concurrent registration outcomes", async () => {
    const identity = preAdmissionIdentityForEvent({
      team_id: "T1",
      event_id: "Ev-registration",
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@UBOT> do work",
        ts: "10.2",
        thread_ts: "10.1",
      },
    });
    const outcomes = [
      { accepted: true, duplicate: false },
      { accepted: false, duplicate: true },
      { accepted: false, duplicate: false },
    ];
    const stub = {
      activeTurnRegisterWithObligation: async () => outcomes.shift()!,
    };
    const env = {
      BOT_STATE: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    };

    const accepted = await preAdmitSlackTurnResult(env as never, identity);
    const duplicate = await preAdmitSlackTurnResult(env as never, identity);
    const concurrent = await preAdmitSlackTurnResult(env as never, identity);

    expect(accepted).toMatchObject({
      status: "accepted",
      turn: { record: { executionId: expect.stringMatching(/^ot1e_/) } },
    });
    expect(duplicate).toMatchObject({
      status: "duplicate",
      turn: {
        record: {
          executionId: accepted.status === "accepted"
            ? accepted.turn.record.executionId
            : "",
        },
      },
    });
    expect(concurrent).toEqual({ status: "concurrent" });
  });

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
      actor: { kind: "slack_user" as const, userId: "U1" },
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
      actor: { kind: "slack_user", userId: "U1" },
      requesterId: "U1",
      inboundTs: "10.2",
      eventId: "Ev-mention",
    });
    await expect(slackTurnIdentity({
      teamId: identity!.teamId,
      actor: { kind: "slack_user", userId: identity!.requesterId },
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
      command: "/agent",
      channel_id: "D1",
      user_id: "U9",
      trigger_id: "trigger-dm",
    })?.conversationKey).toBe("D1::dm");
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

  it("rejects self-authored threaded messages before durable admission", () => {
    const config = parseTrustedTriggerConfig("UOPENTAG", undefined);
    const base = {
      type: "message",
      channel: "C1",
      text: "OPENTAG_FORMAT_OK",
      ts: "2.0",
      thread_ts: "1.0",
    };

    expect(preAdmissionIdentityForEvent({
      event_id: "Ev-self-user",
      event: { ...base, user: "UOPENTAG", bot_id: "BOPENTAG" },
    }, config)).toBeUndefined();
    expect(preAdmissionIdentityForEvent({
      event_id: "Ev-self-profile",
      event: {
        ...base,
        bot_profile: { user_id: "UOPENTAG", id: "BOPENTAG" },
      },
    }, config)).toBeUndefined();
    expect(preAdmissionIdentityForEvent({
      event_id: "Ev-human-reply",
      event: { ...base, user: "U1" },
    }, config)).toMatchObject({ requesterId: "U1" });
  });
});
