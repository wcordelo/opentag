import { describe, expect, it } from "vitest";
import {
  PlatformStateTenantLocatorReader,
  TENANT_LOCATOR_SCHEMA_VERSION,
  TenantLocatorContractError,
  validateTenantLocatorRecord,
  validateTenantLocatorResolution,
} from "../src/platform/tenant-locator.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTIVE = {
  schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
  platform: "slack" as const,
  platformTenantId: "T1",
  tenantId: TENANT,
  version: 2,
  status: "active" as const,
  updatedAt: "2026-08-01T20:00:00.000Z",
};

describe("tenant locator contract", () => {
  it("accepts only canonical, metadata-only active records", () => {
    const record = validateTenantLocatorRecord(ACTIVE);
    expect(record).toEqual(ACTIVE);
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => validateTenantLocatorRecord({
      ...ACTIVE,
      tenantId: "tenant:T1",
    })).toThrow(new TenantLocatorContractError("tenant_id_invalid"));
    expect(() => validateTenantLocatorRecord({
      ...ACTIVE,
      token: "provider-token",
    })).toThrow(new TenantLocatorContractError("tenant_locator_field_invalid"));
  });

  it("validates a resolved response without allowing the caller to add fields", () => {
    expect(validateTenantLocatorResolution({
      status: "resolved",
      locator: {
        platform: "slack",
        platformTenantId: "T1",
        tenantId: TENANT,
        version: 2,
        status: "active",
      },
    })).toMatchObject({
      status: "resolved",
      locator: { tenantId: TENANT, version: 2 },
    });
    expect(() => validateTenantLocatorResolution({
      status: "resolved",
      locator: { ...ACTIVE, token: "secret" },
    })).toThrow(new TenantLocatorContractError("tenant_locator_field_invalid"));
  });
});

describe("PlatformStateTenantLocatorReader", () => {
  it("reads only the reserved platform object and preserves inactive results", async () => {
    const calls: string[] = [];
    const reader = new PlatformStateTenantLocatorReader({
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (input) => {
          calls.push(`${String(id)}:${new URL(String(input)).pathname}`);
          return Response.json({ status: "inactive" });
        },
      }),
    });
    await expect(reader.resolve({ platform: "slack", platformTenantId: "T1" }))
      .resolves.toEqual({ status: "inactive" });
    expect(calls).toEqual(["__platform_marketplace__:/tenant-locator/resolve"]);
  });

  it("fails closed when the registry is unavailable or malformed", async () => {
    const unavailable = new PlatformStateTenantLocatorReader({
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => new Response(null, { status: 503 }),
      }),
    });
    await expect(unavailable.resolve({ platform: "slack", platformTenantId: "T1" }))
      .rejects.toThrow(new TenantLocatorContractError("tenant_locator_unavailable", 503));

    const malformed = new PlatformStateTenantLocatorReader({
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => Response.json({ status: "resolved", locator: { ...ACTIVE, token: "secret" } }),
      }),
    });
    await expect(malformed.resolve({ platform: "slack", platformTenantId: "T1" }))
      .rejects.toThrow(new TenantLocatorContractError("tenant_locator_response_invalid", 503));
  });
});
