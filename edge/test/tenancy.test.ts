import { describe, expect, it } from "vitest";
import { assertTenantId, tenantScope, tenantStub } from "../src/tenancy.js";

describe("tenant isolation contract", () => {
  it("uses the exact validated team id as the Durable Object locator", () => {
    const names: string[] = [];
    const namespace = {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: (id: string) => ({ id }),
    } as never;
    expect(tenantStub(namespace, tenantScope("T1"))).toHaveProperty("fetch");
    expect(tenantStub(namespace, "T2")).toHaveProperty("fetch");
    expect(names).toEqual(["T1", "T2"]);
  });

  it("rejects ambiguous tenant locators", () => {
    expect(() => assertTenantId(" T1")).toThrow("tenant_id_invalid");
    expect(() => assertTenantId("T1:T2")).toThrow("tenant_id_invalid");
    expect(() => assertTenantId("T\u0000")).toThrow("tenant_id_invalid");
  });
});
