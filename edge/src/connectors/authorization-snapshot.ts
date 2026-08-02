/**
 * Read-only composition of the platform records required before credential
 * custody may resolve a provider bearer.
 *
 * Workspace access bundles answer "may this connector action run in this
 * channel?". The platform snapshot answers the separate question "does this
 * server-owned tenant/principal still hold the curated provider grant and its
 * matching custody reference?". Keeping the records together makes the
 * broker's decision explicit and keeps provider secrets out of the contract.
 */

import type {
  ConnectorAuthorizationPlatformBinding,
} from "./authorization.js";
import {
  assertConnectorMarketplaceEntryActivatable,
  validateConnectorMarketplaceEntry,
  validateConnectorOAuthGrant,
  validateCredentialCustodyReference,
  type ConnectorMarketplaceEntry,
  type ConnectorOAuthGrant,
  type CredentialCustodyReference,
} from "../platform/layer3-contract.js";
import {
  TENANT_LOCATOR_OBJECT_NAME,
  tenantLocatorSubject,
  validateTenantLocatorResolution,
  type PlatformStateNamespace,
} from "../platform/tenant-locator.js";
import {
  canonicalInternalPrincipalId,
  canonicalInternalTenantId,
} from "../platform/contract.js";
import {
  validateIdentityLinkResolution,
  type IdentityLinkResolution,
} from "../platform/identity-link.js";
import { platformTenantObjectName } from "../platform/tenant-routing.js";

export const CONNECTOR_AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type ConnectorAuthorizationSnapshot = Readonly<{
  schemaVersion: typeof CONNECTOR_AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION;
  tenantId: string;
  principalId: string;
  connectorId: string;
  action: string;
  identity: Extract<IdentityLinkResolution, { status: "resolved" }>;
  marketplace: ConnectorMarketplaceEntry;
  grant: ConnectorOAuthGrant;
  credential: CredentialCustodyReference;
  observedAt: string;
}>;

export class ConnectorAuthorizationSnapshotError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 503,
  ) {
    super(code);
    this.name = "ConnectorAuthorizationSnapshotError";
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorAuthorizationSnapshotError(`${field}_invalid`, 503);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConnectorAuthorizationSnapshotError(`${field}_invalid`, 503);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new ConnectorAuthorizationSnapshotError(`${field}_invalid`, 503);
  }
  return result;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ConnectorAuthorizationSnapshotError(`${field}_invalid`, 403);
  }
  return value as number;
}

function sortedScopes(value: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(value)].sort());
}

