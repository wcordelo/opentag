/**
 * Layer 3 platform contracts.
 *
 * These are intentionally side-effect-free. They give provisioning, identity
 * custody, connector OAuth/marketplace, billing, and memory governance one
 * versioned vocabulary without pretending that the unresolved tenancy or
 * custody decisions have been made. Secret material is never a valid value in
 * any of these contracts; only opaque references and public metadata cross
 * the application boundary.
 */

export const PLATFORM_SCHEMA_VERSION = 1 as const;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SCOPE_LENGTH = 128;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type TenantIsolationMode =
  | "shared_worker_per_tenant_do"
  | "workers_for_platforms";
export type CustodyBackend =
  | "external_kms"
  | "wrapped_do_envelope"
  | "self_hosted";
export type ProvisioningStatus =
  | "requested"
  | "provisioning"
  | "active"
  | "failed"
  | "suspended";

export type ProvisioningStep =
  | "tenant_locator"
  | "workspace_config"
  | "bot_state"
  | "session_events"
  | "knowledge_namespace"
  | "slack_oauth_install"
  | "identity_custody"
  | "default_access_bundle";

export const REQUIRED_PROVISIONING_STEPS: readonly ProvisioningStep[] = [
  "tenant_locator",
  "workspace_config",
  "bot_state",
  "session_events",
  "knowledge_namespace",
  "slack_oauth_install",
  "identity_custody",
  "default_access_bundle",
] as const;
const METER_TIERS = [1, 2, 3] as const;

export class PlatformFoundationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlatformFoundationError";
  }
}

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new PlatformFoundationError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new PlatformFoundationError(`${field}_invalid`);
  }
  return result;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlatformFoundationError(`${field}_invalid`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PlatformFoundationError(`${field}_invalid`);
  }
  return value as number;
}

function scopeList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new PlatformFoundationError(`${field}_invalid`);
  }
  return [...new Set(value.map((item) => identifier(item, field, MAX_SCOPE_LENGTH)))];
}

function enumValue<T extends string | number>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new PlatformFoundationError(`${field}_invalid`);
  }
  return value as T;
}

function rejectSecretMaterial(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const forbidden = new Set([
    "accessToken", "apiKey", "privateKey", "secret", "secretValue", "token", "value",
  ]);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (forbidden.has(key)) throw new PlatformFoundationError("secret_material_forbidden");
  }
}

export type ProvisioningRequest = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  requestId: string;
  idempotencyKey: string;
  externalPlatform: "slack";
  externalTenantId: string;
  requestedByExternalSubject: string;
  isolationMode: TenantIsolationMode;
  custodyBackend: CustodyBackend;
  requestedAt: string;
}>;

export type ProvisioningReceipt = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  requestId: string;
  idempotencyKey: string;
  tenantId: string;
  status: ProvisioningStatus;
  completedSteps: readonly ProvisioningStep[];
  failedStep?: ProvisioningStep;
  retryable: boolean;
  observedAt: string;
}>;

export function validateProvisioningRequest(value: unknown): ProvisioningRequest {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformFoundationError("provisioning_request_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== PLATFORM_SCHEMA_VERSION) throw new PlatformFoundationError("platform_schema_invalid");
  const externalPlatform = enumValue(input.externalPlatform, ["slack"], "external_platform");
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    requestId: identifier(input.requestId, "request_id"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    externalPlatform,
    externalTenantId: identifier(input.externalTenantId, "external_tenant_id"),
    requestedByExternalSubject: identifier(input.requestedByExternalSubject, "requested_by_external_subject"),
    isolationMode: enumValue(input.isolationMode, ["shared_worker_per_tenant_do", "workers_for_platforms"], "isolation_mode"),
    custodyBackend: enumValue(input.custodyBackend, ["external_kms", "wrapped_do_envelope", "self_hosted"], "custody_backend"),
    requestedAt: timestamp(input.requestedAt, "requested_at"),
  });
}

export function provisioningPlan(_request: ProvisioningRequest): readonly ProvisioningStep[] {
  return REQUIRED_PROVISIONING_STEPS;
}

