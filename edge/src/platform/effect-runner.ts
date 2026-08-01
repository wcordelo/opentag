import {
  type PlatformEffectClaim,
  type PlatformEffectIntent,
  type PlatformEffectKind,
  type PlatformEffectReceipt,
  validatePlatformEffectIntent,
} from "./layer3-contract.js";

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type PlatformEffectRunRequest = Readonly<{
  scope: "tenant" | "platform";
  tenantId?: string;
  intentId: string;
  workerId: string;
  leaseSeconds?: number;
}>;

export class PlatformEffectRunnerError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 409 | 503 = 400,
  ) {
    super(code);
    this.name = "PlatformEffectRunnerError";
  }
}

export class PlatformEffectAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds = 0,
  ) {
    super(code);
    this.name = "PlatformEffectAdapterError";
  }
}

export type PlatformEffectAdapterResult = Readonly<{
  externalReceiptRef?: string;
}>;

export type PlatformEffectAdapter = (
  intent: PlatformEffectIntent,
) => Promise<PlatformEffectAdapterResult>;

export type PlatformEffectAdapters = Partial<
  Record<PlatformEffectKind, PlatformEffectAdapter>
>;

type EffectFailure = Readonly<{
  errorCode: string;
  retryable: boolean;
  retryAfterSeconds: number;
}>;

export type PlatformEffectStateClient = Readonly<{
  claim(input: {
    intentId: string;
    workerId: string;
    leaseSeconds?: number;
  }): Promise<PlatformEffectClaim>;
  complete(input: {
    intentId: string;
    leaseToken: string;
    externalReceiptRef?: string;
  }): Promise<{ ok: true; duplicate: boolean; receipt: PlatformEffectReceipt }>;
  fail(input: {
    intentId: string;
    leaseToken: string;
    errorCode: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  }): Promise<{ ok: true; receipt: PlatformEffectReceipt }>;
}>;

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new PlatformEffectRunnerError(`${field}_invalid`);
  }
  return value;
}

function safeErrorCode(value: unknown, field = "effect_error_code"): string {
  const result = identifier(value, field, 128);
  if (!/^[a-z][a-z0-9_.-]*$/.test(result)) {
    throw new PlatformEffectRunnerError(`${field}_invalid`);
  }
  return result;
}

function leaseSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 30 ||
    (value as number) > 3_600
  ) {
    throw new PlatformEffectRunnerError("lease_seconds_invalid");
  }
  return value as number;
}

export function validatePlatformEffectRunRequest(
  value: unknown,
): PlatformEffectRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformEffectRunnerError("effect_run_request_invalid");
  }
  const input = value as Record<string, unknown>;
  const scope = input.scope;
  if (scope !== "tenant" && scope !== "platform") {
    throw new PlatformEffectRunnerError("effect_scope_invalid");
  }
  const tenantId = input.tenantId === undefined
    ? undefined
    : identifier(input.tenantId, "tenant_id");
  if (scope === "tenant" && !tenantId) {
    throw new PlatformEffectRunnerError("effect_tenant_id_required");
  }
  if (scope === "platform" && tenantId !== undefined) {
    throw new PlatformEffectRunnerError("effect_platform_tenant_forbidden");
  }
  const requestedLeaseSeconds = leaseSeconds(input.leaseSeconds);
  return Object.freeze({
    scope,
    ...(tenantId ? { tenantId } : {}),
    intentId: identifier(input.intentId, "intent_id"),
    workerId: identifier(input.workerId, "worker_id"),
    ...(requestedLeaseSeconds === undefined
      ? {}
      : { leaseSeconds: requestedLeaseSeconds }),
  });
}

function receiptReference(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return identifier(value, "external_receipt_ref", 256);
}

function normalizeAdapterFailure(error: unknown): EffectFailure {
  if (error instanceof PlatformEffectAdapterError) {
    return {
      errorCode: safeErrorCode(error.code),
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  // An adapter must explicitly classify a provider error before it can be
  // retried. Unknown exceptions are terminal so a broken adapter cannot
  // create an unbounded provider-call loop.
  return {
    errorCode: "effect_adapter_failed",
    retryable: false,
    retryAfterSeconds: 0,
  };
}

async function reportFailure(
  state: PlatformEffectStateClient,
  claim: PlatformEffectClaim,
  failure: EffectFailure,
): Promise<PlatformEffectReceipt> {
  try {
    const result = await state.fail({
      intentId: claim.intent.intentId,
      leaseToken: claim.leaseToken,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      retryAfterSeconds: failure.retryAfterSeconds,
    });
    return result.receipt;
  } catch {
    throw new PlatformEffectRunnerError("effect_failure_report_failed", 503);
  }
}

export type PlatformEffectRunResult = Readonly<{
  status: "completed" | "failed";
  adapterConfigured: boolean;
  receipt: PlatformEffectReceipt;
  errorCode?: string;
}>;

/**
 * Claim one durable intent, run only its explicitly registered adapter, and
 * close the lease with a durable receipt. This module never receives a raw
 * provider secret; adapters own their last-mile custody boundary.
 */
export async function runPlatformEffect(input: {
  request: PlatformEffectRunRequest;
  state: PlatformEffectStateClient;
  adapters: PlatformEffectAdapters;
}): Promise<PlatformEffectRunResult> {
  const request = validatePlatformEffectRunRequest(input.request);
  const claim = await input.state.claim({
    intentId: request.intentId,
    workerId: request.workerId,
    leaseSeconds: request.leaseSeconds,
  });
  const intent = validatePlatformEffectIntent(claim.intent);
  const claimMatchesRequest =
    intent.scope === request.scope &&
    (request.scope === "platform" || intent.tenantId === request.tenantId);
  if (!claimMatchesRequest) {
    const receipt = await reportFailure(input.state, claim, {
      errorCode: "effect_scope_mismatch",
      retryable: false,
      retryAfterSeconds: 0,
    });
    return { status: "failed", adapterConfigured: false, receipt, errorCode: "effect_scope_mismatch" };
  }

  const adapter = input.adapters[intent.kind];
  if (!adapter) {
    const receipt = await reportFailure(input.state, claim, {
      errorCode: "effect_adapter_unconfigured",
      retryable: false,
      retryAfterSeconds: 0,
    });
    return {
      status: "failed",
      adapterConfigured: false,
      receipt,
      errorCode: "effect_adapter_unconfigured",
    };
  }

  let result: PlatformEffectAdapterResult;
  try {
    result = await adapter(intent);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new PlatformEffectAdapterError("effect_adapter_result_invalid", false);
    }
  } catch (error) {
    const failure = normalizeAdapterFailure(error);
    const receipt = await reportFailure(input.state, claim, failure);
    return { status: "failed", adapterConfigured: true, receipt, errorCode: failure.errorCode };
  }

  const externalReceiptRef = receiptReference(result.externalReceiptRef);
  let completion: Awaited<ReturnType<PlatformEffectStateClient["complete"]>>;
  try {
    completion = await input.state.complete({
      intentId: intent.intentId,
      leaseToken: claim.leaseToken,
      ...(externalReceiptRef ? { externalReceiptRef } : {}),
    });
  } catch {
    // The provider call has already happened. Do not call fail after an
    // ambiguous completion response: the lease/receipt boundary must be
    // reconciled by the durable state owner instead of risking a duplicate.
    throw new PlatformEffectRunnerError("effect_completion_report_failed", 503);
  }
  return {
    status: "completed",
    adapterConfigured: true,
    receipt: completion.receipt,
  };
}
