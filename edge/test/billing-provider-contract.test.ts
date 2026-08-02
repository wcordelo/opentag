import { describe, expect, it } from "vitest";
import {
  billingProviderMeterRequestFromIntent,
  validateBillingProviderMeterRequest,
  validateBillingProviderReceipt,
} from "../src/platform/billing-provider-contract.js";
import { validatePlatformEffectIntent } from "../src/platform/layer3-contract.js";

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

describe("billing provider handoff contract", () => {
  it("maps a metadata-only billing intent to a bounded meter request", () => {
    expect(billingProviderMeterRequestFromIntent(intent)).toEqual({
      schemaVersion: 1,
      intentId: "effect:billing-meter:event-1",
      idempotencyKey: "billing-meter:meter-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      executionId: "execution-1",
      tier: 1,
      metric: "knowledge_query",
      quantity: 2,
      unit: "count",
      planRevision: 3,
      occurredAt: "2026-08-01T22:00:00.000Z",
    });
  });

  it("rejects provider payloads, metric/unit mismatches, and unknown fields", () => {
    expect(() => validateBillingProviderMeterRequest({
      schemaVersion: 1,
      intentId: "intent-1",
      idempotencyKey: "key-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      executionId: "execution-1",
      tier: 1,
      metric: "agent_tokens",
      quantity: 2,
      unit: "count",
      planRevision: 1,
      occurredAt: "2026-08-01T22:00:00.000Z",
    })).toThrow("billing_unit_mismatch");
    expect(() => validateBillingProviderMeterRequest({
      ...billingProviderMeterRequestFromIntent(intent),
      accessToken: "must-not-cross-boundary",
    })).toThrow("billing_provider_field_invalid");
  });

  it("requires an opaque billing receipt and rejects token-shaped additions", () => {
    expect(validateBillingProviderReceipt({
      schemaVersion: 1,
      tenantId: "tenant-1",
      eventId: "event-1",
      idempotencyKey: "key-1",
      provider: "billing-test",
      externalReceiptRef: "billing:evt-1",
      outcome: "accepted",
      reconciledAt: "2026-08-01T22:00:01.000Z",
    })).toMatchObject({ outcome: "accepted" });
    expect(() => validateBillingProviderReceipt({
      schemaVersion: 1,
      tenantId: "tenant-1",
      eventId: "event-1",
      idempotencyKey: "key-1",
      provider: "billing-test",
      externalReceiptRef: "billing:evt-1",
      outcome: "accepted",
      reconciledAt: "2026-08-01T22:00:01.000Z",
      token: "must-not-cross-boundary",
    })).toThrow("billing_provider_receipt_field_invalid");
  });
});
