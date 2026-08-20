import { Hono } from "hono";
import type { Fetcher } from "@cloudflare/workers-types";
import {
  assertConnectorLabelsIntegrity,
  resolveCredentialBearer,
  validateCredentialBrokerRequest,
  type CredentialBroker,
} from "../../../src/connectors/credential-broker.js";
import {
  parseCredentialReference,
  type ImmutableConnectorLabels,
  type CredentialReference,
} from "../../../src/connectors/authorization.js";
import {
  assertLinearWriteApprovalCurrent,
  createLinearIssue,
  LinearConnectorError,
  type LinearWriteApproval,
} from "../../../src/connectors/linear-write.js";
import type { AccessBundle } from "../../../src/config/access-bundle.js";
import {
  validatePlatformEffectAdapterIntent,
} from "../../../src/platform/effect-runner.js";
import {
  validatePlatformEffectIntent,
  type PlatformEffectIntent,
} from "../../../src/platform/layer3-contract.js";

export const PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION = 1 as const;
export const PROVIDER_RECEIPT_SCHEMA_VERSION = 1 as const;

const MAX_JSON_BYTES = 96 * 1024;
const LINEAR_API_URL = "https://api.linear.app/graphql";
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SAFE_FAILURE_CODE_RE = /^(?:credential|connector|linear|provider|idempotency)_[a-z0-9_.-]{1,127}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ProviderAdapterEnv = {
  Bindings: {
    PLATFORM_PROVIDER_ADAPTER_AUTH_TOKEN?: string;
    PROVIDER_REQUEST_RESOLVER?: Fetcher;
    PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?: string;
    CREDENTIAL_BROKER?: Fetcher;
    CREDENTIAL_BROKER_AUTH_TOKEN?: string;
    PROVIDER_IDEMPOTENCY_STORE?: Fetcher;
    PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN?: string;
    LINEAR_CONTROLLED_WORKSPACE_SUBJECT?: string;
    LINEAR_API_URL?: string;
    ENVIRONMENT?: string;
  };
};

type ProviderReceipt = Readonly<{
  schemaVersion: typeof PROVIDER_RECEIPT_SCHEMA_VERSION;
  tenantId: string;
  provider: "linear";
  action: "create_issue";
  idempotencyKey: string;
  requestRef: string;
  requestRevision: number;
  requestDigest: string;
  authorizationDigest: string;
  status: "completed" | "ambiguous";
  externalReceiptRef?: string;
  observedAt: string;
}>;

type RequestResolution = Readonly<{
  schemaVersion: typeof PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION;
  requestRef: string;
  requestRevision: number;
  requestDigest: string;
  authorizationDigest: string;
  labels: ImmutableConnectorLabels;
  credential: CredentialReference;
  approval: LinearWriteApproval;
}>;

type Reservation = Readonly<{
  reservationId: string;
  key: string;
}>;

class ProviderAdapterError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 503) {
    super(code);
    this.name = "ProviderAdapterError";
  }
}

class ProviderExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds = 0,
    readonly ambiguous = false,
  ) {
    super(code);
    this.name = "ProviderExecutionError";
  }
}

const app = new Hono<ProviderAdapterEnv>();

function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBytes = new TextEncoder().encode(expected);
  const actualBytes = new TextEncoder().encode(actual);
  let difference = expectedBytes.length ^ actualBytes.length;
  const length = Math.max(expectedBytes.length, actualBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);
  }
  return difference === 0;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderAdapterError(code, 400);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  code: string,
): void {
  const allowed = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !allowed.has(field))) {
    throw new ProviderAdapterError(code, 400);
  }
}

function fieldsWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    actual.some((field) => !allowed.has(field))
  ) {
    throw new ProviderAdapterError(code, 400);
  }
}

function identifier(value: unknown, field: string, max = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new ProviderAdapterError(`${field}_invalid`, 400);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProviderAdapterError(`${field}_invalid`, 400);
  }
  return value as number;
}

function digest(value: unknown, field: string): string {
  const result = identifier(value, field, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    throw new ProviderAdapterError(`${field}_invalid`, 400);
  }
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new ProviderAdapterError(`${field}_invalid`, 400);
  }
  return result;
}

function externalReceiptReference(value: unknown, field = "external_receipt_ref"): string {
  const result = identifier(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) {
    throw new ProviderAdapterError(`${field}_invalid`, 503);
  }
  return result;
}

