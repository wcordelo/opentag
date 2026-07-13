import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
vi.mock("../src/bot-engine.js", () => ({
  getOrCreateBot: vi.fn(),
}));

const { quickActionEventId } = await import("../src/slack/quick-actions.js");

describe("quick action ingress identity", () => {
  const standard = {
    type: "block_actions",
    channel: { id: "C1" },
    message: { ts: "100.001", thread_ts: "99.000" },
    actions: [{ action_id: "quick:retry", action_ts: "101.002" }],
  };

  it("is stable across redelivery and distinguishes standard clicks", () => {
    expect(quickActionEventId(standard)).toBe("quick:C1:100.001:101.002");
    expect(quickActionEventId(structuredClone(standard))).toBe(
      "quick:C1:100.001:101.002",
    );
    expect(quickActionEventId({
      ...standard,
      actions: [{ ...standard.actions[0], action_ts: "101.003" }],
    })).toBe("quick:C1:100.001:101.003");
  });

  it("rejects identity-less clicks instead of using trigger_id or randomness", () => {
    expect(quickActionEventId({
      ...standard,
      trigger_id: "not-a-click-identity",
      actions: [{ action_id: "quick:retry" }],
    })).toBeUndefined();
    expect(quickActionEventId({
      ...standard,
      trigger_id: "not-a-click-identity",
      message: {},
    })).toBeUndefined();
  });
});
