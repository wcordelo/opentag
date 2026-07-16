import { describe, expect, it } from "vitest";
import { normalizeSlackEvent } from "../src/slack/ingress-normalize.js";
import { preAdmissionIdentityForEvent } from "../src/slack/pre-admit-turn.js";
import { extractRichDisplayText } from "../src/slack/rich-display-text.js";
import {
  classifyTrustedRichTrigger,
  parseTrustedTriggerConfig,
  trustedRichTriggerDecision,
  trustedTriggerReadiness,
} from "../src/slack/trusted-trigger.js";

const config = parseTrustedTriggerConfig(
  "UOPENTAG",
  "bot:BALERT app:AALERT",
);

function envelope(event: Record<string, unknown>) {
  return { team_id: "T1", event_id: "Ev1", event };
}

describe("trusted rich Slack triggers", () => {
  it.each([
    ["attachment pretext", { attachments: [{ pretext: "<@UOPENTAG> investigate latency" }] }],
    ["attachment fallback", { attachments: [{ fallback: "Alert: <@UOPENTAG|opentag> inspect errors" }] }],
    ["block text", { blocks: [{ type: "section", text: { type: "mrkdwn", text: "<@UOPENTAG> summarize this alert" } }] }],
    ["rich user element", { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "UOPENTAG" }, { type: "text", text: " check the service" }] }] }] }],
    ["nested fields", { attachments: [{ fields: [{ title: "Owner", value: "<@UOPENTAG> review the incident" }] }] }],
  ])("accepts %s", (_name, rich) => {
    const event = {
      type: "message",
      subtype: "bot_message",
      channel: "C1",
      ts: "1.0",
      bot_id: "BALERT",
      ...rich,
    };
    expect(classifyTrustedRichTrigger(event, config)).toMatchObject({
      actor: { kind: "slack_automation", botId: "BALERT" },
    });
  });

  it.each([
    ["untrusted bot", { bot_id: "BOTHER", attachments: [{ text: "<@UOPENTAG> act" }] }],
    ["no exact mention", { bot_id: "BALERT", attachments: [{ text: "@opentag act" }] }],
    ["top-level only", { bot_id: "BALERT", text: "<@UOPENTAG> act" }],
    ["own bot", { bot_id: "BALERT", bot_profile: { user_id: "UOPENTAG" }, attachments: [{ text: "<@UOPENTAG> act" }] }],
    ["wrong subtype", { bot_id: "BALERT", subtype: "message_changed", attachments: [{ text: "<@UOPENTAG> act" }] }],
  ])("rejects %s", (_name, fields) => {
    expect(classifyTrustedRichTrigger({
      type: "message",
      channel: "C1",
      ts: "1.0",
      ...fields,
    }, config)).toBeUndefined();
  });

  it.each([
    "Heads up <@UOPENTAG>, the checkout error rate crossed the threshold",
    "Could <@UOPENTAG|assistant> inspect the new database saturation alert?",
  ])("accepts paraphrased alert text: %s", (text) => {
    expect(classifyTrustedRichTrigger({
      type: "message",
      subtype: "bot_message",
      channel: "C1",
      ts: "1.0",
      app_id: "AALERT",
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    }, config)?.displayText).toBeTruthy();
  });

  it("bounds cyclic and oversized payloads", () => {
    const cyclic: Record<string, unknown> = {
      text: "<@UOPENTAG> " + "x".repeat(50_000),
    };
    cyclic.elements = [cyclic];
    const result = extractRichDisplayText(
      { blocks: [cyclic, ...Array.from({ length: 500 }, () => cyclic)] },
      "UOPENTAG",
    );
    expect(result.hasMention).toBe(true);
    expect(result.displayText.length).toBeLessThanOrEqual(24_000);
  });

  it("does not treat hidden Block Kit action values as display mentions", () => {
    const event = {
      type: "message",
      subtype: "bot_message",
      channel: "C1",
      ts: "1.0",
      bot_id: "BALERT",
      blocks: [{
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "Open alert" },
          value: "<@UOPENTAG> hidden callback metadata",
        }],
      }],
    };
    expect(classifyTrustedRichTrigger(event, config)).toBeUndefined();
    expect(extractRichDisplayText(event, "UOPENTAG")).toEqual({
      hasMention: false,
      displayText: "Open alert",
    });
  });

  it("derives identical pre-admission and adapter identities without a Slack lookup", () => {
    const body = envelope({
      type: "message",
      subtype: "bot_message",
      channel: "C1",
      ts: "2.0",
      thread_ts: "1.0",
      app_id: "AALERT",
      attachments: [{ pretext: "<@UOPENTAG> inspect the database" }],
    });
    const pre = preAdmissionIdentityForEvent(body, config);
    const normalized = normalizeSlackEvent(body, "UOPENTAG", config);
    expect(pre).toMatchObject({
      conversationKey: "C1::1.0",
      actor: { kind: "slack_automation", appId: "AALERT" },
      requesterId: "app:AALERT",
      eventId: "Ev1",
    });
    expect(normalized).toMatchObject({
      kind: "turn",
      source: "trusted_rich_mention",
      channel: pre?.channelId,
      threadTs: pre?.threadTs,
      eventId: pre?.eventId,
      actor: pre?.actor,
    });
  });

  it("fails closed on invalid configuration", () => {
    const invalid = parseTrustedTriggerConfig(undefined, "bot:BALERT bad app:wrong");
    expect(trustedTriggerReadiness(invalid)).toMatchObject({
      ok: false,
      enabled: false,
      reason: "missing_target_id",
      actorCount: 1,
      invalidActorCount: 2,
    });
    expect(invalid.valid).toBe(false);
    expect(trustedRichTriggerDecision({
      type: "message",
      channel: "C1",
      ts: "1.0",
      bot_id: "BALERT",
      attachments: [{ text: "<@UOPENTAG> act" }],
    }, invalid)).toEqual({ reason: "missing_target_id" });
  });

  it("ignores bad allowlist entries, reports them, and keeps valid entries usable", () => {
    const mixed = parseTrustedTriggerConfig(
      "UOPENTAG",
      "bad bot:BALERT app:wrong",
    );
    expect(trustedTriggerReadiness(mixed)).toMatchObject({
      ok: true,
      enabled: true,
      reason: "ready",
      actorCount: 1,
      invalidActorCount: 2,
    });
    expect(classifyTrustedRichTrigger({
      type: "message",
      subtype: "bot_message",
      channel: "C1",
      ts: "1.0",
      bot_id: "BALERT",
      attachments: [{ text: "<@UOPENTAG> act" }],
    }, mixed)).toBeTruthy();
  });

  it("reports an invalid-only allowlist as a readiness failure", () => {
    const invalidOnly = parseTrustedTriggerConfig("UOPENTAG", "bad app:wrong");
    expect(invalidOnly.valid).toBe(false);
    expect(trustedTriggerReadiness(invalidOnly)).toEqual({
      ok: false,
      enabled: false,
      actorCount: 0,
      invalidActorCount: 2,
      reason: "invalid_config",
    });
  });
});
