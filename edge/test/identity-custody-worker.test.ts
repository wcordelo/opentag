import { describe, expect, it } from "vitest";
import { identityCustodyApp } from "../workers/identity-custody/src/index.js";

const request = {
  schemaVersion: 1,
  operation: "provision",
  tenantId: "tenant-1",
  identityRef: "identity:tenant-1:agent",
  backend: "external_kms",
  version: 1,
  idempotencyKey: "identity-provision-1",
  requestedAt: "2026-08-01T20:00:00.000Z",
};

describe("identity custody Worker", () => {
  it("fails closed when its internal auth is not configured", async () => {
    const response = await identityCustodyApp.request("/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "identity_custody_auth_unconfigured" });
  });

  it("requires the internal bearer and never calls an absent provider adapter", async () => {
    const response = await identityCustodyApp.request("/identity", {
      method: "POST",
      headers: {
        authorization: "Bearer custody-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, { IDENTITY_CUSTODY_AUTH_TOKEN: "custody-token" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "identity_provider_adapter_unconfigured" });
  });

  it("validates and correlates the adapter receipt without exposing request data in errors", async () => {
    const calls: Request[] = [];
    const response = await identityCustodyApp.request("/identity", {
      method: "POST",
      headers: {
        authorization: "Bearer custody-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, {
      IDENTITY_CUSTODY_AUTH_TOKEN: "custody-token",
      IDENTITY_PROVIDER_ADAPTER_AUTH_TOKEN: "provider-token",
      IDENTITY_PROVIDER_ADAPTER: {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          calls.push(new Request(input, init));
          return Promise.resolve(new Response(JSON.stringify({
            schemaVersion: 1,
            operation: "provision",
            tenantId: "tenant-1",
            identityRef: "identity:tenant-1:agent",
            backend: "external_kms",
            version: 1,
            externalReceiptRef: "identity-receipt:provider-1",
            observedAt: "2026-08-01T20:00:01.000Z",
            publicKey: "ed25519:public-key",
          }), { status: 200, headers: { "content-type": "application/json" } }));
        },
      } as unknown as Fetcher,
    });
    expect(response.status).toBe(202);
    expect((await response.json() as { receipt: { publicKey: string } }).receipt.publicKey)
      .toBe("ed25519:public-key");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    expect(call!.headers.get("authorization")).toBe("Bearer provider-token");
    expect(await call!.json()).toEqual(request);
  });
});