export type IdentityCustodyReference = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  tenantId: string;
  identityRef: `identity:${string}`;
  backend: CustodyBackend;
  publicKey: string;
  version: number;
  status: "active" | "revoked";
  issuedAt: string;
  revokedAt?: string;
}>;

export type CredentialCustodyReference = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  tenantId: string;
  credentialRef: `credential:${string}`;
  backend: CustodyBackend;
  provider: string;
  subject: string;
  scopes: readonly string[];
  version: number;
  status: "active" | "revoked";
  issuedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}>;

export function validateIdentityCustodyReference(value: unknown): IdentityCustodyReference {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("identity_custody_invalid");
  const input = value as Record<string, unknown>;
  const identityRef = identifier(input.identityRef, "identity_ref");
  if (!identityRef.startsWith("identity:")) throw new PlatformFoundationError("identity_ref_invalid");
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    identityRef: identityRef as `identity:${string}`,
    backend: enumValue(input.backend, ["external_kms", "wrapped_do_envelope", "self_hosted"], "custody_backend"),
    publicKey: identifier(input.publicKey, "public_key"),
    version: positiveVersion(input.version, "version"),
    status: enumValue(input.status, ["active", "revoked"], "status"),
    issuedAt: timestamp(input.issuedAt, "issued_at"),
    ...(input.revokedAt !== undefined ? { revokedAt: timestamp(input.revokedAt, "revoked_at") } : {}),
  });
}

export function validateCredentialCustodyReference(value: unknown): CredentialCustodyReference {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("credential_custody_invalid");
  const input = value as Record<string, unknown>;
  const credentialRef = identifier(input.credentialRef, "credential_ref");
  if (!credentialRef.startsWith("credential:")) throw new PlatformFoundationError("credential_ref_invalid");
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    credentialRef: credentialRef as `credential:${string}`,
    backend: enumValue(input.backend, ["external_kms", "wrapped_do_envelope", "self_hosted"], "custody_backend"),
    provider: identifier(input.provider, "provider"),
    subject: identifier(input.subject, "subject"),
    scopes: scopeList(input.scopes, "scopes"),
    version: positiveVersion(input.version, "version"),
    status: enumValue(input.status, ["active", "revoked"], "status"),
    issuedAt: timestamp(input.issuedAt, "issued_at"),
    ...(input.expiresAt !== undefined ? { expiresAt: timestamp(input.expiresAt, "expires_at") } : {}),
    ...(input.revokedAt !== undefined ? { revokedAt: timestamp(input.revokedAt, "revoked_at") } : {}),
  });
}

export type ConnectorMarketplaceEntry = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  connectorId: string;
  provider: string;
  version: string;
  status: "curated" | "deprecated" | "revoked";
  authMode: "oauth2" | "service_binding" | "none";
  actions: readonly string[];
  oauthScopes: readonly string[];
  trustReviewRef: string;
}>;

export type ConnectorOAuthGrant = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  tenantId: string;
  principalId: string;
  connectorId: string;
  credentialRef: `credential:${string}`;
  providerSubject: string;
  scopes: readonly string[];
  version: number;
  status: "active" | "revoked" | "expired";
  issuedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}>;

export function validateConnectorMarketplaceEntry(value: unknown): ConnectorMarketplaceEntry {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("marketplace_entry_invalid");
  const input = value as Record<string, unknown>;
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    connectorId: identifier(input.connectorId, "connector_id"),
    provider: identifier(input.provider, "provider"),
    version: identifier(input.version, "version"),
    status: enumValue(input.status, ["curated", "deprecated", "revoked"], "status"),
    authMode: enumValue(input.authMode, ["oauth2", "service_binding", "none"], "auth_mode"),
    actions: scopeList(input.actions, "actions"),
    oauthScopes: scopeList(input.oauthScopes, "oauth_scopes"),
    trustReviewRef: identifier(input.trustReviewRef, "trust_review_ref"),
  });
}

