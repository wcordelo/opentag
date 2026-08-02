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
  /** Opaque provider-side receipt; required before an effect can complete. */
  externalReceiptRef: string;
}>;

export type PlatformEffectAdapter = (
  intent: PlatformEffectIntent,
) => Promise<PlatformEffectAdapterResult>;

export type PlatformEffectAdapters = Partial<
  Record<PlatformEffectKind, PlatformEffectAdapter>
>;

export const PLATFORM_EFFECT_ADAPTER_SCHEMA_VERSION = 1 as const;

type PlatformEffectAdapterFetcher = Readonly<{
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}>;

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

function metadataContractError(): never {
  throw new PlatformEffectRunnerError("effect_metadata_contract_invalid");
}

function contractString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    metadataContractError();
  }
  return value;
}

function contractInteger(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    metadataContractError();
  }
  return value as number;
}

function contractEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    metadataContractError();
  }
  return value as T;
}

function contractKeys(
  metadata: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(metadata).some((key) => !allowed.includes(key))) {
    metadataContractError();
  }
}

function contractMetadata(
  intent: PlatformEffectIntent,
): PlatformEffectIntent {
  const metadata = intent.metadata as Record<string, unknown>;
  switch (intent.kind) {
    case "provisioning":
      contractKeys(metadata, [
        "externalPlatform",
        "externalTenantId",
        "isolationMode",
        "custodyBackend",
        "requestId",
      ]);
      contractEnum(metadata.externalPlatform, ["slack"]);
      contractString(metadata.externalTenantId);
      contractEnum(metadata.isolationMode, ["shared_worker_per_tenant_do", "workers_for_platforms"]);
      contractEnum(metadata.custodyBackend, ["external_kms", "wrapped_do_envelope", "self_hosted"]);
      contractString(metadata.requestId);
      break;
    case "identity_custody":
      contractKeys(metadata, ["operation", "version"]);
      contractEnum(metadata.operation, ["revoke", "rotate"]);
      contractInteger(metadata.version);
      break;
    case "credential_custody":
      contractKeys(metadata, ["operation", "previousVersion", "provider", "version"]);
      contractEnum(metadata.operation, ["revoke", "rotate"]);
      contractString(metadata.provider);
      contractInteger(metadata.version);
      if (metadata.previousVersion !== undefined) contractInteger(metadata.previousVersion);
      break;
    case "connector_oauth":
      contractKeys(metadata, ["connectorId", "credentialRef", "operation", "principalId", "version"]);
      contractString(metadata.connectorId);
      contractString(metadata.credentialRef);
      contractEnum(metadata.operation, [
        "credential_revocation",
        "credential_rotation",
        "explicit_revoke",
        "grant_rotation",
      ]);
      contractString(metadata.principalId);
      contractInteger(metadata.version);
      break;
    case "marketplace":
      contractKeys(metadata, [
        "authMode",
        "connectorId",
        "operation",
        "provider",
        "status",
        "trustReviewRef",
        "version",
      ]);
      contractEnum(metadata.authMode, ["oauth2", "service_binding", "none"]);
      contractString(metadata.connectorId);
      contractEnum(metadata.operation, ["curate", "deprecate", "revoke"]);
      contractString(metadata.provider);
      contractEnum(metadata.status, ["curated", "deprecated", "revoked"]);
      contractString(metadata.trustReviewRef);
      contractString(metadata.version);
      break;
    case "billing_meter":
      contractKeys(metadata, ["executionId", "metric", "planRevision", "quantity", "tier", "unit"]);
      contractString(metadata.executionId);
      contractEnum(metadata.metric, ["knowledge_query", "agent_tokens", "connector_calls", "container_ms"]);
      contractInteger(metadata.planRevision);
      contractInteger(metadata.quantity, true);
      if (![1, 2, 3].includes(metadata.tier as number)) metadataContractError();
      contractEnum(metadata.unit, ["count", "tokens", "milliseconds"]);
      break;
    case "memory_deletion":
      contractKeys(metadata, ["deletionEpoch", "requestId"]);
      contractInteger(metadata.deletionEpoch, true);
      contractString(metadata.requestId);
      break;
  }
  return intent;
}

/**
 * Validate the exact metadata shape that a provider adapter may receive.
 *
 * The durable ledger keeps a generic bounded envelope for forward-compatible
 * storage, but the external effect boundary is stricter: each effect kind has
 * a closed metadata vocabulary and primitive types. This prevents a future
 * adapter from treating an unreviewed field as a provider instruction.
 */
