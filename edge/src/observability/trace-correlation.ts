/**
 * Phase-one request correlation.
 *
 * Correlation is deliberately category-level: it carries durable execution
 * identity across Worker/service boundaries, but never carries prompts,
 * query text, tokens, or provider payloads. The execution id is the trace id
 * for a turn because it is already the exact lifecycle fence used by Stop,
 * session events, and render ownership.
 */

export const TRACE_CORRELATION_SCHEMA_VERSION = 1 as const;
const MAX_FIELD_LENGTH = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type TraceComponent =
  | "slack-ingress"
  | "agent-runtime"
  | "harness"
  | "connector"
  | "knowledge"
  | "router"
  | "worker";

export type TraceCorrelation = Readonly<{
  schemaVersion: typeof TRACE_CORRELATION_SCHEMA_VERSION;
  traceId: string;
  executionId: string;
  threadKey: string;
  workspaceId?: string;
}>;

export type TraceEvent = Readonly<{
  correlation: TraceCorrelation;
  component: TraceComponent;
  event: string;
  outcome?: string;
  /** Category-level fields only; callers must not put user/provider content here. */
  attributes?: Record<string, string | number | boolean | null>;
}>;

export class TraceCorrelationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TraceCorrelationError";
  }
}

function boundedIdentifier(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FIELD_LENGTH ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new TraceCorrelationError(code);
  }
  return value;
}

function optionalIdentifier(value: unknown, code: string): string | undefined {
  return value === undefined ? undefined : boundedIdentifier(value, code);
}

export function createTraceCorrelation(input: {
  executionId: string;
  threadKey: string;
  workspaceId?: string;
}): TraceCorrelation {
  const executionId = boundedIdentifier(input.executionId, "trace_execution_id_invalid");
  const threadKey = boundedIdentifier(input.threadKey, "trace_thread_key_invalid");
  const workspaceId = optionalIdentifier(input.workspaceId, "trace_workspace_id_invalid");
  return Object.freeze({
    schemaVersion: TRACE_CORRELATION_SCHEMA_VERSION,
    traceId: executionId,
    executionId,
    threadKey,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

/** Add correlation headers without overwriting caller-owned authorization headers. */
export function withTraceHeaders(
  headers: HeadersInit | undefined,
  correlation: TraceCorrelation,
): Headers {
  const result = new Headers(headers);
  result.set("x-opentag-trace-schema", String(TRACE_CORRELATION_SCHEMA_VERSION));
  result.set("x-opentag-trace-id", correlation.traceId);
  result.set("x-opentag-execution-id", correlation.executionId);
  result.set("x-opentag-thread-key", correlation.threadKey);
  if (correlation.workspaceId) result.set("x-opentag-workspace-id", correlation.workspaceId);
  return result;
}

/** Parse only the bounded correlation headers accepted from an internal hop. */
export function traceCorrelationFromHeaders(headers: Headers): TraceCorrelation | undefined {
  const schema = headers.get("x-opentag-trace-schema");
  const traceId = headers.get("x-opentag-trace-id");
  const executionId = headers.get("x-opentag-execution-id");
  const threadKey = headers.get("x-opentag-thread-key");
  if (schema !== String(TRACE_CORRELATION_SCHEMA_VERSION) || !traceId || !executionId || !threadKey) {
    return undefined;
  }
  if (traceId !== executionId) return undefined;
  try {
    return createTraceCorrelation({
      executionId,
      threadKey,
      ...(headers.get("x-opentag-workspace-id")
        ? { workspaceId: headers.get("x-opentag-workspace-id")! }
        : {}),
    });
  } catch {
    return undefined;
  }
}

function safeAttributes(
  attributes: TraceEvent["attributes"],
): Record<string, string | number | boolean | null> | undefined {
  if (!attributes) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  const forbiddenKeys = new Set([
    "authorization", "body", "content", "credential", "message", "prompt",
    "query", "secret", "token", "transcript", "url",
  ]);
  for (const [key, value] of Object.entries(attributes)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
    if (forbiddenKeys.has(key.toLocaleLowerCase())) continue;
    if (typeof value === "string") {
      if (value.length > MAX_FIELD_LENGTH || CONTROL_RE.test(value)) continue;
      result[key] = value;
    } else if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Emit one bounded JSON line. The default sink is injectable for tests. */
export function logTraceEvent(
  event: Omit<TraceEvent, "correlation"> & { correlation: TraceCorrelation },
  sink: (line: string) => void = (line) => console.log(line),
): void {
  const payload = {
    metric: "trace_event",
    traceSchema: TRACE_CORRELATION_SCHEMA_VERSION,
    traceId: event.correlation.traceId,
    executionId: event.correlation.executionId,
    threadKey: event.correlation.threadKey,
    ...(event.correlation.workspaceId ? { workspaceId: event.correlation.workspaceId } : {}),
    component: event.component,
    event: boundedIdentifier(event.event, "trace_event_invalid"),
    ...(event.outcome ? { outcome: boundedIdentifier(event.outcome, "trace_outcome_invalid") } : {}),
    ...(safeAttributes(event.attributes) ? { attributes: safeAttributes(event.attributes) } : {}),
  };
  sink(JSON.stringify(payload));
}
