import type { RouterShadowRecord } from "./shadow.js";

export const ROUTER_MEASUREMENT_SCHEMA_VERSION = 1 as const;
export const ROUTER_FEEDBACK_MAX_BYTES = 4_096;

export type RouterMeasurementOutcome =
  | "answered"
  | "tier1_miss"
  | "escalated"
  | "failed"
  | "cancelled"
  | "rejected";

export type RouterFeedbackKind =
  | "escalated_explicit"
  | "escalated_implicit"
  | "declined_tier3";

export type RouterFeedbackFeatures = Readonly<Pick<
  RouterShadowRecord,
  | "tier1Gate"
  | "tierDecided"
  | "confidence"
  | "classifierPath"
  | "matchedRule"
  | "primarySignal"
  | "eligibleTiers"
  | "classifyLatencyMs"
  | "surfaceFeatures"
>>;

export type RouterDispatchMeasurement = Readonly<{
  schemaVersion: typeof ROUTER_MEASUREMENT_SCHEMA_VERSION;
  workspaceId: string;
  threadKey: string;
  executionId: string;
  shadowRecord: RouterShadowRecord;
  recordedAt: string;
  outcome?: RouterMeasurementOutcome;
  outcomeReason?: string;
  injectedChunkCount?: number;
  injectedTokenCount?: number;
}>;

export type RouterFeedbackRecord = Readonly<{
  schemaVersion: typeof ROUTER_MEASUREMENT_SCHEMA_VERSION;
  feedbackId: string;
  workspaceId: string;
  executionId: string;
  kind: RouterFeedbackKind;
  messageText: string;
  features: RouterFeedbackFeatures;
  decidedTier: 1 | 2 | 3;
  correctedTier: 1 | 2 | 3;
  createdAt: string;
}>;

export class RouterMeasurementError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(code);
    this.name = "RouterMeasurementError";
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CLASSIFIER_PATHS = new Set([
  "explicit_command",
  "hard_gate",
  "heuristic",
  "classifier_failed",
]);
const PRIMARY_SIGNALS = new Set([
  "retrieval_verb",
  "construction_verb",
  "question_form",
  "code_present",
  "long_spec_form",
  "conversational",
  "explicit_hint",
  "history_continuation",
  "other",
]);
const OUTCOMES = new Set<RouterMeasurementOutcome>([
  "answered",
  "tier1_miss",
  "escalated",
  "failed",
  "cancelled",
  "rejected",
]);
const FEEDBACK_KINDS = new Set<RouterFeedbackKind>([
  "escalated_explicit",
  "escalated_implicit",
  "declined_tier3",
]);

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  if (!Number.isFinite(Date.parse(result))) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  return result;
}

function tier(value: unknown, field: string): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RouterMeasurementError(`${field}_invalid`);
  return value;
}

function boundedNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  return value as number;
}

function eligibleTiers(value: unknown): RouterShadowRecord["eligibleTiers"] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 3 ||
    !value.every((item) => item === 1 || item === 2 || item === 3) ||
    new Set(value).size !== value.length
  ) {
    throw new RouterMeasurementError("eligible_tiers_invalid");
  }
  if (!value.includes(2)) throw new RouterMeasurementError("tier2_not_eligible");
  return Object.freeze([...value] as RouterShadowRecord["eligibleTiers"]);
}

function surfaceFeatures(value: unknown): RouterShadowRecord["surfaceFeatures"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterMeasurementError("surface_features_invalid");
  }
  const input = value as Record<string, unknown>;
  return Object.freeze({
    hasCodeBlock: boolean(input.hasCodeBlock, "has_code_block"),
    hasAttachment: boolean(input.hasAttachment, "has_attachment"),
    wordCount: boundedInteger(input.wordCount, "word_count", 1_000),
    matchedTier1Pattern: boolean(input.matchedTier1Pattern, "matched_tier1_pattern"),
    matchedTier2Pattern: boolean(input.matchedTier2Pattern, "matched_tier2_pattern"),
    tier3Flag: boolean(input.tier3Flag, "tier3_flag"),
  });
}

