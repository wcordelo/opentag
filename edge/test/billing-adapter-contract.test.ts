import { describe, expect, it } from "vitest";
import { validatePlatformEffectIntent } from "../src/platform/layer3-contract.js";
import {
  assertBillingAdapterReceiptMatches,
  billingAdapterRequestFromIntent,
  validateBillingAdapterReceipt,
  validateBillingAdapterRequest,
} from "../src/platform/billing-adapter-contract.js";

const intent = validatePlatformEffectIntent({
  schemaVersion: 1,
  intentId: "effect:billing-meter:event-1",
  idempotencyKey: "billing-meter:meter-1",
  scope: "tenant",
  tenantId: "tenant-1",
  kind: "billing_meter",
  targetRef: "event-1",
  metadata: {
    executionId: "execution-1",
    metric: "knowledge_query",
    planRevision: 3,
    quantity: 2,
    tier: 1,
    unit: "count",
  },
  requestedAt: "2026-08-01T22:00:00.000Z",
});

const request = billingAdapterRequestFromIntent(intent, {
  planId: "plan-standard",
  planRevision: 3,
  amountMinor: 1250,
  currency: "USD",
});

const receipt = validateBillingAdapterReceipt({
  schemaVersion: 1,
  operation: "meter",
  intentId: request.intentId,
  tenantId: request.tenantId,
  eventId: request.eventId,
  idempotencyKey: request.idempotencyKey,
  executionId: request.executionId,
  planId: request.planId,
  planRevision: request.planRevision,
  amountMinor: request.amountMinor,
  currency: request.currency,
  provider: "billing-test",
  externalReceiptRef: "billing:evt-1",
  outcome: "accepted",
  reconciledAt: "2026-08-01T22:00:01.000Z",
});

describe("billing adapter contract", () => {
  it("adds only an approved plan and monetary tuple to a meter intent", () => {
    expect(request).toEqual({
      schemaVersion: 1,
      operation: "meter",
      intentId: "effect:billing-meter:event-1",
      idempotencyKey: "billing-meter:meter-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      executionId: "execution-1",
      tier: 1,
      metric: "knowledge_query",
      quantity: 2,
      unit: "count",
      planId: "plan-standard",
      planRevision: 3,
      amountMinor: 1250,
      currency: "USD",
      occurredAt: "2026-08-01T22:00:00.000Z",
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("rejects unknown payload fields and non-canonical money fields", () => {
    expect(() => validateBillingAdapterRequest({
      ...request,
      providerPayload: { card: "must-not-cross-boundary" },
    })).toThrow("billing_adapter_request_field_invalid");
    expect(() => validateBillingAdapterRequest({
      ...request,
      amountMinor: 12.5,
    })).toThrow("amount_minor_invalid");
    expect(() => validateBillingAdapterRequest({
      ...request,
      currency: "usd",
    })).toThrow("currency_invalid");
  });

  it("requires the charge tuple to use the meter plan revision", () => {
    expect(() => billingAdapterRequestFromIntent(intent, {
      planId: "plan-standard",
      planRevision: 2,
      amountMinor: 1250,
      currency: "USD",
    })).toThrow("billing_plan_revision_mismatch");
  });

  it("requires a receipt to echo all billing correlation fields", () => {
    expect(() => assertBillingAdapterReceiptMatches(request, receipt)).not.toThrow();
    const mismatches = [
      { tenantId: "tenant-other" },
      { idempotencyKey: "billing-meter:other" },
      { planId: "plan-other" },
      { planRevision: 4 },
      { amountMinor: 1251 },
      { currency: "EUR" },
    ];
    for (const mismatch of mismatches) {
      expect(() => assertBillingAdapterReceiptMatches(
        request,
        validateBillingAdapterReceipt({ ...receipt, ...mismatch }),
      )).toThrow("billing_adapter_receipt_mismatch");
    }
    expect(() => validateBillingAdapterReceipt({
      ...receipt,
      authorization: "must-not-cross-boundary",
    })).toThrow("billing_adapter_receipt_field_invalid");
  });
});
