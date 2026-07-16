import { describe, expect, it, vi } from "vitest";
import {
  hydrateLateFileRefs,
  lateFileRepairDedupeKey,
  matchLateFileEvent,
  needsFileInfoHydration,
  pendingLateFileKey,
  waitForLateFileThreadIdle,
} from "../src/slack/late-file-repair.js";

describe("late file repair primitives", () => {
  const pending = {
    teamId: "T1", channelId: "C1", userId: "U1",
    mentionTs: "100.000", threadTs: "99.000", eventId: "Ev1", expiresAt: 120_000,
  };

  it("correlates a bounded same-user upload and derives durable keys", () => {
    const event = {
      teamId: "T1", channelId: "C1", userId: "U1", fileTs: "110.000",
      threadTs: "99.000", files: [{ id: "F1" }],
    };
    expect(matchLateFileEvent(pending, event, 110_000)).toBe(true);
    expect(pendingLateFileKey(pending)).toBe("late-file:T1:C1:U1");
    expect(lateFileRepairDedupeKey(pending, event)).toBe("late-file-repair:Ev1:110.000:F1");
  });

  it("rejects cross-user and expired uploads and identifies file_info repair", () => {
    expect(matchLateFileEvent(pending, { teamId: "T1", channelId: "C1", userId: "U2", fileTs: "101", files: [{ id: "F1" }] }, 101_000)).toBe(false);
    expect(matchLateFileEvent(pending, { teamId: "T1", channelId: "C1", userId: "U1", fileTs: "101", files: [{ id: "F1" }] }, 130_000)).toBe(false);
    expect(needsFileInfoHydration({ id: "F1" })).toBe(true);
  });

  it("hydrates incomplete Slack file rows before synthetic handoff", async () => {
    const lookup = vi.fn(async () => ({
      id: "F1",
      name: "report.pdf",
      mimetype: "application/pdf",
      size: 7,
      url_private: "https://files.slack.com/F1",
    }));
    await expect(hydrateLateFileRefs([{ id: "F1", name: "report.pdf" }], lookup))
      .resolves.toEqual([expect.objectContaining({
        id: "F1",
        mimetype: "application/pdf",
        size: 7,
        url_private: "https://files.slack.com/F1",
      })]);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith("F1");
  });

  it("waits for exact thread idle with a bounded polling loop", async () => {
    const isBusy = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const sleep = vi.fn(async () => undefined);
    await expect(waitForLateFileThreadIdle(isBusy, { timeoutMs: 1_000, pollMs: 1, sleep }))
      .resolves.toBe(true);
    expect(isBusy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
