import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createRouterDispatchMeasurement } from "../src/router/measurement.js";
import { createResponseRouteJevMeasurement } from "../src/router/response-route-jev-measurement.js";
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
  it("returns duplicate:true on /record retry when recordedAt predates the retention window", async () => {
    const workspaceId = `router-workers-stale-${crypto.randomUUID()}`;
    const stub = env.ROUTER_MEASUREMENTS!.get(
      env.ROUTER_MEASUREMENTS!.idFromName(workspaceId),
    ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
    const measurement = createRouterDispatchMeasurement({
      workspaceId,
      threadKey: "slack:C1:thread-1",
      executionId: `execution-${crypto.randomUUID()}`,
      shadowRecord: shadow,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    const first = await stub.fetch("https://router-measurement/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(measurement),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ ok: true, duplicate: false });

    const duplicate = await stub.fetch("https://router-measurement/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(measurement),
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const summary = await stub.fetch("https://router-measurement/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    await expect(summary.json()).resolves.toMatchObject({ workspaceId, total: 1 });
  });

  it("persists additive response-route Jev shadow rows", async () => {
    const workspaceId = `router-jev-${crypto.randomUUID()}`;
    const stub = env.ROUTER_MEASUREMENTS!.get(
      env.ROUTER_MEASUREMENTS!.idFromName(workspaceId),
    ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
    const record = createResponseRouteJevMeasurement({
      workspaceId,
      eventId: `Ev-${crypto.randomUUID()}`,
      threadKey: "slack:T1:C1:1.0",
      executionId: "route-jev:test",
      currentRoute: {
        decision: "respond",
        reason: "question",
        classification: {
          tier: 1,
          confidence: 1,
          classifierPath: "heuristic",
          matchedRule: "t1.11",
          primarySignal: "question_form",
          surfaceFeatures: {
            hasCodeBlock: false,
            hasAttachment: false,
            wordCount: 3,
            matchedTier1Pattern: true,
            matchedTier2Pattern: false,
            tier3Flag: false,
          },
          normalizedMessage: "what is up",
        },
      },
      jev: {
        schema: 1,
        shadow: true,
        model: "jev-test",
        latencyMs: 12,
        state: {
          message: "what is up",
          source: "thread_reply",
          channelType: "channel",
          botMentioned: false,
          hasFiles: false,
          threadContext: [],
          memoryOptOut: false,
        },
        route: {
          choice: "respond",
          probabilities: { respond: 0.91, observe: 0.09 },
          confidence: 0.82,
        },
      },
    });
    const response = await stub.fetch("https://router-measurement/response-route-jev/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, duplicate: false });
  });

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
      // Stay inside the DO's 30-day retention window (prune uses wall-clock now()).
      recordedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const record = await stub.fetch("https://router-measurement/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(measurement),
    });
    expect(record.status).toBe(200);

    const duplicate = await stub.fetch("https://router-measurement/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(measurement),
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

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