function shadowRecord(value: unknown): RouterShadowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterMeasurementError("shadow_record_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.routerSchema !== 1 || input.patternTable !== "v1") {
    throw new RouterMeasurementError("shadow_record_version_invalid");
  }
  if (input.shadow !== true) throw new RouterMeasurementError("shadow_record_not_shadow");
  if (input.tier1Gate !== "enabled" && input.tier1Gate !== "dark") {
    throw new RouterMeasurementError("tier1_gate_invalid");
  }
  const tierDecided = tier(input.tierDecided, "tier_decided");
  if (input.tierDispatched !== 2) {
    throw new RouterMeasurementError("tier_dispatched_invalid");
  }
  if (typeof input.classifierPath !== "string" || !CLASSIFIER_PATHS.has(input.classifierPath)) {
    throw new RouterMeasurementError("classifier_path_invalid");
  }
  if (typeof input.primarySignal !== "string" || !PRIMARY_SIGNALS.has(input.primarySignal)) {
    throw new RouterMeasurementError("primary_signal_invalid");
  }
  return Object.freeze({
    routerSchema: 1,
    patternTable: "v1",
    shadow: true,
    tier1Gate: input.tier1Gate,
    tierDecided,
    tierDispatched: 2,
    confidence: boundedNumber(input.confidence, "confidence", 1),
    classifierPath: input.classifierPath as RouterShadowRecord["classifierPath"],
    matchedRule: identifier(input.matchedRule, "matched_rule", 128),
    primarySignal: input.primarySignal as RouterShadowRecord["primarySignal"],
    eligibleTiers: eligibleTiers(input.eligibleTiers),
    classifyLatencyMs: boundedNumber(input.classifyLatencyMs, "classify_latency_ms", 10_000),
    surfaceFeatures: surfaceFeatures(input.surfaceFeatures),
  });
}

function feedbackFeatures(value: unknown): RouterFeedbackFeatures {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterMeasurementError("feedback_features_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.tier1Gate !== "enabled" && input.tier1Gate !== "dark") {
    throw new RouterMeasurementError("feedback_tier1_gate_invalid");
  }
  if (typeof input.classifierPath !== "string" || !CLASSIFIER_PATHS.has(input.classifierPath)) {
    throw new RouterMeasurementError("feedback_classifier_path_invalid");
  }
  if (typeof input.primarySignal !== "string" || !PRIMARY_SIGNALS.has(input.primarySignal)) {
    throw new RouterMeasurementError("feedback_primary_signal_invalid");
  }
  return Object.freeze({
    tier1Gate: input.tier1Gate,
    tierDecided: tier(input.tierDecided, "feedback_tier_decided"),
    confidence: boundedNumber(input.confidence, "feedback_confidence", 1),
    classifierPath: input.classifierPath as RouterShadowRecord["classifierPath"],
    matchedRule: identifier(input.matchedRule, "feedback_matched_rule", 128),
    primarySignal: input.primarySignal as RouterShadowRecord["primarySignal"],
    eligibleTiers: eligibleTiers(input.eligibleTiers),
    classifyLatencyMs: boundedNumber(input.classifyLatencyMs, "feedback_classify_latency_ms", 10_000),
    surfaceFeatures: surfaceFeatures(input.surfaceFeatures),
  });
}

export function routerFeedbackFeatures(shadow: RouterShadowRecord): RouterFeedbackFeatures {
  return feedbackFeatures({
    tier1Gate: shadow.tier1Gate,
    tierDecided: shadow.tierDecided,
    confidence: shadow.confidence,
    classifierPath: shadow.classifierPath,
    matchedRule: shadow.matchedRule,
    primarySignal: shadow.primarySignal,
    eligibleTiers: shadow.eligibleTiers,
    classifyLatencyMs: shadow.classifyLatencyMs,
    surfaceFeatures: shadow.surfaceFeatures,
  });
}

