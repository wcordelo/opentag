import { Hono } from "hono";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  assertConnectorLabelsIntegrity,
  type CredentialCustodyResolveRequest,
  validateCredentialBrokerResponse,
  validateCredentialCustodyResolveRequest,
} from "../../../src/connectors/credential-broker.js";
import {
  validateCredentialCustodyReference,
  type CredentialCustodyReference,
} from "../../../src/platform/layer3-contract.js";
import type { PlatformStateDO } from "../../../src/platform/platform-state-do.js";
import type { WorkspaceConfigDO } from "../../../src/config/workspace-config-do.js";
import { platformTenantObjectName } from "../../../src/platform/tenant-routing.js";

type SecretsStoreSecret = Readonly<{
  get(): Promise<string>;
}>;

type CustodyBindings = {
  /** Authoritative access-bundle and connector-grant revalidation. */
  WORKSPACE_CONFIG?: DurableObjectNamespace<WorkspaceConfigDO>;
  /** Cross-Worker namespace owned by opentag-bot; metadata only. */
  PLATFORM_STATE?: DurableObjectNamespace<PlatformStateDO>;
  CUSTODY_AUTH_TOKEN?: string;
  /** JSON metadata only: secret values stay in Secrets Store bindings. */
  CUSTODY_BINDINGS_JSON?: string;
  ENVIRONMENT?: string;
  [binding: string]: unknown;
};

type CustodyEnv = {
  Bindings: CustodyBindings;
};

type CustodyBindingConfig = Readonly<{
  ref: string;
  version: number;
  binding: string;
  expiresAt: string;
}>;

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

class CustodyError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(code);
    this.name = "CustodyError";
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BINDING_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_ERROR_CODE_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const app = new Hono<CustodyEnv>();

function identifier(value: unknown, field: string, max = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new CustodyError(`${field}_invalid`, 400);
  }
  return value;
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CustodyError(`${field}_invalid`, 400);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new CustodyError(`${field}_invalid`, 400);
  }
  return result;
}

function requireAuth(env: CustodyBindings, authorization: string | undefined): void {
  if (!env.CUSTODY_AUTH_TOKEN) {
    throw new CustodyError("credential_custody_auth_unconfigured", 503);
  }
  if (authorization !== `Bearer ${env.CUSTODY_AUTH_TOKEN}`) {
    throw new CustodyError("unauthorized", 401);
  }
}

function parseBindingConfig(env: CustodyBindings): CustodyBindingConfig[] {
  if (!env.CUSTODY_BINDINGS_JSON?.trim()) {
    throw new CustodyError("credential_custody_bindings_unconfigured", 503);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(env.CUSTODY_BINDINGS_JSON);
  } catch {
    throw new CustodyError("credential_custody_bindings_invalid", 503);
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) {
    throw new CustodyError("credential_custody_bindings_invalid", 503);
  }
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CustodyError("credential_custody_binding_invalid", 503);
    }
    const input = value as Record<string, unknown>;
    const ref = identifier(input.ref, "credential_ref");
    const credentialVersion = version(input.version, "credential_version");
    const binding = identifier(input.binding, "secret_binding", 64);
    if (!BINDING_RE.test(binding)) {
      throw new CustodyError("secret_binding_invalid", 503);
    }
    const expiresAt = timestamp(input.expiresAt, "credential_expires_at");
    const key = `${ref}@${credentialVersion}`;
    if (seen.has(key)) {
      throw new CustodyError("credential_custody_binding_duplicate", 503);
    }
    seen.add(key);
    return Object.freeze({ ref, version: credentialVersion, binding, expiresAt });
  });
}

function configuredBinding(
  configs: readonly CustodyBindingConfig[],
  request: CredentialCustodyResolveRequest,
): CustodyBindingConfig {
  const binding = configs.find((item) =>
    item.ref === request.reference.ref && item.version === request.reference.version);
  if (!binding) {
    throw new CustodyError("credential_custody_binding_not_found", 404);
  }
  return binding;
}