function safeFailureCode(value: unknown, fallback: string): string {
  if (typeof value === "string" && SAFE_FAILURE_CODE_RE.test(value)) return value;
  return fallback;
}

function safeProviderCode(error: unknown, fallback: string): string {
  const candidate = error instanceof LinearConnectorError
    ? error.code
    : error instanceof Error
      ? error.message
      : undefined;
  return typeof candidate === "string" && SAFE_FAILURE_CODE_RE.test(candidate)
    ? candidate
    : fallback;
}

function responseFailure(
  code: string,
  retryable: boolean,
  retryAfterSeconds = 0,
): Record<string, unknown> {
  return {
    schemaVersion: PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION,
    status: "failed",
    errorCode: safeFailureCode(code, "provider_execution_failed"),
    retryable,
    retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= 86_400
      ? retryAfterSeconds
      : 0,
  };
}

function responseCompleted(externalReceiptRef: string): Record<string, unknown> {
  return {
    schemaVersion: PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION,
    status: "completed",
    externalReceiptRef,
  };
}

function contentLengthTooLarge(request: Request): boolean {
  const raw = request.headers.get("content-length");
  return raw !== null && /^\d+$/.test(raw) && Number(raw) > MAX_JSON_BYTES;
}

async function readBoundedJson(
  stream: ReadableStream<Uint8Array> | null,
  tooLargeCode: string,
  invalidCode: string,
): Promise<unknown> {
  if (!stream) throw new ProviderAdapterError(invalidCode, 400);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new ProviderAdapterError(tooLargeCode, 400);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ProviderAdapterError(invalidCode, 400);
  }
}

function requireAuth(
  env: ProviderAdapterEnv["Bindings"],
  authorization: string | undefined,
): void {
  const expected = env.PLATFORM_PROVIDER_ADAPTER_AUTH_TOKEN;
  if (!expected?.trim()) {
    throw new ProviderAdapterError("provider_adapter_auth_unconfigured", 503);
  }
  const prefix = "Bearer ";
  const presented = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : undefined;
  if (!presented || !constantTimeEqual(expected, presented)) {
    throw new ProviderAdapterError("unauthorized", 401);
  }
}

function validateEffectEnvelope(value: unknown): PlatformEffectIntent {
  const envelope = record(value, "provider_adapter_request_invalid");
  exactFields(envelope, ["schemaVersion", "intent"], "provider_adapter_request_invalid");
  if (envelope.schemaVersion !== PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION) {
    throw new ProviderAdapterError("provider_adapter_schema_invalid", 400);
  }
  const rawIntent = record(envelope.intent, "provider_adapter_request_invalid");
  exactFields(
    rawIntent,
    ["schemaVersion", "intentId", "idempotencyKey", "scope", "tenantId", "kind", "targetRef", "metadata", "requestedAt"],
    "provider_adapter_request_invalid",
  );
  let intent: PlatformEffectIntent;
  try {
    intent = validatePlatformEffectIntent(rawIntent);
    validatePlatformEffectAdapterIntent(intent);
  } catch {
    throw new ProviderAdapterError("provider_adapter_request_invalid", 400);
  }
  if (
    intent.scope !== "tenant" ||
    !intent.tenantId ||
    intent.kind !== "connector_effect" ||
    intent.targetRef !== "connector:linear:create_issue"
  ) {
    throw new ProviderAdapterError("linear_effect_not_supported", 400);
  }
  const metadata = intent.metadata as Record<string, unknown>;
  if (
    metadata.connectorId !== "linear" ||
    metadata.action !== "create_issue" ||
    typeof metadata.credentialRef !== "string" ||
    !Number.isSafeInteger(metadata.credentialVersion) ||
    typeof metadata.requestRef !== "string" ||
    !Number.isSafeInteger(metadata.requestRevision) ||
    typeof metadata.authorizationDigest !== "string" ||
    typeof metadata.requestDigest !== "string"
  ) {
    throw new ProviderAdapterError("provider_adapter_request_invalid", 400);
  }
  return intent;
}

