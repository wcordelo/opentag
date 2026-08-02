/**
 * Connector authorization foundation.
 *
 * This module deliberately contains no secret values and no Workers bindings.
 * A connector receives an immutable, short-lived label set derived from the
 * verified request, the current access-bundle revision, and an optional
 * versioned credential reference. Revocation is checked again at the effect
 * boundary by `verifyConnectorAuthorizationCurrent`.
 */

import type { AccessBundle } from "../config/access-bundle.js";
import {
  canonicalInternalPrincipalId,
  canonicalInternalTenantId,
  type Platform,
} from "../platform/contract.js";

export const CONNECTOR_AUTH_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONNECTOR_AUTH_LIFETIME_MS = 60_000;
export const MAX_CONNECTOR_AUTH_LIFETIME_MS = 5 * 60_000;

export type ConnectorGrantScope = "workspace" | "project" | "channel";

export type ConnectorAccessGrant = Readonly<{
  connectorId: string;
  actions: readonly string[];
  scope: ConnectorGrantScope;
  /** Optional exact scope constraints; required for project/channel grants. */
  projectId?: string;
  channelId?: string;
  /** Opaque reference only; never a token, key, or secret value. */
  credentialRef?: string;
}>;

export type CredentialReferenceStatus = "active" | "revoked";

export type CredentialReference = Readonly<{
  schemaVersion: typeof CONNECTOR_AUTH_SCHEMA_VERSION;
  ref: string;
  provider: string;
  name: string;
  version: number;
  status: CredentialReferenceStatus;
  scopes: readonly string[];
  subject: string;
  issuedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}>;

/**
 * Server-owned platform state captured when a connector label is issued.
 *
 * These are public version fences only. They are deliberately not a provider
 * token, OAuth code, key, or any other credential material. The credential
 * broker re-reads the corresponding platform records before it will ask
 * custody for a bearer.
 */
export type ConnectorAuthorizationPlatformBinding = Readonly<{
  schemaVersion: typeof CONNECTOR_AUTH_SCHEMA_VERSION;
  platform: Platform;
  platformTenantId: string;
  platformSubjectId: string;
  tenantId: string;
  principalId: string;
  identityLinkVersion: number;
  authorizationVersion: number;
  tenantLocatorVersion: number;
  oauthGrantVersion: number;
  marketplaceVersion: string;
}>;

export type ConnectorRequestIdentity = Readonly<{
  workspaceId: string;
  projectId: string;
  channelId: string;
  requesterId: string;
  /** Canonical principal id supplied only by the server-owned identity path. */
  principalId?: string;
  actorKind: "human" | "service" | "automation";
  executionId: string;
  threadKey: string;
}>;

export type ImmutableConnectorLabels = Readonly<{
  schemaVersion: typeof CONNECTOR_AUTH_SCHEMA_VERSION;
  workspaceId: string;
  projectId: string;
  channelId: string;
  connectorId: string;
  action: string;
  scope: ConnectorGrantScope;
  requesterId: string;
  actorKind: ConnectorRequestIdentity["actorKind"];
  executionId: string;
  threadKey: string;
  accessBundleId: string;
  accessBundleRevision: number;
  credentialRef?: string;
  credentialVersion?: number;
  platformBinding?: ConnectorAuthorizationPlatformBinding;
  issuedAt: string;
  expiresAt: string;
  digest: string;
}>;

export class ConnectorAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConnectorAuthorizationError";
  }
}

