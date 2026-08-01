import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createRouterDispatchMeasurement } from "../src/router/measurement.js";
import type { RouterShadowRecord } from "../src/router/shadow.js";

const shadow: RouterShadowRecord = {
  routerSchema: 1,
  patternTable: "v1",
  shadow: true,
  tier1Gate: "dark",
  tierDecided: 2,
  tierDispatched: 2,
  confidence: 0.64,
  classifierPath: "heuristic",
  matchedRule: "t2.01",
  primarySignal: "construction_verb",
  eligibleTiers: [1, 2],
  classifyLatencyMs: 1,
  surfaceFeatures: {
    hasCodeBlock: true,
    hasAttachment: false,
    wordCount: 12,
    matchedTier1Pattern: false,
    matchedTier2Pattern: true,
    tier3Flag: false,
  },
};

describe("RouterMeasurementDO in workerd", () => {
  it("uses the deployed SQLite binding and migration for workspace measurements", async () => {
    const workspaceId = `router-workers-${crypto.randomUUID()}`;
    const stub = env.ROUTER_MEASUREMENTS!.get(
      env.ROUTER_MEASUREMENTS!.idFromName(workspaceId),
    ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
    const measurement = createRouterDispatchMeasurement({
      workspaceId,
      threadKey: "slack:C1:thread-1",
      executionId: `execution-${crypto.randomUUID()}`,
      shadowRecord: shadow,
      recordedAt: "2026-08-01T20:00:00.000Z",
    });

    const record = await stub.fetch("https://router-measurement/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(measurement),
    });
    expect(record.status).toBe(200);

    const outcome = await stub.fetch("https://router-measurement/outcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        executionId: measurement.executionId,
        outcome: "answered",
      }),
    });
    expect(outcome.status).toBe(200);

    const summary = await stub.fetch("https://router-measurement/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      workspaceId,
      total: 1,
      shadowOnly: true,
      feedbackCount: 0,
    });
  });
});
