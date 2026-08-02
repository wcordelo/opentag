import { Hono } from "hono";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  type CredentialBrokerResponse,
  validateCredentialBrokerRequest,
  validateCredentialBrokerResponse,
} from "../../../src/connectors/credential-broker.js";
import type { CredentialCustodyReference } from "../../../src/platform/layer3-contract.js";
import { validateCredentialCustodyReference } from "../../../src/platform/layer3-contract.js";
import type { PlatformStateDO } from "../../../src/platform/platform-state-do.js";
import type { WorkspaceConfigDO } from "../../../src/config/workspace-config-do.js";
import { deriveInternalTenantId } from "../../../src/platform/tenant-id.js";
import { platformTenantObjectName } from "../../../src/platform/tenant-routing.js";

type BrokerEnv = {
  Bindings: {
    /** Authoritative access-bundle and connector-grant revalidation. */
    WORKSPACE_CONFIG?: DurableObjectNamespace<WorkspaceConfigDO>;
    /** Cross-Worker namespace owned by opentag-bot; metadata only. */
    PLATFORM_STATE?: DurableObjectNamespace<PlatformStateDO>;
    /** External custody service. It is deliberately unconfigured by default. */
    CUSTODY?: Fetcher;
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
): Promise<{ tenantId: string; credential: CredentialCustodyReference }> {
  if (!env.WORKSPACE_CONFIG) {
    throw new CredentialBrokerError("workspace_config_unavailable", 503);
  }
  const authorizationStub = env.WORKSPACE_CONFIG.get(
    env.WORKSPACE_CONFIG.idFromName(request.labels.workspaceId),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
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
  const tenantId = await deriveInternalTenantId({
    externalPlatform: "slack",
    externalTenantId: request.labels.workspaceId,
  });
  const stub = env.PLATFORM_STATE.get(
    env.PLATFORM_STATE.idFromName(platformTenantObjectName(tenantId)),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  const response = await stub.fetch("https://platform-state/credential/get", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentialRef: request.reference.ref }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "credential_metadata_unavailable";
    const status = response.status === 404 ? 404 : response.status === 409 ? 409 : 503;
    throw new CredentialBrokerError(code, status);
  }
  let credential: CredentialCustodyReference;
  try {
    credential = validateCredentialCustodyReference(body);
  } catch {
    throw new CredentialBrokerError("credential_metadata_invalid", 503);
  }
  return { tenantId, credential };
}

async function assertLabelsIntegrity(
  labels: ReturnType<typeof validateCredentialBrokerRequest>["labels"],
): Promise<void> {
  const { digest, ...unsigned } = labels;
  const payload = JSON.stringify([
    unsigned.schemaVersion,
    unsigned.workspaceId,
    unsigned.projectId,
    unsigned.channelId,
    unsigned.connectorId,
    unsigned.action,
    unsigned.scope,
    unsigned.requesterId,
    unsigned.actorKind,
    unsigned.executionId,
    unsigned.threadKey,
    unsigned.accessBundleId,
    unsigned.accessBundleRevision,
    unsigned.credentialRef ?? null,
    unsigned.credentialVersion ?? null,
    unsigned.issuedAt,
    unsigned.expiresAt,
  ]);
  const computed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const expected = `sha256:${[...new Uint8Array(computed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  if (expected !== digest) {
    throw new CredentialBrokerError("connector_labels_tampered", 403);
  }
}

function assertResolutionAllowed(
  request: ReturnType<typeof validateCredentialBrokerRequest>,
  tenantId: string,
  credential: CredentialCustodyReference,
  policy: ConnectorPolicy,
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
  const response = await env.CUSTODY.fetch("https://custody/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opentag-credential-authorization": request.labels.digest,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      tenantId,
      reference: request.reference,
      labels: request.labels,
      credential: {
        credentialRef: credential.credentialRef,
        provider: credential.provider,
        subject: credential.subject,
        scopes: credential.scopes,
        version: credential.version,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new CredentialBrokerError("credential_custody_resolution_failed", response.status >= 500 ? 503 : 403);
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

app.get("/health", (c) => c.json({
  ok: true,
  role: "credential-broker",
  configured: Boolean(c.env.BROKER_AUTH_TOKEN),
  workspaceConfigConfigured: Boolean(c.env.WORKSPACE_CONFIG),
  platformStateConfigured: Boolean(c.env.PLATFORM_STATE),
  custodyConfigured: Boolean(c.env.CUSTODY),
  providerResolutionEnabled: Boolean(
    c.env.BROKER_AUTH_TOKEN &&
    c.env.WORKSPACE_CONFIG &&
    c.env.PLATFORM_STATE &&
    c.env.CUSTODY,
  ),
}));

app.post("/resolve", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    const request = validateCredentialBrokerRequest(await c.req.json());
    await assertLabelsIntegrity(request.labels);
    const policy = policyFor(request);
    const { tenantId, credential } = await readCredentialMetadata(c.env, request);
    assertResolutionAllowed(request, tenantId, credential, policy);
    return c.json(await resolveFromCustody(c.env, request, tenantId, credential));
  } catch (error) {
    if (error instanceof CredentialBrokerError) {
      return c.json({ error: error.code }, error.status);
    }
    if (error instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
    console.error("[credential-broker] request failed", error instanceof Error ? error.message : "unknown");
    return c.json({ error: "credential_broker_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("[credential-broker] request failed", error instanceof Error ? error.message : "unknown");
  return c.json({ error: "credential_broker_internal_error" }, 503);
});

export { app as credentialBrokerApp };
export default { fetch: app.fetch };
