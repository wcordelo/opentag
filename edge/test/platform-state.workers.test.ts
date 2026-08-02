import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { REQUIRED_PROVISIONING_STEPS } from "../src/platform/layer3-contract.js";

async function post(
  stub: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  path: string,
  body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await stub.fetch(`https://platform-state${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("PlatformStateDO in workerd", () => {
  it("uses the real SQLite Durable Object binding for provisioning state", async () => {
    const objectName = `workers-test-${crypto.randomUUID()}`;
    const stub = env.PLATFORM_STATE!.get(
      env.PLATFORM_STATE!.idFromName(objectName),
    ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
    const request = {
      schemaVersion: 1,
      requestId: `request-${objectName}`,
      idempotencyKey: `install-${objectName}`,
      externalPlatform: "slack",
      externalTenantId: objectName,
      requestedByExternalSubject: "U-admin",
      isolationMode: "shared_worker_per_tenant_do",
      custodyBackend: "external_kms",
      requestedAt: "2026-08-01T20:00:00.000Z",
    };
    const first = await post(stub, "/provision", request);
    expect(first.response.status).toBe(200);
    expect(first.body.status).toBe("requested");
    expect(first.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);

    const step = await post(stub, "/provision/step", {
      schemaVersion: 1,
      idempotencyKey: request.idempotencyKey,
      step: REQUIRED_PROVISIONING_STEPS[0],
      outcome: "complete",
      externalReceiptRef: "receipt:workers-step-1",
      observedAt: request.requestedAt,
    });
    expect(step.response.status).toBe(200);
    expect(step.body.status).toBe("provisioning");
    expect(step.body.completedSteps).toEqual([REQUIRED_PROVISIONING_STEPS[0]]);
  });
});