function safeId(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConnectorAuthorizationError(`${field}_invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const result = safeId(value, field, 64);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new ConnectorAuthorizationError(`${field}_invalid`);
  }
  return result;
}

function providerPart(value: unknown, field: string): string {
  const result = safeId(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result)) {
    throw new ConnectorAuthorizationError(`${field}_invalid`);
  }
  return result;
}

function uniqueSorted(values: readonly unknown[], field: string): readonly string[] {
  const normalized = values.map((value) => safeId(value, field, 256));
  return Object.freeze([...new Set(normalized)].sort());
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorAuthorizationError(`${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ConnectorAuthorizationError(`${field}_invalid`);
  }
  return value as number;
}

/** Parse the metadata-only server-owned authorization fence. */
export function parseConnectorAuthorizationPlatformBinding(
  value: unknown,
): ConnectorAuthorizationPlatformBinding {
  const input = record(value, "connector_platform_binding");
  const allowed = new Set([
    "schemaVersion",
    "platform",
    "platformTenantId",
    "platformSubjectId",
    "tenantId",
    "principalId",
    "identityLinkVersion",
    "authorizationVersion",
    "tenantLocatorVersion",
    "oauthGrantVersion",
    "marketplaceVersion",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ConnectorAuthorizationError("connector_platform_binding_field_invalid");
  }
  if (input.schemaVersion !== CONNECTOR_AUTH_SCHEMA_VERSION) {
    throw new ConnectorAuthorizationError("connector_platform_binding_schema_invalid");
  }
  if (input.platform !== "slack" && input.platform !== "buzz" && input.platform !== "teams") {
    throw new ConnectorAuthorizationError("connector_platform_binding_platform_invalid");
  }
  let tenantId: string;
  let principalId: string;
  try {
    tenantId = canonicalInternalTenantId(input.tenantId);
    principalId = canonicalInternalPrincipalId(input.principalId);
  } catch {
    throw new ConnectorAuthorizationError("connector_platform_binding_identity_invalid");
  }
  const marketplaceVersion = providerPart(input.marketplaceVersion, "marketplace_version");
  return Object.freeze({
    schemaVersion: CONNECTOR_AUTH_SCHEMA_VERSION,
    platform: input.platform,
    platformTenantId: safeId(input.platformTenantId, "platform_tenant_id"),
    platformSubjectId: safeId(input.platformSubjectId, "platform_subject_id"),
    tenantId,
    principalId,
    identityLinkVersion: positiveVersion(input.identityLinkVersion, "identity_link_version"),
    authorizationVersion: positiveVersion(input.authorizationVersion, "authorization_version"),
    tenantLocatorVersion: positiveVersion(input.tenantLocatorVersion, "tenant_locator_version"),
    oauthGrantVersion: positiveVersion(input.oauthGrantVersion, "oauth_grant_version"),
    marketplaceVersion,
  });
}

export function credentialReferenceId(provider: string, name: string): string {
  return `credential:${providerPart(provider, "provider")}:${providerPart(name, "name")}`;
}

export function parseCredentialReference(value: unknown): CredentialReference {
  const input = record(value, "credential_reference");
  const provider = providerPart(input.provider, "provider");
  const name = providerPart(input.name, "name");
  const ref = safeId(input.ref, "ref", 512);
  if (ref !== credentialReferenceId(provider, name)) {
    throw new ConnectorAuthorizationError("credential_reference_ref_mismatch");
  }
  if (input.schemaVersion !== CONNECTOR_AUTH_SCHEMA_VERSION) {
    throw new ConnectorAuthorizationError("credential_reference_schema_invalid");
  }
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) {
    throw new ConnectorAuthorizationError("credential_reference_version_invalid");
  }
  if (input.status !== "active" && input.status !== "revoked") {
    throw new ConnectorAuthorizationError("credential_reference_status_invalid");
  }
  if (!Array.isArray(input.scopes)) {
    throw new ConnectorAuthorizationError("credential_reference_scopes_invalid");
  }
  const scopes = uniqueSorted(input.scopes as unknown[], "credential_scope");
  const subject = safeId(input.subject, "credential_subject", 256);
  const issuedAt = canonicalTimestamp(input.issuedAt, "credential_issued_at");
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : canonicalTimestamp(input.expiresAt, "credential_expires_at");
  const revokedAt = input.revokedAt === undefined
    ? undefined
    : canonicalTimestamp(input.revokedAt, "credential_revoked_at");
  if (input.status === "active" && revokedAt !== undefined) {
    throw new ConnectorAuthorizationError("active_credential_has_revocation");
  }
  if (input.status === "revoked" && revokedAt === undefined) {
    throw new ConnectorAuthorizationError("revoked_credential_missing_revocation");
  }
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new ConnectorAuthorizationError("credential_expiry_invalid");
  }
  return Object.freeze({
    schemaVersion: CONNECTOR_AUTH_SCHEMA_VERSION,
    ref,
    provider,
    name,
    version: input.version as number,
    status: input.status,
    scopes,
    subject,
    issuedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  });
}

