import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type Stub = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

async function post(stub: Stub, path: string, body: unknown): Promise<{
  response: Response;
  body: Record<string, unknown>;
}> {
  const response = await stub.fetch(`https://oauth-state${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("OAuthStateDO in workerd", () => {
  it("stores only hashed state and consumes it exactly once", async () => {
    const stub = env.OAUTH_STATE!.get(
      env.OAUTH_STATE!.idFromName(`oauth-workers-${crypto.randomUUID()}`),
    ) as unknown as Stub;
    const issue = await post(stub, "/issue", {
      schemaVersion: 1,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://app.example.test/oauth/callback",
      scopes: ["drive.readonly"],
    });
    expect(issue.response.status).toBe(200);
    expect(issue.body.state).toEqual(expect.any(String));
    expect(issue.body.nonce).toEqual(expect.any(String));
    expect(issue.body.expiresAt).toEqual(expect.any(String));

    const consumeRequest = {
      schemaVersion: 1,
      state: issue.body.state,
      nonce: issue.body.nonce,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://app.example.test/oauth/callback",
    };
    const consumed = await post(stub, "/consume", consumeRequest);
    expect(consumed.response.status).toBe(200);
    expect(consumed.body).toMatchObject({
      tenantId: "tenant-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      scopes: ["drive.readonly"],
    });
    expect(consumed.body).not.toHaveProperty("state");
    expect(consumed.body).not.toHaveProperty("nonce");

    const replay = await post(stub, "/consume", consumeRequest);
    expect(replay.response.status).toBe(409);
    expect(replay.body.error).toBe("oauth_state_replayed");
  });

  it("rejects a mismatched nonce without consuming the valid state", async () => {
    const stub = env.OAUTH_STATE!.get(
      env.OAUTH_STATE!.idFromName(`oauth-workers-${crypto.randomUUID()}`),
    ) as unknown as Stub;
    const issue = await post(stub, "/issue", {
      schemaVersion: 1,
      tenantId: "tenant-2",
      principalId: "principal-2",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://admin.example.test/oauth/callback",
      scopes: [],
    });
    expect(issue.response.status).toBe(200);
    expect(issue.body.state).toEqual(expect.any(String));
    const base = {
      schemaVersion: 1,
      state: issue.body.state,
      tenantId: "tenant-2",
      principalId: "principal-2",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://admin.example.test/oauth/callback",
    };
    const mismatch = await post(stub, "/consume", { ...base, nonce: "1234567890abcdef" });
    expect(mismatch.response.status).toBe(400);
    expect(mismatch.body.error).toBe("oauth_nonce_mismatch");
    const valid = await post(stub, "/consume", { ...base, nonce: issue.body.nonce });
    expect(valid.response.status).toBe(200);
  });
});
