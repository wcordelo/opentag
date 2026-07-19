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
 *              model?, repo?: { url, branch? }, requesterContext?, transcript?,
 *              codingTask?, remoteGitApproved?, createPullRequest? }
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
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  isSafeIdentifier,
  EXECUTION_BINDING_HEADER,
  requesterAttribution,
  validateRepoSpec,
  validateTurnRequest,
  validateInterruptRequest,
  type RepoPolicy,
  type RepoSpec,
  type TurnRequestBody,
  type TurnAttachment,
  type TurnValidation,
  type HarnessType,
} from "./turn-contract.js";

export {
  EXECUTION_BINDING_HEADER,
  isSafeIdentifier,
  requesterAttribution,
  validateRepoSpec,
  validateTurnRequest,
};
export type { RepoPolicy, RepoSpec, TurnRequestBody, TurnValidation };

// ---------------------------------------------------------------------------
// Config (env-overridable; sane container defaults)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8080);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORK_ROOT = process.env.WORK_ROOT || "/work";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 10 * 60_000);
// The authenticated Worker may resolve the 32 MiB staged tier to base64 before
// forwarding. 48 MiB bounds that expansion plus the rest of the turn JSON.
const MAX_BODY_BYTES = Number(process.env.HARNESS_MAX_BODY_BYTES || 48 * 1024 * 1024);
const GIT_TIMEOUT_MS = Number(process.env.HARNESS_GIT_TIMEOUT_MS || 2 * 60_000);
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 1024 * 1024;
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
// Claude runs headlessly, so interactive approval modes cannot make progress.
// `bypassPermissions` is safe only inside this boundary: a non-root container,
// one allowlisted repository/workdir, platform egress policy, guarded git/gh
// remote writes, and credentials stripped unless the request carries HITL
// approval. Keep those enforcement layers independent of the model prompt.
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE ?? "bypassPermissions";


export function repoPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RepoPolicy {
  const csv = (name: string): Set<string> =>
    new Set(
      (env[name] ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
  const hosts = csv("HARNESS_ALLOWED_REPO_HOSTS");
  if (hosts.size === 0) hosts.add("github.com");
  return { allowedHosts: hosts, allowedOrgs: csv("HARNESS_ALLOWED_REPO_ORGS") };
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

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
  gitPolicy?: string;
  attachmentPaths?: string[];
}): string {
  const sections: string[] = [];
  const context = input.requesterContext?.trim();
  if (context) sections.push(context);
  const transcript = input.transcript?.trim();
  if (transcript) sections.push(transcript);
  const gitPolicy = input.gitPolicy?.trim();
  if (gitPolicy) sections.push(gitPolicy);
  if (input.attachmentPaths?.length) {
    sections.push(`[Attachments]\n${input.attachmentPaths.map((value) => `- ${value}`).join("\n")}`);
  }
  const body = (input.inputLines ?? []).join("\n").trim();
  if (body) sections.push(body);
  return sections.join("\n\n");
}

export async function materializeTurnAttachments(
  executionHome: string,
  attachments: TurnAttachment[] | undefined,
): Promise<string[]> {
  if (!attachments?.length) return [];
  const attachmentRoot = path.join(executionHome, "attachments");
  await fs.promises.mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    if (attachment.kind !== "inline") {
      throw new Error(`staged_attachment_unresolved:${attachment.id}`);
    }
    const safeName = attachment.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "attachment";
    const target = path.join(attachmentRoot, `${index + 1}-${safeName}`);
    const bytes = Buffer.from(attachment.dataBase64, "base64");
    if (bytes.byteLength !== attachment.size) throw new Error(`attachment_size_mismatch:${attachment.id}`);
    await fs.promises.writeFile(target, bytes, { mode: 0o600 });
    paths.push(`${target} (${attachment.mimeType})`);
  }
  return paths;
}

export async function materializePermissionSnapshot(
  executionHome: string,
  snapshot: TurnRequestBody["permissionSnapshot"],
): Promise<string | undefined> {
  if (!snapshot) return undefined;
  const target = path.join(executionHome, "opentag-permissions.json");
  await fs.promises.writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}