export function parseConnectorAccessGrant(value: unknown): ConnectorAccessGrant {
  const input = record(value, "connector_access_grant");
  const connectorId = providerPart(input.connectorId, "connector_id");
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    throw new ConnectorAuthorizationError("connector_actions_invalid");
  }
  const actions = uniqueSorted(input.actions as unknown[], "connector_action");
  if (input.scope !== "workspace" && input.scope !== "project" && input.scope !== "channel") {
    throw new ConnectorAuthorizationError("connector_scope_invalid");
  }
  const projectId = input.projectId === undefined ? undefined : safeId(input.projectId, "connector_project_id");
  const channelId = input.channelId === undefined ? undefined : safeId(input.channelId, "connector_channel_id");
  if (input.scope === "project" && !projectId) {
    throw new ConnectorAuthorizationError("project_connector_scope_requires_project_id");
  }
  if (input.scope === "channel" && !channelId) {
    throw new ConnectorAuthorizationError("channel_connector_scope_requires_channel_id");
  }
  const credentialRef = input.credentialRef === undefined
    ? undefined
    : safeId(input.credentialRef, "credential_ref", 512);
  return Object.freeze({
    connectorId,
    actions,
    scope: input.scope,
    ...(projectId ? { projectId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(credentialRef ? { credentialRef } : {}),
  });
}

export function connectorGrantsOf(bundle: AccessBundle): readonly ConnectorAccessGrant[] {
  if (bundle.connectorGrants === undefined) return Object.freeze([]);
  if (!Array.isArray(bundle.connectorGrants)) {
    throw new ConnectorAuthorizationError("connector_grants_invalid");
  }
  return Object.freeze(bundle.connectorGrants.map(parseConnectorAccessGrant));
}

export function accessBundleRevisionOf(bundle: AccessBundle): number {
  const revision = bundle.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ConnectorAuthorizationError("access_bundle_revision_invalid");
  }
  return revision;
}

export function assertAccessBundleActive(bundle: AccessBundle): void {
  if ((bundle.status ?? "active") !== "active") {
    throw new ConnectorAuthorizationError("access_bundle_revoked");
  }
}

function scopeMatches(
  grant: ConnectorAccessGrant,
  identity: ConnectorRequestIdentity,
): boolean {
  // Grants are intentionally monotonic: a workspace grant covers every
  // project/channel, while a channel grant is exact.
  if (grant.projectId && grant.projectId !== identity.projectId) return false;
  if (grant.channelId && grant.channelId !== identity.channelId) return false;
  if (grant.scope === "workspace") return true;
  if (grant.scope === "project") {
    return typeof identity.projectId === "string" && identity.projectId.length > 0;
  }
  return typeof identity.channelId === "string" && identity.channelId.length > 0;
}

function credentialIsActive(credential: CredentialReference, now: number): void {
  if (credential.status !== "active" || credential.revokedAt) {
    throw new ConnectorAuthorizationError("credential_reference_revoked");
  }
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= now) {
    throw new ConnectorAuthorizationError("credential_reference_expired");
  }
}

export function matchingGrant(
  bundle: AccessBundle,
  connectorId: string,
  action: string,
  identity: ConnectorRequestIdentity,
): ConnectorAccessGrant {
  const grant = connectorGrantsOf(bundle).find((candidate) =>
    candidate.connectorId === connectorId &&
    candidate.actions.includes(action) &&
    scopeMatches(candidate, identity));
  if (!grant) throw new ConnectorAuthorizationError("connector_action_not_granted");
  return grant;
}

