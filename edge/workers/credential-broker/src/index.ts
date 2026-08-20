import { Hono } from "hono";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  assertConnectorLabelsIntegrity,
  type CredentialBrokerResponse,
  validateCredentialBrokerRequest,
  validateCredentialBrokerResponse,
} from "../../../src/connectors/credential-broker.js";
import {
  assertConnectorAuthorizationSnapshotMatchesBinding,
  ConnectorAuthorizationSnapshotError,
  PlatformStateConnectorAuthorizationReader,
  type ConnectorAuthorizationSnapshot,
} from "../../../src/connectors/authorization-snapshot.js";
import type { CredentialCustodyReference } from "../../../src/platform/layer3-contract.js";
import type { PlatformStateDO } from "../../../src/platform/platform-state-do.js";
import type { WorkspaceConfigDO } from "../../../src/config/workspace-config-do.js";
import { deriveInternalTenantId } from "../../../src/platform/tenant-id.js";
import { tenantStub } from "../../../src/tenancy.js";

type BrokerEnv = {
  Bindings: {
    /** Authoritative access-bundle and connector-grant revalidation. */
    WORKSPACE_CONFIG?: DurableObjectNamespace<WorkspaceConfigDO>;
    /** Cross-Worker namespace owned by opentag-bot; metadata only. */
    PLATFORM_STATE?: DurableObjectNamespace<PlatformStateDO>;
    /** External custody service. It is deliberately unconfigured by default. */
    CUSTODY?: Fetcher;
    /** Separate internal auth for the custody service binding. */
    CUSTODY_AUTH_TOKEN?: string;
    /** Internal service-binding authentication; never a provider credential. */
    BROKER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

type ConnectorPolicy = Readonly<{
  provider: string;
  requiredScopes: readonly string[];
  anyRequiredScope?: boolean;
}>;

const CONNECTOR_POLICIES: Readonly<Record<string, ConnectorPolicy>> = {
  "google_drive:search": {
    provider: "google",
    requiredScopes: ["drive.readonly"],
  },
  "linear:create_issue": {
    provider: "linear",
    requiredScopes: ["issues:create", "write"],
    anyRequiredScope: true,
  },
};

class CredentialBrokerError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(code);
    this.name = "CredentialBrokerError";
  }
}

const app = new Hono<BrokerEnv>();

function requireAuth(env: BrokerEnv["Bindings"], authorization: string | undefined): void {
  if (!env.BROKER_AUTH_TOKEN) {
    throw new CredentialBrokerError("credential_broker_unconfigured", 503);
  }
  if (authorization !== `Bearer ${env.BROKER_AUTH_TOKEN}`) {
    throw new CredentialBrokerError("unauthorized", 401);
  }
}

function policyFor(request: ReturnType<typeof validateCredentialBrokerRequest>): ConnectorPolicy {
  const policy = CONNECTOR_POLICIES[`${request.labels.connectorId}:${request.labels.action}`];
  if (!policy) throw new CredentialBrokerError("connector_resolution_not_allowed", 403);
  return policy;
}

function expiresAtAfter(now: number, value: string | undefined): boolean {
  return value === undefined || Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
}

