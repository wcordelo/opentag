import { describe, expect, it } from "vitest";
import { probeDurabilityHealth } from "../src/health.js";

function namespace(healthCheck: () => Promise<unknown>) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({ healthCheck }),
  };
}

describe("durability health", () => {
  it("is healthy only when both required bindings answer", async () => {
    await expect(probeDurabilityHealth({
      BOT_STATE: namespace(async () => ({ ok: true })) as never,
      SESSION_EVENTS: namespace(async () => ({ ok: true })) as never,
      DEFERRED_INGRESS: namespace(async () => ({ ok: true })) as never,
      SLACK_RATE_LIMIT: namespace(async () => ({ ok: true })) as never,
    }, 10)).resolves.toEqual({
      ok: true,
      checks: {
        botState: "ok",
        sessionEvents: "ok",
        deferredIngress: "ok",
        slackRateLimit: "ok",
      },
    });
  });

  it("reports a broken SessionEventDO binding instead of static green metadata", async () => {
    await expect(probeDurabilityHealth({
      BOT_STATE: namespace(async () => ({ ok: true })) as never,
      SESSION_EVENTS: namespace(async () => { throw new Error("binding broken"); }) as never,
      DEFERRED_INGRESS: namespace(async () => ({ ok: true })) as never,
      SLACK_RATE_LIMIT: namespace(async () => ({ ok: true })) as never,
    }, 10)).resolves.toEqual({
      ok: false,
      checks: {
        botState: "ok",
        sessionEvents: "error",
        deferredIngress: "ok",
        slackRateLimit: "ok",
      },
    });
  });
});
