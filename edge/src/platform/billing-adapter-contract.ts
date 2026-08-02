/**
 * Authenticated, provider-independent billing adapter protocol.
 *
 * The platform ledger owns usage acceptance and the generic platform effect
 * runner owns effect leases. This boundary carries only a fixed meter and
 * charge correlation tuple to an approved provider adapter. It never carries
 * credentials, payment methods, or an arbitrary provider payload.
 */

import {
  billingProviderMeterRequestFromIntent,
  BillingProviderContractError,
  validateBillingProviderMeterRequest,
  validateBillingProviderReceipt,
  type BillingProviderMeterRequest,
  type BillingProviderReceipt,
} from "./billing-provider-contract.js";
import type { PlatformEffectIntent } from "./layer3-contract.js";

export const BILLING_ADAPTER_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PLAN_ID_LENGTH = 128;
const MAX_CURRENCY_LENGTH = 3;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class BillingAdapterContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BillingAdapterContractError";
  }
}

export type BillingAdapterCharge = Readonly<{
  planId: string;
  planRevision: number;
  amountMinor: number;
  currency: string;
}>;

export type BillingAdapterRequest = Readonly<
  BillingProviderMeterRequest & {
    schemaVersion: typeof BILLING_ADAPTER_SCHEMA_VERSION;
    operation: "meter";
    planId: string;
    amountMinor: number;
    currency: string;
  }
>;

export type BillingAdapterReceipt = Readonly<
  BillingProviderReceipt & {
    schemaVersion: typeof BILLING_ADAPTER_SCHEMA_VERSION;
    operation: "meter";
    intentId: string;
    executionId: string;
    planId: string;
    planRevision: number;
    amountMinor: number;
    currency: string;
  }
>;

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingAdapterContractError(code);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new BillingAdapterContractError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new BillingAdapterContractError(`${field}_invalid`);
  }
  return result;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new BillingAdapterContractError(`${field}_invalid`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BillingAdapterContractError(`${field}_invalid`);
  }
  return value as number;
}

function currency(value: unknown): string {
  const result = identifier(value, "currency", MAX_CURRENCY_LENGTH);
  if (!CURRENCY_RE.test(result)) {
    throw new BillingAdapterContractError("currency_invalid");
  }
  return result;
}

function exactFields(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new BillingAdapterContractError(code);
  }
}

function providerMeterInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    intentId: input.intentId,
    idempotencyKey: input.idempotencyKey,
    tenantId: input.tenantId,
    eventId: input.eventId,
    executionId: input.executionId,
    tier: input.tier,
    metric: input.metric,
    quantity: input.quantity,
    unit: input.unit,
    planRevision: input.planRevision,
    occurredAt: input.occurredAt,
  };
}

function providerReceiptInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    tenantId: input.tenantId,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    provider: input.provider,
    externalReceiptRef: input.externalReceiptRef,
    outcome: input.outcome,
    reconciledAt: input.reconciledAt,
  };
}

function providerContractError(error: unknown, fallback: string): BillingAdapterContractError {
  if (error instanceof BillingProviderContractError) {
    return new BillingAdapterContractError(error.code);
  }
  return error instanceof BillingAdapterContractError
    ? error
    : new BillingAdapterContractError(fallback);
}

const REQUEST_FIELDS = [
  "schemaVersion",
  "operation",
  "intentId",
  "idempotencyKey",
  "tenantId",
  "eventId",
  "executionId",
  "tier",
  "metric",
  "quantity",
  "unit",
  "planId",
  "planRevision",
  "amountMinor",
  "currency",
  "occurredAt",
] as const;

export function validateBillingAdapterRequest(value: unknown): BillingAdapterRequest {
  const input = object(value, "billing_adapter_request_invalid");
  exactFields(input, REQUEST_FIELDS, "billing_adapter_request_field_invalid");
  if (input.schemaVersion !== BILLING_ADAPTER_SCHEMA_VERSION) {
    throw new BillingAdapterContractError("billing_adapter_schema_invalid");
  }
  if (input.operation !== "meter") {
    throw new BillingAdapterContractError("billing_adapter_operation_invalid");
  }

  let meter: BillingProviderMeterRequest;
  try {
    meter = validateBillingProviderMeterRequest(providerMeterInput(input));
  } catch (error) {
    throw providerContractError(error, "billing_adapter_request_invalid");
  }

  return Object.freeze({
    ...meter,
    schemaVersion: BILLING_ADAPTER_SCHEMA_VERSION,
    operation: "meter",
    planId: identifier(input.planId, "plan_id", MAX_PLAN_ID_LENGTH),
    amountMinor: nonNegativeInteger(input.amountMinor, "amount_minor"),
    currency: currency(input.currency),
  });
}

