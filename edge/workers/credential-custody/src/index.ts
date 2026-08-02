import { Hono } from "hono";
import {
  assertConnectorLabelsIntegrity,
  type CredentialCustodyResolveRequest,
  validateCredentialBrokerResponse,
  validateCredentialCustodyResolveRequest,
} from "../../../src/connectors/credential-broker.js";

type SecretsStoreSecret = Readonly<{
  get(): Promise<string>;
}>;

type CustodyBindings = {
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

class CustodyError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 503) {
    super(code);
    this.name = "CustodyError";
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BINDING_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
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

function boundedExpiry(request: CredentialCustodyResolveRequest, configured: string): string {
  const values = [configured, request.labels.expiresAt];
  if (request.credential.expiresAt) values.push(request.credential.expiresAt);
  const expiresAt = new Date(Math.min(...values.map((value) => Date.parse(value))));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new CustodyError("credential_custody_token_expired", 403);
  }
  return expiresAt.toISOString();
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
  const response = validateCredentialBrokerResponse({
    schemaVersion: 1,
    ref: request.reference.ref,
    version: request.reference.version,
    accessToken,
    expiresAt: boundedExpiry(request, binding.expiresAt),
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
  providerResolutionEnabled: Boolean(
    c.env.CUSTODY_AUTH_TOKEN && c.env.CUSTODY_BINDINGS_JSON?.trim(),
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
    if (request.credential.status !== "active") {
      throw new CustodyError("credential_revoked", 403);
    }
    const binding = configuredBinding(parseBindingConfig(c.env), request);
    return await resolveSecret(c.env, request, binding);
  } catch (error) {
    if (error instanceof CustodyError) return c.json({ error: error.code }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
    console.error("[credential-custody] request failed", error instanceof Error ? error.message : "unknown");
    return c.json({ error: "credential_custody_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("[credential-custody] request failed", error instanceof Error ? error.message : "unknown");
  return c.json({ error: "credential_custody_internal_error" }, 503);
});

export { app as credentialCustodyApp };
export default { fetch: app.fetch };