async function readCredentialMetadata(
  env: BrokerEnv["Bindings"],
  request: ReturnType<typeof validateCredentialBrokerRequest>,
): Promise<{
  tenantId: string;
  credential: CredentialCustodyReference;
  snapshot: ConnectorAuthorizationSnapshot;
}> {
  if (!env.WORKSPACE_CONFIG) {
    throw new CredentialBrokerError("workspace_config_unavailable", 503);
  }
  const authorizationStub = tenantStub(env.WORKSPACE_CONFIG, request.labels.workspaceId);
  const authorizationResponse = await authorizationStub.fetch(
    "https://workspace/verifyConnectorAuthorization",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: request.labels }),
    },
  );
  if (!authorizationResponse.ok) {
    const body = await authorizationResponse.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof body.error === "string" && /^[a-z][a-z0-9_.-]{0,127}$/.test(body.error)
      ? body.error
      : "connector_authorization_unavailable";
    const status = authorizationResponse.status === 403
      ? 403
      : authorizationResponse.status === 409
        ? 409
        : 503;
    throw new CredentialBrokerError(code, status);
  }
  if (!env.PLATFORM_STATE) {
    throw new CredentialBrokerError("platform_state_unavailable", 503);
  }
  const platformBinding = request.labels.platformBinding;
  if (!platformBinding) {
    throw new CredentialBrokerError("platform_authorization_required", 403);
  }
  const tenantId = await deriveInternalTenantId({
    externalPlatform: "slack",
    externalTenantId: request.labels.workspaceId,
  });
  if (
    platformBinding.tenantId !== tenantId ||
    platformBinding.platform !== "slack" ||
    platformBinding.platformTenantId !== request.labels.workspaceId
  ) {
    throw new CredentialBrokerError("platform_tenant_mismatch", 403);
  }
  let snapshot: ConnectorAuthorizationSnapshot;
  try {
    snapshot = await new PlatformStateConnectorAuthorizationReader(env.PLATFORM_STATE).resolve({
      tenantId,
      principalId: platformBinding.principalId,
      platform: platformBinding.platform,
      platformTenantId: platformBinding.platformTenantId,
      platformSubjectId: platformBinding.platformSubjectId,
      tenantLocatorVersion: platformBinding.tenantLocatorVersion,
      connectorId: request.labels.connectorId,
      action: request.labels.action,
    });
    assertConnectorAuthorizationSnapshotMatchesBinding(
      snapshot,
      platformBinding,
      {
        connectorId: request.labels.connectorId,
        action: request.labels.action,
        credentialRef: request.reference.ref,
        credentialVersion: request.reference.version,
      },
    );
  } catch (error) {
    if (error instanceof CredentialBrokerError) throw error;
    if (error instanceof ConnectorAuthorizationSnapshotError) {
      throw new CredentialBrokerError(error.code, error.status);
    }
    const code = error instanceof Error ? error.message : "connector_authorization_snapshot_unavailable";
    throw new CredentialBrokerError(code, 503);
  }
  return { tenantId, credential: snapshot.credential, snapshot };
}

function assertResolutionAllowed(
  request: ReturnType<typeof validateCredentialBrokerRequest>,
  tenantId: string,
  credential: CredentialCustodyReference,
  policy: ConnectorPolicy,
  snapshot: ConnectorAuthorizationSnapshot,
): void {
  const now = Date.now();
  if (!expiresAtAfter(now, request.labels.expiresAt)) {
    throw new CredentialBrokerError("connector_authorization_expired", 403);
  }
  if (credential.tenantId !== tenantId) {
    throw new CredentialBrokerError("credential_tenant_mismatch", 403);
  }
  if (credential.credentialRef !== request.reference.ref) {
    throw new CredentialBrokerError("credential_reference_mismatch", 403);
  }
  if (credential.version !== request.reference.version) {
    throw new CredentialBrokerError("credential_version_mismatch", 403);
  }
  if (credential.status !== "active") {
    throw new CredentialBrokerError("credential_revoked", 403);
  }
  if (!expiresAtAfter(now, credential.expiresAt)) {
    throw new CredentialBrokerError("credential_expired", 403);
  }
  if (credential.expiresAt && Date.parse(request.labels.expiresAt) > Date.parse(credential.expiresAt)) {
    throw new CredentialBrokerError("connector_authorization_outlives_credential", 403);
  }
  if (credential.provider !== policy.provider) {
    throw new CredentialBrokerError("credential_provider_mismatch", 403);
  }
  const hasScope = (scope: string) => credential.scopes.includes(scope);
  const scopesAllowed = policy.anyRequiredScope
    ? policy.requiredScopes.some(hasScope)
    : policy.requiredScopes.every(hasScope);
  if (!scopesAllowed) {
    throw new CredentialBrokerError("credential_scope_missing", 403);
  }
  if (
    snapshot.connectorId !== request.labels.connectorId ||
    snapshot.action !== request.labels.action
  ) {
    throw new CredentialBrokerError("connector_authorization_snapshot_mismatch", 403);
  }
}

