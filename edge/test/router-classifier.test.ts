import { describe, expect, it } from "vitest";
import { classifyRouterMessage } from "../src/router/classifier.js";

describe("router v1 heuristic classifier", () => {
  it("recognizes retrieval questions and courtesy-prefix normalization", () => {
    expect(classifyRouterMessage({ message: "Can you find the thread where we discussed rate limits?" })).toMatchObject({
      tier: 1,
      classifierPath: "heuristic",
      matchedRule: "t1.08",
    });
    expect(classifyRouterMessage({ message: "supermemory re-rank budget?" })).toMatchObject({
      tier: 1,
      matchedRule: "t1.11",
    });
    expect(classifyRouterMessage({ message: "search Slack for the exact canary marker" })).toMatchObject({
      tier: 1,
      matchedRule: "t1.12",
      primarySignal: "retrieval_verb",
    });
  });

  it("recognizes construction and long-running signals without dispatching them", () => {
    expect(classifyRouterMessage({ message: "update the on-call rotation doc" })).toMatchObject({
      tier: 2,
      matchedRule: "t2.07",
      surfaceFeatures: { tier3Flag: false },
    });
    expect(classifyRouterMessage({ message: "run the migration against staging" })).toMatchObject({
      tier: 2,
      matchedRule: "t2.01",
      surfaceFeatures: { tier3Flag: true },
    });
  });

  it("defaults mixed signals and code-bearing lookup questions to Tier 2", () => {
    expect(classifyRouterMessage({ message: "summarize the incident and draft an RFC" })).toMatchObject({
      tier: 2,
      matchedRule: "mixed_signal",
    });
    expect(classifyRouterMessage({ message: "why does this throw?\n```ts\nthrow new Error()\n```" })).toMatchObject({
      tier: 2,
      matchedRule: "code_veto",
      primarySignal: "code_present",
    });
  });

  it("preserves explicit command intent as a counterfactual", () => {
    expect(classifyRouterMessage({ message: "/task rebuild the docs site" })).toMatchObject({
      tier: 3,
      classifierPath: "explicit_command",
      matchedRule: "command.task",
    });
  });
});
