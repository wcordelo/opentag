import { describe, expect, it } from "vitest";
import {
  computeCombinedRouteRule4a,
  createResponseRouteJevMeasurement,
} from "../src/router/response-route-jev-measurement.js";
import type { RouterJevRouteJudgment } from "../src/router/jev-route-shadow.js";

const baseJev = (overrides: Partial<RouterJevRouteJudgment> = {}): RouterJevRouteJudgment => ({
  schema: 1,
  shadow: true,
  model: "jev-test",
  latencyMs: 10,
  state: {
    message: "test",
    source: "thread_reply",
    channelType: "channel",
    botMentioned: false,
    hasFiles: false,
    threadContext: [],
    memoryOptOut: false,
  },
  route: { choice: "observe", probabilities: { respond: 0.2, observe: 0.8 } },
  memoryNeeded: { noul: 0.9 },
  ...overrides,
});

describe("combined route rule 4a", () => {
  it("responds when Jev says respond", () => {
    const jev = baseJev({ route: { choice: "respond", probabilities: { respond: 0.9, observe: 0.1 } } });
    expect(computeCombinedRouteRule4a({ decision: "observe" }, jev)).toEqual({
      decision: "respond",
      rule: "4a",
    });
  });

  it("responds when router responds and memoryNeeded is high even if Jev observes", () => {
    const jev = baseJev();
    expect(computeCombinedRouteRule4a({ decision: "respond" }, jev)).toEqual({
      decision: "respond",
      rule: "4a",
    });
  });

  it("observes when Jev observes, router responds, and memoryNeeded is below threshold", () => {
    const jev = baseJev({ memoryNeeded: { noul: 0.2 } });
    expect(computeCombinedRouteRule4a({ decision: "respond" }, jev)).toEqual({
      decision: "observe",
      rule: "4a",
    });
  });

  it("falls back to the router when Jev errored", () => {
    const jev = baseJev({ error: "typesafe_http_500", route: undefined });
    expect(computeCombinedRouteRule4a({ decision: "respond" }, jev)).toEqual({
      decision: "respond",
      rule: "4a",
    });
    expect(computeCombinedRouteRule4a({ decision: "observe" }, jev)).toEqual({
      decision: "observe",
      rule: "4a",
    });
  });

  it("is stored on shadow measurements", () => {
    const record = createResponseRouteJevMeasurement({
      workspaceId: "T1",
      eventId: "Ev1",
      threadKey: "slack:T1:C1:1.0",
      executionId: "route-jev:Ev1",
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
      jev: baseJev(),
    });
    expect(record.combinedRoute).toEqual({ decision: "respond", rule: "4a" });
  });
});
