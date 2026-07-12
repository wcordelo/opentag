/**
 * harness-server.ts — HTTP shim that runs INSIDE the Claude Code harness
 * container (containers/harness/Dockerfile), plain Node — NOT a Cloudflare
 * Worker. GOAL.md Phase A5 / SPEC.md §4.4 + §5 Phase A5.
 *
 * Pinned wire contract (the edge half — `edge/src/harness/client.ts` — codes
 * against this exactly; do not change field names without updating both
 * sides):
 *   GET  /health
 *     -> { ok: true, service: "opentag-harness", claudeCode: "<version|missing>" }
 *   POST /turn
 *     body: { sessionId, executionId, threadKey, inputLines: string[],
 *              model?, repo?: { url, branch? }, requesterContext?, transcript? }
 *     response: Content-Type: application/x-ndjson, one JSON object per line,
 *       streamed as they happen:
 *         {"kind":"output","payload":{"text":"…"}}
 *         {"kind":"output","payload":{"tool":"…","summary":"…"}}
 *         {"kind":"error","payload":{"message":"…"}}
 *         {"kind":"done","payload":{"ok":boolean,"summary":"…"}}   (ALWAYS last)
 *     Duplicate in-flight executionId -> HTTP 409 {"error":"execution_in_flight"}
 *
 * Structure: every function needed to reason about correctness without a
 * running container (event mapping, prompt assembly, the done-always-last
 * invariant, execution admission, argv construction) is a pure, exported
 * function — see edge/test/harness-server.test.ts. Side-effecting pieces
 * (spawning `claude`, git clone, the actual http.Server) are thin wrappers
 * around those pure functions and are exercised only via Docker/manual
 * testing (out of scope here — see the mission report).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config (env-overridable; sane container defaults)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8080);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORK_ROOT = process.env.WORK_ROOT || "/work";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 10 * 60_000);
const SYSTEM_PROMPT_PATH =
  process.env.SYSTEM_PROMPT_PATH || "/opt/harness/SYSTEM_PROMPT.md";
/**
 * Headless turns have no human present to approve tool calls, so a turn that
 * needs to touch the filesystem would otherwise hang until TURN_TIMEOUT_MS.
 * Not literally spelled out in the /turn wire contract, but required for the
 * container to do anything beyond chat — see the mission report's deviations
 * section. Settable to "" to disable (falls back to interactive prompting,
 * which will just time out — useful only for debugging the CLI itself).
 */
const CLAUDE_PERMISSION_MODE =
  process.env.CLAUDE_PERMISSION_MODE ?? "bypassPermissions";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface RepoSpec {
  url: string;
  branch?: string;
}

export interface TurnRequestBody {
  sessionId: string;
  executionId: string;
  threadKey: string;
  inputLines: string[];
  model?: string;
  repo?: RepoSpec;
  requesterContext?: string;
  transcript?: string;
}

export type NdjsonEvent =
  | { kind: "output"; payload: { text: string } }
  | { kind: "output"; payload: { tool: string; summary: string } }
  | { kind: "error"; payload: { message: string } }
  | { kind: "done"; payload: { ok: boolean; summary: string } };

// ---------------------------------------------------------------------------
// Pure helpers — prompt assembly
// ---------------------------------------------------------------------------

/**
 * Builds the text handed to `claude -p`. Order: requester context, then the
 * harness-restart transcript re-feed, then the turn's own input lines — each
 * section separated by a blank line, empty/whitespace-only sections dropped.
 */
export function assemblePrompt(input: {
  requesterContext?: string;
  transcript?: string;
  inputLines: string[];
}): string {
  const sections: string[] = [];
  const context = input.requesterContext?.trim();
  if (context) sections.push(context);
  const transcript = input.transcript?.trim();
  if (transcript) sections.push(transcript);
  const body = (input.inputLines ?? []).join("\n").trim();
  if (body) sections.push(body);
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Pure helpers — misc formatting
// ---------------------------------------------------------------------------

export function truncateSummary(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, maxLen);
  return `${text.slice(0, maxLen - 1)}…`;
}