/** Runtime instructions mirror the credential gate; the prompt alone is never the gate. */
export function gitPolicyPrompt(body: TurnRequestBody): string {
  const lines = ["[Git Policy]"];
  if (body.codingTask) {
    lines.push("This is a coding turn. Make the requested changes and commit them on the current dedicated branch before finishing.");
  }
  if (!body.remoteGitApproved) {
    lines.push("Remote git approval was NOT obtained. Do not push, create or edit pull requests, or perform any other remote git write. Remote credentials are unavailable to you.");
  } else if (body.createPullRequest) {
    lines.push("Remote git approval was obtained for this turn. Push the dedicated branch and create the requested GitHub pull request before finishing.");
    const attribution = requesterAttribution(body.requesterContext);
    if (attribution) lines.push(`The pull request body must contain this exact standalone line: ${attribution}`);
  } else {
    lines.push("Remote git approval was obtained for this turn. Remote git writes needed for the requested work are allowed.");
  }
  return lines.join("\n");
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

export function resolveSessionWorkdir(root: string, sessionId: string): string {
  if (!isSafeIdentifier(sessionId)) throw new Error("invalid sessionId");
  const resolvedRoot = path.resolve(root);
  const workdir = path.resolve(resolvedRoot, sessionId);
  if (path.dirname(workdir) !== resolvedRoot) throw new Error("unsafe session workdir");
  return workdir;
}

/**
 * A turn gets a disposable HOME outside its repository checkout. Execution
 * IDs are wire-safe and namespace-distinct from session IDs, so this cannot
 * alias a live session checkout under the shared /work root.
 */
export function resolveExecutionHome(root: string, executionId: string): string {
  if (!isSafeIdentifier(executionId)) throw new Error("invalid executionId");
  const resolvedRoot = path.resolve(root);
  const executionRoot = path.resolve(resolvedRoot, executionId);
  if (path.dirname(executionRoot) !== resolvedRoot) throw new Error("unsafe execution home");
  return path.join(executionRoot, "home");
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
  systemPromptText: string;
  permissionMode?: string;
}): string[] {
  if (!opts.systemPromptText.trim()) {
    throw new Error("authoritative system prompt is empty");
  }
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  const permissionMode = opts.permissionMode ?? CLAUDE_PERMISSION_MODE;
  if (permissionMode) args.push("--permission-mode", permissionMode);
  args.push("--append-system-prompt", opts.systemPromptText);
  args.push(opts.prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Pure logic — duplicate executionId admission (409 decision)
// ---------------------------------------------------------------------------

export interface ExecutionTracker {
  begin(executionId: string, sessionId?: string, controller?: AbortController): boolean;
  end(executionId: string): void;
  has(executionId: string): boolean;
  interrupt(sessionId: string, executionId: string): boolean;
  waitForQuiescence(
    sessionId: string,
    executionId: string,
    timeoutMs: number,
  ): Promise<boolean>;
  pendingCount(): number;
  dispose(): void;
}

export interface ExecutionTrackerOptions {
  pendingTtlMs?: number;
  maxPending?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export function createExecutionTracker(options: ExecutionTrackerOptions = {}): ExecutionTracker {
  const active = new Map<string, {
    sessionId: string;
    controller: AbortController;
    completion: Promise<void>;
    resolveCompletion: () => void;
  }>();
  const pendingInterrupts = new Map<string, number>();
  const recentlyEnded = new Map<string, number>();
  const pendingTtlMs = options.pendingTtlMs ?? 30_000;
  const maxPending = options.maxPending ?? 1024;
  const sweepIntervalMs = options.sweepIntervalMs ?? Math.min(1000, pendingTtlMs);
  const now = options.now ?? Date.now;
  const pendingKey = (sessionId: string, executionId: string): string => `${sessionId}\0${executionId}`;
  const sweep = (): void => {
    const current = now();
    for (const [key, expiresAt] of pendingInterrupts) {
      if (expiresAt <= current) pendingInterrupts.delete(key);
    }
    for (const [key, expiresAt] of recentlyEnded) {
      if (expiresAt <= current) recentlyEnded.delete(key);
    }
  };
  const sweepTimer = setInterval(sweep, Math.max(1, sweepIntervalMs));
  sweepTimer.unref();
  return {
    begin(executionId, sessionId = "", controller = new AbortController()) {
      sweep();
      const key = pendingKey(sessionId, executionId);
      const pendingUntil = pendingInterrupts.get(key);
      if (pendingUntil !== undefined) {
        pendingInterrupts.delete(key);
        if (pendingUntil > now()) return false;
      }
      if (active.has(executionId)) return false;
      recentlyEnded.delete(key);
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      active.set(executionId, {
        sessionId,
        controller,
        completion,
        resolveCompletion,
      });
      return true;
    },
    end(executionId) {
      const execution = active.get(executionId);
      execution?.resolveCompletion();
      active.delete(executionId);
      if (execution) recentlyEnded.set(pendingKey(execution.sessionId, executionId), now() + pendingTtlMs);
    },
    has(executionId) {
      return active.has(executionId);
    },
    interrupt(sessionId, executionId) {
      sweep();
      const execution = active.get(executionId);
      if (execution && execution.sessionId !== sessionId) return false;
      if (!execution) {
        const key = pendingKey(sessionId, executionId);
        // A late/repeated Stop must not poison reuse of an execution that has
        // already ended. Pending entries exist only for pre-admission reorder.
        if (recentlyEnded.has(key)) return false;
        // Covers frontend/container-start reordering. Exact and short-lived:
        // it cannot poison another execution or arbitrary future work.
        pendingInterrupts.delete(key);
        pendingInterrupts.set(key, now() + pendingTtlMs);
        while (pendingInterrupts.size > maxPending) {
          const oldest = pendingInterrupts.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          pendingInterrupts.delete(oldest);
        }
        return false;
      }
      execution.controller.abort();
      return true;
    },
    async waitForQuiescence(sessionId, executionId, timeoutMs) {
      sweep();
      const key = pendingKey(sessionId, executionId);
      const execution = active.get(executionId);
      if (execution) {
        if (execution.sessionId !== sessionId) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            execution.completion.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
              timer.unref();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      // A pre-admission tombstone is quiescent: begin() will consume it and
      // reject the exact future execution before clone/tool/write work.
      return pendingInterrupts.has(key) || recentlyEnded.has(key);
    },
    pendingCount() {
      return pendingInterrupts.size;
    },
    dispose() {
      clearInterval(sweepTimer);
      pendingInterrupts.clear();
      recentlyEnded.clear();
    },
  };
}

/** Pure decision behind the /turn 409 response. */
export function decideTurnAdmission(
  tracker: ExecutionTracker,
  executionId: string,
  sessionId?: string,
  controller?: AbortController,
): "accept" | "duplicate" {
  return tracker.begin(executionId, sessionId, controller) ? "accept" : "duplicate";
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
// Side-effecting helpers (git clone, claude --version). Process execution is
// async so the HTTP event loop can always admit an exact /interrupt.
// ---------------------------------------------------------------------------

export interface WorkdirResult {
  ok: boolean;
  branch?: string;
  error?: string;
}

export interface CloneOperations {
  execFile(file: string, args: string[], options: AsyncCommandOptions): string | void | Promise<string | void>;
}

const defaultCloneOperations: CloneOperations = {
  execFile(file, args, options) {
    return runAbortableCommand(file, args, options);
  },
};

export interface AsyncCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs?: number;
}

function abortError(): DOMException {
  return new DOMException("interrupted", "AbortError");
}

/** Async, AbortSignal-aware subprocess execution with process-group cleanup. */
export async function runAbortableCommand(
  file: string,
  args: string[],
  options: AsyncCommandOptions,
): Promise<string> {
  const { signal, timeoutMs = GIT_TIMEOUT_MS } = options;
  if (signal.aborted) throw abortError();
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform === "linux",
  });
  const terminator = createChildTerminator(child);
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  let timedOut = false;
  let outputExceeded = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) {
      outputExceeded = true;
      terminator.terminate();
    }
  });
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const onAbort = (): void => { terminator.terminate(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminator.terminate();
  }, timeoutMs);
  timeout.unref();
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      failure = error;
      resolve(null);
    });
    child.once("close", resolve);
  });
  clearTimeout(timeout);
  signal.removeEventListener("abort", onAbort);
  terminator.markExited();
  terminator.terminate();
  await terminator.waitForCleanup();
  if (signal.aborted) throw abortError();
  if (timedOut) throw new Error(`${file} timed out after ${timeoutMs}ms`);
  if (outputExceeded) throw new Error(`${file} exceeded ${MAX_COMMAND_OUTPUT_BYTES} output bytes`);
  if (failure) throw failure;
  if (code !== 0) {
    throw new Error(`${file} exited with code ${code}: ${truncateSummary(stderr.trim(), 500)}`);
  }
  return stdout.trim();
}

