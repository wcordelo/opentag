import { describe, expect, it } from "vitest";
import {
  classifyRouterHeuristics,
  normalizeRouterText,
} from "../src/router/heuristics.js";

describe("router heuristic classifier", () => {
  it("resolves clean retrieval questions to Tier 1", () => {
    expect(classifyRouterHeuristics("<@U123> Where is the deploy runbook?")).toMatchObject({
      tierDecided: 1,
      classifierPath: "heuristic",
      matchedRule: "t1.01",
      reason: "single_tier1_family",
      surfaceFeatures: {
        matchedTier1Pattern: true,
        matchedTier2Pattern: false,
        tier3Flag: false,
      },
    });
    expect(classifyRouterHeuristics("supermemory re-rank budget?")).toMatchObject({
      tierDecided: 1,
      matchedRules: ["t1.10"],
    });
  });

  it("strips courtesy prefixes and keeps the update-me idiom in Tier 1", () => {
    expect(classifyRouterHeuristics("can you find the thread about rate limits?")).toMatchObject({
      tierDecided: 1,
      matchedRule: "t1.08",
    });
    expect(classifyRouterHeuristics("update me on the queue migration")).toMatchObject({
      tierDecided: 1,
      matchedRule: "t1.09",
    });
    expect(classifyRouterHeuristics("update the migration document")).toMatchObject({
      tierDecided: 2,
      matchedRule: "t2.06",
    });
  });

  it("resolves construction and mutation requests to Tier 2", () => {
    expect(classifyRouterHeuristics("fix the flaky ledger test")).toMatchObject({
      tierDecided: 2,
      matchedRule: "t2.02",
      tier3Flag: false,
    });
    expect(classifyRouterHeuristics("run the migration against staging")).toMatchObject({
      tierDecided: 2,
      matchedRule: "t2.01",
      tier3Flag: true,
    });
  });

  it("sends mixed or uncertain messages to the model path", () => {
    expect(classifyRouterHeuristics("summarize the incident and draft an RFC")).toMatchObject({
      tierDecided: null,
      classifierPath: "model_required",
      reason: "mixed_signal",
    });
    expect(classifyRouterHeuristics("thanks, good bot")).toMatchObject({
      tierDecided: null,
      classifierPath: "model_required",
      reason: "no_heuristic_match",
    });
  });

  it("vetoes Tier 1 for code and preserves the feature without exposing text", () => {
    const decision = classifyRouterHeuristics("why does this throw?\n```ts\nthrow error\n```");
    expect(decision).toMatchObject({
      tierDecided: null,
      classifierPath: "model_required",
      reason: "code_veto",
      surfaceFeatures: { hasCodeBlock: true },
    });
    expect(JSON.stringify(decision)).not.toContain("throw error");
  });

  it("counts neither fenced code nor quoted lines", () => {
    expect(normalizeRouterText("> quoted words\nactual question?\n```\nignored words\n```")).toEqual({
      text: "actual question?",
      hasCodeBlock: true,
      hasQuotedText: true,
      wordCount: 2,
    });
  });

  it("flags a long specification for possible Tier 3 without dispatching it", () => {
    const longSpec = `${Array.from({ length: 81 }, () => "requirement").join(" ")}\n- one\n- two\n- three`;
    expect(classifyRouterHeuristics(longSpec)).toMatchObject({
      tierDecided: 2,
      classifierPath: "heuristic",
      matchedRule: "t2.07",
      tier3Flag: true,
      surfaceFeatures: { wordCount: 87 },
    });
  });
});
