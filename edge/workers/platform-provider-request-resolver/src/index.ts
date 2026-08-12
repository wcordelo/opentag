import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";
import {
  parseCredentialReference,
  type ImmutableConnectorLabels,
  type CredentialReference,
} from "../../../src/connectors/authorization.js";
import {
  assertLinearWriteApprovalCurrent,
  type LinearWriteApproval,
} from "../../../src/connectors/linear-write.js";

const SCHEMA_VERSION = 1 as const;
const MAX_BODY_BYTES = 96 * 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REQUEST_REF_RE = /^linear-write-approval:[A-Za-z0-9_-]{16,200}$/;

type RequestResolution = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  requestRef: string;
  requestRevision: number;
  requestDigest: string;
  authorizationDigest: string;
  labels: ImmutableConnectorLabels;
  credential: CredentialReference;
  approval: LinearWriteApproval;
}>;

type ResolverEnv = {
  Bindings: {
    PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?: string;
    REQUESTS: DurableObjectNamespace<ProviderRequestDO>;
    ENVIRONMENT?: string;
  };
};

class ResolverError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 409 | 413 | 503) {
    super(code);
    this.name = "ResolverError";
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResolverError(code, 400);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], code: string): void {
  const allowed = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !allowed.has(field))) {
    throw new ResolverError(code, 400);
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
    throw new ResolverError(`${field}_invalid`, 400);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ResolverError(`${field}_invalid`, 400);
  }
  return value as number;
}

function digest(value: unknown, field: string): string {
  const result = identifier(value, field, 80);
  if (!DIGEST_RE.test(result)) throw new ResolverError(`${field}_invalid`, 400);
  return result;
}

function rejectSecretKeys(value: unknown, depth = 0, nodes = { count: 0 }): void {
  if (depth > 8) throw new ResolverError("request_resolution_too_deep", 400);
  nodes.count += 1;
  if (nodes.count > 512) throw new ResolverError("request_resolution_too_large", 413);
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretKeys(item, depth + 1, nodes);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_.-]/g, "");
    if (["accesstoken", "apikey", "authorization", "cookie", "password", "privatekey", "secret", "secretvalue", "token"].includes(normalizedKey)) {
      throw new ResolverError("request_resolution_secret_field", 400);
    }
    rejectSecretKeys(item, depth + 1, nodes);
  }
}

function validateLabels(value: unknown, credential: CredentialReference): ImmutableConnectorLabels {
  const input = record(value, "provider_request_labels_invalid");
  const fields = [
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
  ] as const;
  exactFields(input, fields, "provider_request_labels_invalid");
  if (
    input.connectorId !== "linear" ||
    input.action !== "create_issue" ||
    input.credentialRef !== credential.ref ||
    input.credentialVersion !== credential.version
  ) {
    throw new ResolverError("provider_request_labels_invalid", 400);
  }
  try {
    return Object.freeze(input as unknown as ImmutableConnectorLabels);
  } catch {
    throw new ResolverError("provider_request_labels_invalid", 400);
  }
}

async function validateResolution(value: unknown): Promise<RequestResolution> {
  rejectSecretKeys(value);
  const input = record(value, "provider_request_resolution_invalid");
  exactFields(
    input,
    ["schemaVersion", "requestRef", "requestRevision", "requestDigest", "authorizationDigest", "labels", "credential", "approval"],
    "provider_request_resolution_invalid",
  );
  if (input.schemaVersion !== SCHEMA_VERSION) throw new ResolverError("provider_request_schema_invalid", 400);
  const requestRef = identifier(input.requestRef, "request_ref");
  if (!REQUEST_REF_RE.test(requestRef)) throw new ResolverError("request_ref_invalid", 400);
  const requestRevision = positiveInteger(input.requestRevision, "request_revision");
  const requestDigest = digest(input.requestDigest, "request_digest");
  const authorizationDigest = digest(input.authorizationDigest, "authorization_digest");
  let credential: CredentialReference;
  try {
    credential = parseCredentialReference(input.credential);
  } catch {
    throw new ResolverError("provider_request_credential_invalid", 400);
  }
  const labels = validateLabels(input.labels, credential);
  const approvalInput = record(input.approval, "provider_request_approval_invalid");
  const approval = await assertLinearWriteApprovalCurrent(approvalInput, {
    approvalId: requestRef.slice("linear-write-approval:".length),
    teamId: identifier(approvalInput.teamId, "approval_team_id"),
    channelId: identifier(approvalInput.channelId, "approval_channel_id"),
    requesterId: identifier(approvalInput.requesterId, "approval_requester_id"),
    executionId: identifier(approvalInput.executionId, "approval_execution_id"),
    threadKey: identifier(approvalInput.threadKey, "approval_thread_key"),
    draft: approvalInput.draft,
  });
  if (approval.draftDigest !== requestDigest) {
    throw new ResolverError("provider_request_digest_mismatch", 409);
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    requestRef,
    requestRevision,
    requestDigest,
    authorizationDigest,
    labels,
    credential,
    approval,
  });
}

function requireAuth(env: ResolverEnv["Bindings"], authorization: string | undefined): void {
  const expected = env.PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?.trim();
  if (!expected) throw new ResolverError("provider_request_resolver_unconfigured", 503);
  if (authorization !== `Bearer ${expected}`) throw new ResolverError("unauthorized", 401);
}

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    throw new ResolverError("request_body_too_large", 413);
  }
  try {
    return await request.json();
  } catch {
    throw new ResolverError("invalid_json", 400);
  }
}