interface WorkdirIdentity {
  repoUrl: string;
  baseBranch: string | null;
}

const WORKDIR_IDENTITY_FILE = "opentag-workdir.json";
const MAX_WORKDIR_IDENTITY_BYTES = 4096;

interface WorkdirStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

export interface WorkdirFilesystem {
  lstat(target: string): Promise<WorkdirStat>;
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options: { recursive: true; force: true }): Promise<void>;
  writeFile(target: string, data: string, options: { mode: number }): Promise<void>;
  readIdentity(target: string, maxBytes: number, signal: AbortSignal): Promise<string>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function filesystemBoundary<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const result = await operation();
  throwIfAborted(signal);
  return result;
}

async function readBoundedFile(
  target: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const handle = await fs.promises.open(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    throwIfAborted(signal);
    const stat = await filesystemBoundary(signal, () => handle.stat());
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("invalid workdir identity");
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await filesystemBoundary(signal, () =>
        handle.read(buffer, offset, buffer.length - offset, offset),
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("workdir identity too large");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    // Closing cannot mutate session state, but is still awaited so descriptors
    // cannot accumulate across malformed identity attempts.
    await handle.close();
    throwIfAborted(signal);
  }
}

export const defaultWorkdirFilesystem: WorkdirFilesystem = {
  lstat: (target) => fs.promises.lstat(target),
  mkdir: (target, options) => fs.promises.mkdir(target, options),
  rename: (from, to) => fs.promises.rename(from, to),
  rm: (target, options) => fs.promises.rm(target, options),
  writeFile: (target, data, options) => fs.promises.writeFile(target, data, options),
  readIdentity: readBoundedFile,
};

async function optionalLstat(
  target: string,
  filesystem: WorkdirFilesystem,
  signal: AbortSignal,
): Promise<WorkdirStat | undefined> {
  try {
    return await filesystemBoundary(signal, () => filesystem.lstat(target));
  } catch (err) {
    if (signal.aborted) throw abortError();
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Detach live names before recursive removal so late cleanup can only touch quarantine. */
async function quarantineAndRemove(
  target: string,
  filesystem: WorkdirFilesystem,
  signal: AbortSignal,
): Promise<void> {
  if (!await optionalLstat(target, filesystem, signal)) return;
  const quarantine = `${target}.quarantine-${process.pid}-${randomUUID()}`;
  throwIfAborted(signal);
  try {
    await filesystem.rename(target, quarantine);
  } catch (err) {
    if (signal.aborted) throw abortError();
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  // Start cleanup before observing an abort that may have arrived with rename:
  // from this point only the unique quarantine name is ever removed.
  const cleanup = filesystem.rm(quarantine, { recursive: true, force: true });
  const abortedAfterRename = signal.aborted;
  try {
    await cleanup;
  } catch (err) {
    if (signal.aborted) throw abortError();
    throw err;
  }
  if (abortedAfterRename) throw abortError();
  throwIfAborted(signal);
}

function assertPrivateDirectory(stat: fs.Stats, target: string): void {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (expectedUid !== undefined && stat.uid !== expectedUid) ||
    (stat.mode & 0o777) !== 0o700
  ) throw new Error(`unsafe execution home component: ${target}`);
}

/** Create a fresh, non-symlinked 0700 HOME for exactly one execution. */
export async function prepareExecutionHome(
  root: string,
  executionId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const home = resolveExecutionHome(root, executionId);
  const executionRoot = path.dirname(home);
  // A crashed/recycled process may leave state behind. Detach and remove it
  // before exclusive creation; repository code can never make stale global
  // ~/.claude state authoritative for the next execution.
  await quarantineAndRemove(executionRoot, defaultWorkdirFilesystem, signal);
  try {
    throwIfAborted(signal);
    await fs.promises.mkdir(executionRoot, { mode: 0o700 });
    throwIfAborted(signal);
    await fs.promises.mkdir(home, { mode: 0o700 });
    const [executionStat, homeStat] = await Promise.all([
      fs.promises.lstat(executionRoot),
      fs.promises.lstat(home),
    ]);
    throwIfAborted(signal);
    assertPrivateDirectory(executionStat, executionRoot);
    assertPrivateDirectory(homeStat, home);
    return home;
  } catch (err) {
    try {
      await quarantineAndRemove(
        executionRoot,
        defaultWorkdirFilesystem,
        new AbortController().signal,
      );
    } catch {
      // Preserve the authoritative setup error.
    }
    throw err;
  }
}

/** Cleanup ignores a turn abort because writable config must never survive it. */
export async function cleanupExecutionHome(root: string, executionId: string): Promise<void> {
  const executionRoot = path.dirname(resolveExecutionHome(root, executionId));
  await quarantineAndRemove(
    executionRoot,
    defaultWorkdirFilesystem,
    new AbortController().signal,
  );
}

function parseWorkdirIdentity(raw: string): WorkdirIdentity {
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).repoUrl !== "string" ||
    !(
      (value as Record<string, unknown>).baseBranch === null ||
      typeof (value as Record<string, unknown>).baseBranch === "string"
    )
  ) throw new Error("invalid workdir identity");
  return value as WorkdirIdentity;
}

async function existingWorkdirMatches(
  workdir: string,
  repo: RepoSpec,
  operations: CloneOperations,
  signal: AbortSignal,
  filesystem: WorkdirFilesystem,
  executionId?: string,
): Promise<boolean> {
  try {
    throwIfAborted(signal);
    const origin = await operations.execFile(
      "/usr/bin/git",
      ["-C", workdir, "remote", "get-url", "origin"],
      { env: gitAuthenticationEnv(process.env, executionId), signal },
    );
    throwIfAborted(signal);
    if (typeof origin !== "string" || origin.trim() !== repo.url) return false;
    const identityPath = path.join(workdir, ".git", WORKDIR_IDENTITY_FILE);
    const identity = parseWorkdirIdentity(await filesystemBoundary(
      signal,
      () => filesystem.readIdentity(identityPath, MAX_WORKDIR_IDENTITY_BYTES, signal),
    ));
    if (identity.repoUrl !== repo.url || identity.baseBranch !== (repo.branch ?? null)) return false;
    if (repo.branch) {
      await operations.execFile(
        "/usr/bin/git",
        ["-C", workdir, "rev-parse", "--verify", `refs/remotes/origin/${repo.branch}`],
        { env: gitAuthenticationEnv(process.env, executionId), signal },
      );
      throwIfAborted(signal);
    }
    return true;
  } catch (err) {
    if (signal.aborted) throw err;
    return false;
  }
}

export function gitAuthenticationEnv(
  source: NodeJS.ProcessEnv,
  executionId?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: source.GIT_ASKPASS || "/usr/local/bin/opentag-git-askpass",
  };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  if (executionId) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `${EXECUTION_BINDING_HEADER}: ${executionId}`;
  }
  return env;
}