function expiresAtAfter(now: number, value: string | undefined): boolean {
  return value === undefined || Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
}

async function verifyConnectorAuthorization(
  env: CustodyBindings,
  request: CredentialCustodyResolveRequest,
): Promise<void> {
  if (!env.WORKSPACE_CONFIG) {
    throw new CustodyError("workspace_config_unavailable", 503);
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
    throw new CustodyError(code, status);
  }
}

async function readCredentialMetadata(
  env: CustodyBindings,
  request: CredentialCustodyResolveRequest,
): Promise<CredentialCustodyReference> {
  if (!env.PLATFORM_STATE) {
    throw new CustodyError("platform_state_unavailable", 503);
  }
  const stub = env.PLATFORM_STATE.get(
    env.PLATFORM_STATE.idFromName(platformTenantObjectName(request.tenantId)),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  const response = await stub.fetch("https://platform-state/credential/get", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentialRef: request.reference.ref }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" && SAFE_ERROR_CODE_RE.test(body.error)
      ? body.error
      : "credential_metadata_unavailable";
    const status = response.status === 404 ? 404 : response.status === 409 ? 409 : 503;
    throw new CustodyError(code, status);
  }
  try {
    return validateCredentialCustodyReference(body);
  } catch {
    throw new CustodyError("credential_metadata_invalid", 503);
  }
}

function policyFor(request: CredentialCustodyResolveRequest): ConnectorPolicy {
  const policy = CONNECTOR_POLICIES[`${request.labels.connectorId}:${request.labels.action}`];
  if (!policy) throw new CustodyError("connector_resolution_not_allowed", 403);
  return policy;
}

function assertCredentialActive(
  request: CredentialCustodyResolveRequest,
  credential: CredentialCustodyReference,
  policy: ConnectorPolicy,
): void {
  const now = Date.now();
  if (!expiresAtAfter(now, request.labels.expiresAt)) {
    throw new CustodyError("connector_authorization_expired", 403);
  }
  if (credential.tenantId !== request.tenantId) {
    throw new CustodyError("credential_tenant_mismatch", 403);
  }
  if (credential.credentialRef !== request.reference.ref) {
    throw new CustodyError("credential_reference_mismatch", 403);
  }
  if (credential.version !== request.reference.version) {
    throw new CustodyError("credential_version_mismatch", 403);
  }
  if (credential.status !== "active") {
    throw new CustodyError("credential_revoked", 403);
  }
  if (!expiresAtAfter(now, credential.expiresAt)) {
    throw new CustodyError("credential_expired", 403);
  }
  if (credential.expiresAt && Date.parse(request.labels.expiresAt) > Date.parse(credential.expiresAt)) {
    throw new CustodyError("connector_authorization_outlives_credential", 403);
  }
  if (credential.provider !== policy.provider) {
    throw new CustodyError("credential_provider_mismatch", 403);
  }
  const hasScope = (scope: string) => credential.scopes.includes(scope);
  const scopesAllowed = policy.anyRequiredScope
    ? policy.requiredScopes.some(hasScope)
    : policy.requiredScopes.every(hasScope);
  if (!scopesAllowed) {
    throw new CustodyError("credential_scope_missing", 403);
  }
}

function boundedExpiry(
  request: CredentialCustodyResolveRequest,
  configured: string,
  credential: CredentialCustodyReference,
): string {
  const values = [configured, request.labels.expiresAt];
  if (credential.expiresAt) values.push(credential.expiresAt);
  const expiresAt = new Date(Math.min(...values.map((value) => Date.parse(value))));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new CustodyError("credential_custody_token_expired", 403);
  }
  return expiresAt.toISOString();
}

