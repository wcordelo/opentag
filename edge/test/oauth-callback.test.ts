import { describe, expect, it, vi } from "vitest";
import { oauthCallbackApp } from "../workers/oauth-callback/src/index.js";

const state = "state-1234567890123456";
const nonce = "nonce-1234567890123456";

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://oauth.example.com/oauth/callback?${query}`, { headers });
}

describe("OAuth callback handoff", () => {
  it("reports the boundary as disabled until origin, auth, and effecter are configured", async () => {
    const response = await oauthCallbackApp.fetch(new Request("https://oauth.example.com/health"), {});
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      providerExchangeEnabled: false,
    });
  });

  it("forwards a bounded code and nonce without persisting provider material", async () => {
    let body: Record<string, unknown> | undefined;
    const effecter = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer effecter-secret");
        return Response.json({ accepted: true }, { status: 202 });
      }),
    };
    const response = await oauthCallbackApp.fetch(
      request(`state=${state}&code=provider-code` , { cookie: `opentag_oauth_nonce=${nonce}` }),
      {
        OAUTH_CALLBACK_ORIGIN: "https://oauth.example.com",
        OAUTH_EFFECTER: effecter as never,
        OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret",
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "accepted" });
    expect(body).toMatchObject({
      schemaVersion: 1,
      state,
      nonce,
      code: "provider-code",
      callbackOrigin: "https://oauth.example.com",
    });
  });

  it("rejects missing nonce, conflicting results, and missing effecter", async () => {
    const env = {
      OAUTH_CALLBACK_ORIGIN: "https://oauth.example.com",
      OAUTH_EFFECTER: { fetch: vi.fn() } as never,
      OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret",
    };
    const noNonce = await oauthCallbackApp.fetch(request(`state=${state}&code=provider-code`), env);
    expect(noNonce.status).toBe(400);
    await expect(noNonce.json()).resolves.toEqual({ error: "oauth_state_invalid" });

    const conflict = await oauthCallbackApp.fetch(
      request(`state=${state}&code=provider-code&error=access_denied`, { cookie: `opentag_oauth_nonce=${nonce}` }),
      env,
    );
    expect(conflict.status).toBe(400);
    await expect(conflict.json()).resolves.toEqual({ error: "oauth_result_conflict" });

    const unavailable = await oauthCallbackApp.fetch(
      request(`state=${state}&code=provider-code`, { cookie: `opentag_oauth_nonce=${nonce}` }),
      { OAUTH_CALLBACK_ORIGIN: "https://oauth.example.com", OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret" },
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "oauth_effecter_unavailable" });
  });

  it("fails closed on an unexpected callback origin", async () => {
    const response = await oauthCallbackApp.fetch(
      new Request(`https://other.example.com/oauth/callback?state=${state}&code=provider-code`, {
        headers: { cookie: `opentag_oauth_nonce=${nonce}` },
      }),
      {
        OAUTH_CALLBACK_ORIGIN: "https://oauth.example.com",
        OAUTH_EFFECTER: { fetch: vi.fn() } as never,
        OAUTH_EFFECTER_AUTH_TOKEN: "effecter-secret",
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "oauth_callback_origin_mismatch" });
  });
});
