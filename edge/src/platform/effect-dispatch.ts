import type {
  DurableObjectNamespace,
  Fetcher,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types";
import type { PlatformStateDO } from "./platform-state-do.js";

export const PLATFORM_EFFECT_WAKEUP_SCHEMA_VERSION = 1 as const;
export const PLATFORM_EFFECT_MAX_BATCH = 10;
const MAX_QUEUE_DELAY_SECONDS = 900;
const OBJECT_NAME_RE = /^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORM_OBJECT_NAME = "__platform_marketplace__";
const QUEUE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * A wakeup contains only an internal Durable Object name. It is deliberately
 * not an effect payload: the effecter reads the validated intent from the
 * PlatformStateDO before it can claim a lease.
 */
export type PlatformEffectWakeup = Readonly<{
  schemaVersion: typeof PLATFORM_EFFECT_WAKEUP_SCHEMA_VERSION;
  objectName: string;
}>;

export type PlatformEffectDispatchBindings = Readonly<{
  PLATFORM_STATE?: DurableObjectNamespace<PlatformStateDO>;
  PLATFORM_EFFECTER?: Fetcher;
  EFFECTOR_AUTH_TOKEN?: string;
  PLATFORM_EFFECTS_QUEUE?: Queue<PlatformEffectWakeup>;
}>;

export class PlatformEffectDispatchError extends Error {
  constructor(readonly code: string, readonly retryable = true) {
    super(code);
    this.name = "PlatformEffectDispatchError";
  }
}

export function isPlatformEffectQueueName(value: unknown): value is string {
  return typeof value === "string" &&
    QUEUE_NAME_RE.test(value) &&
    !value.endsWith("-dlq");
}

function safeObjectName(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new PlatformEffectDispatchError("effect_wakeup_object_invalid", false);
  }
  if (value !== PLATFORM_OBJECT_NAME && !OBJECT_NAME_RE.test(value)) {
    throw new PlatformEffectDispatchError("effect_wakeup_object_invalid", false);
  }
  return value;
}

export function validatePlatformEffectWakeup(value: unknown): PlatformEffectWakeup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformEffectDispatchError("effect_wakeup_invalid", false);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "schemaVersion" && key !== "objectName")) {
    throw new PlatformEffectDispatchError("effect_wakeup_field_invalid", false);
  }
  if (input.schemaVersion !== PLATFORM_EFFECT_WAKEUP_SCHEMA_VERSION) {
    throw new PlatformEffectDispatchError("effect_wakeup_schema_invalid", false);
  }
  return Object.freeze({
    schemaVersion: PLATFORM_EFFECT_WAKEUP_SCHEMA_VERSION,
    objectName: safeObjectName(input.objectName),
  });
}

export function platformEffectWakeup(objectName: string): PlatformEffectWakeup {
  return validatePlatformEffectWakeup({
    schemaVersion: PLATFORM_EFFECT_WAKEUP_SCHEMA_VERSION,
    objectName,
  });
}

export async function enqueuePlatformEffectWakeup(
  queue: Queue<PlatformEffectWakeup> | undefined,
  objectName: string,
  delaySeconds = 0,
): Promise<void> {
  if (!queue) throw new PlatformEffectDispatchError("platform_effect_queue_unconfigured");
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_QUEUE_DELAY_SECONDS) {
    throw new PlatformEffectDispatchError("effect_wakeup_delay_invalid", false);
  }
  await queue.send(platformEffectWakeup(objectName), {
    contentType: "json",
    ...(delaySeconds > 0 ? { delaySeconds } : {}),
  });
}

type EffectReceipt = Readonly<{
  intentId: string;
  scope: "tenant" | "platform";
  tenantId?: string;
  status: "pending" | "failed" | "leased";
  retryable: boolean;
  availableAt: string;
  leaseExpiresAt?: string;
}>;

function receipt(value: unknown, expected: "pending" | "failed" | "leased"): EffectReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformEffectDispatchError("effect_receipt_invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.intentId !== "string" ||
    !input.intentId ||
    (input.scope !== "tenant" && input.scope !== "platform") ||
    input.status !== expected ||
    typeof input.retryable !== "boolean" ||
    typeof input.availableAt !== "string" ||
    !Number.isFinite(Date.parse(input.availableAt))
  ) {
    throw new PlatformEffectDispatchError("effect_receipt_invalid");
  }
  if (input.scope === "tenant" && typeof input.tenantId !== "string") {
    throw new PlatformEffectDispatchError("effect_receipt_tenant_invalid");
  }
  if (input.scope === "platform" && input.tenantId !== undefined) {
    throw new PlatformEffectDispatchError("effect_receipt_platform_tenant_invalid");
  }
  return Object.freeze({
    intentId: input.intentId,
    scope: input.scope,
    ...(typeof input.tenantId === "string" ? { tenantId: input.tenantId } : {}),
    status: expected,
    retryable: input.retryable,
    availableAt: input.availableAt,
    ...(typeof input.leaseExpiresAt === "string" ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
  });
}

async function readEffectList(
  stub: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  scope: "tenant" | "platform",
  tenantId: string | undefined,
  status: "pending" | "failed" | "leased",
): Promise<EffectReceipt[]> {
  const response = await stub.fetch("https://platform-state/effect/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope,
      ...(tenantId ? { tenantId } : {}),
      status,
      limit: 100,
    }),
  });
  if (!response.ok) {
    throw new PlatformEffectDispatchError(
      response.status >= 500 ? "platform_effect_list_unavailable" : "platform_effect_list_rejected",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PlatformEffectDispatchError("platform_effect_list_invalid");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as Record<string, unknown>).effects)) {
    throw new PlatformEffectDispatchError("platform_effect_list_invalid");
  }
  return (body as { effects: unknown[] }).effects.map((item) => receipt(item, status));
}