/** Short human-readable summary for a tool_use content block's input. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return name;
  const record = input as Record<string, unknown>;
  const preferredKeys = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return `${name}: ${truncateSummary(value.trim(), 120)}`;
    }
  }
  return name;
}

/** `opentag/session-<sessionId-prefix>` — see centaur's git-branch.sh pattern. */
export function workBranchName(sessionId: string): string {
  const prefix = sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "session";
  return `opentag/session-${prefix}`;
}

// ---------------------------------------------------------------------------
// Pure helpers — claude-code stream-json -> NDJSON event mapping
// ---------------------------------------------------------------------------

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    content?: ClaudeContentBlock[];
  };
}

/**
 * Maps ONE line of `claude -p --output-format stream-json --verbose` output
 * to zero or more NDJSON events. Deviation from a literal token-by-token
 * "delta": without `--include-partial-messages` (not requested by the pinned
 * claude invocation), `assistant` events carry whole content blocks, so each
 * text block becomes one output event rather than a token stream — still
 * incremental (block-by-block), just coarser. See mission report.
 *
 * Malformed JSON and event types we don't surface (`system` init, `user`
 * tool-result echoes) both map to `[]` — never throws, so one bad line never
 * takes down a turn.
 */
export function mapStreamJsonLine(rawLine: string): NdjsonEvent[] {
  const line = rawLine.trim();
  if (!line) return [];

  let parsed: ClaudeStreamLine;
  try {
    parsed = JSON.parse(line) as ClaudeStreamLine;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  switch (parsed.type) {
    case "assistant": {
      const blocks = parsed.message?.content ?? [];
      const events: NdjsonEvent[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          events.push({ kind: "output", payload: { text: block.text } });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          events.push({
            kind: "output",
            payload: {
              tool: block.name,
              summary: summarizeToolInput(block.name, block.input),
            },
          });
        }
        // "thinking" blocks and anything else are intentionally not surfaced.
      }
      return events;
    }
    case "result": {
      const ok = parsed.is_error !== true;
      const summary =
        typeof parsed.result === "string" && parsed.result
          ? parsed.result
          : (parsed.subtype ?? (ok ? "completed" : "failed"));
      return [{ kind: "done", payload: { ok, summary: truncateSummary(summary, 500) } }];
    }
    case "system":
    case "user":
    default:
      return [];
  }
}

/**
 * Enforces "done is ALWAYS the final line, and exactly once": if the mapped
 * events already end in a `done`, they're returned unchanged; if a `done`
 * appears mid-stream, everything after it is dropped; if none is present,
 * a fallback `done{ok:false}` is appended. This is the pure/testable form of
 * the same invariant `runTurnStreaming`'s `emit()` enforces live.
 */
export function finalizeEvents(
  events: NdjsonEvent[],
  fallback: NdjsonEvent = {
    kind: "done",
    payload: { ok: false, summary: "No result received from Claude Code" },
  },
): NdjsonEvent[] {
  const doneIndex = events.findIndex((event) => event.kind === "done");
  if (doneIndex === -1) return [...events, fallback];
  return events.slice(0, doneIndex + 1);
}

// ---------------------------------------------------------------------------
// Pure helpers — claude argv construction
// ---------------------------------------------------------------------------

