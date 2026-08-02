import { describe, expect, it } from "vitest";
import { memoryDeletionApp } from "../workers/memory-deletion/src/index.js";

const request = {
  schemaVersion: 1,
  operation: "delete",
  requestId: "deletion-1",
  idempotencyKey: "memory-delete:T1:deletion-1:slack:T1:C1:123",
  tenantId: "T1",
  sourceKey: "slack:T1:C1:123",
  deletionEpoch: 2,
  requestedAt: "2026-08-01T20:00:00.000Z",
};

function providerReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: request.idempotencyKey,
    requestId: request.requestId,
    tenantId: request.tenantId,
    sourceKey: request.sourceKey,
    deletionEpoch: request.deletionEpoch,
    status: "deleted",
    observedAt: "2026-08-01T20:00:01.000Z",
    receiptRef: "memory-provider:deletion-1",
    ...overrides,
  };
}

describe("memory deletion Worker", () => {
  it("fails closed when internal auth is not configured", async () => {
    const response = await memoryDeletionApp.request("/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "memory_deletion_auth_unconfigured" });
  });

  it("requires the internal bearer and an approved provider adapter", async () => {
    const response = await memoryDeletionApp.request("/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer deletion-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, { MEMORY_DELETION_AUTH_TOKEN: "deletion-token" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "memory_provider_adapter_unconfigured" });
  });

  it("forwards only the bounded source request and validates the provider receipt", async () => {
    const calls: Request[] = [];
    const response = await memoryDeletionApp.request("/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer deletion-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, {
      MEMORY_DELETION_AUTH_TOKEN: "deletion-token",
      MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN: "provider-token",
      MEMORY_PROVIDER_ADAPTER: {
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
      receipt: { status: "deleted", receiptRef: "memory-provider:deletion-1" },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    expect(call!.url).toBe("https://memory-provider-adapter/delete");
    expect(call!.headers.get("authorization")).toBe("Bearer provider-token");
    expect(await call!.json()).toEqual(request);
  });

  it("does not accept a provider receipt for another tenant, source, or epoch", async () => {
    const response = await memoryDeletionApp.request("/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer deletion-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, {
      MEMORY_DELETION_AUTH_TOKEN: "deletion-token",
      MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN: "provider-token",
      MEMORY_PROVIDER_ADAPTER: {
        fetch() {
          return Promise.resolve(new Response(JSON.stringify(providerReceipt({ tenantId: "other-tenant" })), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        },
      } as unknown as Fetcher,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "memory_deletion_receipt_mismatch" });
  });

  it("rejects provider payloads that try to smuggle memory content", async () => {
    const response = await memoryDeletionApp.request("/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer deletion-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }, {
      MEMORY_DELETION_AUTH_TOKEN: "deletion-token",
      MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN: "provider-token",
      MEMORY_PROVIDER_ADAPTER: {
        fetch() {
          return Promise.resolve(new Response(JSON.stringify({
            ...providerReceipt(),
            content: "never store or return this",
          }), { status: 200 }));
        },
      } as unknown as Fetcher,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "memory_deletion_source_receipt_field_invalid" });
  });
});