function equalScopes(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedScopes(left);
  const b = sortedScopes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function activeExpiry(value: string | undefined, now: number, code: string): void {
  if (value !== undefined && Date.parse(value) <= now) {
    throw new ConnectorAuthorizationSnapshotError(code, 403);
  }
}

/** Validate an untrusted snapshot response before it is used by the broker. */
export function validateConnectorAuthorizationSnapshot(
  value: unknown,
): ConnectorAuthorizationSnapshot {
  const input = object(value, "connector_authorization_snapshot");
  const allowed = new Set([
    "schemaVersion",
    "tenantId",
    "principalId",
    "connectorId",
    "action",
    "identity",
    "marketplace",
    "grant",
    "credential",
    "observedAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ConnectorAuthorizationSnapshotError("connector_authorization_snapshot_field_invalid", 503);
  }
  if (input.schemaVersion !== CONNECTOR_AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new ConnectorAuthorizationSnapshotError("connector_authorization_snapshot_schema_invalid", 503);
  }
  let marketplace: ConnectorMarketplaceEntry;
  let grant: ConnectorOAuthGrant;
  let credential: CredentialCustodyReference;
  let identity: Extract<IdentityLinkResolution, { status: "resolved" }>;
  try {
    const identityResolution = validateIdentityLinkResolution(input.identity);
    if (identityResolution.status !== "resolved") {
      throw new Error("identity_link_inactive");
    }
    identity = identityResolution;
    marketplace = validateConnectorMarketplaceEntry(input.marketplace);
    grant = validateConnectorOAuthGrant(input.grant);
    credential = validateCredentialCustodyReference(input.credential);
  } catch {
    throw new ConnectorAuthorizationSnapshotError("connector_authorization_snapshot_metadata_invalid", 503);
  }
  return Object.freeze({
    schemaVersion: CONNECTOR_AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    principalId: identifier(input.principalId, "principal_id"),
    connectorId: identifier(input.connectorId, "connector_id"),
    action: identifier(input.action, "connector_action"),
    identity,
    marketplace,
    grant,
    credential,
    observedAt: timestamp(input.observedAt, "observed_at"),
  });
}

/**
 * Check all cross-record relationships and current activation state. A
 * structurally valid row is not enough: revoked, expired, deprecated, or
 * scope-mismatched records must never reach custody.
 */
export function assertConnectorAuthorizationSnapshotUsable(
  snapshot: ConnectorAuthorizationSnapshot,
  now = Date.now(),
): void {
  if (
    snapshot.grant.tenantId !== snapshot.tenantId ||
    snapshot.credential.tenantId !== snapshot.tenantId ||
    snapshot.identity.principal.tenantId !== snapshot.tenantId ||
    snapshot.identity.identityLink.tenantId !== snapshot.tenantId ||
    snapshot.identity.principal.principalId !== snapshot.principalId ||
    snapshot.identity.identityLink.principalId !== snapshot.principalId ||
    snapshot.identity.principal.status !== "active" ||
    snapshot.grant.principalId !== snapshot.principalId ||
    snapshot.grant.connectorId !== snapshot.connectorId ||
    snapshot.marketplace.connectorId !== snapshot.connectorId ||
    snapshot.grant.credentialRef !== snapshot.credential.credentialRef ||
    snapshot.grant.marketplaceVersion !== snapshot.marketplace.version
  ) {
    throw new ConnectorAuthorizationSnapshotError("connector_authorization_snapshot_relationship_mismatch", 403);
  }
  try {
    assertConnectorMarketplaceEntryActivatable(snapshot.marketplace);
  } catch {
    throw new ConnectorAuthorizationSnapshotError("connector_marketplace_not_activatable", 403);
  }
  if (
    snapshot.marketplace.status !== "curated" ||
    snapshot.marketplace.authMode !== "oauth2" ||
    !snapshot.marketplace.actions.includes(snapshot.action)
  ) {
    throw new ConnectorAuthorizationSnapshotError("connector_marketplace_action_not_allowed", 403);
  }
  if (snapshot.grant.status !== "active") {
    throw new ConnectorAuthorizationSnapshotError("connector_oauth_grant_inactive", 403);
  }
  if (snapshot.credential.status !== "active") {
    throw new ConnectorAuthorizationSnapshotError("connector_credential_inactive", 403);
  }
  activeExpiry(snapshot.grant.expiresAt, now, "connector_oauth_grant_expired");
  activeExpiry(snapshot.credential.expiresAt, now, "connector_credential_expired");
  if (snapshot.credential.provider !== snapshot.marketplace.provider) {
    throw new ConnectorAuthorizationSnapshotError("connector_provider_mismatch", 403);
  }
  if (
    !equalScopes(snapshot.grant.scopes, snapshot.credential.scopes) ||
    snapshot.grant.scopes.some((scope) => !snapshot.marketplace.oauthScopes.includes(scope))
  ) {
    throw new ConnectorAuthorizationSnapshotError("connector_scope_mismatch", 403);
  }
}

export function assertConnectorAuthorizationSnapshotMatchesBinding(
  snapshot: ConnectorAuthorizationSnapshot,
  binding: ConnectorAuthorizationPlatformBinding,
  expected: Readonly<{
    connectorId: string;
    action: string;
    credentialRef: string;
    credentialVersion: number;
  }>,
  now = Date.now(),
): void {
  assertConnectorAuthorizationSnapshotUsable(snapshot, now);
  if (
    snapshot.tenantId !== binding.tenantId ||
    snapshot.principalId !== binding.principalId ||
    snapshot.identity.identityLink.subject.platform !== binding.platform ||
    snapshot.identity.identityLink.subject.platformTenantId !== binding.platformTenantId ||
    snapshot.identity.identityLink.subject.platformSubjectId !== binding.platformSubjectId ||
    snapshot.identity.identityLink.identityLinkVersion !== binding.identityLinkVersion ||
    snapshot.identity.principal.authorizationVersion !== binding.authorizationVersion ||
    snapshot.connectorId !== expected.connectorId ||
    snapshot.action !== expected.action ||
    snapshot.grant.version !== binding.oauthGrantVersion ||
    snapshot.marketplace.version !== binding.marketplaceVersion ||
    snapshot.credential.credentialRef !== expected.credentialRef ||
    snapshot.credential.version !== expected.credentialVersion
  ) {
    throw new ConnectorAuthorizationSnapshotError("connector_authorization_snapshot_stale", 403);
  }
}

type PlatformStateStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

async function readJson(
  namespace: PlatformStateNamespace,
  objectName: string,
  path: string,
  body: unknown,
  missingCode: string,
): Promise<unknown> {
  let response: Response;
  try {
    const stub = namespace.get(namespace.idFromName(objectName)) as PlatformStateStub;
    response = await stub.fetch(`https://platform-state${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ConnectorAuthorizationSnapshotError("platform_state_unavailable", 503);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = object(payload, "platform_state_error").error;
    throw new ConnectorAuthorizationSnapshotError(
      typeof code === "string" ? code : missingCode,
      response.status === 404 ? 404 : response.status === 409 ? 409 : response.status >= 500 ? 503 : 403,
    );
  }
  return payload;
}

/** Read the grant, marketplace version, and custody reference as one logical decision. */
export class PlatformStateConnectorAuthorizationReader {
  constructor(private readonly namespace: PlatformStateNamespace) {}

  async resolve(input: Readonly<{
    tenantId: string;
    principalId: string;
    platform: "slack" | "buzz" | "teams";
    platformTenantId: string;
    platformSubjectId: string;
    tenantLocatorVersion: number;
    connectorId: string;
    action: string;
  }>): Promise<ConnectorAuthorizationSnapshot> {
    let tenantId: string;
    let principalId: string;
    try {
      tenantId = canonicalInternalTenantId(identifier(input.tenantId, "tenant_id"));
      principalId = canonicalInternalPrincipalId(identifier(input.principalId, "principal_id"));
    } catch {
      throw new ConnectorAuthorizationSnapshotError("connector_platform_identity_invalid", 403);
    }
    const tenantObjectName = platformTenantObjectName(tenantId);
    const connectorId = identifier(input.connectorId, "connector_id");
    const action = identifier(input.action, "connector_action");
    const platformTenantId = identifier(input.platformTenantId, "platform_tenant_id");
    const platformSubjectId = identifier(input.platformSubjectId, "platform_subject_id");
    const platform = input.platform;
    const tenantLocatorVersion = positiveVersion(input.tenantLocatorVersion, "tenant_locator_version");
    const tenantLocator = validateTenantLocatorResolution(await readJson(
      this.namespace,
      TENANT_LOCATOR_OBJECT_NAME,
      "/tenant-locator/resolve",
      tenantLocatorSubject({ platform, platformTenantId }),
      "connector_tenant_locator_unavailable",
    ));
    if (tenantLocator.status !== "resolved") {
      throw new ConnectorAuthorizationSnapshotError(
        `connector_tenant_locator_${tenantLocator.status}`,
        tenantLocator.status === "not_found" ? 404 : 403,
      );
    }
    if (
      tenantLocator.locator.tenantId !== tenantId ||
      tenantLocator.locator.platform !== platform ||
      tenantLocator.locator.platformTenantId !== platformTenantId
    ) {
      throw new ConnectorAuthorizationSnapshotError(
        "connector_tenant_locator_relationship_mismatch",
        403,
      );
    }
    if (tenantLocator.locator.version !== tenantLocatorVersion) {
      throw new ConnectorAuthorizationSnapshotError("connector_tenant_locator_stale", 403);
    }
    const identityResolution = validateIdentityLinkResolution(await readJson(
      this.namespace,
      tenantObjectName,
      "/identity-link/resolve",
      {
        schemaVersion: 1,
        platform,
        platformTenantId,
        platformSubjectId,
      },
      "connector_identity_link_unavailable",
    ));
    if (identityResolution.status !== "resolved") {
      throw new ConnectorAuthorizationSnapshotError(
        `connector_identity_link_${identityResolution.status}`,
        403,
      );
    }
    const grant = validateConnectorOAuthGrant(await readJson(
      this.namespace,
      tenantObjectName,
      "/oauth/get",
      { tenantId, principalId, connectorId },
      "connector_oauth_grant_unavailable",
    ));
    const marketplacePayload = object(await readJson(
      this.namespace,
      TENANT_LOCATOR_OBJECT_NAME,
      "/marketplace/list",
      { connectorId, version: grant.marketplaceVersion },
      "connector_marketplace_unavailable",
    ), "marketplace_response");
    const entries = marketplacePayload.entries;
    if (!Array.isArray(entries) || entries.length !== 1) {
      throw new ConnectorAuthorizationSnapshotError("connector_marketplace_not_found", 404);
    }
    const credential = validateCredentialCustodyReference(await readJson(
      this.namespace,
      tenantObjectName,
      "/credential/get",
      { credentialRef: grant.credentialRef },
      "connector_credential_unavailable",
    ));
    const snapshot = validateConnectorAuthorizationSnapshot({
      schemaVersion: CONNECTOR_AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION,
      tenantId,
      principalId,
      connectorId,
      action,
      identity: identityResolution,
      marketplace: entries[0],
      grant,
      credential,
      observedAt: new Date().toISOString(),
    });
    assertConnectorAuthorizationSnapshotUsable(snapshot);
    return snapshot;
  }
}