async function assertLabelsIntegrity(
  request: CredentialCustodyResolveRequest,
): Promise<void> {
  try {
    await assertConnectorLabelsIntegrity(request.labels);
  } catch (error) {
    if (error instanceof Error && error.message === "connector_labels_tampered") {
      throw new CustodyError("connector_labels_tampered", 403);
    }
    throw error;
  }
}

/**
 * Re-read every authorization source after secret resolution. The secret
 * binding is not returned until this same-request second pass observes the
 * same immutable labels, workspace grant, tenant metadata, and policy.
 */
async function revalidateAfterSecretRead(
  env: CustodyBindings,
  request: CredentialCustodyResolveRequest,
): Promise<CredentialCustodyReference> {
  await assertLabelsIntegrity(request);
  await verifyConnectorAuthorization(env, request);
  const policy = policyFor(request);
  const credential = await readCredentialMetadata(env, request);
  assertCredentialActive(request, credential, policy);
  return credential;
}

async function resolveSecret(
  env: CustodyBindings,
  request: CredentialCustodyResolveRequest,
  binding: CustodyBindingConfig,
): Promise<Response> {
  const candidate = env[binding.binding];
  if (!candidate || typeof candidate !== "object" ||
      typeof (candidate as { get?: unknown }).get !== "function") {
    throw new CustodyError("credential_custody_secret_binding_unavailable", 503);
  }
  let accessToken: string;
  try {
    accessToken = await (candidate as SecretsStoreSecret).get();
  } catch {
    throw new CustodyError("credential_custody_secret_unavailable", 503);
  }
  const currentCredential = await revalidateAfterSecretRead(env, request);
  const response = validateCredentialBrokerResponse({
    schemaVersion: 1,
    ref: request.reference.ref,
    version: request.reference.version,
    accessToken,
    expiresAt: boundedExpiry(request, binding.expiresAt, currentCredential),
  });
  return Response.json(response, {
    headers: { "cache-control": "no-store" },
  });
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "credential-custody",
  authConfigured: Boolean(c.env.CUSTODY_AUTH_TOKEN),
  bindingConfigConfigured: Boolean(c.env.CUSTODY_BINDINGS_JSON?.trim()),
  workspaceConfigConfigured: Boolean(c.env.WORKSPACE_CONFIG),
  platformStateConfigured: Boolean(c.env.PLATFORM_STATE),
  providerResolutionEnabled: Boolean(
    c.env.CUSTODY_AUTH_TOKEN &&
    c.env.CUSTODY_BINDINGS_JSON?.trim() &&
    c.env.WORKSPACE_CONFIG &&
    c.env.PLATFORM_STATE,
  ),
}));

app.post("/resolve", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    let request: CredentialCustodyResolveRequest;
    try {
      request = await validateCredentialCustodyResolveRequest(await c.req.json());
      await assertConnectorLabelsIntegrity(request.labels);
    } catch (error) {
      if (error instanceof CustodyError) throw error;
      if (error instanceof Error && error.message === "connector_labels_tampered") {
        throw new CustodyError("connector_labels_tampered", 403);
      }
      if (error instanceof Error && error.message === "credential_custody_workspace_tenant_mismatch") {
        throw new CustodyError("credential_custody_workspace_tenant_mismatch", 403);
      }
      return c.json({ error: error instanceof Error ? error.message : "credential_custody_request_invalid" }, 400);
    }
    await verifyConnectorAuthorization(c.env, request);
    const policy = policyFor(request);
    const credential = await readCredentialMetadata(c.env, request);
    assertCredentialActive(request, credential, policy);
    const binding = configuredBinding(parseBindingConfig(c.env), request);
    return await resolveSecret(c.env, request, binding);
  } catch (error) {
    if (error instanceof CustodyError) return c.json({ error: error.code }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
    console.error("[credential-custody] request failed", "unexpected");
    return c.json({ error: "credential_custody_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("[credential-custody] request failed", "unexpected");
  return c.json({ error: "credential_custody_internal_error" }, 503);
});

export { app as credentialCustodyApp };
export default { fetch: app.fetch };
