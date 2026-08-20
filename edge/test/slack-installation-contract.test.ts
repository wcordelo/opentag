import { describe, expect, it } from "vitest";
import {
  assessSlackManifestCoverage,
  extractSlackManifestCapabilities,
  slackManifestCoverageReceipt,
  SLACK_REQUIRED_BOT_EVENTS,
  SLACK_REQUIRED_BOT_SCOPES,
  validateSlackManifestReadback,
} from "../src/slack/installation-contract.js";

const observedAt = "2026-08-02T22:30:00.000Z";

function completeReadback(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    teamId: "T0BBBEDLEGY",
    botUserId: "U0BAK4AJ2Q1",
    botScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    botEvents: [...SLACK_REQUIRED_BOT_EVENTS],
    observedAt,
    ...overrides,
  };
}

describe("Slack installation coverage contract", () => {
  it("normalizes capability order and reports complete coverage", async () => {
    const readback = validateSlackManifestReadback(completeReadback({
      botScopes: [...SLACK_REQUIRED_BOT_SCOPES].reverse(),
      botEvents: [...SLACK_REQUIRED_BOT_EVENTS].reverse(),
    }));
    expect(readback.botScopes).toEqual([...SLACK_REQUIRED_BOT_SCOPES].sort());
    expect(readback.botEvents).toEqual([...SLACK_REQUIRED_BOT_EVENTS].sort());
    expect(assessSlackManifestCoverage(readback)).toEqual({
      status: "complete",
      missingScopes: [],
      missingEvents: [],
    });
    const receipt = await slackManifestCoverageReceipt(readback);
    expect(receipt.status).toBe("complete");
    expect(receipt.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reports missing capabilities without treating extras as completion", () => {
    const readback = validateSlackManifestReadback(completeReadback({
      botScopes: ["channels:history", "reactions:read", "unexpected:scope"],
      botEvents: ["message.channels", "reaction_added", "unexpected_event"],
    }));
    expect(assessSlackManifestCoverage(readback)).toMatchObject({
      status: "incomplete",
      missingScopes: expect.arrayContaining(["groups:history", "users.profile:read"]),
      missingEvents: expect.arrayContaining(["message.groups", "tokens_revoked"]),
    });
  });

  it("extracts only the bot capabilities from a Slack manifest response", () => {
    expect(extractSlackManifestCapabilities({
      display_information: { name: "OpenTag" },
      oauth_config: { scopes: { user: ["chat:write"], bot: ["channels:history"] } },
      settings: {
        event_subscriptions: {
          request_url: "https://example.test/slack/events",
          bot_events: ["message.channels"],
        },
      },
    })).toEqual({
      botScopes: ["channels:history"],
      botEvents: ["message.channels"],
    });
  });

  it("keeps the capability digest stable across freshness observations", async () => {
    const first = await slackManifestCoverageReceipt(completeReadback({
      observedAt: "2026-08-02T22:30:00.000Z",
    }));
    const later = await slackManifestCoverageReceipt(completeReadback({
      observedAt: "2026-08-02T22:31:00.000Z",
    }));
    expect(later.manifestDigest).toBe(first.manifestDigest);
    expect(later.observedAt).not.toBe(first.observedAt);
  });

  it("rejects duplicate or extra fields before a receipt can be recorded", () => {
    expect(() => validateSlackManifestReadback(completeReadback({
      botEvents: [...SLACK_REQUIRED_BOT_EVENTS, "message.channels"],
    }))).toThrow("bot_events_duplicate");
    expect(() => validateSlackManifestReadback({
      ...completeReadback(),
      token: "xoxb-never-store-this",
    })).toThrow("slack_manifest_readback_field_invalid");
  });
});
