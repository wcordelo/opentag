import { describe, expect, it } from "vitest";
import {
  PlatformEffectAdapterError,
  PlatformEffectRunnerError,
  runPlatformEffect,
  validatePlatformEffectRunRequest,
  type PlatformEffectStateClient,
} from "../src/platform/effect-runner.js";
import type {
  PlatformEffectClaim,
  PlatformEffectReceipt,
} from "../src/platform/layer3-contract.js";
import { validatePlatformEffectIntent } from "../src/platform/layer3-contract.js";

const intent = validatePlatformEffectIntent({
  schemaVersion: 1,
  intentId: "effect:credential:rotate:1",
  idempotencyKey: "credential-rotate-1",
  scope: "tenant",
  tenantId: "tenant-1",
  kind: "credential_custody",
  targetRef: "credential:google:workspace",
  metadata: { operation: "rotate", version: 2 },
  requestedAt: "2026-08-01T22:00:00.000Z",
});

function receipt(status: PlatformEffectReceipt["status"]): PlatformEffectReceipt {
  return {
    schemaVersion: 1,
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    scope: intent.scope,
    tenantId: intent.tenantId,
    kind: intent.kind,
    targetRef: intent.targetRef,
    status,
    attempts: 1,
    retryable: status === "failed",
    availableAt: "2026-08-01T22:00:00.000Z",
    requestedAt: intent.requestedAt,
    updatedAt: "2026-08-01T22:00:00.000Z",
  };
}

function makeState(): {
  state: PlatformEffectStateClient;
  calls: { claim: unknown[]; complete: unknown[]; fail: unknown[] };
} {
  const calls = { claim: [] as unknown[], complete: [] as unknown[], fail: [] as unknown[] };
  const claim: PlatformEffectClaim = {
    intent,
    receipt: receipt("leased"),
    leaseToken: "lease-1",
    leaseOwner: "effecter-1",
    leaseExpiresAt: "2026-08-01T22:05:00.000Z",
  };
  return {
    calls,
    state: {
      async claim(input) {
        calls.claim.push(input);
        return claim;
      },
      async complete(input) {
        calls.complete.push(input);
        return { ok: true, duplicate: false, receipt: receipt("completed") };
      },
      async fail(input) {
        calls.fail.push(input);
        return { ok: true, receipt: receipt("failed") };
      },
    },
  };
}

describe("platform effect runner", () => {
  it("claims, invokes the explicit adapter, and records a bounded receipt", async () => {
    const { state, calls } = makeState();
    const result = await runPlatformEffect({
      request: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
        leaseSeconds: 60,
      },
      state,
      adapters: {
        credential_custody: async (received) => {
          expect(received).toEqual(intent);
          return { externalReceiptRef: "kms-receipt-1" };
        },
      },
    });
    expect(result).toMatchObject({ status: "completed", adapterConfigured: true });
    expect(calls.claim).toEqual([{
      intentId: intent.intentId,
      workerId: "effecter-1",
      leaseSeconds: 60,
    }]);
    expect(calls.complete).toEqual([{
      intentId: intent.intentId,
      leaseToken: "lease-1",
      externalReceiptRef: "kms-receipt-1",
    }]);
    expect(calls.fail).toHaveLength(0);
  });

  it("fails closed when an adapter is not configured", async () => {
    const { state, calls } = makeState();
    const result = await runPlatformEffect({
      request: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
      state,
      adapters: {},
    });
    expect(result).toMatchObject({
      status: "failed",
      adapterConfigured: false,
      errorCode: "effect_adapter_unconfigured",
    });
    expect(calls.complete).toHaveLength(0);
    expect(calls.fail).toEqual([{
      intentId: intent.intentId,
      leaseToken: "lease-1",
      errorCode: "effect_adapter_unconfigured",
      retryable: false,
      retryAfterSeconds: 0,
    }]);
  });

  it("preserves explicit retry classification and rejects scope confusion", async () => {
    const { state, calls } = makeState();
    const retry = await runPlatformEffect({
      request: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
      state,
      adapters: {
        credential_custody: async () => {
          throw new PlatformEffectAdapterError("kms_temporarily_unavailable", true, 30);
        },
      },
    });
    expect(retry).toMatchObject({ status: "failed", errorCode: "kms_temporarily_unavailable" });
    expect(calls.fail.at(-1)).toMatchObject({
      errorCode: "kms_temporarily_unavailable",
      retryable: true,
      retryAfterSeconds: 30,
    });

    const mismatched = await runPlatformEffect({
      request: {
        scope: "tenant",
        tenantId: "tenant-other",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
      state,
      adapters: {},
    });
    expect(mismatched).toMatchObject({ status: "failed", errorCode: "effect_scope_mismatch" });
    expect(calls.fail.at(-1)).toMatchObject({ errorCode: "effect_scope_mismatch", retryable: false });
  });

  it("bounds runner requests and does not retry unknown adapter exceptions", async () => {
    expect(() => validatePlatformEffectRunRequest({
      scope: "platform",
      tenantId: "not-allowed",
      intentId: "effect-1",
      workerId: "worker-1",
    })).toThrow("effect_platform_tenant_forbidden");

    const { state, calls } = makeState();
    const result = await runPlatformEffect({
      request: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
      state,
      adapters: { credential_custody: async () => { throw new Error("provider detail"); } },
    });
    expect(result).toMatchObject({ status: "failed", errorCode: "effect_adapter_failed" });
    expect(calls.fail.at(-1)).toMatchObject({
      errorCode: "effect_adapter_failed",
      retryable: false,
    });
    expect(result).not.toHaveProperty("provider detail");
    expect(() => validatePlatformEffectRunRequest({})).toThrow(PlatformEffectRunnerError);
  });
});
