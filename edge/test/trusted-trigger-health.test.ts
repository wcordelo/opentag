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
    ENVIRONMENT: "test",
    BOT_STATE: healthy as unknown as Env["BOT_STATE"],
    WORKSPACE_CONFIG: healthy as unknown as Env["WORKSPACE_CONFIG"],
    KNOWLEDGE: healthy as unknown as Env["KNOWLEDGE"],
    SESSION_EVENTS: healthy as unknown as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    DEFERRED_INGRESS: healthy as unknown as Env["DEFERRED_INGRESS"],
    SLACK_RATE_LIMIT: healthy as unknown as Env["SLACK_RATE_LIMIT"],
    AGENT_RUNTIME: {
      fetch: async () => new Response("ok"),
    } as unknown as Env["AGENT_RUNTIME"],
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

  it("keeps liveness separate from strict readiness", async () => {
    const health = await worker.fetch(
      new Request("https://worker/health"),
      env(),
    );
    expect(health.status).toBe(200);

    const ready = await worker.fetch(
      new Request("https://worker/ready"),
      env(),
    );
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      ok: false,
      profile: "core",
      blockers: expect.arrayContaining([
        "slackBotToken",
        "slackSigningSecret",
        "agentModel",
        "knowledgeQueue",
      ]),
    });
  });

  it("uses the full profile by default for production and accepts explicit diagnostics", async () => {
    const production = env({
      ENVIRONMENT: "production",
      ADMIN_SECRET: "test-admin",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "signing-secret",
      AGENT_MODEL: "gpt-5.6-sol",
      AGENT_RUNTIME: {
        fetch: async () => new Response("ok"),
      } as unknown as Env["AGENT_RUNTIME"],
      KNOWLEDGE_QUEUE: {} as Env["KNOWLEDGE_QUEUE"],
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge-dlq",
      WORKSPACE_CONFIG: healthyNamespace() as unknown as Env["WORKSPACE_CONFIG"],
      KNOWLEDGE: healthyNamespace() as unknown as Env["KNOWLEDGE"],
      DEFERRED_INGRESS: healthyNamespace() as unknown as Env["DEFERRED_INGRESS"],
      SLACK_RATE_LIMIT: healthyNamespace() as unknown as Env["SLACK_RATE_LIMIT"],
      DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
      SESSION_EVENTS: healthyNamespace() as unknown as Env["SESSION_EVENTS"],
      BOT_STATE: healthyNamespace() as unknown as Env["BOT_STATE"],
    });

    const full = await worker.fetch(new Request("https://worker/ready", {
      headers: { Authorization: "Bearer test-admin" },
    }), production);
    expect(full.status).toBe(503);
    await expect(full.json()).resolves.toMatchObject({
      profile: "full",
      blockers: expect.arrayContaining(["knowledgeSearchService", "buzzWake"]),
    });

    const core = await worker.fetch(
      new Request("https://worker/ready?profile=core", {
        headers: { Authorization: "Bearer test-admin" },
      }),
      production,
    );
    expect(core.status).toBe(200);
    await expect(core.json()).resolves.toMatchObject({
      ok: true,
      profile: "core",
      blockers: [],
    });
  });

  it("requires admin auth for production readiness and does not silently downgrade an unset environment", async () => {
    const production = env({
      ENVIRONMENT: "",
      ADMIN_SECRET: "test-admin",
    });
    const unauthorized = await worker.fetch(
      new Request("https://worker/ready"),
      production,
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await worker.fetch(
      new Request("https://worker/ready", {
        headers: { Authorization: "Bearer test-admin" },
      }),
      production,
    );
    expect(authorized.status).toBe(503);
    await expect(authorized.json()).resolves.toMatchObject({
      profile: "full",
      blockers: expect.arrayContaining(["environment"]),
    });

    const staging = await worker.fetch(
      new Request("https://worker/ready", {
        headers: { Authorization: "Bearer test-admin" },
      }),
      env({ ENVIRONMENT: "staging", ADMIN_SECRET: "test-admin" }),
    );
    expect(staging.status).toBe(503);
    await expect(staging.json()).resolves.toMatchObject({
      blockers: expect.arrayContaining(["environment"]),
    });
  });

  it("rejects an unknown readiness profile without probing dependencies", async () => {
    const response = await worker.fetch(
      new Request("https://worker/ready?profile=unknown"),
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_readiness_profile",
      profiles: ["core", "knowledge", "full"],
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