function delayFor(availableAt: string, now: number): number {
  const remaining = Math.max(0, Date.parse(availableAt) - now);
  return Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(1, Math.ceil(remaining / 1_000)));
}

function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(5, attempts - 1));
  return Math.min(MAX_QUEUE_DELAY_SECONDS, 30 * (2 ** exponent));
}

function objectScope(objectName: string): { scope: "tenant" | "platform"; tenantId?: string } {
  const validated = safeObjectName(objectName);
  return validated === PLATFORM_OBJECT_NAME
    ? { scope: "platform" }
    : { scope: "tenant", tenantId: validated.slice("tenant:".length) };
}

async function effecterRun(
  effecter: Fetcher,
  effect: EffectReceipt,
  workerId: string,
  authToken: string,
): Promise<"completed" | "skipped"> {
  const response = await effecter.fetch("https://platform-effecter/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      scope: effect.scope,
      ...(effect.tenantId ? { tenantId: effect.tenantId } : {}),
      intentId: effect.intentId,
      workerId,
      leaseSeconds: 300,
    }),
  });
  if (response.ok) return "completed";
  if (response.status === 409) return "skipped";
  if (response.status >= 500) {
    throw new PlatformEffectDispatchError("platform_effecter_unavailable");
  }
  throw new PlatformEffectDispatchError("platform_effecter_request_rejected", false);
}

export async function dispatchPlatformEffectWakeup(
  value: unknown,
  bindings: Pick<PlatformEffectDispatchBindings, "PLATFORM_STATE" | "PLATFORM_EFFECTER" | "EFFECTOR_AUTH_TOKEN">,
  now = Date.now(),
): Promise<{ dispatched: number; nextDelaySeconds?: number }> {
  const wakeup = validatePlatformEffectWakeup(value);
  if (!bindings.PLATFORM_STATE) {
    throw new PlatformEffectDispatchError("platform_state_unavailable");
  }
  if (!bindings.PLATFORM_EFFECTER) {
    throw new PlatformEffectDispatchError("platform_effecter_unconfigured");
  }
  if (!bindings.EFFECTOR_AUTH_TOKEN) {
    throw new PlatformEffectDispatchError("platform_effecter_auth_unconfigured", false);
  }
  const { scope, tenantId } = objectScope(wakeup.objectName);
  const stub = bindings.PLATFORM_STATE.get(
    bindings.PLATFORM_STATE.idFromName(wakeup.objectName),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  const [pending, failed, leased] = await Promise.all([
    readEffectList(stub, scope, tenantId, "pending"),
    readEffectList(stub, scope, tenantId, "failed"),
    readEffectList(stub, scope, tenantId, "leased"),
  ]);
  const expiredLeased = leased.filter(
    (item) => item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= now,
  );
  const candidates = [
    ...pending,
    ...expiredLeased,
    ...failed.filter((item) => item.retryable),
  ].sort((left, right) => Date.parse(left.availableAt) - Date.parse(right.availableAt));
  const runnable = candidates.filter((item) => Date.parse(item.availableAt) <= now);
  const future = candidates.find((item) => Date.parse(item.availableAt) > now);
  const selected = runnable.slice(0, PLATFORM_EFFECT_MAX_BATCH);
  let dispatched = 0;
  for (const effect of selected) {
    const outcome = await effecterRun(
      bindings.PLATFORM_EFFECTER,
      effect,
      `platform-effect-dispatch:${crypto.randomUUID()}`,
      bindings.EFFECTOR_AUTH_TOKEN,
    );
    if (outcome === "completed") dispatched += 1;
  }
  if (runnable.length > selected.length) return { dispatched, nextDelaySeconds: 0 };
  if (future) return { dispatched, nextDelaySeconds: delayFor(future.availableAt, now) };
  return { dispatched };
}

export async function handlePlatformEffectQueue(
  batch: MessageBatch<PlatformEffectWakeup>,
  bindings: PlatformEffectDispatchBindings,
): Promise<void> {
  for (const message of batch.messages) {
    let wakeup: PlatformEffectWakeup;
    try {
      wakeup = validatePlatformEffectWakeup(message.body);
    } catch (error) {
      // A malformed queue body cannot become valid on retry. Ack it without
      // logging the body, which could contain untrusted or secret-shaped data.
      message.ack();
      console.error(JSON.stringify({
        metric: "platform_effect_wakeup_invalid",
        errorCode: error instanceof Error ? error.message : "effect_wakeup_invalid",
      }));
      continue;
    }
    try {
      const result = await dispatchPlatformEffectWakeup(wakeup, bindings);
      if (result.nextDelaySeconds !== undefined) {
        if (!bindings.PLATFORM_EFFECTS_QUEUE) {
          throw new PlatformEffectDispatchError("platform_effect_queue_unconfigured");
        }
        await enqueuePlatformEffectWakeup(
          bindings.PLATFORM_EFFECTS_QUEUE,
          wakeup.objectName,
          result.nextDelaySeconds,
        );
      }
      message.ack();
    } catch (error) {
      if (error instanceof PlatformEffectDispatchError && !error.retryable) {
        message.ack();
        console.error(JSON.stringify({
          metric: "platform_effect_wakeup_rejected",
          errorCode: error.code,
        }));
        continue;
      }
      message.retry({ delaySeconds: backoffSeconds(message.attempts) });
      console.error(JSON.stringify({
        metric: "platform_effect_wakeup_retry",
        errorCode: error instanceof Error ? error.message : "platform_effect_dispatch_failed",
      }));
    }
  }
}