function validateLabels(value: unknown, credentialRef: string, credentialVersion: number): ImmutableConnectorLabels {
  const input = record(value, "provider_request_labels_invalid");
  exactFields(
    input,
    [
      "schemaVersion",
      "workspaceId",
      "projectId",
      "channelId",
      "connectorId",
      "action",
      "scope",
      "requesterId",
      "actorKind",
      "executionId",
      "threadKey",
      "accessBundleId",
      "accessBundleRevision",
      "credentialRef",
      "credentialVersion",
      "issuedAt",
      "expiresAt",
      "digest",
    ],
    "provider_request_labels_invalid",
  );
  try {
    return validateCredentialBrokerRequest({
      schemaVersion: 1,
      reference: { ref: credentialRef, version: credentialVersion },
      labels: input,
    }).labels;
  } catch {
    throw new ProviderAdapterError("provider_request_labels_invalid", 400);
  }
}

function approvalIdFromReference(requestRef: string): string {
  const prefix = "linear-write-approval:";
  if (!requestRef.startsWith(prefix)) {
    throw new ProviderExecutionError("linear_request_ref_unsupported", false);
  }
  const approvalId = requestRef.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(approvalId)) {
    throw new ProviderExecutionError("linear_request_ref_invalid", false);
  }
  return approvalId;
}

async function validateResolution(
  value: unknown,
  intent: PlatformEffectIntent,
  env: ProviderAdapterEnv["Bindings"],
): Promise<RequestResolution> {
  const metadata = intent.metadata as Record<string, unknown>;
  const input = record(value, "provider_request_resolution_invalid");
  exactFields(
    input,
    ["schemaVersion", "requestRef", "requestRevision", "requestDigest", "authorizationDigest", "labels", "credential", "approval"],
    "provider_request_resolution_invalid",
  );
  if (input.schemaVersion !== PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION) {
    throw new ProviderExecutionError("provider_request_resolution_invalid", false);
  }
  const requestRef = identifier(input.requestRef, "request_ref");
  const requestRevision = positiveInteger(input.requestRevision, "request_revision");
  const requestDigest = digest(input.requestDigest, "request_digest");
  const authorizationDigest = digest(input.authorizationDigest, "authorization_digest");
  if (
    requestRef !== metadata.requestRef ||
    requestRevision !== metadata.requestRevision ||
    requestDigest !== metadata.requestDigest ||
    authorizationDigest !== metadata.authorizationDigest
  ) {
    throw new ProviderExecutionError("provider_request_resolution_mismatch", false);
  }
  const credentialInput = record(input.credential, "provider_request_credential_invalid");
  fieldsWithOptional(
    credentialInput,
    ["schemaVersion", "ref", "provider", "name", "version", "status", "scopes", "subject", "issuedAt"],
    ["expiresAt", "revokedAt"],
    "provider_request_credential_invalid",
  );
  let credential: CredentialReference;
  try {
    credential = parseCredentialReference(credentialInput);
  } catch {
    throw new ProviderExecutionError("provider_request_credential_invalid", false);
  }
  if (credential.ref !== metadata.credentialRef || credential.version !== metadata.credentialVersion) {
    throw new ProviderExecutionError("credential_reference_mismatch", false);
  }
  if (credential.provider !== "linear") {
    throw new ProviderExecutionError("credential_provider_mismatch", false);
  }
  if (credential.status !== "active" || credential.revokedAt !== undefined) {
    throw new ProviderExecutionError("credential_revoked", false);
  }
  if (credential.expiresAt !== undefined && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new ProviderExecutionError("credential_expired", false);
  }
  if (!credential.scopes.includes("issues:create") && !credential.scopes.includes("write")) {
    throw new ProviderExecutionError("credential_scope_missing", false);
  }
  if (!env.LINEAR_CONTROLLED_WORKSPACE_SUBJECT?.trim()) {
    throw new ProviderAdapterError("linear_controlled_workspace_unconfigured", 503);
  }
  if (credential.subject !== env.LINEAR_CONTROLLED_WORKSPACE_SUBJECT) {
    throw new ProviderExecutionError("linear_workspace_not_controlled", false);
  }
  const labels = validateLabels(input.labels, credential.ref, credential.version);
  if (
    labels.connectorId !== "linear" ||
    labels.action !== "create_issue" ||
    labels.credentialRef !== credential.ref ||
    labels.credentialVersion !== credential.version ||
    labels.digest !== authorizationDigest ||
    Date.parse(labels.expiresAt) <= Date.now()
  ) {
    throw new ProviderExecutionError("connector_authorization_mismatch", false);
  }
  try {
    await assertConnectorLabelsIntegrity(labels);
  } catch {
    throw new ProviderExecutionError("connector_labels_tampered", false);
  }
  const approvalInput = record(input.approval, "provider_request_approval_invalid");
  exactFields(
    approvalInput,
    [
      "schemaVersion",
      "approvalId",
      "connectorId",
      "action",
      "teamId",
      "channelId",
      "requesterId",
      "actorKind",
      "executionId",
      "threadKey",
      "draft",
      "draftDigest",
      "approvedAt",
      "expiresAt",
    ],
    "provider_request_approval_invalid",
  );
  const approvalId = approvalIdFromReference(requestRef);
  let approval: LinearWriteApproval;
  try {
    approval = await assertLinearWriteApprovalCurrent(approvalInput, {
      approvalId,
      teamId: identifier(approvalInput.teamId, "linear_team_id"),
      channelId: identifier(approvalInput.channelId, "linear_channel_id"),
      requesterId: identifier(approvalInput.requesterId, "linear_requester_id"),
      executionId: identifier(approvalInput.executionId, "linear_execution_id"),
      threadKey: identifier(approvalInput.threadKey, "linear_thread_key"),
      draft: approvalInput.draft,
      now: Date.now(),
    });
  } catch (error) {
    if (error instanceof LinearConnectorError && SAFE_FAILURE_CODE_RE.test(error.code)) {
      throw new ProviderExecutionError(error.code, error.retryable);
    }
    throw new ProviderExecutionError("provider_request_approval_invalid", false);
  }
  if (approval.draftDigest !== requestDigest) {
    throw new ProviderExecutionError("provider_request_digest_mismatch", false);
  }
  return Object.freeze({
    schemaVersion: PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION,
    requestRef,
    requestRevision,
    requestDigest,
    authorizationDigest,
    labels,
    credential,
    approval,
  });
}

