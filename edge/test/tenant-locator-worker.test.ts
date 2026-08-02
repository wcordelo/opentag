import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
import worker from "../src/worker.js";
import type { Env } from "../src/env.js";
import { deriveInternalTenantId } from "../src/platform/tenant-id.js";

function platformStateNamespace(calls: string[], bodies: Record<string, unknown>[] = []) {
  return {
    idFromName: (name: string) => name,
    get: (objectName: string) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${objectName}:${path}`);
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        if (path === "/tenant-locator/resolve") {
          return Response.json({ status: "not_found" });
        }
        return Response.json({ ok: true });
      },
    }),
  };
}

describe("tenant locator provisioning integration", () => {
  it("registers the external mapping before forwarding tenant provisioning", async () => {
    const calls: string[] = [];
    const request = {
      schemaVersion: 1,
      requestId: "worker-request-1",
      idempotencyKey: "worker-install-1",
      externalPlatform: "slack",
      externalTenantId: "T-worker",
      requestedByExternalSubject: "U-admin",
      isolationMode: "shared_worker_per_tenant_do",
      custodyBackend: "external_kms",
      requestedAt: "2026-08-01T20:00:00.000Z",
    } as const;
    const tenantId = await deriveInternalTenantId(request);
    const env = {
      ENVIRONMENT: "development",
      PLATFORM_STATE: platformStateNamespace(calls),
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://worker/admin/platform/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "__platform_marketplace__:/tenant-locator/resolve",
      "__platform_marketplace__:/tenant-locator",
      `tenant:${tenantId}:/provision`,
    ]);
  });

  it("routes identity-link lookup through the tenant object without forwarding the routing field", async () => {
    const calls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const env = {
      ENVIRONMENT: "development",
      PLATFORM_STATE: platformStateNamespace(calls, bodies),
    } as unknown as Env;
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const response = await worker.fetch(
      new Request("https://worker/admin/platform/identity-link/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          schemaVersion: 1,
          platform: "slack",
          platformTenantId: "T-worker",
          platformSubjectId: "U-worker",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([`tenant:${tenantId}:/identity-link/resolve`]);
    expect(bodies[0]).not.toHaveProperty("tenantId");
  });
});