export function validatePlatformEffectAdapterIntent(
  intent: PlatformEffectIntent,
): PlatformEffectIntent {
  return contractMetadata(intent);
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

function boundedEffectRetryAfterSeconds(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 86_400
  ) {
    return 0;
  }
  return value as number;
}

function strictAdapterRetryAfter(value: unknown): number {
  if (value === undefined) return 0;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 86_400
  ) {
    throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
  }
  return value as number;
}

function strictResponseKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
  }
}

function remoteAdapterResponse(value: unknown): PlatformEffectAdapterResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== PLATFORM_EFFECT_ADAPTER_SCHEMA_VERSION) {
    throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
  }
  if (input.status === "completed") {
    strictResponseKeys(input, ["schemaVersion", "status", "externalReceiptRef"]);
    return { externalReceiptRef: receiptReference(input.externalReceiptRef) };
  }
  if (input.status === "failed") {
    strictResponseKeys(input, ["schemaVersion", "status", "errorCode", "retryable", "retryAfterSeconds"]);
    let errorCode: string;
    try {
      errorCode = safeErrorCode(input.errorCode, "effect_provider_error_code");
    } catch {
      throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
    }
    if (typeof input.retryable !== "boolean") {
      throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
    }
    throw new PlatformEffectAdapterError(
      errorCode,
      input.retryable,
      strictAdapterRetryAfter(input.retryAfterSeconds),
    );
  }
  throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
}

/**
 * Build one metadata-only adapter for an explicitly authenticated provider
 * Worker. The remote Worker owns provider custody and returns only a bounded
 * receipt or safe retry classification; it never receives the effect lease.
 */
export function createRemotePlatformEffectAdapter(
  fetcher: PlatformEffectAdapterFetcher,
  authToken: string,
): PlatformEffectAdapter {
  if (!authToken || !authToken.trim()) {
    throw new PlatformEffectRunnerError("effect_adapter_auth_unconfigured");
  }
  return async (intent) => {
    validatePlatformEffectAdapterIntent(intent);
    let response: Response;
    try {
      response = await fetcher.fetch("https://platform-effect-adapter/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          schemaVersion: PLATFORM_EFFECT_ADAPTER_SCHEMA_VERSION,
          intent,
        }),
      });
    } catch {
      throw new PlatformEffectAdapterError("effect_provider_unavailable", true, 30);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new PlatformEffectAdapterError(
        retryable
          ? "effect_provider_unavailable"
          : response.status === 401 || response.status === 403
            ? "effect_provider_unauthorized"
            : "effect_provider_rejected",
        retryable,
        retryable ? 30 : 0,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PlatformEffectAdapterError("effect_adapter_response_invalid", false);
    }
    return remoteAdapterResponse(payload);
  };
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

function receiptReference(value: unknown): string {
  try {
    return identifier(value, "external_receipt_ref", 256);
  } catch {
    throw new PlatformEffectAdapterError("external_receipt_ref_invalid", false);
  }
}

function normalizeAdapterFailure(error: unknown): EffectFailure {
  if (error instanceof PlatformEffectAdapterError) {
    try {
      return {
        errorCode: safeErrorCode(error.code),
        retryable: error.retryable,
        retryAfterSeconds: boundedEffectRetryAfterSeconds(error.retryAfterSeconds),
      };
    } catch {
      return {
        errorCode: "effect_adapter_failed",
        retryable: false,
        retryAfterSeconds: 0,
      };
    }
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
      retryable: true,
      retryAfterSeconds: 0,
    });
    return { status: "failed", adapterConfigured: false, receipt, errorCode: "effect_scope_mismatch" };
  }

  try {
    validatePlatformEffectAdapterIntent(intent);
  } catch {
    const receipt = await reportFailure(input.state, claim, {
      errorCode: "effect_metadata_contract_invalid",
      retryable: false,
      retryAfterSeconds: 0,
    });
    return {
      status: "failed",
      adapterConfigured: false,
      receipt,
      errorCode: "effect_metadata_contract_invalid",
    };
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
  let externalReceiptRef: string;
  try {
    result = await adapter(intent);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new PlatformEffectAdapterError("effect_adapter_result_invalid", false);
    }
    externalReceiptRef = receiptReference(result.externalReceiptRef);
  } catch (error) {
    const failure = normalizeAdapterFailure(error);
    const receipt = await reportFailure(input.state, claim, failure);
    return { status: "failed", adapterConfigured: true, receipt, errorCode: failure.errorCode };
  }
  let completion: Awaited<ReturnType<PlatformEffectStateClient["complete"]>>;
  try {
    completion = await input.state.complete({
      intentId: intent.intentId,
      leaseToken: claim.leaseToken,
      externalReceiptRef,
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