function objectName(tenantId: string, requestRef: string): string {
  return `${tenantId}|${requestRef}`;
}

async function resolverCall(
  env: ResolverEnv["Bindings"],
  path: "/register" | "/resolve",
  body: unknown,
): Promise<Response> {
  const input = record(body, "provider_request_invalid");
  const tenantId = identifier(input.tenantId, "tenant_id");
  const requestRef = identifier(input.requestRef, "request_ref");
  const stub = env.REQUESTS.get(env.REQUESTS.idFromName(objectName(tenantId, requestRef)));
  const response = await stub.fetch(new Request(`https://provider-request${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const app = new Hono<ResolverEnv>();

app.get("/health", (c) => c.json({
  ok: true,
  role: "platform-provider-request-resolver",
  configured: Boolean(c.env.PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN?.trim()),
  durable: true,
}));

app.post("/register", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    const body = record(await readJson(c.req.raw), "provider_request_invalid");
    exactFields(body, ["schemaVersion", "tenantId", "provider", "action", "requestRef", "requestRevision", "requestDigest", "authorizationDigest", "labels", "credential", "approval"], "provider_request_invalid");
    if (body.schemaVersion !== SCHEMA_VERSION || body.provider !== "linear" || body.action !== "create_issue") {
      throw new ResolverError("provider_request_invalid", 400);
    }
    const resolution = await validateResolution({
      schemaVersion: body.schemaVersion,
      requestRef: body.requestRef,
      requestRevision: body.requestRevision,
      requestDigest: body.requestDigest,
      authorizationDigest: body.authorizationDigest,
      labels: body.labels,
      credential: body.credential,
      approval: body.approval,
    });
    const tenantId = identifier(body.tenantId, "tenant_id");
    return resolverCall(c.env, "/register", {
      tenantId,
      requestRef: resolution.requestRef,
      resolution,
    });
  } catch (error) {
    if (error instanceof ResolverError) return c.json({ error: error.code }, error.status);
    return c.json({ error: "provider_request_registration_invalid" }, 400);
  }
});

app.post("/resolve", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    const body = record(await readJson(c.req.raw), "provider_request_invalid");
    exactFields(body, ["schemaVersion", "tenantId", "provider", "action", "requestRef", "requestRevision", "requestDigest", "authorizationDigest"], "provider_request_invalid");
    if (body.schemaVersion !== SCHEMA_VERSION || body.provider !== "linear" || body.action !== "create_issue") {
      throw new ResolverError("provider_request_invalid", 400);
    }
    return resolverCall(c.env, "/resolve", body);
  } catch (error) {
    if (error instanceof ResolverError) return c.json({ error: error.code }, error.status);
    return c.json({ error: "provider_request_resolution_failed" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError(() => Response.json({ error: "provider_request_resolver_internal_error" }, { status: 503 }));

export class ProviderRequestDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || (url.pathname !== "/register" && url.pathname !== "/resolve")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const body = record(await readJson(request), "provider_request_invalid");
      if (url.pathname === "/register") {
        exactFields(body, ["tenantId", "requestRef", "resolution"], "provider_request_invalid");
        const resolution = await validateResolution(body.resolution);
        const existing = await this.ctx.storage.get<RequestResolution>("resolution");
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(resolution)) {
            return Response.json({ error: "provider_request_conflict" }, { status: 409 });
          }
          return Response.json({ ok: true, duplicate: true });
        }
        const expiresAt = Math.min(
          Date.parse(resolution.approval.expiresAt),
          Date.parse(resolution.labels.expiresAt),
          resolution.credential.expiresAt ? Date.parse(resolution.credential.expiresAt) : Number.POSITIVE_INFINITY,
        );
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          return Response.json({ error: "provider_request_expired" }, { status: 409 });
        }
        await this.ctx.storage.put("tenantId", identifier(body.tenantId, "tenant_id"));
        await this.ctx.storage.put("resolution", resolution, { expiration: Math.floor(expiresAt / 1_000) });
        return Response.json({ ok: true, duplicate: false });
      }
      exactFields(body, ["schemaVersion", "tenantId", "provider", "action", "requestRef", "requestRevision", "requestDigest", "authorizationDigest"], "provider_request_invalid");
      const resolution = await this.ctx.storage.get<RequestResolution>("resolution");
      if (!resolution) return Response.json({ error: "provider_request_not_found" }, { status: 404 });
      const tenantId = await this.ctx.storage.get<string>("tenantId");
      if (
        body.schemaVersion !== SCHEMA_VERSION ||
        body.tenantId !== tenantId ||
        body.provider !== "linear" ||
        body.action !== "create_issue" ||
        body.requestRef !== resolution.requestRef ||
        body.requestRevision !== resolution.requestRevision ||
        body.requestDigest !== resolution.requestDigest ||
        body.authorizationDigest !== resolution.authorizationDigest
      ) {
        return Response.json({ error: "provider_request_resolution_mismatch" }, { status: 409 });
      }
      return Response.json(resolution, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ResolverError) return Response.json({ error: error.code }, { status: error.status });
      return Response.json({ error: "provider_request_state_failed" }, { status: 503 });
    }
  }
}

export default { fetch: app.fetch };
