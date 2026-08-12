import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";

const SCHEMA_VERSION = 1 as const;
const MAX_BODY_BYTES = 48 * 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const KEY_RE = /^\S{1,1024}$/;

type Receipt = Record<string, unknown>;
type ReservationRecord = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  state: "reserved" | "completed" | "ambiguous";
  reservationId: string;
  key: string;
  receipt?: Receipt;
  createdAt: string;
}>;

type IdempotencyEnv = {
  Bindings: {
    PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN?: string;
    RECORDS: DurableObjectNamespace<ProviderIdempotencyDO>;
    ENVIRONMENT?: string;
  };
};

class IdempotencyError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 409 | 413 | 503) {
    super(code);
    this.name = "IdempotencyError";
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IdempotencyError(code, 400);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], code: string): void {
  const allowed = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !allowed.has(field))) {
    throw new IdempotencyError(code, 400);
  }
}

function identifier(value: unknown, field: string, max = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new IdempotencyError(`${field}_invalid`, 400);
  }
  return value;
}

function key(value: unknown): string {
  const result = identifier(value, "idempotency_key");
  if (!KEY_RE.test(result)) throw new IdempotencyError("idempotency_key_invalid", 400);
  return result;
}

function rejectSecretKeys(value: unknown, depth = 0, nodes = { count: 0 }): void {
  if (depth > 6) throw new IdempotencyError("receipt_too_deep", 400);
  nodes.count += 1;
  if (nodes.count > 256) throw new IdempotencyError("receipt_too_large", 413);
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretKeys(item, depth + 1, nodes);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, item] of Object.entries(value)) {
    const normalizedField = field.toLowerCase().replace(/[_.-]/g, "");
    if (["accesstoken", "apikey", "authorization", "cookie", "password", "privatekey", "secret", "secretvalue", "token"].includes(normalizedField)) {
      throw new IdempotencyError("receipt_secret_field", 400);
    }
    rejectSecretKeys(item, depth + 1, nodes);
  }
}

function requireAuth(env: IdempotencyEnv["Bindings"], authorization: string | undefined): void {
  const expected = env.PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN?.trim();
  if (!expected) throw new IdempotencyError("provider_idempotency_store_unconfigured", 503);
  if (authorization !== `Bearer ${expected}`) throw new IdempotencyError("unauthorized", 401);
}

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    throw new IdempotencyError("request_body_too_large", 413);
  }
  try {
    return await request.json();
  } catch {
    throw new IdempotencyError("invalid_json", 400);
  }
}

function statusResponse(value: unknown): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}

async function callState(
  env: IdempotencyEnv["Bindings"],
  path: "/reserve" | "/complete" | "/ambiguous" | "/release",
  body: unknown,
): Promise<Response> {
  const input = record(body, "provider_idempotency_request_invalid");
  const stateKey = key(input.key);
  const stub = env.RECORDS.get(env.RECORDS.idFromName(stateKey));
  const response = await stub.fetch(new Request(`https://provider-idempotency${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const app = new Hono<IdempotencyEnv>();

app.get("/health", (c) => c.json({
  ok: true,
  role: "platform-provider-idempotency",
  configured: Boolean(c.env.PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN?.trim()),
  durable: true,
}));

app.post("/:operation", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    const operation = c.req.param("operation");
    if (!["reserve", "complete", "ambiguous", "release"].includes(operation)) {
      throw new IdempotencyError("operation_invalid", 400);
    }
    const body = record(await readJson(c.req.raw), "provider_idempotency_request_invalid");
    if (body.schemaVersion !== SCHEMA_VERSION || body.operation !== operation) {
      throw new IdempotencyError("provider_idempotency_request_invalid", 400);
    }
    return callState(c.env, `/${operation}` as "/reserve" | "/complete" | "/ambiguous" | "/release", body);
  } catch (error) {
    if (error instanceof IdempotencyError) return c.json({ error: error.code }, error.status);
    return c.json({ error: "provider_idempotency_unavailable" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError(() => Response.json({ error: "provider_idempotency_internal_error" }, { status: 503 }));

export class ProviderIdempotencyDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const body = record(await readJson(request), "provider_idempotency_request_invalid");
      const operation = path.slice(1);
      if (request.method !== "POST" || !["reserve", "complete", "ambiguous", "release"].includes(operation)) {
        return statusResponse({ error: "not_found" });
      }
      if (body.schemaVersion !== SCHEMA_VERSION || body.operation !== operation) {
        return Response.json({ error: "provider_idempotency_request_invalid" }, { status: 400 });
      }
      const requestKey = key(body.key);
      const current = await this.ctx.storage.get<ReservationRecord>("record");
      const now = Date.now();
      if (operation === "reserve") {
        exactFields(body, ["schemaVersion", "operation", "key", "tenantId", "provider", "action", "idempotencyKey", "requestRef", "requestRevision", "requestDigest", "authorizationDigest"], "provider_idempotency_request_invalid");
        if (current?.state === "completed" || current?.state === "ambiguous") {
          return statusResponse({ schemaVersion: SCHEMA_VERSION, status: current.state, receipt: current.receipt });
        }
        if (current && current.state === "reserved" && Date.parse(current.createdAt) + 10 * 60_000 > now) {
          return statusResponse({ schemaVersion: SCHEMA_VERSION, status: "conflict" });
        }
        const reservation: ReservationRecord = {
          schemaVersion: SCHEMA_VERSION,
          state: "reserved",
          reservationId: crypto.randomUUID(),
          key: requestKey,
          createdAt: new Date(now).toISOString(),
        };
        await this.ctx.storage.put("record", reservation, { expirationTtl: 15 * 60 });
        return statusResponse({ schemaVersion: SCHEMA_VERSION, status: "reserved", reservationId: reservation.reservationId });
      }
      exactFields(body, ["schemaVersion", "operation", "key", "reservationId", ...(operation === "release" ? [] : ["receipt"])], "provider_idempotency_request_invalid");
      if (!current || current.key !== requestKey) {
        return Response.json({ error: "reservation_not_found" }, { status: 409 });
      }
      if (operation === "release") {
        if (current.state !== "reserved" || current.reservationId !== body.reservationId) {
          return Response.json({ error: "reservation_not_owned" }, { status: 409 });
        }
        await this.ctx.storage.delete("record");
        return statusResponse({ schemaVersion: SCHEMA_VERSION, status: "released" });
      }
      rejectSecretKeys(body.receipt);
      const receipt = record(body.receipt, "provider_receipt_invalid");
      const desiredState = operation === "complete" ? "completed" : "ambiguous";
      if (current.state === desiredState) {
        return statusResponse({ schemaVersion: SCHEMA_VERSION, status: "stored" });
      }
      if (current.state !== "reserved" || current.reservationId !== body.reservationId) {
        return Response.json({ error: "reservation_not_owned" }, { status: 409 });
      }
      const updated: ReservationRecord = {
        ...current,
        state: desiredState,
        receipt,
      };
      await this.ctx.storage.put("record", updated, { expirationTtl: 30 * 24 * 60 * 60 });
      return statusResponse({ schemaVersion: SCHEMA_VERSION, status: "stored" });
    } catch (error) {
      if (error instanceof IdempotencyError) return Response.json({ error: error.code }, { status: error.status });
      return Response.json({ error: "provider_idempotency_state_failed" }, { status: 503 });
    }
  }
}

export default { fetch: app.fetch };