export function buildClaudeArgs(opts: {
  prompt: string;
  model?: string;
  systemPromptText?: string;
  permissionMode?: string;
}): string[] {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  const permissionMode = opts.permissionMode ?? CLAUDE_PERMISSION_MODE;
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (opts.systemPromptText && opts.systemPromptText.trim()) {
    args.push("--append-system-prompt", opts.systemPromptText);
  }
  args.push(opts.prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Pure logic — duplicate executionId admission (409 decision)
// ---------------------------------------------------------------------------

export interface ExecutionTracker {
  begin(executionId: string): boolean;
  end(executionId: string): void;
  has(executionId: string): boolean;
}

export function createExecutionTracker(): ExecutionTracker {
  const active = new Set<string>();
  return {
    begin(executionId) {
      if (active.has(executionId)) return false;
      active.add(executionId);
      return true;
    },
    end(executionId) {
      active.delete(executionId);
    },
    has(executionId) {
      return active.has(executionId);
    },
  };
}

/** Pure decision behind the /turn 409 response. */
export function decideTurnAdmission(
  tracker: ExecutionTracker,
  executionId: string,
): "accept" | "duplicate" {
  return tracker.begin(executionId) ? "accept" : "duplicate";
}

// ---------------------------------------------------------------------------
// Pure-ish logic — per-session serialization (different sessions run
// concurrently; same session's /turn calls queue behind each other)
// ---------------------------------------------------------------------------

export interface SessionQueue {
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
}

export function createSessionQueue(): SessionQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(sessionId, task) {
      const prevTail = tails.get(sessionId) ?? Promise.resolve();
      const started = prevTail.catch(() => undefined).then(() => task());
      tails.set(
        sessionId,
        started.then(
          () => undefined,
          () => undefined,
        ),
      );
      return started;
    },
  };
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (git clone, claude --version) — integration-only,
// not covered by unit tests (no Docker/git/claude binary assumed available
// in the test environment; see mission report).
// ---------------------------------------------------------------------------

export interface WorkdirResult {
  ok: boolean;
  branch?: string;
  error?: string;
}

/** `git clone --depth=1 [--branch <branch>]` into workdir, then check out the session work branch. */
export function ensureWorkdir(
  workdir: string,
  repo: RepoSpec,
  sessionId: string,
): WorkdirResult {
  const branch = workBranchName(sessionId);
  if (fs.existsSync(path.join(workdir, ".git"))) {
    return { ok: true, branch };
  }
  try {
    fs.mkdirSync(path.dirname(workdir), { recursive: true });
    const cloneArgs = ["clone", "--depth=1"];
    if (repo.branch) cloneArgs.push("--branch", repo.branch);
    cloneArgs.push(repo.url, workdir);
    execFileSync("git", cloneArgs, { stdio: "pipe" });
    execFileSync("git", ["-C", workdir, "checkout", "-q", "-b", branch], {
      stdio: "pipe",
    });
    return { ok: true, branch };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let cachedClaudeVersion: string | undefined;

function getClaudeVersion(): string {
  if (cachedClaudeVersion !== undefined) return cachedClaudeVersion;
  try {
    const out = execFileSync(CLAUDE_BIN, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    cachedClaudeVersion = out.trim() || "missing";
  } catch {
    cachedClaudeVersion = "missing";
  }
  return cachedClaudeVersion;
}

let cachedSystemPromptText: string | undefined;

function loadSystemPromptText(): string {
  if (cachedSystemPromptText !== undefined) return cachedSystemPromptText;
  try {
    cachedSystemPromptText = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  } catch {
    cachedSystemPromptText = "";
  }
  return cachedSystemPromptText;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function writeNdjson(res: http.ServerResponse, event: NdjsonEvent): void {
  res.write(`${JSON.stringify(event)}\n`);
}

function isValidTurnRequest(body: unknown): body is TurnRequestBody {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.executionId === "string" &&
    record.executionId.length > 0 &&
    typeof record.threadKey === "string" &&
    record.threadKey.length > 0 &&
    Array.isArray(record.inputLines)
  );
}

/**
 * Runs one turn, writing NDJSON events to `res` as they happen. Never
 * throws — every failure path (clone failure, spawn failure, non-zero exit,
 * timeout) resolves after writing its own terminal `done` event, per the
 * never-silent contract (GOAL.md house rule 3 / this file's mission).
 */
async function runTurnStreaming(
  body: TurnRequestBody,
  res: http.ServerResponse,
): Promise<void> {
  let doneWritten = false;
  const emit = (event: NdjsonEvent): void => {
    if (doneWritten) return;
    writeNdjson(res, event);
    if (event.kind === "done") doneWritten = true;
  };

  const workdir = path.join(WORK_ROOT, body.sessionId);

  if (body.repo) {
    const cloneResult = ensureWorkdir(workdir, body.repo, body.sessionId);
    if (!cloneResult.ok) {
      emit({
        kind: "error",
        payload: { message: `git clone failed: ${cloneResult.error ?? "unknown error"}` },
      });
      emit({ kind: "done", payload: { ok: false, summary: "workdir setup failed" } });
      return;
    }
  } else {
    try {
      fs.mkdirSync(workdir, { recursive: true });
    } catch (err) {
      emit({
        kind: "error",
        payload: {
          message: `failed to create workdir: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      emit({ kind: "done", payload: { ok: false, summary: "workdir setup failed" } });
      return;
    }
  }

  const prompt = assemblePrompt({
    requesterContext: body.requesterContext,
    transcript: body.transcript,
    inputLines: body.inputLines,
  });
  const args = buildClaudeArgs({
    prompt,
    model: body.model,
    systemPromptText: loadSystemPromptText(),
  });

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (body.model) env.CLAUDE_MODEL = body.model;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd: workdir, env });
  } catch (err) {
    emit({
      kind: "error",
      payload: {
        message: `failed to start claude: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    emit({ kind: "done", payload: { ok: false, summary: "failed to start claude" } });
    return;
  }

  const timeout = setTimeout(() => {
    emit({
      kind: "error",
      payload: { message: `turn timed out after ${TURN_TIMEOUT_MS}ms` },
    });
    emit({ kind: "done", payload: { ok: false, summary: "turn timed out" } });
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, TURN_TIMEOUT_MS);
  timeout.unref();

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const event of mapStreamJsonLine(line)) emit(event);
    });
  }

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  await new Promise<void>((resolve) => {
    child.on("error", (err) => {
      clearTimeout(timeout);
      emit({ kind: "error", payload: { message: `claude process error: ${err.message}` } });
      emit({ kind: "done", payload: { ok: false, summary: "claude process error" } });
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!doneWritten) {
        if (code !== 0) {
          emit({
            kind: "error",
            payload: {
              message: `claude exited with code ${code}: ${truncateSummary(stderrTail, 500)}`,
            },
          });
        }
        emit({
          kind: "done",
          payload: {
            ok: code === 0,
            summary:
              code === 0
                ? "completed without an explicit result event"
                : `process exited with code ${code}`,
          },
        });
      }
      resolve();
    });
  });
}

interface ServerContext {
  executionTracker: ExecutionTracker;
  sessionQueue: SessionQueue;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "opentag-harness",
      claudeCode: getClaudeVersion(),
    });
    return;
  }

  if (url.pathname === "/turn" && req.method === "POST") {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    if (!isValidTurnRequest(body)) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    if (decideTurnAdmission(ctx.executionTracker, body.executionId) === "duplicate") {
      sendJson(res, 409, { error: "execution_in_flight" });
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    try {
      await ctx.sessionQueue.run(body.sessionId, () => runTurnStreaming(body, res));
    } finally {
      ctx.executionTracker.end(body.executionId);
    }
    res.end();
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

export function createHarnessServer(): http.Server {
  const ctx: ServerContext = {
    executionTracker: createExecutionTracker(),
    sessionQueue: createSessionQueue(),
  };
  return http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.end();
      }
    });
  });
}

function startServer(): void {
  const server = createHarnessServer();
  server.listen(PORT, () => {
    console.log(`opentag-harness listening on :${PORT}`);
  });
}

// Only start listening when invoked directly (`node harness-server.js`) —
// importing this module (tests) must never bind a port as a side effect.
const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  startServer();
}
