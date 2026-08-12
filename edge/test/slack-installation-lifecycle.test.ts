import { describe, expect, it } from "vitest";
import {
  slackLifecycleChannelStatus,
  slackLifecycleEventDisablesChannel,
  slackLifecycleEventDisablesInstallation,
  slackLifecycleEventFromCallback,
} from "../src/slack/installation-lifecycle.js";

describe("Slack installation lifecycle events", () => {
  it("recognizes workspace-wide uninstall and token revocation without inventing a channel", () => {
    for (const eventType of ["app_uninstalled", "tokens_revoked"] as const) {
      expect(slackLifecycleEventFromCallback({
        type: "event_callback",
        team_id: "T1",
        event_id: `Ev-${eventType}`,
        event_time: 1710000000,
        event: { type: eventType },
      })).toEqual({
        teamId: "T1",
        eventId: `Ev-${eventType}`,
        eventType,
        observedAt: "2024-03-09T16:00:00.000Z",
      });
      expect(slackLifecycleEventDisablesInstallation(eventType)).toBe(true);
    }
  });

  it("recognizes channel lifecycle events and requires their channel", () => {
    expect(slackLifecycleEventFromCallback({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvArchive",
      event: { type: "channel_archive", channel: "C1", event_ts: "1710000000.100000" },
    })).toMatchObject({
      teamId: "T1",
      eventId: "EvArchive",
      eventType: "channel_archive",
      channelId: "C1",
    });
    expect(slackLifecycleEventDisablesChannel("channel_archive")).toBe(true);
    expect(slackLifecycleEventDisablesChannel("channel_unarchive")).toBe(false);
    expect(slackLifecycleEventFromCallback({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvMissingChannel",
      event: { type: "channel_left" },
    })).toBeUndefined();
  });

  it("covers private-channel lifecycle events without re-enabling sources", () => {
    for (const eventType of [
      "group_archive",
      "group_unarchive",
      "group_deleted",
      "group_close",
      "group_open",
      "group_left",
      "channel_deleted",
      "channel_unshared",
    ] as const) {
      expect(slackLifecycleEventFromCallback({
        type: "event_callback",
        team_id: "T1",
        event_id: `Ev-${eventType}`,
        event: { type: eventType, channel: "G1" },
      })).toMatchObject({ eventType, channelId: "G1" });
    }
    expect(slackLifecycleEventDisablesChannel("group_archive")).toBe(true);
    expect(slackLifecycleEventDisablesChannel("group_unarchive")).toBe(false);
    expect(slackLifecycleEventDisablesChannel("group_open")).toBe(false);
    expect(slackLifecycleChannelStatus("group_archive")).toBe("archived");
    expect(slackLifecycleChannelStatus("group_unarchive")).toBe("active");
    expect(slackLifecycleChannelStatus("group_open")).toBe("active");
    expect(slackLifecycleChannelStatus("group_left")).toBe("left");
  });

  it("does not revoke the installation for a user-only OAuth token event", () => {
    expect(slackLifecycleEventFromCallback({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvUserToken",
      event: { type: "tokens_revoked", tokens: { oauth: ["U1"], bot: [] } },
    })).toBeUndefined();
    expect(slackLifecycleEventFromCallback({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvBotToken",
      event: { type: "tokens_revoked", tokens: { bot: ["Ubot"] } },
    }, "Ubot")).toMatchObject({ eventType: "tokens_revoked" });
    expect(slackLifecycleEventFromCallback({
      type: "event_callback",
      team_id: "T1",
      event_id: "EvOtherBotToken",
      event: { type: "tokens_revoked", tokens: { bot: ["Uother"] } },
    }, "Ubot")).toBeUndefined();
  });

  it("only treats the bot's own membership departure as a channel lifecycle event", () => {
    const callback = {
      type: "event_callback" as const,
      team_id: "T1",
      event_id: "EvMemberLeft",
      event: { type: "member_left_channel", channel: "C1", user: "Ubot" },
    };
    expect(slackLifecycleEventFromCallback(callback, "Uother")).toBeUndefined();
    expect(slackLifecycleEventFromCallback(callback, "Ubot")).toMatchObject({
      eventType: "member_left_channel",
      channelId: "C1",
    });
  });
});
