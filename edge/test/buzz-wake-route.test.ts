/**
 * HTTP route boundary for POST /buzz/wake auth-tag fail-closed contract.
 * Pins the specific 503 code (not just fall-through buzz_receive_not_configured).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import worker from "../src/worker.js";
import type { Env } from "../src/env.js";
import { randomPrivateKeyHex } from "../src/buzz/nostr-crypto.js";

function healthyNamespace() {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({ healthCheck: async () => ({ ok: true }) }),
  };
}

function wakeEnv(overrides: Partial<Env> = {}): Env {
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
    BUZZ_OPEN_TAG_SIGNER_SECRET: randomPrivateKeyHex(),
    BUZZ_RELAY_HTTP_BASE_URL: "https://berendo.communities.buzz.xyz",
    BUZZ_CHANNEL_TENANT_MAP: JSON.stringify({
      "80d210c7-6cf2-49b3-8dab-06cbee389c04":
        "11111111-1111-4111-8111-111111111111",
    }),
    ...overrides,
  };
}

async function postWake(env: Env): Promise<Response> {
  return worker.fetch(
    new Request("https://worker/buzz/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Body unread when auth-tag shape fails during deps build.
      body: JSON.stringify({}),
    }),
    env,
  );
}

describe("POST /buzz/wake auth-tag route boundary", () => {
  it("returns 503 buzz_auth_tag_invalid_shape for malformed AUTH_TAG", async () => {
    const response = await postWake(
      wakeEnv({ BUZZ_OPEN_TAG_AUTH_TAG: "not-a-tag" }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: "buzz_auth_tag_invalid_shape",
    });
  });

  it("returns 503 buzz_auth_tag_invalid_shape for whitespace-only AUTH_TAG", async () => {
    const response = await postWake(
      wakeEnv({ BUZZ_OPEN_TAG_AUTH_TAG: "   \t\n  " }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: "buzz_auth_tag_invalid_shape",
    });
  });

  it("does not collapse malformed AUTH_TAG into buzz_receive_not_configured", async () => {
    const response = await postWake(
      wakeEnv({ BUZZ_OPEN_TAG_AUTH_TAG: '["auth","short","",""]' }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("buzz_auth_tag_invalid_shape");
    expect(body.error).not.toBe("buzz_receive_not_configured");
  });
});
