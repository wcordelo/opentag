import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import worker from "../src/worker.js";
import type { Env } from "../src/env.js";

function healthyNamespace() {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({ healthCheck: async () => ({ ok: true }) }),
  };
}

function env(overrides: Partial<Env> = {}): Env {
  const healthy = healthyNamespace();
  return {
    BOT_STATE: healthy as unknown as Env["BOT_STATE"],
    WORKSPACE_CONFIG: healthy as unknown as Env["WORKSPACE_CONFIG"],
    KNOWLEDGE: healthy as unknown as Env["KNOWLEDGE"],
    SESSION_EVENTS: healthy as unknown as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    DEFERRED_INGRESS: healthy as unknown as Env["DEFERRED_INGRESS"],
    SLACK_RATE_LIMIT: healthy as unknown as Env["SLACK_RATE_LIMIT"],
    AGENT_URL: "https://agent.example.test",
    ...overrides,
  };
}

describe("trusted rich trigger readiness", () => {
  it("keeps the optional feature healthy when disabled", async () => {
    const response = await worker.fetch(
      new Request("https://worker/health"),
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      trustedRichMention: {
        ok: true,
        enabled: false,
        reason: "disabled",
      },
    });
  });

  it.each([
    {
      vars: {
        SLACK_BOT_USER_ID: "UOPENTAG",
        SLACK_TRUSTED_TRIGGER_ACTORS: "bad app:wrong",
      },
      reason: "invalid_config",
    },
    {
      vars: {
        SLACK_TRUSTED_TRIGGER_ACTORS: "bot:BALERT",
      },
      reason: "missing_target_id",
    },
  ])("fails readiness for $reason", async ({ vars, reason }) => {
    const response = await worker.fetch(
      new Request("https://worker/health"),
      env(vars),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      trustedRichMention: {
        ok: false,
        enabled: false,
        reason,
      },
    });
  });
});