async function resolveFromCustody(
  env: BrokerEnv["Bindings"],
  request: ReturnType<typeof validateCredentialBrokerRequest>,
  tenantId: string,
  credential: CredentialCustodyReference,
): Promise<CredentialBrokerResponse> {
  if (!env.CUSTODY) {
    throw new CredentialBrokerError("credential_custody_unavailable", 503);
  }
  if (!env.CUSTODY_AUTH_TOKEN) {
    throw new CredentialBrokerError("credential_custody_auth_unconfigured", 503);
  }
  const response = await env.CUSTODY.fetch("https://custody/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.CUSTODY_AUTH_TOKEN}`,
      "x-opentag-credential-authorization": request.labels.digest,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      tenantId,
      reference: request.reference,
      labels: request.labels,
      credential: {
        schemaVersion: credential.schemaVersion,
        tenantId: credential.tenantId,
        credentialRef: credential.credentialRef,
        backend: credential.backend,
        provider: credential.provider,
        subject: credential.subject,
        scopes: credential.scopes,
        version: credential.version,
        status: credential.status,
        issuedAt: credential.issuedAt,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
      },
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof body.error === "string" && /^[a-z][a-z0-9_.-]{0,127}$/.test(body.error)
      ? body.error
      : "credential_custody_resolution_failed";
    throw new CredentialBrokerError(code, response.status >= 500 ? 503 : 403);
  }
  let result: CredentialBrokerResponse;
  try {
    result = validateCredentialBrokerResponse(await response.json());
  } catch {
    throw new CredentialBrokerError("credential_custody_response_invalid", 503);
  }
  if (result.ref !== request.reference.ref || result.version !== request.reference.version) {
    throw new CredentialBrokerError("credential_custody_reference_mismatch", 503);
  }
  if (!expiresAtAfter(Date.now(), result.expiresAt)) {
    throw new CredentialBrokerError("credential_custody_token_expired", 503);
  }
  if (result.expiresAt && Date.parse(result.expiresAt) > Date.parse(request.labels.expiresAt)) {
    throw new CredentialBrokerError("credential_custody_token_outlives_authorization", 503);
  }
  return result;
}

async function custodyProviderResolutionEnabled(env: BrokerEnv["Bindings"]): Promise<boolean> {
  if (!env.CUSTODY) return false;
  try {
    const response = await env.CUSTODY.fetch("https://credential-custody/health");
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.ok === true && body.providerResolutionEnabled === true;
  } catch {
    return false;
  }
}

app.get("/health", async (c) => c.json({
  ok: true,
  role: "credential-broker",
  configured: Boolean(c.env.BROKER_AUTH_TOKEN),
  workspaceConfigConfigured: Boolean(c.env.WORKSPACE_CONFIG),
  platformStateConfigured: Boolean(c.env.PLATFORM_STATE),
  custodyConfigured: Boolean(c.env.CUSTODY),
  custodyAuthConfigured: Boolean(c.env.CUSTODY_AUTH_TOKEN),
  providerResolutionEnabled: Boolean(
    c.env.BROKER_AUTH_TOKEN &&
    c.env.WORKSPACE_CONFIG &&
    c.env.PLATFORM_STATE &&
    c.env.CUSTODY &&
    c.env.CUSTODY_AUTH_TOKEN &&
    await custodyProviderResolutionEnabled(c.env),
  ),
}));

app.post("/resolve", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    let request: ReturnType<typeof validateCredentialBrokerRequest>;
    try {
      request = validateCredentialBrokerRequest(await c.req.json());
    } catch (error) {
      if (error instanceof Error) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
    try {
      await assertConnectorLabelsIntegrity(request.labels);
    } catch {
      throw new CredentialBrokerError("connector_labels_tampered", 403);
    }
    const policy = policyFor(request);
    const { tenantId, credential, snapshot } = await readCredentialMetadata(c.env, request);
    assertResolutionAllowed(request, tenantId, credential, policy, snapshot);
    return c.json(await resolveFromCustody(c.env, request, tenantId, credential), 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (error instanceof CredentialBrokerError) {
      return c.json({ error: error.code }, error.status);
    }
    if (error instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
    console.error("[credential-broker] request failed", "unexpected");
    return c.json({ error: "credential_broker_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("[credential-broker] request failed", "unexpected");
  return c.json({ error: "credential_broker_internal_error" }, 503);
});

export { app as credentialBrokerApp };
export default { fetch: app.fetch };
