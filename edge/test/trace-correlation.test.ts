import { describe, expect, it } from "vitest";
import {
  createTraceCorrelation,
  logTraceEvent,
  traceCorrelationFromHeaders,
  withTraceHeaders,
} from "../src/observability/trace-correlation.js";
import { classifyRouterShadow } from "../src/router/shadow.js";

describe("phase-one trace correlation", () => {
  const correlation = createTraceCorrelation({
    executionId: "exec-1",
    threadKey: "slack:C1:123",
    workspaceId: "T1",
  });

  it("round-trips only bounded internal headers", () => {
    const headers = withTraceHeaders({ authorization: "Bearer opaque" }, correlation);
    expect(headers.get("authorization")).toBe("Bearer opaque");
    expect(traceCorrelationFromHeaders(headers)).toEqual(correlation);
    headers.set("x-opentag-trace-id", "different");
    expect(traceCorrelationFromHeaders(headers)).toBeUndefined();
  });

  it("does not emit message or secret content", () => {
    const lines: string[] = [];
    logTraceEvent({
      correlation,
      component: "router",
      event: "classified",
      attributes: { queryLength: 12, secret: "sk-never-log" },
    }, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("sk-never-log");
    expect(lines[0]).not.toContain("where is the deploy runbook");
    expect(JSON.parse(lines[0]!)).toMatchObject({ traceId: "exec-1", threadKey: "slack:C1:123" });
  });

  it("records counterfactual tier decisions while dispatching Tier 2", () => {
    const record = classifyRouterShadow({
      message: "where is the deploy runbook?",
      correlation,
      tier1Enabled: false,
    });
    expect(record).toMatchObject({
      shadow: true,
      tier1Gate: "dark",
      tierDecided: 1,
      tierDispatched: 2,
      matchedRule: "t1.01",
    });
  });
});