function outcome(value: unknown): RouterMeasurementOutcome {
  if (typeof value !== "string" || !OUTCOMES.has(value as RouterMeasurementOutcome)) {
    throw new RouterMeasurementError("outcome_invalid");
  }
  return value as RouterMeasurementOutcome;
}

export function createRouterDispatchMeasurement(input: {
  workspaceId: string;
  threadKey: string;
  executionId: string;
  shadowRecord: RouterShadowRecord;
  recordedAt?: string;
}): RouterDispatchMeasurement {
  return validateRouterDispatchMeasurement({
    schemaVersion: ROUTER_MEASUREMENT_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    threadKey: input.threadKey,
    executionId: input.executionId,
    shadowRecord: input.shadowRecord,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  });
}

export function validateRouterDispatchMeasurement(value: unknown): RouterDispatchMeasurement {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterMeasurementError("dispatch_measurement_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== ROUTER_MEASUREMENT_SCHEMA_VERSION) {
    throw new RouterMeasurementError("measurement_schema_invalid");
  }
  const measurement: RouterDispatchMeasurement = {
    schemaVersion: ROUTER_MEASUREMENT_SCHEMA_VERSION,
    workspaceId: identifier(input.workspaceId, "workspace_id"),
    threadKey: identifier(input.threadKey, "thread_key"),
    executionId: identifier(input.executionId, "execution_id"),
    shadowRecord: shadowRecord(input.shadowRecord),
    recordedAt: timestamp(input.recordedAt, "recorded_at"),
    ...(input.outcome === undefined ? {} : { outcome: outcome(input.outcome) }),
    ...(input.outcomeReason === undefined
      ? {}
      : { outcomeReason: identifier(input.outcomeReason, "outcome_reason", 128) }),
    ...(input.injectedChunkCount === undefined
      ? {}
      : { injectedChunkCount: boundedInteger(input.injectedChunkCount, "injected_chunk_count", 100) }),
    ...(input.injectedTokenCount === undefined
      ? {}
      : { injectedTokenCount: boundedInteger(input.injectedTokenCount, "injected_token_count", 100_000) }),
  };
  if (measurement.outcome === undefined && (measurement.outcomeReason || measurement.injectedChunkCount !== undefined || measurement.injectedTokenCount !== undefined)) {
    throw new RouterMeasurementError("outcome_metadata_without_outcome");
  }
  return Object.freeze(measurement);
}

export function validateRouterFeedback(value: unknown): RouterFeedbackRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouterMeasurementError("feedback_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== ROUTER_MEASUREMENT_SCHEMA_VERSION) {
    throw new RouterMeasurementError("feedback_schema_invalid");
  }
  if (typeof input.kind !== "string" || !FEEDBACK_KINDS.has(input.kind as RouterFeedbackKind)) {
    throw new RouterMeasurementError("feedback_kind_invalid");
  }
  const messageText = identifier(input.messageText, "message_text", ROUTER_FEEDBACK_MAX_BYTES);
  if (new TextEncoder().encode(messageText).byteLength > ROUTER_FEEDBACK_MAX_BYTES) {
    throw new RouterMeasurementError("message_text_too_large");
  }
  return Object.freeze({
    schemaVersion: ROUTER_MEASUREMENT_SCHEMA_VERSION,
    feedbackId: identifier(input.feedbackId, "feedback_id"),
    workspaceId: identifier(input.workspaceId, "workspace_id"),
    executionId: identifier(input.executionId, "execution_id"),
    kind: input.kind as RouterFeedbackKind,
    messageText,
    features: feedbackFeatures(input.features),
    decidedTier: tier(input.decidedTier, "decided_tier"),
    correctedTier: tier(input.correctedTier, "corrected_tier"),
    createdAt: timestamp(input.createdAt, "created_at"),
  });
}

export function routerMeasurementOutcome(value: RouterMeasurementOutcome): RouterMeasurementOutcome {
  return outcome(value);
}