function labelPayload(labels: Omit<ImmutableConnectorLabels, "digest">): string {
  return JSON.stringify([
    labels.schemaVersion,
    labels.workspaceId,
    labels.projectId,
    labels.channelId,
    labels.connectorId,
    labels.action,
    labels.scope,
    labels.requesterId,
    labels.actorKind,
    labels.executionId,
    labels.threadKey,
    labels.accessBundleId,
    labels.accessBundleRevision,
    labels.credentialRef ?? null,
    labels.credentialVersion ?? null,
    labels.platformBinding
      ? [
          labels.platformBinding.schemaVersion,
          labels.platformBinding.platform,
          labels.platformBinding.platformTenantId,
          labels.platformBinding.platformSubjectId,
          labels.platformBinding.tenantId,
          labels.platformBinding.principalId,
          labels.platformBinding.identityLinkVersion,
          labels.platformBinding.authorizationVersion,
          labels.platformBinding.tenantLocatorVersion,
          labels.platformBinding.oauthGrantVersion,
          labels.platformBinding.marketplaceVersion,
        ]
      : null,
    labels.issuedAt,
    labels.expiresAt,
  ]);
}

export async function issueConnectorAuthorization(input: {
  bundle: AccessBundle;
  credential?: CredentialReference;
  identity: ConnectorRequestIdentity;
  connectorId: string;
  action: string;
  platformBinding?: ConnectorAuthorizationPlatformBinding;
  now?: number;
  lifetimeMs?: number;
}): Promise<{ labels: ImmutableConnectorLabels; credential?: CredentialReference }> {
  const now = input.now ?? Date.now();
  assertAccessBundleActive(input.bundle);
  const connectorId = providerPart(input.connectorId, "connector_id");
  const action = providerPart(input.action, "connector_action");
  let principalId: string | undefined;
  if (input.identity.principalId !== undefined) {
    try {
      principalId = canonicalInternalPrincipalId(input.identity.principalId);
    } catch {
      throw new ConnectorAuthorizationError("principal_id_invalid");
    }
  }
  const identity = Object.freeze({
    workspaceId: safeId(input.identity.workspaceId, "workspace_id"),
    projectId: safeId(input.identity.projectId, "project_id"),
    channelId: safeId(input.identity.channelId, "channel_id"),
    requesterId: safeId(input.identity.requesterId, "requester_id"),
    ...(principalId ? { principalId } : {}),
    actorKind: input.identity.actorKind,
    executionId: safeId(input.identity.executionId, "execution_id"),
    threadKey: safeId(input.identity.threadKey, "thread_key"),
  } satisfies ConnectorRequestIdentity);
  if (identity.actorKind !== "human" && identity.actorKind !== "service" && identity.actorKind !== "automation") {
    throw new ConnectorAuthorizationError("actor_kind_invalid");
  }
  const grant = matchingGrant(input.bundle, connectorId, action, identity);
  const platformBinding = input.platformBinding === undefined
    ? undefined
    : parseConnectorAuthorizationPlatformBinding(input.platformBinding);
  if (platformBinding && identity.principalId !== platformBinding.principalId) {
    throw new ConnectorAuthorizationError("platform_principal_mismatch");
  }
  if (platformBinding && platformBinding.platformTenantId !== identity.workspaceId) {
    throw new ConnectorAuthorizationError("platform_tenant_subject_mismatch");
  }
  const expectedCredentialRef = grant.credentialRef;
  if (expectedCredentialRef && !input.credential) {
    throw new ConnectorAuthorizationError("credential_reference_required");
  }
  if (!expectedCredentialRef && input.credential) {
    throw new ConnectorAuthorizationError("credential_reference_not_granted");
  }
  if (input.credential) {
    if (input.credential.ref !== expectedCredentialRef) {
      throw new ConnectorAuthorizationError("credential_reference_mismatch");
    }
    credentialIsActive(input.credential, now);
  }
  const requestedLifetime = input.lifetimeMs ?? DEFAULT_CONNECTOR_AUTH_LIFETIME_MS;
  if (!Number.isSafeInteger(requestedLifetime) || requestedLifetime < 1 || requestedLifetime > MAX_CONNECTOR_AUTH_LIFETIME_MS) {
    throw new ConnectorAuthorizationError("connector_authorization_lifetime_invalid");
  }
  const issuedAt = new Date(now).toISOString();
  const requestedExpiry = now + requestedLifetime;
  const credentialExpiry = input.credential?.expiresAt ? Date.parse(input.credential.expiresAt) : undefined;
  const expiresAt = new Date(Math.min(requestedExpiry, credentialExpiry ?? requestedExpiry)).toISOString();
  const unsigned = {
    schemaVersion: CONNECTOR_AUTH_SCHEMA_VERSION,
    workspaceId: identity.workspaceId,
    projectId: identity.projectId,
    channelId: identity.channelId,
    connectorId,
    action,
    scope: grant.scope,
    requesterId: identity.requesterId,
    actorKind: identity.actorKind,
    executionId: identity.executionId,
    threadKey: identity.threadKey,
    accessBundleId: safeId(input.bundle.id, "access_bundle_id"),
    accessBundleRevision: accessBundleRevisionOf(input.bundle),
    ...(input.credential ? { credentialRef: input.credential.ref, credentialVersion: input.credential.version } : {}),
    ...(platformBinding ? { platformBinding } : {}),
    issuedAt,
    expiresAt,
  } satisfies Omit<ImmutableConnectorLabels, "digest">;
  const digest = await sha256(labelPayload(unsigned));
  const labels = Object.freeze({ ...unsigned, digest });
  return Object.freeze({ labels, ...(input.credential ? { credential: input.credential } : {}) });
}