/** Clone into a disposable sibling and rename only after checkout succeeds. */
export async function ensureWorkdir(
  workdir: string,
  repo: RepoSpec,
  sessionId: string,
  operations: CloneOperations = defaultCloneOperations,
  signal: AbortSignal = new AbortController().signal,
  filesystem: WorkdirFilesystem = defaultWorkdirFilesystem,
  executionId?: string,
): Promise<WorkdirResult> {
  const branch = workBranchName(sessionId);
  const partial = `${workdir}.partial-${process.pid}-${randomUUID()}`;
  try {
    await filesystemBoundary(signal, () => filesystem.mkdir(path.dirname(workdir), { recursive: true }));
    const workdirStat = await optionalLstat(workdir, filesystem, signal);
    const gitStat = workdirStat?.isDirectory() && !workdirStat.isSymbolicLink()
      ? await optionalLstat(path.join(workdir, ".git"), filesystem, signal)
      : undefined;
    if (
      gitStat?.isDirectory() &&
      !gitStat.isSymbolicLink() &&
      await existingWorkdirMatches(workdir, repo, operations, signal, filesystem, executionId)
    ) {
      throwIfAborted(signal);
      return { ok: true, branch };
    }
    // A stale, mismatched, symlinked, or partial live path is first detached.
    await quarantineAndRemove(workdir, filesystem, signal);
    throwIfAborted(signal);
    const cloneArgs = ["clone", "--depth=1"];
    if (repo.branch) cloneArgs.push("--branch", repo.branch);
    cloneArgs.push(repo.url, partial);
    await operations.execFile("/usr/bin/git", cloneArgs, {
      env: gitAuthenticationEnv(process.env, executionId),
      signal,
    });
    throwIfAborted(signal);
    await operations.execFile("/usr/bin/git", ["-C", partial, "checkout", "-q", "-b", branch], {
      env: gitAuthenticationEnv(process.env, executionId),
      signal,
    });
    throwIfAborted(signal);
    await filesystemBoundary(signal, () => filesystem.writeFile(
      path.join(partial, ".git", WORKDIR_IDENTITY_FILE),
      `${JSON.stringify({ repoUrl: repo.url, baseBranch: repo.branch ?? null })}\n`,
      { mode: 0o600 },
    ));
    throwIfAborted(signal);
    await filesystem.rename(partial, workdir);
    // Never remove the live path if Stop lands after this atomic publication.
    throwIfAborted(signal);
    return { ok: true, branch };
  } catch (err) {
    try {
      // Cleanup is restricted to this attempt's unique, never-published name.
      await quarantineAndRemove(partial, filesystem, new AbortController().signal);
    } catch {
      // The setup error remains authoritative; future unique attempts cannot
      // collide with or publish this partial path.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface PullRequestInfo {
  body: string;
  headSha: string;
  url?: string;
}

export interface OutcomeOperations {
  execFile(
    file: string,
    args: string[],
    options: AsyncCommandOptions & { cwd: string },
  ): string | Promise<string>;
}

const defaultOutcomeOperations: OutcomeOperations = {
  execFile(file, args, options) {
    return runAbortableCommand(file, args, options);
  },
};

export interface GitBaseline {
  head: string;
  tree: string;
}

export type TurnOutcome = { ok: true; prUrl?: string } | { ok: false; error: string };

export function outcomeTerminalEvents(
  outcome: TurnOutcome,
  successSummary: string,
): NdjsonEvent[] {
  if (!outcome.ok) {
    const message = `postcondition_failed: ${outcome.error}`;
    return [
      { kind: "error", payload: { message } },
      { kind: "done", payload: { ok: false, summary: message } },
    ];
  }
  return [
    {
      kind: "done",
      payload: {
        ok: true,
        summary: outcome.prUrl ? `completed; pull request: ${outcome.prUrl}` : successSummary,
      },
    },
  ];
}

/** Mechanical postconditions; injected operations keep all unit tests offline. */
export async function verifyTurnOutcome(
  body: TurnRequestBody,
  workdir: string,
  baseline: GitBaseline | undefined,
  operations: OutcomeOperations = defaultOutcomeOperations,
  signal: AbortSignal = new AbortController().signal,
  turnEnv: NodeJS.ProcessEnv = process.env,
): Promise<TurnOutcome> {
  if (!body.codingTask) return { ok: true };
  const branch = workBranchName(body.sessionId);
  try {
    const git = async (args: string[]): Promise<string> =>
      await operations.execFile("/usr/bin/git", args, {
        cwd: workdir,
        env: gitAuthenticationEnv(turnEnv, body.executionId),
        signal,
      });
    const currentBranch = await git(["branch", "--show-current"]);
    const currentHead = await git(["rev-parse", "HEAD"]);
    const currentTree = await git(["rev-parse", "HEAD^{tree}"]);
    if (currentBranch !== branch) return { ok: false, error: `expected commit on ${branch}` };
    if (!baseline || currentHead === baseline.head) {
      return { ok: false, error: "coding turn produced no new commit" };
    }
    await git(["merge-base", "--is-ancestor", baseline.head, currentHead]);
    if (currentTree === baseline.tree) {
      return { ok: false, error: "coding turn produced no changed tree" };
    }
    if (!body.createPullRequest) return { ok: true };
    if (!body.remoteGitApproved) return { ok: false, error: "remote git was not approved" };
    const attribution = requesterAttribution(body.requesterContext);
    if (!attribution) return { ok: false, error: "requester attribution is missing" };
    if (!body.repo) return { ok: false, error: "pull request repository is missing" };
    const repoUrl = new URL(body.repo.url);
    const [owner, repoNameWithSuffix] = repoUrl.pathname.split("/").filter(Boolean);
    const repoName = repoNameWithSuffix?.replace(/\.git$/i, "");
    if (!owner || !repoName) return { ok: false, error: "pull request repository is invalid" };
    const rawPr = await operations.execFile(
      "/usr/bin/gh",
      [
        "api",
        "--method",
        "GET",
        "--header",
        `${EXECUTION_BINDING_HEADER}: ${body.executionId}`,
        `repos/${owner}/${repoName}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
      ],
      {
        cwd: workdir,
        env: { ...turnEnv, GH_PROMPT_DISABLED: "1" },
        signal,
      },
    );
    const parsedPrs = JSON.parse(rawPr) as Array<{
      body?: unknown;
      html_url?: unknown;
      head?: { ref?: unknown; sha?: unknown };
    }>;
    const parsedPr = Array.isArray(parsedPrs)
      ? parsedPrs.find((candidate) => candidate.head?.ref === branch)
      : undefined;
    const pr: PullRequestInfo | undefined = parsedPr &&
      typeof parsedPr.body === "string" && typeof parsedPr.head?.sha === "string"
        ? {
            body: parsedPr.body,
            headSha: parsedPr.head.sha,
            ...(typeof parsedPr.html_url === "string" ? { url: parsedPr.html_url } : {}),
          }
        : undefined;
    if (!pr) return { ok: false, error: `no pull request exists for ${branch}` };
    if (pr.headSha !== currentHead) {
      return { ok: false, error: "pull request head does not match the verified local commit" };
    }
    const attributionLines = pr.body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Prompted by:"));
    if (attributionLines.length !== 1 || attributionLines[0] !== attribution) {
      return { ok: false, error: `pull request body must contain exactly '${attribution}'` };
    }
    return { ok: true, ...(pr.url ? { prUrl: pr.url } : {}) };
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, error: `git outcome verification failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

let cachedClaudeVersion: Promise<string> | undefined;

async function getClaudeVersion(): Promise<string> {
  if (cachedClaudeVersion !== undefined) return cachedClaudeVersion;
  const controller = new AbortController();
  cachedClaudeVersion = runAbortableCommand(CLAUDE_BIN, ["--version"], {
    signal: controller.signal,
    timeoutMs: 5000,
  }).then((out) => out || "missing", () => "missing");
  return cachedClaudeVersion;
}

/**
 * Reads the image-owned prompt on every turn. A missing, non-regular,
 * oversized, or empty prompt is an authoritative setup failure: callers must
 * not start Claude without these instructions.
 */
export async function loadAuthoritativeSystemPrompt(
  target: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("invalid system prompt size limit");
  }
  const text = await readBoundedFile(target, maxBytes, signal);
  if (!text.trim()) throw new Error("system prompt is empty");
  return text;
}

export function buildClaudeEnv(
  source: NodeJS.ProcessEnv,
  model?: string,
  _remoteGitApproved = false,
  repo?: RepoSpec,
  sessionId?: string,
  executionId?: string,
  executionHome?: string,
  permissionsFile?: string,
  harnessType: HarnessType = "claudecode",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = gitAuthenticationEnv(source);
  // Repository-controlled code receives only obvious sentinels. Real Anthropic,
  // GitHub, OAuth, and frontend bearer credentials exist solely in the trusted
  // Worker outbound handlers and can never be read from /proc or child env.
  delete env.HARNESS_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDEX_AUTH_TOKEN;
  delete env.OPENTAG_REMOTE_GIT_APPROVED;
  delete env.OPENTAG_EXECUTION_ID;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  env.ANTHROPIC_API_KEY = "opentag-egress-injected-not-a-secret";
  env.GITHUB_TOKEN = "opentag-egress-injected-not-a-secret";
  env.GH_TOKEN = "opentag-egress-injected-not-a-secret";
  if (executionHome) {
    // Do not inherit any writable global user/config location. Claude and all
    // of its tool descendants share only this execution-scoped HOME, which is
    // quarantined and removed after terminal outcome verification.
    env.HOME = executionHome;
    env.USERPROFILE = executionHome;
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    env.XDG_CONFIG_HOME = path.join(executionHome, ".config");
    env.XDG_CACHE_HOME = path.join(executionHome, ".cache");
    env.XDG_DATA_HOME = path.join(executionHome, ".local", "share");
    env.CLAUDE_CONFIG_DIR = path.join(executionHome, ".claude");
  }
  if (harnessType === "claudex") {
    const baseUrl = normalizeClaudexProxyUrl(source.CLAUDEX_PROXY_URL);
    if (!baseUrl) throw new Error("claudex requires a valid CLAUDEX_PROXY_URL");
    const claudexModel = model || source.CLAUDEX_MODEL || "gpt-5.6-sol";
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = "opentag-egress-injected-not-a-secret";
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = claudexModel;
    env.CLAUDE_CODE_SUBAGENT_MODEL = claudexModel;
    env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1";
    env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = "3";
    env.ENABLE_TOOL_SEARCH = "false";
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (repo) {
    const url = new URL(repo.url);
    env.OPENTAG_REPO_SLUG = url.pathname.replace(/^\//, "").replace(/\.git$/i, "");
  }
  if (sessionId) env.OPENTAG_WORK_BRANCH = workBranchName(sessionId);
  if (executionId) {
    env.OPENTAG_EXECUTION_ID = executionId;
    // Git's per-process configuration propagates the exact execution binding
    // to smart-HTTP descendants without persisting it in repository config.
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `${EXECUTION_BINDING_HEADER}: ${executionId}`;
  }
  if (model) env.CLAUDE_MODEL = model;
  if (permissionsFile) env.OPENTAG_PERMISSIONS_FILE = permissionsFile;
  else delete env.OPENTAG_PERMISSIONS_FILE;
  return env;
}

/** HTTPS in production; loopback HTTP is accepted only for local CLIProxyAPI development. */
export function normalizeClaudexProxyUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(new BodyTooLargeError("request body too large"));
      return;
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.off("data", onData);
        req.resume();
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
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

export function hasValidBearerToken(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export interface ChildTerminator {
  terminate(): boolean;
  markExited(): void;
  waitForCleanup(): Promise<void>;
}

export interface ProcessGroupOperations {
  platform: NodeJS.Platform;
  kill(pid: number, signal: NodeJS.Signals): void;
}

const defaultProcessGroupOperations: ProcessGroupOperations = {
  platform: process.platform,
  kill(pid, signal) {
    process.kill(pid, signal);
  },
};

/** Idempotent graceful termination with one bounded SIGKILL escalation. */
export function createChildTerminator(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  graceMs = 5000,
  processGroups: ProcessGroupOperations = defaultProcessGroupOperations,
): ChildTerminator {
  let requested = false;
  let leaderExited = false;
  let cleanupFinished = false;
  let escalation: NodeJS.Timeout | undefined;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const finish = (): void => {
    if (cleanupFinished) return;
    cleanupFinished = true;
    if (escalation) clearTimeout(escalation);
    finishCleanup();
  };
  const signal = (value: NodeJS.Signals): boolean => {
    if (processGroups.platform === "linux" && typeof child.pid === "number" && child.pid > 0) {
      try {
        processGroups.kill(-child.pid, value);
        return true;
      } catch (err) {
        // ESRCH means the group already exited; anything else is unexpected.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        return false;
      }
    }
    // ChildProcess.kill() addresses a PID, not an owned process handle. Never
    // call it after exit, when that PID could already belong to another process.
    return leaderExited ? false : child.kill(value);
  };
  return {
    terminate() {
      if (requested) return false;
      requested = true;
      if (!signal("SIGTERM")) {
        finish();
        return true;
      }
      escalation = setTimeout(() => {
        if (!cleanupFinished) {
          signal("SIGKILL");
          finish();
        }
      }, graceMs);
      escalation.unref();
      return true;
    },
    markExited() {
      leaderExited = true;
      // A detached Linux leader can leave descendants in its process group.
      // Their lifecycle ends only after terminate() has swept that group.
      if (processGroups.platform !== "linux") finish();
      else if (requested && !signal("SIGTERM")) finish();
    },
    waitForCleanup() {
      return cleanup;
    },
  };
}

export function buildClaudeSpawnOptions(
  workdir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"] } {
  return {
    cwd: workdir,
    env,
    // Both Claude modes receive their prompt as argv. Closing stdin prevents a
    // headless CLI from waiting for piped input (the production Claude smoke
    // test exposed this exact failure mode).
    stdio: ["ignore", "pipe", "pipe"],
    // On Linux Claude leads a process group, allowing abort/timeout to reach
    // every tool descendant via a negative PGID.
    detached: platform === "linux",
  };
}

/**
 * Runs one turn, writing NDJSON events to `res` as they happen. Never
 * throws — every failure path (clone failure, spawn failure, non-zero exit,
 * timeout) resolves after writing its own terminal `done` event, per the
 * never-silent contract (GOAL.md house rule 3 / this file's mission).
 */
export async function runTurnStreaming(
  body: TurnRequestBody,
  res: http.ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  let doneWritten = false;
  let deferTerminalUntilHomeCleanup = false;
  let deferredTerminal: Extract<NdjsonEvent, { kind: "done" }> | undefined;
  const emit = (event: NdjsonEvent): void => {
    if (doneWritten) return;
    if (signal.aborted && event.kind !== "done") return;
    if (event.kind === "done" && event.payload.ok && signal.aborted) {
      event = { kind: "done", payload: { ok: false, summary: "interrupted" } };
    }
    if (event.kind === "done" && deferTerminalUntilHomeCleanup) {
      deferredTerminal = event;
      doneWritten = true;
      return;
    }
    writeNdjson(res, event);
    if (event.kind === "done") doneWritten = true;
  };
  const emitInterrupted = (): void => {
    emit({ kind: "done", payload: { ok: false, summary: "interrupted" } });
  };

  if (signal.aborted) { emitInterrupted(); return; }
  const workdir = resolveSessionWorkdir(WORK_ROOT, body.sessionId);
  let baseline: GitBaseline | undefined;

  if (body.repo) {
    const cloneResult = await ensureWorkdir(
      workdir,
      body.repo,
      body.sessionId,
      defaultCloneOperations,
      signal,
      defaultWorkdirFilesystem,
      body.executionId,
    );
    if (signal.aborted) { emitInterrupted(); return; }
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
      const stat = await optionalLstat(workdir, defaultWorkdirFilesystem, signal);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
        await quarantineAndRemove(workdir, defaultWorkdirFilesystem, signal);
      }
      await filesystemBoundary(
        signal,
        () => defaultWorkdirFilesystem.mkdir(workdir, { recursive: true }),
      );
    } catch (err) {
      if (signal.aborted) { emitInterrupted(); return; }
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
  if (signal.aborted) { emitInterrupted(); return; }

  if (body.codingTask) {
    try {
      const readRevision = (revision: string): Promise<string> =>
        runAbortableCommand("/usr/bin/git", ["rev-parse", revision], {
          cwd: workdir,
          signal,
          timeoutMs: GIT_TIMEOUT_MS,
          env: gitAuthenticationEnv(process.env, body.executionId),
        });
      baseline = { head: await readRevision("HEAD"), tree: await readRevision("HEAD^{tree}") };
    } catch {
      if (signal.aborted) { emitInterrupted(); return; }
      emit({ kind: "error", payload: { message: "coding workdir has no baseline commit" } });
      emit({ kind: "done", payload: { ok: false, summary: "coding workdir invalid" } });
      return;
    }
  }

  let systemPromptText: string;
  try {
    systemPromptText = await loadAuthoritativeSystemPrompt(
      SYSTEM_PROMPT_PATH,
      MAX_SYSTEM_PROMPT_BYTES,
      signal,
    );
  } catch (err) {
    if (signal.aborted) {
      emitInterrupted();
      return;
    }
    emit({
      kind: "error",
      payload: {
        message: `system prompt setup failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    emit({ kind: "done", payload: { ok: false, summary: "system prompt unavailable" } });
    return;
  }
  throwIfAborted(signal);

  let executionHome: string;
  try {
    executionHome = await prepareExecutionHome(WORK_ROOT, body.executionId, signal);
  } catch (err) {
    if (signal.aborted) { emitInterrupted(); return; }
    emit({
      kind: "error",
      payload: {
        message: `execution home setup failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    emit({ kind: "done", payload: { ok: false, summary: "execution home unavailable" } });
    return;
  }

  let attachmentPaths: string[];
  let permissionsFile: string | undefined;
  try {
    attachmentPaths = await materializeTurnAttachments(executionHome, body.attachments);
    permissionsFile = await materializePermissionSnapshot(
      executionHome,
      body.permissionSnapshot,
    );
  } catch (err) {
    try { await cleanupExecutionHome(WORK_ROOT, body.executionId); } catch { /* next setup reports */ }
    emit({ kind: "error", payload: { message: err instanceof Error ? err.message : String(err) } });
    emit({ kind: "done", payload: { ok: false, summary: "attachment setup failed" } });
    return;
  }
  const prompt = assemblePrompt({
    requesterContext: body.requesterContext,
    transcript: body.transcript,
    gitPolicy: gitPolicyPrompt(body),
    inputLines: body.inputLines,
    attachmentPaths,
  });
  const harnessType: HarnessType = body.harnessType ?? "claudecode";
  const effectiveModel = harnessType === "claudex"
    ? body.model || process.env.CLAUDEX_MODEL || "gpt-5.6-sol"
    : body.model;
  const agentLabel = harnessType === "claudex" ? "claudex" : "claude";
  const args = buildClaudeArgs({ prompt, model: effectiveModel, systemPromptText });

  let env: NodeJS.ProcessEnv;
  try {
    env = buildClaudeEnv(
      process.env,
      effectiveModel,
      body.remoteGitApproved === true,
      body.repo,
      body.sessionId,
      body.executionId,
      executionHome,
      permissionsFile,
      harnessType,
    );
  } catch (err) {
    try { await cleanupExecutionHome(WORK_ROOT, body.executionId); } catch { /* reported by setup next turn */ }
    emit({ kind: "error", payload: { message: err instanceof Error ? err.message : String(err) } });
    emit({ kind: "done", payload: { ok: false, summary: "claudex setup failed" } });
    return;
  }
  let agentResult: Extract<NdjsonEvent, { kind: "done" }> | undefined;

  let child: ReturnType<typeof spawn>;
  try {
    throwIfAborted(signal);
    child = spawn(CLAUDE_BIN, args, buildClaudeSpawnOptions(workdir, env));
  } catch (err) {
    try { await cleanupExecutionHome(WORK_ROOT, body.executionId); } catch { /* reported by setup next turn */ }
    if (signal.aborted) { emitInterrupted(); return; }
    emit({
      kind: "error",
      payload: {
        message: `failed to start ${agentLabel}: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    emit({ kind: "done", payload: { ok: false, summary: `failed to start ${agentLabel}` } });
    return;
  }
  // Once repository-controlled code starts, hold the terminal frame until its
  // writable HOME has been quarantined and removed. This closes the lifecycle
  // race where a client could observe done and recycle the container first.
  deferTerminalUntilHomeCleanup = true;

  let terminalFailure: string | undefined;
  const terminator = createChildTerminator(child);
  const abortChild = (): void => {
    terminalFailure = "interrupted";
    terminator.terminate();
  };
  signal.addEventListener("abort", abortChild, { once: true });
  if (signal.aborted) abortChild();

  // `exit` is earlier than `close`: descendants can inherit Claude's stdio and
  // keep `close` pending. Sweep the detached group as soon as its leader exits.
  child.once("exit", () => {
    terminator.markExited();
    terminator.terminate();
  });

  const timeout = setTimeout(() => {
    terminalFailure = "turn timed out";
    emit({
      kind: "error",
      payload: { message: `turn timed out after ${TURN_TIMEOUT_MS}ms` },
    });
    terminator.terminate();
  }, TURN_TIMEOUT_MS);
  timeout.unref();

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const event of mapStreamJsonLine(line)) {
        // A successful terminal event is held until git/PR postconditions pass.
        if (event.kind === "done") agentResult = event;
        else emit(event);
      }
    });
  }

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  await new Promise<void>((resolve) => {
    child.on("error", async (err) => {
      clearTimeout(timeout);
      terminator.markExited();
      terminator.terminate();
      await terminator.waitForCleanup();
      signal.removeEventListener("abort", abortChild);
      emit({ kind: "error", payload: { message: `${agentLabel} process error: ${err.message}` } });
      emit({ kind: "done", payload: { ok: false, summary: `${agentLabel} process error` } });
      resolve();
    });
    child.on("close", async (code) => {
      clearTimeout(timeout);
      terminator.markExited();
      terminator.terminate();
      await terminator.waitForCleanup();
      signal.removeEventListener("abort", abortChild);
      if (!doneWritten) {
        if (terminalFailure) {
          emit({ kind: "done", payload: { ok: false, summary: terminalFailure } });
        } else if (code !== 0) {
          emit({
            kind: "error",
            payload: {
              message: `${agentLabel} exited with code ${code}: ${truncateSummary(stderrTail, 500)}`,
            },
          });
        }
        if (!terminalFailure && !signal.aborted && code === 0 && agentResult?.payload.ok !== false) {
          let outcome: TurnOutcome;
          try {
            outcome = await verifyTurnOutcome(
              body,
              workdir,
              baseline,
              defaultOutcomeOperations,
              signal,
              env,
            );
          } catch {
            emitInterrupted();
            resolve();
            return;
          }
          // Give an already-arrived /interrupt request one event-loop turn to
          // run before the success gate. No await occurs after this check.
          await new Promise<void>((next) => setImmediate(next));
          if (signal.aborted) {
            emitInterrupted();
            resolve();
            return;
          }
          for (const event of outcomeTerminalEvents(
            outcome,
            agentResult?.payload.summary ?? "completed without an explicit result event",
          )) emit(event);
        } else if (!terminalFailure) {
          emit({
            kind: "done",
            payload: {
              ok: false,
              summary: agentResult?.payload.summary ?? `process exited with code ${code}`,
            },
          });
        }
      }
      resolve();
    });
  });
  let cleanupFailure: unknown;
  try {
    await cleanupExecutionHome(WORK_ROOT, body.executionId);
  } catch (err) {
    cleanupFailure = err;
    console.error("execution home cleanup failed", err);
  }
  deferTerminalUntilHomeCleanup = false;
  if (cleanupFailure) {
    writeNdjson(res, {
      kind: "error",
      payload: {
        message: `execution home cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
      },
    });
    writeNdjson(res, { kind: "done", payload: { ok: false, summary: "execution home cleanup failed" } });
  } else if (deferredTerminal) {
    writeNdjson(res, deferredTerminal);
  }
}

interface ServerContext {
  executionTracker: ExecutionTracker;
  sessionQueue: SessionQueue;
  authToken: string | undefined;
  maxBodyBytes: number;
  repoPolicy: RepoPolicy;
  runTurn: typeof runTurnStreaming;
  interruptWaitMs: number;
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
      claudeCode: await getClaudeVersion(),
    });
    return;
  }

  if (url.pathname === "/interrupt" && req.method === "POST") {
    if (!ctx.authToken) {
      sendJson(res, 503, { error: "harness_auth_not_configured" });
      return;
    }
    const authorization = req.headers.authorization;
    if (!hasValidBearerToken(Array.isArray(authorization) ? authorization[0] : authorization, ctx.authToken)) {
      res.setHeader("www-authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, ctx.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "body_too_large" });
        return;
      }
      throw err;
    }
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { sendJson(res, 400, { error: "invalid_json" }); return; }
    const validation = validateInterruptRequest(body);
    if (!validation.ok) { sendJson(res, 400, { error: validation.error }); return; }
    const interrupted = ctx.executionTracker.interrupt(
      validation.body.sessionId,
      validation.body.executionId,
    );
    const quiescent = await ctx.executionTracker.waitForQuiescence(
      validation.body.sessionId,
      validation.body.executionId,
      ctx.interruptWaitMs,
    );
    if (!quiescent) {
      sendJson(res, 503, { error: "interrupt_quiescence_timeout" });
      return;
    }
    sendJson(res, 200, { interrupted });
    return;
  }

  if (url.pathname === "/turn" && req.method === "POST") {
    if (!ctx.authToken) {
      sendJson(res, 503, { error: "harness_auth_not_configured" });
      return;
    }
    const authorization = req.headers.authorization;
    if (!hasValidBearerToken(Array.isArray(authorization) ? authorization[0] : authorization, ctx.authToken)) {
      res.setHeader("www-authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, ctx.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "body_too_large" });
        return;
      }
      throw err;
    }
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const validation = validateTurnRequest(body, ctx.repoPolicy);
    if (!validation.ok) {
      sendJson(res, 400, { error: validation.error });
      return;
    }
    const turnBody = validation.body;

    const abortController = new AbortController();
    if (decideTurnAdmission(
      ctx.executionTracker,
      turnBody.executionId,
      turnBody.sessionId,
      abortController,
    ) === "duplicate") {
      sendJson(res, 409, { error: "execution_in_flight" });
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const abort = (): void => abortController.abort();
    const abortOnResponseClose = (): void => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", abortOnResponseClose);
    try {
      await ctx.sessionQueue.run(turnBody.sessionId, async () => {
        if (abortController.signal.aborted) return;
        await ctx.runTurn(turnBody, res, abortController.signal);
      });
    } finally {
      req.off("aborted", abort);
      res.off("close", abortOnResponseClose);
      ctx.executionTracker.end(turnBody.executionId);
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

export interface HarnessServerOptions {
  /** null explicitly exercises/configures fail-closed mode; undefined reads the environment. */
  authToken?: string | null;
  maxBodyBytes?: number;
  repoPolicy?: RepoPolicy;
  runTurn?: typeof runTurnStreaming;
  /** Bounded exact-execution quiescence wait; injectable for tests. */
  interruptWaitMs?: number;
}

export function createHarnessServer(options: HarnessServerOptions = {}): http.Server {
  const ctx: ServerContext = {
    executionTracker: createExecutionTracker(),
    sessionQueue: createSessionQueue(),
    authToken: options.authToken === null ? undefined : (options.authToken ?? process.env.HARNESS_AUTH_TOKEN),
    maxBodyBytes:
      Number.isFinite(options.maxBodyBytes ?? MAX_BODY_BYTES) && (options.maxBodyBytes ?? MAX_BODY_BYTES) > 0
        ? (options.maxBodyBytes ?? MAX_BODY_BYTES)
        : 1024 * 1024,
    repoPolicy: options.repoPolicy ?? repoPolicyFromEnv(),
    runTurn: options.runTurn ?? runTurnStreaming,
    interruptWaitMs: options.interruptWaitMs ?? 30_000,
  };
  const server = http.createServer((req, res) => {
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
  server.once("close", () => ctx.executionTracker.dispose());
  return server;
}

function startServer(): void {
  const server = createHarnessServer();
  server.listen(PORT, () => {
    console.log(`opentag-harness listening on :${PORT}`);
  });
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
      if (error) {
        console.error("opentag-harness shutdown failed", error);
        process.exitCode = 1;
      }
    });
    const forceClose = setTimeout(() => server.closeAllConnections(), 5000);
    forceClose.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
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
