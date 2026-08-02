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

  it("forwards the bounded handoff to an authenticated adapter and validates its receipt", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const adapter = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer adapter-secret");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          schemaVersion: 1,
          tenantId: "tenant-1",
          principalId: "principal-1",
          connectorId: "google_drive",
          provider: "google",
          marketplaceVersion: "v1",
          credentialRef: "credential:google-drive-1",
          providerSubject: "subject-1",
          scopes: ["drive.readonly"],
          version: 1,
          issuedAt: "2026-08-02T00:00:00.000Z",
          expiresAt: "2026-08-02T01:00:00.000Z",
        }, { status: 200 });
      },
    };
    const response = await oauthEffecterApp.fetch(
      new Request("https://effecter/callback", {
        method: "POST",
        headers: { authorization: "Bearer effecter-secret", "content-type": "application/json" },
        body: JSON.stringify(handoff),
      }),
      {
        OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret",
        OAUTH_PROVIDER_ADAPTER: adapter as never,
        OAUTH_PROVIDER_ADAPTER_AUTH_TOKEN: "adapter-secret",
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "completed" });
    expect(requestBody).toEqual({ schemaVersion: 1, handoff });
  });

  it("rejects a provider response that contains token-shaped material", async () => {
    const adapter = {
      fetch: async () => Response.json({
        schemaVersion: 1,
        tenantId: "tenant-1",
        principalId: "principal-1",
        connectorId: "google_drive",
        provider: "google",
        marketplaceVersion: "v1",
        credentialRef: "credential:google-drive-1",
        providerSubject: "subject-1",
        scopes: ["drive.readonly"],
        version: 1,
        issuedAt: "2026-08-02T00:00:00.000Z",
        accessToken: "must-not-cross-boundary",
      }),
    };
    const response = await oauthEffecterApp.fetch(
      new Request("https://effecter/callback", {
        method: "POST",
        headers: { authorization: "Bearer effecter-secret", "content-type": "application/json" },
        body: JSON.stringify(handoff),
      }),
      {
        OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret",
        OAUTH_PROVIDER_ADAPTER: adapter as never,
        OAUTH_PROVIDER_ADAPTER_AUTH_TOKEN: "adapter-secret",
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "oauth_adapter_receipt_field_invalid" });
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