export function validateConnectorOAuthGrant(value: unknown): ConnectorOAuthGrant {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("oauth_grant_invalid");
  const input = value as Record<string, unknown>;
  const credentialRef = identifier(input.credentialRef, "credential_ref");
  if (!credentialRef.startsWith("credential:")) throw new PlatformFoundationError("credential_ref_invalid");
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    principalId: identifier(input.principalId, "principal_id"),
    connectorId: identifier(input.connectorId, "connector_id"),
    credentialRef: credentialRef as `credential:${string}`,
    providerSubject: identifier(input.providerSubject, "provider_subject"),
    scopes: scopeList(input.scopes, "scopes"),
    version: positiveVersion(input.version, "version"),
    status: enumValue(input.status, ["active", "revoked", "expired"], "status"),
    issuedAt: timestamp(input.issuedAt, "issued_at"),
    ...(input.expiresAt !== undefined ? { expiresAt: timestamp(input.expiresAt, "expires_at") } : {}),
    ...(input.revokedAt !== undefined ? { revokedAt: timestamp(input.revokedAt, "revoked_at") } : {}),
  });
}

export type UsageMeterEvent = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  eventId: string;
  idempotencyKey: string;
  tenantId: string;
  executionId: string;
  tier: 1 | 2 | 3;
  metric: "knowledge_query" | "agent_tokens" | "connector_calls" | "container_ms";
  quantity: number;
  unit: "count" | "tokens" | "milliseconds";
  planRevision: number;
  occurredAt: string;
}>;

export function validateUsageMeterEvent(value: unknown): UsageMeterEvent {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("usage_event_invalid");
  const input = value as Record<string, unknown>;
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    eventId: identifier(input.eventId, "event_id"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    tenantId: identifier(input.tenantId, "tenant_id"),
    executionId: identifier(input.executionId, "execution_id"),
    tier: enumValue(input.tier, METER_TIERS, "tier"),
    metric: enumValue(input.metric, ["knowledge_query", "agent_tokens", "connector_calls", "container_ms"], "metric"),
    quantity: nonNegativeInteger(input.quantity, "quantity"),
    unit: enumValue(input.unit, ["count", "tokens", "milliseconds"], "unit"),
    planRevision: positiveVersion(input.planRevision, "plan_revision"),
    occurredAt: timestamp(input.occurredAt, "occurred_at"),
  });
}

export type MemoryGovernancePolicy = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  tenantId: string;
  retentionDays: number;
  optedOutChannelIds: readonly string[];
  deletionEpoch: number;
  adminVisibility: "metadata_only" | "metadata_and_excerpts";
  updatedAt: string;
}>;

export type MemoryDeletionRequest = Readonly<{
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION;
  requestId: string;
  idempotencyKey: string;
  tenantId: string;
  sourceKeys: readonly string[];
  requestedByPrincipalId: string;
  requestedAt: string;
  deletionEpoch: number;
}>;

export function validateMemoryGovernancePolicy(value: unknown): MemoryGovernancePolicy {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("memory_policy_invalid");
  const input = value as Record<string, unknown>;
  const retentionDays = nonNegativeInteger(input.retentionDays, "retention_days");
  if (retentionDays > 36_500) throw new PlatformFoundationError("retention_days_invalid");
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    retentionDays,
    optedOutChannelIds: scopeList(input.optedOutChannelIds, "opted_out_channel_ids"),
    deletionEpoch: nonNegativeInteger(input.deletionEpoch, "deletion_epoch"),
    adminVisibility: enumValue(input.adminVisibility, ["metadata_only", "metadata_and_excerpts"], "admin_visibility"),
    updatedAt: timestamp(input.updatedAt, "updated_at"),
  });
}

export function validateMemoryDeletionRequest(value: unknown): MemoryDeletionRequest {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformFoundationError("memory_deletion_invalid");
  const input = value as Record<string, unknown>;
  const sourceKeys = scopeList(input.sourceKeys, "source_keys");
  if (sourceKeys.length === 0) throw new PlatformFoundationError("source_keys_invalid");
  return Object.freeze({
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    requestId: identifier(input.requestId, "request_id"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    tenantId: identifier(input.tenantId, "tenant_id"),
    sourceKeys,
    requestedByPrincipalId: identifier(input.requestedByPrincipalId, "requested_by_principal_id"),
    requestedAt: timestamp(input.requestedAt, "requested_at"),
    deletionEpoch: nonNegativeInteger(input.deletionEpoch, "deletion_epoch"),
  });
}
