import type { Env } from "../env.js";
import type { SlackResponseRoute } from "../slack/response-routing.js";
import { callRouterJevJudgment, type RouterJevRouteJudgment } from "./jev-route-shadow.js";
import { resolveRouterJevShadowConfig } from "./jev-route-config.js";
import type { RouterJevRouteSource } from "./jev-route-questions.js";

export const RESPONSE_ROUTE_JEV_SCHEMA_VERSION = 1 as const;

export type ResponseRouteJevMeasurement = Readonly<{
  schemaVersion: typeof RESPONSE_ROUTE_JEV_SCHEMA_VERSION;
  workspaceId: string;
  eventId: string;
  threadKey: string;
  executionId: string;
  currentRoute: Readonly<{
    decision: SlackResponseRoute["decision"];
    reason: SlackResponseRoute["reason"];
  }>;
  jev: RouterJevRouteJudgment;
  recordedAt: string;
}>;

export class ResponseRouteJevMeasurementError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(code);
    this.name = "ResponseRouteJevMeasurementError";
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new ResponseRouteJevMeasurementError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) {
    throw new ResponseRouteJevMeasurementError(`${field}_invalid`);
  }
  if (!Number.isFinite(Date.parse(result))) {
    throw new ResponseRouteJevMeasurementError(`${field}_invalid`);
  }
  return result;
}

function validateJevJudgment(value: unknown): RouterJevRouteJudgment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResponseRouteJevMeasurementError("jev_judgment_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schema !== 1 || input.shadow !== true) {
    throw new ResponseRouteJevMeasurementError("jev_judgment_invalid");
  }
  return value as RouterJevRouteJudgment;
}

export function validateResponseRouteJevMeasurement(value: unknown): ResponseRouteJevMeasurement {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResponseRouteJevMeasurementError("response_route_jev_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== RESPONSE_ROUTE_JEV_SCHEMA_VERSION) {
    throw new ResponseRouteJevMeasurementError("response_route_jev_schema_invalid");
  }
  const currentRoute = input.currentRoute;
  if (!currentRoute || typeof currentRoute !== "object" || Array.isArray(currentRoute)) {
    throw new ResponseRouteJevMeasurementError("current_route_invalid");
  }
  const route = currentRoute as Record<string, unknown>;
  if (route.decision !== "respond" && route.decision !== "observe") {
    throw new ResponseRouteJevMeasurementError("current_route_invalid");
  }
  if (typeof route.reason !== "string" || route.reason.length === 0) {
    throw new ResponseRouteJevMeasurementError("current_route_invalid");
  }
  return Object.freeze({
    schemaVersion: RESPONSE_ROUTE_JEV_SCHEMA_VERSION,
    workspaceId: identifier(input.workspaceId, "workspace_id"),
    eventId: identifier(input.eventId, "event_id"),
    threadKey: identifier(input.threadKey, "thread_key"),
    executionId: identifier(input.executionId, "execution_id"),
    currentRoute: Object.freeze({
      decision: route.decision as SlackResponseRoute["decision"],
      reason: route.reason as SlackResponseRoute["reason"],
    }),
    jev: validateJevJudgment(input.jev),
    recordedAt: timestamp(input.recordedAt, "recorded_at"),
  });
}

export function createResponseRouteJevMeasurement(input: {
  workspaceId: string;
  eventId: string;
  threadKey: string;
  executionId: string;
  currentRoute: SlackResponseRoute;
  jev: RouterJevRouteJudgment;
  recordedAt?: string;
}): ResponseRouteJevMeasurement {
  return validateResponseRouteJevMeasurement({
    schemaVersion: RESPONSE_ROUTE_JEV_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    threadKey: input.threadKey,
    executionId: input.executionId,
    currentRoute: {
      decision: input.currentRoute.decision,
      reason: input.currentRoute.reason,
    },
    jev: input.jev,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  });
}

export async function persistResponseRouteJevMeasurement(
  env: Pick<Env, "ROUTER_MEASUREMENTS">,
  record: ResponseRouteJevMeasurement,
): Promise<void> {
  if (!env.ROUTER_MEASUREMENTS) return;
  const measurementDo = env.ROUTER_MEASUREMENTS.get(
    env.ROUTER_MEASUREMENTS.idFromName(record.workspaceId),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  const response = await measurementDo.fetch("https://router-measurement/response-route-jev/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    throw new Error(`response_route_jev_record_failed:${response.status}`);
  }
}

export type ScheduleRouterJevShadowInput = Readonly<{
  workspaceId?: string;
  eventId: string;
  threadKey: string;
  executionId: string;
  message: string;
  source: RouterJevRouteSource;
  channelType?: string;
  botMentioned?: boolean;
  hasFiles?: boolean;
  threadContext?: readonly string[];
  currentRoute: SlackResponseRoute;
}>;

export function scheduleRouterJevShadow(
  env: Pick<
    Env,
    "ROUTER_JEV_SHADOW" | "TYPESAFE_API_KEY" | "ROUTER_JEV_MODEL" | "ROUTER_JEV_TIMEOUT_MS" | "ROUTER_MEASUREMENTS"
  >,
  input: ScheduleRouterJevShadowInput,
  fetchImpl?: typeof fetch,
): void {
  const config = resolveRouterJevShadowConfig(env);
  if (!config.enabled || !config.apiKey) return;
  const workspaceId = input.workspaceId?.trim() || "unknown";
  void (async () => {
    const jev = await callRouterJevJudgment({
      apiKey: config.apiKey!,
      model: config.model,
      timeoutMs: config.timeoutMs,
      message: input.message,
      source: input.source,
      channelType: input.channelType,
      botMentioned: input.botMentioned,
      hasFiles: input.hasFiles,
      threadContext: input.threadContext,
      fetchImpl,
    });
    console.log(JSON.stringify({
      event: "router_jev_shadow",
      workspaceId,
      eventId: input.eventId,
      currentDecision: input.currentRoute.decision,
      jevRoute: jev.route?.choice,
      jevModel: jev.model,
      latencyMs: jev.latencyMs,
      error: jev.error,
    }));
    try {
      await persistResponseRouteJevMeasurement(env, createResponseRouteJevMeasurement({
        workspaceId,
        eventId: input.eventId,
        threadKey: input.threadKey,
        executionId: input.executionId,
        currentRoute: input.currentRoute,
        jev,
      }));
    } catch (error) {
      console.warn(
        "[router-jev] durable shadow record unavailable",
        error instanceof Error ? error.message : error,
      );
    }
  })();
}
