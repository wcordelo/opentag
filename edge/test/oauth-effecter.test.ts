import { describe, expect, it } from "vitest";
import { oauthEffecterApp } from "../workers/oauth-effecter/src/index.js";

const handoff = {
  schemaVersion: 1,
  state: "state-1234567890123456",
  nonce: "nonce-1234567890123456",
  callbackOrigin: "https://oauth.example.com",
  receivedAt: "2026-08-02T00:00:00.000Z",
  code: "provider-code",
};

describe("OAuth effecter boundary", () => {
  it("fails closed until an auth token and provider adapter are configured", async () => {
    const missing = await oauthEffecterApp.fetch(
      new Request("https://effecter/callback", { method: "POST", body: JSON.stringify(handoff) }),
      {},
    );
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toEqual({ error: "oauth_effecter_unconfigured" });

    const unconfigured = await oauthEffecterApp.fetch(
      new Request("https://effecter/callback", {
        method: "POST",
        headers: { authorization: "Bearer effecter-secret", "content-type": "application/json" },
        body: JSON.stringify(handoff),
      }),
      { OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret" },
    );
    expect(unconfigured.status).toBe(503);
    await expect(unconfigured.json()).resolves.toEqual({ error: "oauth_provider_adapter_unconfigured" });
  });

  it("rejects invalid handoffs without exposing body details", async () => {
    const response = await oauthEffecterApp.fetch(
      new Request("https://effecter/callback", {
        method: "POST",
        headers: { authorization: "Bearer effecter-secret", "content-type": "application/json" },
        body: JSON.stringify({ ...handoff, accessToken: "should-not-be-accepted" }),
      }),
      { OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret" },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "oauth_callback_field_invalid" });
  });
});
