import {
  classifyRouterMessage,
  ROUTER_PATTERN_TABLE_VERSION,
  type RouterClassification,
  type RouterTier,
} from "./classifier.js";
import {
  createTraceCorrelation,
  logTraceEvent,
  type TraceCorrelation,
} from "../observability/trace-correlation.js";

export type RouterShadowRecord = Readonly<{
  routerSchema: 1;
  patternTable: typeof ROUTER_PATTERN_TABLE_VERSION;
  shadow: true;
  tier1Gate: "enabled" | "dark";
  tierDecided: RouterTier;
  tierDispatched: 2;
  confidence: number;
  classifierPath: RouterClassification["classifierPath"];
  matchedRule: string;
  primarySignal: RouterClassification["primarySignal"];
  eligibleTiers: readonly RouterTier[];
  classifyLatencyMs: number;
  surfaceFeatures: RouterClassification["surfaceFeatures"];
}>;

export function classifyRouterShadow(input: {
  message: string;
  hasAttachment?: boolean;
  activeSession?: boolean;
  /** Tier 1 remains dark until the knowledge rollout gate is explicitly enabled. */
  tier1Enabled?: boolean;
  correlation: TraceCorrelation;
}): RouterShadowRecord {
  const started = Date.now();
  const classification = classifyRouterMessage(input);
  const record: RouterShadowRecord = Object.freeze({
    routerSchema: 1,
    patternTable: ROUTER_PATTERN_TABLE_VERSION,
    shadow: true,
    tier1Gate: input.tier1Enabled === true ? "enabled" : "dark",
    tierDecided: classification.tier,
    tierDispatched: 2,
    confidence: classification.confidence,
    classifierPath: classification.classifierPath,
    matchedRule: classification.matchedRule,
    primarySignal: classification.primarySignal,
    // The shadow dataset keeps Tier 1 eligible as a counterfactual even while
    // the real rollout gate is dark. Tier 3 remains non-dispatching by design.
    eligibleTiers: [1, 2] as const,
    classifyLatencyMs: Math.max(0, Date.now() - started),
    surfaceFeatures: classification.surfaceFeatures,
  });
  logTraceEvent({
    correlation: input.correlation,
    component: "router",
    event: "router_classified",
    outcome: "shadow_tier2",
    attributes: {
      tierDecided: record.tierDecided,
      tierDispatched: record.tierDispatched,
      confidence: record.confidence,
      classifierPath: record.classifierPath,
      matchedRule: record.matchedRule,
      primarySignal: record.primarySignal,
      shadow: true,
      classifyLatencyMs: record.classifyLatencyMs,
    },
  });
  return record;
}

export function traceForRouter(input: {
  executionId: string;
  threadKey: string;
  workspaceId: string;
}): TraceCorrelation {
  return createTraceCorrelation(input);
}
