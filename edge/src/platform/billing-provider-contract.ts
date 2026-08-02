/**
 * Secret-free billing provider handoff.
 *
 * The platform effect ledger records usage before this boundary is invoked.
 * A billing adapter receives only the bounded meter identity and quantity, and
 * returns an opaque provider receipt. Prices, payment methods, card data, and
 * provider credentials stay outside OpenTag.
 */

import {
  BILLING_METRICS,
  type BillingMetric,
  type PlatformEffectIntent,
  type UsageMeterEvent,
} from "./layer3-contract.js";

export const BILLING_PROVIDER_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class BillingProviderContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BillingProviderContractError";
  }
}

export type BillingProviderMeterRequest = Readonly<{
  schemaVersion: typeof BILLING_PROVIDER_SCHEMA_VERSION;
  intentId: string;
  idempotencyKey: string;
  tenantId: string;
  eventId: string;
  executionId: string;
  tier: 1 | 2 | 3;
  metric: BillingMetric;
  quantity: number;
  unit: "count" | "tokens" | "milliseconds";
  planRevision: number;
  occurredAt: string;
}>;

export type BillingProviderReceipt = Readonly<{
  schemaVersion: typeof BILLING_PROVIDER_SCHEMA_VERSION;
  tenantId: string;
  eventId: string;
  idempotencyKey: string;
  provider: string;
  externalReceiptRef: `billing:${string}`;
  outcome: "accepted" | "duplicate";
  reconciledAt: string;
}>;

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new BillingProviderContractError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new BillingProviderContractError(`${field}_invalid`);
  }
  return result;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new BillingProviderContractError(`${field}_invalid`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BillingProviderContractError(`${field}_invalid`);
  }
  return value as number;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingProviderContractError(code);
  }
  return value as Record<string, unknown>;
}

function expectedUnit(metric: BillingMetric): BillingProviderMeterRequest["unit"] {
  return metric === "agent_tokens"
    ? "tokens"
    : metric === "container_ms"
      ? "milliseconds"
      : "count";
}

function parseRequest(input: Record<string, unknown>): BillingProviderMeterRequest {
  if (input.schemaVersion !== BILLING_PROVIDER_SCHEMA_VERSION) {
    throw new BillingProviderContractError("billing_provider_schema_invalid");
  }
  const metric = input.metric;
  if (!BILLING_METRICS.includes(metric as BillingMetric)) {
    throw new BillingProviderContractError("billing_metric_invalid");
  }
  const typedMetric = metric as BillingMetric;
  const unit = input.unit;
  if (unit !== "count" && unit !== "tokens" && unit !== "milliseconds") {
    throw new BillingProviderContractError("billing_unit_invalid");
  }
  if (unit !== expectedUnit(typedMetric)) {
    throw new BillingProviderContractError("billing_unit_mismatch");
  }
  const tier = input.tier;
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    throw new BillingProviderContractError("billing_tier_invalid");
  }
  return Object.freeze({
    schemaVersion: BILLING_PROVIDER_SCHEMA_VERSION,
    intentId: identifier(input.intentId, "intent_id"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    tenantId: identifier(input.tenantId, "tenant_id"),
    eventId: identifier(input.eventId, "event_id"),
    executionId: identifier(input.executionId, "execution_id"),
    tier,
    metric: typedMetric,
    quantity: nonNegativeInteger(input.quantity, "quantity"),
    unit,
    planRevision: positiveVersion(input.planRevision, "plan_revision"),
    occurredAt: timestamp(input.occurredAt, "occurred_at"),
  });
}

export function validateBillingProviderMeterRequest(value: unknown): BillingProviderMeterRequest {
  const input = object(value, "billing_provider_request_invalid");
  const allowed = new Set([
    "schemaVersion",
    "intentId",
    "idempotencyKey",
    "tenantId",
    "eventId",
    "executionId",
    "tier",
    "metric",
    "quantity",
    "unit",
    "planRevision",
    "occurredAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new BillingProviderContractError("billing_provider_field_invalid");
  }
  return parseRequest(input);
}

/** Convert the metadata-only platform intent into the provider request. */
export function billingProviderMeterRequestFromIntent(
  value: PlatformEffectIntent,
): BillingProviderMeterRequest {
  if (value.kind !== "billing_meter" || value.scope !== "tenant" || !value.tenantId) {
    throw new BillingProviderContractError("billing_effect_intent_invalid");
  }
  const metadata = object(value.metadata, "billing_effect_metadata_invalid");
  return validateBillingProviderMeterRequest({
    schemaVersion: BILLING_PROVIDER_SCHEMA_VERSION,
    intentId: value.intentId,
    idempotencyKey: value.idempotencyKey,
    tenantId: value.tenantId,
    eventId: value.targetRef,
    executionId: metadata.executionId,
    tier: metadata.tier,
    metric: metadata.metric,
    quantity: metadata.quantity,
    unit: metadata.unit,
    planRevision: metadata.planRevision,
    occurredAt: value.requestedAt,
  });
}

export function validateBillingProviderReceipt(value: unknown): BillingProviderReceipt {
  const input = object(value, "billing_provider_receipt_invalid");
  const allowed = new Set([
    "schemaVersion",
    "tenantId",
    "eventId",
    "idempotencyKey",
    "provider",
    "externalReceiptRef",
    "outcome",
    "reconciledAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new BillingProviderContractError("billing_provider_receipt_field_invalid");
  }
  if (input.schemaVersion !== BILLING_PROVIDER_SCHEMA_VERSION) {
    throw new BillingProviderContractError("billing_provider_receipt_schema_invalid");
  }
  const externalReceiptRef = identifier(input.externalReceiptRef, "external_receipt_ref");
  if (!externalReceiptRef.startsWith("billing:")) {
    throw new BillingProviderContractError("billing_external_receipt_ref_invalid");
  }
  if (input.outcome !== "accepted" && input.outcome !== "duplicate") {
    throw new BillingProviderContractError("billing_provider_outcome_invalid");
  }
  return Object.freeze({
    schemaVersion: BILLING_PROVIDER_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    eventId: identifier(input.eventId, "event_id"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    provider: identifier(input.provider, "provider"),
    externalReceiptRef: externalReceiptRef as `billing:${string}`,
    outcome: input.outcome,
    reconciledAt: timestamp(input.reconciledAt, "reconciled_at"),
  });
}

export function billingProviderRequestFromMeterEvent(
  event: UsageMeterEvent,
  intentId: string,
): BillingProviderMeterRequest {
  return validateBillingProviderMeterRequest({
    schemaVersion: BILLING_PROVIDER_SCHEMA_VERSION,
    intentId,
    idempotencyKey: event.idempotencyKey,
    tenantId: event.tenantId,
    eventId: event.eventId,
    executionId: event.executionId,
    tier: event.tier,
    metric: event.metric,
    quantity: event.quantity,
    unit: event.unit,
    planRevision: event.planRevision,
    occurredAt: event.occurredAt,
  });
}