export async function verifyConnectorAuthorizationCurrent(input: {
  labels: ImmutableConnectorLabels;
  bundle: AccessBundle;
  credential?: CredentialReference;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const labels = input.labels;
  if (!labels || labels.schemaVersion !== CONNECTOR_AUTH_SCHEMA_VERSION) {
    throw new ConnectorAuthorizationError("connector_labels_invalid");
  }
  if (Date.parse(labels.expiresAt) <= now) {
    throw new ConnectorAuthorizationError("connector_authorization_expired");
  }
  assertAccessBundleActive(input.bundle);
  if (input.bundle.id !== labels.accessBundleId || accessBundleRevisionOf(input.bundle) !== labels.accessBundleRevision) {
    throw new ConnectorAuthorizationError("access_bundle_changed");
  }
  const identity = {
    workspaceId: labels.workspaceId,
    projectId: labels.projectId,
    channelId: labels.channelId,
    requesterId: labels.requesterId,
    actorKind: labels.actorKind,
    executionId: labels.executionId,
    threadKey: labels.threadKey,
  } satisfies ConnectorRequestIdentity;
  const grant = matchingGrant(input.bundle, labels.connectorId, labels.action, identity);
  if (grant.scope !== labels.scope) throw new ConnectorAuthorizationError("connector_scope_changed");
  if (grant.credentialRef !== labels.credentialRef) throw new ConnectorAuthorizationError("credential_grant_changed");
  if (labels.credentialRef) {
    if (!input.credential || input.credential.ref !== labels.credentialRef || input.credential.version !== labels.credentialVersion) {
      throw new ConnectorAuthorizationError("credential_reference_changed");
    }
    credentialIsActive(input.credential, now);
  } else if (input.credential) {
    throw new ConnectorAuthorizationError("credential_reference_unexpected");
  }
  const { digest: _digest, ...unsigned } = labels;
  if (await sha256(labelPayload(unsigned)) !== labels.digest) {
    throw new ConnectorAuthorizationError("connector_labels_tampered");
  }
}