function requestKey(intent: PlatformEffectIntent): string {
  return [
    intent.tenantId,
    "linear",
    "create_issue",
    intent.idempotencyKey,
  ].join("|");
}

function providerReceiptFields(status: ProviderReceipt["status"]): readonly string[] {
  return status === "completed"
    ? [
      "schemaVersion",
      "tenantId",
      "provider",
      "action",
      "idempotencyKey",
      "requestRef",
      "requestRevision",
      "requestDigest",
      "authorizationDigest",
      "status",
      "externalReceiptRef",
      "observedAt",
    ]
    : [
      "schemaVersion",
      "tenantId",
      "provider",
      "action",
      "idempotencyKey",
      "requestRef",
      "requestRevision",
      "requestDigest",
      "authorizationDigest",
      "status",
      "observedAt",
    ];
}

function validateProviderReceipt(value: unknown): ProviderReceipt {
  const input = record(value, "provider_receipt_invalid");
  if (input.status !== "completed" && input.status !== "ambiguous") {
    throw new ProviderAdapterError("provider_receipt_invalid", 503);
  }
  exactFields(input, providerReceiptFields(input.status), "provider_receipt_invalid");
  if (input.schemaVersion !== PROVIDER_RECEIPT_SCHEMA_VERSION) {
    throw new ProviderAdapterError("provider_receipt_invalid", 503);
  }
  const provider = input.provider;
  const action = input.action;
  if (provider !== "linear" || action !== "create_issue") {
    throw new ProviderAdapterError("provider_receipt_invalid", 503);
  }
  const result: ProviderReceipt = {
    schemaVersion: PROVIDER_RECEIPT_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "receipt_tenant_id"),
    provider: "linear",
    action: "create_issue",
    idempotencyKey: identifier(input.idempotencyKey, "receipt_idempotency_key"),
    requestRef: identifier(input.requestRef, "receipt_request_ref"),
    requestRevision: positiveInteger(input.requestRevision, "receipt_request_revision"),
    requestDigest: digest(input.requestDigest, "receipt_request_digest"),
    authorizationDigest: digest(input.authorizationDigest, "receipt_authorization_digest"),
    status: input.status,
    ...(input.status === "completed"
      ? { externalReceiptRef: externalReceiptReference(input.externalReceiptRef) }
      : {}),
    observedAt: timestamp(input.observedAt, "receipt_observed_at"),
  };
  return Object.freeze(result);
}

