import { describe, expect, it } from "vitest";
import { provisioningAdapterApp } from "../workers/provisioning-adapter/src/index.js";

const request = {
  schemaVersion: 1,
  operation: "provision_step",
  requestId: "provision-1",
  idempotencyKey: "provision-key-1",
  externalPlatform: "slack",
  externalTenantId: "T_EXTERNAL",
  requestedByExternalSubject: "U_ADMIN",
  isolationMode: "shared_worker_per_tenant_do",
  custodyBackend: "external_kms",
  step: "tenant_locator",
  requestedAt: "2026-08-01T20:00:00.000Z",
};

function providerReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: request.idempotencyKey,
    step: request.step,
    outcome: "complete",
    retryable: false,
    externalReceiptRef: "bootstrap:tenant-locator-1",
    observedAt: "2026-08-01T20:00:01.000Z",
    ...overrides,
  };
}

describe("provisioning adapter Worker", () => {
  it("fails closed when internal auth is not configured", async () => {
    const response = await provisioningAdapterApp.request("/provision-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provisioning_adapter_auth_unconfigured" });
  });

  it("requires the internal bearer and a provider adapter", async () => {
    const response = await provisioningAdapterApp.request("/provision-step", {
      method: "POST",
      headers: {
        authorization: "Bearer bootstrap-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, { PROVISIONING_ADAPTER_AUTH_TOKEN: "bootstrap-token" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provisioning_provider_adapter_unconfigured" });
  });

  it("forwards only the step contract and validates the receipt", async () => {
    const calls: Request[] = [];
    const response = await provisioningAdapterApp.request("/provision-step", {
      method: "POST",
      headers: {
        authorization: "Bearer bootstrap-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, {
      PROVISIONING_ADAPTER_AUTH_TOKEN: "bootstrap-token",
      PROVISIONING_PROVIDER_ADAPTER_AUTH_TOKEN: "provider-token",
      PROVISIONING_PROVIDER_ADAPTER: {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          calls.push(new Request(input, init));
          return Promise.resolve(new Response(JSON.stringify(providerReceipt()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        },
      } as unknown as Fetcher,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "completed",
      receipt: { step: "tenant_locator", externalReceiptRef: "bootstrap:tenant-locator-1" },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    expect(call!.url).toBe("https://provisioning-provider-adapter/provision-step");
    expect(call!.headers.get("authorization")).toBe("Bearer provider-token");
    expect(await call!.json()).toEqual(request);
  });

  it("rejects a receipt for a different provisioning step", async () => {
    const response = await provisioningAdapterApp.request("/provision-step", {
      method: "POST",
      headers: {
        authorization: "Bearer bootstrap-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, {
      PROVISIONING_ADAPTER_AUTH_TOKEN: "bootstrap-token",
      PROVISIONING_PROVIDER_ADAPTER_AUTH_TOKEN: "provider-token",
      PROVISIONING_PROVIDER_ADAPTER: {
        fetch() {
          return Promise.resolve(new Response(JSON.stringify(providerReceipt({ step: "workspace_config" })), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        },
      } as unknown as Fetcher,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provisioning_adapter_receipt_mismatch" });
  });
});