const RECEIPT_FIELDS = [
  "schemaVersion",
  "operation",
  "intentId",
  "tenantId",
  "eventId",
  "idempotencyKey",
  "executionId",
  "planId",
  "planRevision",
  "amountMinor",
  "currency",
  "provider",
  "externalReceiptRef",
  "outcome",
  "reconciledAt",
] as const;

export function validateBillingAdapterReceipt(value: unknown): BillingAdapterReceipt {
  const input = object(value, "billing_adapter_receipt_invalid");
  exactFields(input, RECEIPT_FIELDS, "billing_adapter_receipt_field_invalid");
  if (input.schemaVersion !== BILLING_ADAPTER_SCHEMA_VERSION) {
    throw new BillingAdapterContractError("billing_adapter_receipt_schema_invalid");
  }
  if (input.operation !== "meter") {
    throw new BillingAdapterContractError("billing_adapter_operation_invalid");
  }

  let providerReceipt: BillingProviderReceipt;
  try {
    providerReceipt = validateBillingProviderReceipt(providerReceiptInput(input));
  } catch (error) {
    throw providerContractError(error, "billing_adapter_receipt_invalid");
  }

  return Object.freeze({
    ...providerReceipt,
    schemaVersion: BILLING_ADAPTER_SCHEMA_VERSION,
    operation: "meter",
    intentId: identifier(input.intentId, "intent_id"),
    executionId: identifier(input.executionId, "execution_id"),
    planId: identifier(input.planId, "plan_id", MAX_PLAN_ID_LENGTH),
    planRevision: positiveVersion(input.planRevision, "plan_revision"),
    amountMinor: nonNegativeInteger(input.amountMinor, "amount_minor"),
    currency: currency(input.currency),
    reconciledAt: timestamp(input.reconciledAt, "reconciled_at"),
  });
}

export function assertBillingAdapterReceiptMatches(
  request: BillingAdapterRequest,
  receipt: BillingAdapterReceipt,
): void {
  if (
    receipt.operation !== request.operation ||
    receipt.intentId !== request.intentId ||
    receipt.tenantId !== request.tenantId ||
    receipt.eventId !== request.eventId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.executionId !== request.executionId ||
    receipt.planId !== request.planId ||
    receipt.planRevision !== request.planRevision ||
    receipt.amountMinor !== request.amountMinor ||
    receipt.currency !== request.currency
  ) {
    throw new BillingAdapterContractError("billing_adapter_receipt_mismatch");
  }
}

function validateCharge(value: unknown): BillingAdapterCharge {
  const input = object(value, "billing_adapter_charge_invalid");
  exactFields(
    input,
    ["planId", "planRevision", "amountMinor", "currency"],
    "billing_adapter_charge_field_invalid",
  );
  return Object.freeze({
    planId: identifier(input.planId, "plan_id", MAX_PLAN_ID_LENGTH),
    planRevision: positiveVersion(input.planRevision, "plan_revision"),
    amountMinor: nonNegativeInteger(input.amountMinor, "amount_minor"),
    currency: currency(input.currency),
  });
}

/**
 * Add an approved monetary correlation tuple to a metadata-only billing intent.
 * The price and currency are supplied by the billing authority; this function
 * validates and forwards them but does not calculate or authorize them.
 */
export function billingAdapterRequestFromIntent(
  value: PlatformEffectIntent,
  chargeValue: unknown,
): BillingAdapterRequest {
  let meter: BillingProviderMeterRequest;
  try {
    meter = billingProviderMeterRequestFromIntent(value);
  } catch (error) {
    throw providerContractError(error, "billing_effect_intent_invalid");
  }
  const charge = validateCharge(chargeValue);
  if (charge.planRevision !== meter.planRevision) {
    throw new BillingAdapterContractError("billing_plan_revision_mismatch");
  }
  return validateBillingAdapterRequest({
    ...meter,
    schemaVersion: BILLING_ADAPTER_SCHEMA_VERSION,
    operation: "meter",
    planId: charge.planId,
    amountMinor: charge.amountMinor,
    currency: charge.currency,
  });
}