function assertReceiptMatches(intent: PlatformEffectIntent, receipt: ProviderReceipt): void {
  const metadata = intent.metadata as Record<string, unknown>;
  if (
    receipt.tenantId !== intent.tenantId ||
    receipt.provider !== "linear" ||
    receipt.action !== "create_issue" ||
    receipt.idempotencyKey !== intent.idempotencyKey ||
    receipt.requestRef !== metadata.requestRef ||
    receipt.requestRevision !== metadata.requestRevision ||
    receipt.requestDigest !== metadata.requestDigest ||
    receipt.authorizationDigest !== metadata.authorizationDigest
  ) {
    throw new ProviderAdapterError("provider_receipt_mismatch", 503);
  }
}

async function idempotencyRequest(
  env: ProviderAdapterEnv["Bindings"],
  path: string,
  body: unknown,
): Promise<unknown> {
  if (!env.PROVIDER_IDEMPOTENCY_STORE) {
    throw new ProviderAdapterError("provider_idempotency_store_unconfigured", 503);
  }
  let response: Response;
  try {
    response = await env.PROVIDER_IDEMPOTENCY_STORE.fetch(`https://provider-idempotency${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderAdapterError("provider_idempotency_store_unavailable", 503);
  }
  if (!response.ok) {
    throw new ProviderAdapterError(
      response.status >= 500 ? "provider_idempotency_store_unavailable" : "provider_idempotency_store_rejected",
      503,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderAdapterError("provider_idempotency_store_response_invalid", 503);
  }
}

async function reserveIdempotency(
  env: ProviderAdapterEnv["Bindings"],
  intent: PlatformEffectIntent,
): Promise<Reservation | { receipt: ProviderReceipt }> {
  const metadata = intent.metadata as Record<string, unknown>;
  const key = requestKey(intent);
  const raw = record(await idempotencyRequest(env, "/reserve", {
    schemaVersion: PROVIDER_RECEIPT_SCHEMA_VERSION,
    operation: "reserve",
    key,
    tenantId: intent.tenantId,
    provider: "linear",
    action: "create_issue",
    idempotencyKey: intent.idempotencyKey,
    requestRef: metadata.requestRef,
    requestRevision: metadata.requestRevision,
    requestDigest: metadata.requestDigest,
    authorizationDigest: metadata.authorizationDigest,
  }), "provider_idempotency_reserve_invalid");
  if (raw.schemaVersion !== PROVIDER_RECEIPT_SCHEMA_VERSION) {
    throw new ProviderAdapterError("provider_idempotency_reserve_invalid", 503);
  }
  if (raw.status === "reserved") {
    exactFields(raw, ["schemaVersion", "status", "reservationId"], "provider_idempotency_reserve_invalid");
    return Object.freeze({
      key,
      reservationId: identifier(raw.reservationId, "reservation_id"),
    });
  }
  if (raw.status === "conflict") {
    exactFields(raw, ["schemaVersion", "status"], "provider_idempotency_reserve_invalid");
    throw new ProviderExecutionError("linear_idempotency_conflict", true, 30);
  }
  if (raw.status === "completed" || raw.status === "ambiguous") {
    exactFields(raw, ["schemaVersion", "status", "receipt"], "provider_idempotency_reserve_invalid");
    const receipt = validateProviderReceipt(raw.receipt);
    assertReceiptMatches(intent, receipt);
    return Object.freeze({ receipt });
  }
  throw new ProviderAdapterError("provider_idempotency_reserve_invalid", 503);
}

async function finalizeIdempotency(
  env: ProviderAdapterEnv["Bindings"],
  operation: "complete" | "ambiguous",
  reservation: Reservation,
  receipt: ProviderReceipt,
): Promise<void> {
  const raw = record(await idempotencyRequest(env, `/${operation}`, {
    schemaVersion: PROVIDER_RECEIPT_SCHEMA_VERSION,
    operation,
    reservationId: reservation.reservationId,
    key: reservation.key,
    receipt,
  }), "provider_idempotency_finalize_invalid");
  exactFields(raw, ["schemaVersion", "status"], "provider_idempotency_finalize_invalid");
  if (raw.schemaVersion !== PROVIDER_RECEIPT_SCHEMA_VERSION || raw.status !== "stored") {
    throw new ProviderAdapterError("provider_idempotency_finalize_invalid", 503);
  }
}

async function releaseIdempotency(
  env: ProviderAdapterEnv["Bindings"],
  reservation: Reservation,
): Promise<void> {
  const raw = record(await idempotencyRequest(env, "/release", {
    schemaVersion: PROVIDER_RECEIPT_SCHEMA_VERSION,
    operation: "release",
    reservationId: reservation.reservationId,
    key: reservation.key,
  }), "provider_idempotency_release_invalid");
  exactFields(raw, ["schemaVersion", "status"], "provider_idempotency_release_invalid");
  if (raw.schemaVersion !== PROVIDER_RECEIPT_SCHEMA_VERSION || raw.status !== "released") {
    throw new ProviderAdapterError("provider_idempotency_release_invalid", 503);
  }
}

async function resolveRequest(
  env: ProviderAdapterEnv["Bindings"],
  intent: PlatformEffectIntent,
): Promise<RequestResolution> {
  if (!env.PROVIDER_REQUEST_RESOLVER || !env.PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?.trim()) {
    throw new ProviderAdapterError("provider_request_resolver_unconfigured", 503);
  }
  const metadata = intent.metadata as Record<string, unknown>;
  let response: Response;
  try {
    response = await env.PROVIDER_REQUEST_RESOLVER.fetch("https://provider-request-resolver/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: PLATFORM_PROVIDER_ADAPTER_SCHEMA_VERSION,
        tenantId: intent.tenantId,
        provider: "linear",
        action: "create_issue",
        requestRef: metadata.requestRef,
        requestRevision: metadata.requestRevision,
        requestDigest: metadata.requestDigest,
        authorizationDigest: metadata.authorizationDigest,
      }),
    });
  } catch {
    throw new ProviderExecutionError("provider_request_unavailable", true, 30);
  }
  if (!response.ok) {
    let code = response.status >= 500 ? "provider_request_unavailable" : "provider_request_rejected";
    try {
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.error === "string" && SAFE_FAILURE_CODE_RE.test(body.error)) code = body.error;
    } catch {
      code = response.status >= 500 ? "provider_request_unavailable" : "provider_request_rejected";
    }
    throw new ProviderExecutionError(code, response.status >= 500, response.status >= 500 ? 30 : 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderExecutionError("provider_request_resolution_invalid", false);
  }
  try {
    return await validateResolution(body, intent, env);
  } catch (error) {
    if (error instanceof ProviderExecutionError) throw error;
    if (error instanceof ProviderAdapterError && error.status === 503) throw error;
    throw new ProviderExecutionError("provider_request_resolution_invalid", false);
  }
}

function bundleFor(labels: ImmutableConnectorLabels): AccessBundle {
  return {
    id: labels.accessBundleId,
    tools: [],
    mcpEndpoints: [],
    secretRefs: [],
    schemaVersion: 1,
    revision: labels.accessBundleRevision,
    status: "active",
    connectorGrants: [{
      connectorId: "linear",
      actions: ["create_issue"],
      scope: labels.scope,
      ...(labels.scope === "project" ? { projectId: labels.projectId } : {}),
      ...(labels.scope === "channel" ? { channelId: labels.channelId } : {}),
      credentialRef: labels.credentialRef,
    }],
  };
}

function linearApiUrl(env: ProviderAdapterEnv["Bindings"]): string {
  const value = env.LINEAR_API_URL?.trim() || LINEAR_API_URL;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("invalid");
  } catch {
    throw new ProviderAdapterError("linear_api_url_invalid", 503);
  }
  return value;
}

async function executeLinear(
  env: ProviderAdapterEnv["Bindings"],
  intent: PlatformEffectIntent,
  resolution: RequestResolution,
): Promise<{ externalReceiptRef: string; mutationStarted: boolean }> {
  if (!env.CREDENTIAL_BROKER || !env.CREDENTIAL_BROKER_AUTH_TOKEN?.trim()) {
    throw new ProviderAdapterError("credential_broker_unconfigured", 503);
  }
  let mutationStarted = false;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let query = "";
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        query = typeof body.query === "string" ? body.query : "";
      } catch {
        query = "";
      }
    }
    if (query.includes("mutation CreateLinearIssue")) mutationStarted = true;
    const headers = new Headers(init?.headers);
    headers.set("idempotency-key", intent.idempotencyKey);
    return await fetch(linearApiUrl(env), { ...init, headers });
  };
  const revalidate = async (): Promise<void> => {
    await assertConnectorLabelsIntegrity(resolution.labels);
    await resolveCredentialBearer(
      env.CREDENTIAL_BROKER as CredentialBroker,
      resolution.credential,
      resolution.labels,
      { brokerAuthToken: env.CREDENTIAL_BROKER_AUTH_TOKEN },
    );
  };
  try {
    const result = await createLinearIssue({
      labels: resolution.labels,
      bundle: bundleFor(resolution.labels),
      credential: resolution.credential,
      credentialBroker: env.CREDENTIAL_BROKER as CredentialBroker,
      brokerAuthToken: env.CREDENTIAL_BROKER_AUTH_TOKEN,
      draft: resolution.approval.draft,
      fetchImpl,
      revalidate,
    });
    const externalReceiptRef = `linear-issue:${result.id}`;
    if (!/^linear-issue:[A-Za-z0-9][A-Za-z0-9._:-]{0,242}$/.test(externalReceiptRef)) {
      throw new ProviderExecutionError("linear_provider_response_ambiguous", false, 0, true);
    }
    return {
      externalReceiptRef,
      mutationStarted,
    };
  } catch (error) {
    if (mutationStarted) {
      if (error instanceof LinearConnectorError && error.code === "linear_authorization_rejected") {
        throw new ProviderExecutionError(error.code, false);
      }
      throw new ProviderExecutionError("linear_provider_response_ambiguous", false, 0, true);
    }
    if (error instanceof LinearConnectorError) {
      throw new ProviderExecutionError(error.code, error.retryable, error.retryable ? 30 : 0);
    }
    const code = safeProviderCode(error, "credential_resolution_failed");
    throw new ProviderExecutionError(code, false);
  }
}

function completedReceipt(
  intent: PlatformEffectIntent,
  resolution: RequestResolution,
  externalReceiptRef: string,
): ProviderReceipt {
  return Object.freeze({
    schemaVersion: PROVIDER_RECEIPT_SCHEMA_VERSION,
    tenantId: intent.tenantId!,
    provider: "linear",
    action: "create_issue",
    idempotencyKey: intent.idempotencyKey,
    requestRef: resolution.requestRef,
    requestRevision: resolution.requestRevision,
    requestDigest: resolution.requestDigest,
    authorizationDigest: resolution.authorizationDigest,
    status: "completed",
    externalReceiptRef: externalReceiptReference(externalReceiptRef),
    observedAt: new Date().toISOString(),
  });
}

function ambiguousReceipt(
  intent: PlatformEffectIntent,
  resolution: RequestResolution,
): ProviderReceipt {
  return Object.freeze({
    schemaVersion: PROVIDER_RECEIPT_SCHEMA_VERSION,
    tenantId: intent.tenantId!,
    provider: "linear",
    action: "create_issue",
    idempotencyKey: intent.idempotencyKey,
    requestRef: resolution.requestRef,
    requestRevision: resolution.requestRevision,
    requestDigest: resolution.requestDigest,
    authorizationDigest: resolution.authorizationDigest,
    status: "ambiguous",
    observedAt: new Date().toISOString(),
  });
}

async function releaseOrThrow(
  env: ProviderAdapterEnv["Bindings"],
  reservation: Reservation,
): Promise<void> {
  try {
    await releaseIdempotency(env, reservation);
  } catch {
    throw new ProviderAdapterError("provider_idempotency_release_failed", 503);
  }
}

async function execute(
  env: ProviderAdapterEnv["Bindings"],
  intent: PlatformEffectIntent,
): Promise<Record<string, unknown>> {
  let reserved: Reservation | { receipt: ProviderReceipt };
  try {
    reserved = await reserveIdempotency(env, intent);
  } catch (error) {
    if (error instanceof ProviderExecutionError) {
      return responseFailure(error.code, error.retryable, error.retryAfterSeconds);
    }
    throw error;
  }
  if ("receipt" in reserved) {
    if (reserved.receipt.status === "completed") {
      return responseCompleted(reserved.receipt.externalReceiptRef!);
    }
    return responseFailure("linear_provider_response_ambiguous", false);
  }
  const reservation = reserved;
  let resolution: RequestResolution;
  try {
    resolution = await resolveRequest(env, intent);
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      await releaseOrThrow(env, reservation);
      throw error;
    }
    try {
      await releaseOrThrow(env, reservation);
    } catch (releaseError) {
      throw releaseError;
    }
    const failure = error instanceof ProviderExecutionError
      ? error
      : new ProviderExecutionError("provider_request_resolution_invalid", false);
    return responseFailure(failure.code, failure.retryable, failure.retryAfterSeconds);
  }
  try {
    const result = await executeLinear(env, intent, resolution);
    const receipt = completedReceipt(intent, resolution, result.externalReceiptRef);
    try {
      await finalizeIdempotency(env, "complete", reservation, receipt);
    } catch {
      const uncertain = ambiguousReceipt(intent, resolution);
      try {
        await finalizeIdempotency(env, "ambiguous", reservation, uncertain);
      } catch {
        throw new ProviderAdapterError("provider_receipt_persist_failed", 503);
      }
      return responseFailure("linear_provider_response_ambiguous", false);
    }
    return responseCompleted(receipt.externalReceiptRef!);
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      await releaseOrThrow(env, reservation);
      throw error;
    }
    const failure = error instanceof ProviderExecutionError
      ? error
      : new ProviderExecutionError("provider_execution_failed", false);
    if (failure.ambiguous) {
      const receipt = ambiguousReceipt(intent, resolution);
      try {
        await finalizeIdempotency(env, "ambiguous", reservation, receipt);
      } catch {
        throw new ProviderAdapterError("provider_ambiguity_persist_failed", 503);
      }
      return responseFailure(failure.code, false);
    }
    await releaseOrThrow(env, reservation);
    return responseFailure(failure.code, failure.retryable, failure.retryAfterSeconds);
  }
}

function providerBindingsConfigured(env: ProviderAdapterEnv["Bindings"]): boolean {
  return Boolean(
    env.PLATFORM_PROVIDER_ADAPTER_AUTH_TOKEN?.trim() &&
    env.PROVIDER_REQUEST_RESOLVER &&
    env.PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?.trim() &&
    env.CREDENTIAL_BROKER &&
    env.CREDENTIAL_BROKER_AUTH_TOKEN?.trim() &&
    env.PROVIDER_IDEMPOTENCY_STORE &&
    env.PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN?.trim() &&
    env.LINEAR_CONTROLLED_WORKSPACE_SUBJECT?.trim(),
  );
}

async function providerConfigured(env: ProviderAdapterEnv["Bindings"]): Promise<boolean> {
  if (!providerBindingsConfigured(env)) return false;
  try {
    const response = await env.CREDENTIAL_BROKER!.fetch("https://credential-broker/health");
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.ok === true && body.providerResolutionEnabled === true;
  } catch {
    return false;
  }
}

app.get("/health", async (c) => {
  const bindingsConfigured = providerBindingsConfigured(c.env);
  const effectsEnabled = await providerConfigured(c.env);
  return c.json({
    ok: true,
    role: "platform-provider-adapter",
    configured: bindingsConfigured,
    providerEffectsEnabled: effectsEnabled,
    requestResolverConfigured: Boolean(
      c.env.PROVIDER_REQUEST_RESOLVER && c.env.PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?.trim(),
    ),
    credentialBrokerConfigured: Boolean(
      c.env.CREDENTIAL_BROKER && c.env.CREDENTIAL_BROKER_AUTH_TOKEN?.trim(),
    ),
    idempotencyStoreConfigured: Boolean(
      c.env.PROVIDER_IDEMPOTENCY_STORE && c.env.PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN?.trim(),
    ),
    controlledWorkspaceConfigured: Boolean(c.env.LINEAR_CONTROLLED_WORKSPACE_SUBJECT?.trim()),
    actions: effectsEnabled ? ["linear/create_issue"] : [],
  });
});

app.post("/execute", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    if (contentLengthTooLarge(c.req.raw)) {
      throw new ProviderAdapterError("request_body_too_large", 400);
    }
    const body = await readBoundedJson(c.req.raw.body, "request_body_too_large", "invalid_json");
    const intent = validateEffectEnvelope(body);
    return c.json(await execute(c.env, intent));
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      return c.json({ error: error.code }, error.status);
    }
    console.error(
      "[platform-provider-adapter] request failed",
      error instanceof ProviderExecutionError ? error.code : "internal",
    );
    return c.json({ error: "provider_adapter_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError(() => Response.json({ error: "provider_adapter_internal_error" }, { status: 503 }));

export { app as platformProviderAdapterApp };
export default { fetch: app.fetch };
