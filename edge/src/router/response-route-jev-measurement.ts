import type { Env } from "../env.js";
import type { SlackResponseRoute } from "../slack/response-routing.js";
import { callRouterJevJudgment, type RouterJevRouteJudgment } from "./jev-route-shadow.js";
import { resolveRouterJevShadowConfig } from "./jev-route-config.js";
import type { RouterJevRouteSource } from "./jev-route-questions.js";

export const RESPONSE_ROUTE_JEV_SCHEMA_VERSION = 1 as const;
export const COMBINED_ROUTE_RULE_4A = "4a" as const;
export const COMBINED_ROUTE_MEMORY_THRESHOLD = 0.5;

export type CombinedRouteDecision = Readonly<{
  decision: SlackResponseRoute["decision"];
  rule: typeof COMBINED_ROUTE_RULE_4A;
}>;

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
  combinedRoute: CombinedRouteDecision;
  recordedAt: string;
}>;

/** Rule 4a (shadow-only): respond if Jev says respond, or router says respond and memoryNeeded >= 0.5. */
export function computeCombinedRouteRule4a(
  currentRoute: Pick<SlackResponseRoute, "decision">,
  jev: RouterJevRouteJudgment,
): CombinedRouteDecision {
  if (jev.error || !jev.route) {
    return Object.freeze({
      decision: currentRoute.decision,
      rule: COMBINED_ROUTE_RULE_4A,
    });
  }
  const respond = jev.route.choice === "respond"
    || (currentRoute.decision === "respond"
      && (jev.memoryNeeded?.noul ?? 0) >= COMBINED_ROUTE_MEMORY_THRESHOLD);
  return Object.freeze({
    decision: respond ? "respond" : "observe",
    rule: COMBINED_ROUTE_RULE_4A,
  });
}

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
  const currentRouteInput = input.currentRoute;
  if (!currentRouteInput || typeof currentRouteInput !== "object" || Array.isArray(currentRouteInput)) {
    throw new ResponseRouteJevMeasurementError("current_route_invalid");
  }
  const route = currentRouteInput as Record<string, unknown>;
  if (route.decision !== "respond" && route.decision !== "observe") {
    throw new ResponseRouteJevMeasurementError("current_route_invalid");
  }
  if (typeof route.reason !== "string" || route.reason.length === 0) {
    throw new ResponseRouteJevMeasurementError("current_route_invalid");
  }
  const jev = validateJevJudgment(input.jev);
  const currentRoute = Object.freeze({
    decision: route.decision as SlackResponseRoute["decision"],
    reason: route.reason as SlackResponseRoute["reason"],
  });
  const combinedRoute = validateCombinedRoute(input.combinedRoute, currentRoute, jev);
  return Object.freeze({
    schemaVersion: RESPONSE_ROUTE_JEV_SCHEMA_VERSION,
    workspaceId: identifier(input.workspaceId, "workspace_id"),
    eventId: identifier(input.eventId, "event_id"),
    threadKey: identifier(input.threadKey, "thread_key"),
    executionId: identifier(input.executionId, "execution_id"),
    currentRoute,
    jev,
    combinedRoute,
    recordedAt: timestamp(input.recordedAt, "recorded_at"),
  });
}

function validateCombinedRoute(
  value: unknown,
  currentRoute: Readonly<{ decision: SlackResponseRoute["decision"] }>,
  jev: RouterJevRouteJudgment,
): CombinedRouteDecision {
  const expected = computeCombinedRouteRule4a(currentRoute, jev);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return expected;
  }
  const input = value as Record<string, unknown>;
  if (
    input.rule === COMBINED_ROUTE_RULE_4A
    && (input.decision === "respond" || input.decision === "observe")
    && input.decision === expected.decision
  ) {
    return Object.freeze({
      decision: input.decision as SlackResponseRoute["decision"],
      rule: COMBINED_ROUTE_RULE_4A,
    });
  }
  throw new ResponseRouteJevMeasurementError("combined_route_invalid");
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
  const currentRoute = {
    decision: input.currentRoute.decision,
    reason: input.currentRoute.reason,
  };
  const combinedRoute = computeCombinedRouteRule4a(currentRoute, input.jev);
  return validateResponseRouteJevMeasurement({
    schemaVersion: RESPONSE_ROUTE_JEV_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    threadKey: input.threadKey,
    executionId: input.executionId,
    currentRoute,
    jev: input.jev,
    combinedRoute,
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
    const combinedRoute = computeCombinedRouteRule4a(input.currentRoute, jev);
    console.log(JSON.stringify({
      event: "router_jev_shadow",
      workspaceId,
      eventId: input.eventId,
      currentDecision: input.currentRoute.decision,
      jevRoute: jev.route?.choice,
      combinedRoute: combinedRoute.decision,
      combinedRouteRule: combinedRoute.rule,
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
