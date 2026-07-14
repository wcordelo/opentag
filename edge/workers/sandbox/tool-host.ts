/**
 * tool-host.ts — TypeScript port of centaur's `centaur_tool_host.py` (106
 * LOC; see `~/Documents/centaur/services/sandbox/centaur_tool_host.py`).
 * GOAL.md Phase A5 / SPEC.md §4.4.
 *
 * A minimal stdin/stdout JSON bridge that shells out to a tool CLI. Keeps the
 * same tiny surface as the Python original on purpose (SPEC §4.4): the
 * container's own footprint stays small, and tools can be supplied by setting
 * OPENTAG_TOOL_BIN on the Container Worker without rebuilding this image.
 *
 * Protocol (line-delimited JSON), unchanged from centaur_tool_host.py:
 *   stdin  (per line): {"id":..., "tool":"...", "method":"...",
 *                        "arguments":{...}, "timeout_seconds":120,
 *                        "principal_id"?:"...", "token_id"?:"..."}
 *   stdout (per line):  {"type":"result","turn_id":<id>,"result":"<json>"}
 *   On start: prints "__OPENTAG_TOOL_HOST_READY" (opentag's rename of
 *   centaur's "__CENTAUR_TOOL_HOST_READY" sentinel).
 *
 * Shells out to: `${OPENTAG_TOOL_BIN} call <tool> <method> <json-args>`.
 * Node stdlib only (child_process, readline) — no npm install needed at
 * image build time.
 */
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  id?: string | number | null;
  tool: string;
  method: string;
  arguments?: unknown;
  timeout_seconds?: number;
  principal_id?: string;
  token_id?: string;
}

export interface ToolCallResponse {
  id: string | number | null;
  status: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface ToolHostResultEnvelope {
  type: "result";
  turn_id: string | number | null;
  result: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type ParsedToolCallRequest =
  | { ok: true; request: ToolCallRequest }
  | { ok: false; error: string };

/** Parses one stdin line into a {@link ToolCallRequest}, never throwing. */
export function parseToolCallRequest(rawLine: string): ParsedToolCallRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).tool !== "string" ||
    typeof (parsed as Record<string, unknown>).method !== "string"
  ) {
    return { ok: false, error: "request missing required 'tool'/'method' string fields" };
  }
  return { ok: true, request: parsed as ToolCallRequest };
}

/** Return the explicitly configured tool CLI; no phantom default is assumed. */
export function toolBinName(): string | undefined {
  return process.env.OPENTAG_TOOL_BIN?.trim() || undefined;
}

/** `<bin> call <tool> <method> <json-args>` — matches centaur_tool_host.py's argv shape. */
export function buildToolCommand(request: ToolCallRequest): { bin: string; args: string[] } {
  const bin = toolBinName();
  if (!bin) {
    throw new Error("custom tools disabled: OPENTAG_TOOL_BIN is not configured");
  }
  return {
    bin,
    args: ["call", request.tool, request.method, JSON.stringify(request.arguments ?? {})],
  };
}

export function buildResultEnvelope(response: ToolCallResponse): ToolHostResultEnvelope {
  return {
    type: "result",
    turn_id: response.id,
    result: JSON.stringify(response),
  };
}

// ---------------------------------------------------------------------------
// Side-effecting: shell out to the tool CLI with a timeout
// ---------------------------------------------------------------------------

/** Runs one tool call via `spawnSync`, capturing stdout/stderr/status/timeout — mirrors `_run_tool` in centaur_tool_host.py. */
export function runTool(request: ToolCallRequest): ToolCallResponse {
  const { bin, args } = buildToolCommand(request);
  const timeoutSeconds = Math.max(1, Math.trunc(Number(request.timeout_seconds) || 120));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (request.principal_id) env.OPENTAG_MCP_PRINCIPAL_ID = String(request.principal_id);
  if (request.token_id) env.OPENTAG_MCP_TOKEN_ID = String(request.token_id);

  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    env,
  });

  const id = request.id ?? null;

  if (result.error) {
    const isTimeout = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (isTimeout) {
      return {
        id,
        status: null,
        stdout: result.stdout ?? "",
        stderr: `${result.stderr ?? ""}\nopentag tool call timed out after ${timeoutSeconds}s`,
        timed_out: true,
      };
    }
    return {
      id,
      status: 1,
      stdout: "",
      stderr: result.error.message,
      timed_out: false,
    };
  }

  return {
    id,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timed_out: false,
  };
}

/** Parses one stdin line and produces the stdout envelope to emit — mirrors the try/except wrapper around `_run_tool`/`_emit_result` in `main()`. */
export function handleRequestLine(rawLine: string): ToolHostResultEnvelope {
  const parsed = parseToolCallRequest(rawLine);
  if (parsed.ok === false) {
    return buildResultEnvelope({
      id: null,
      status: 1,
      stdout: "",
      stderr: parsed.error,
      timed_out: false,
    });
  }
  try {
    return buildResultEnvelope(runTool(parsed.request));
  } catch (err) {
    return buildResultEnvelope({
      id: parsed.request.id ?? null,
      status: 1,
      stdout: "",
      stderr: err instanceof Error ? (err.stack ?? err.message) : String(err),
      timed_out: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const READY_SENTINEL = "__OPENTAG_TOOL_HOST_READY";

function main(): void {
  process.stdout.write(`${READY_SENTINEL}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const envelope = handleRequestLine(trimmed);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  });
}

const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
