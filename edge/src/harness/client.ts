/**
 * Harness client — talks to the Claude Code harness container (GOAL.md Phase
 * A5, SPEC.md §3.6/§4.4). This module owns the *edge* half of the pinned wire
 * contract only; the container itself (`edge/workers/sandbox/` +
 * `containers/harness/`) is a different agent's concern and ships separately.
 *
 * Wire contract (PINNED):
 *   POST /turn
 *     body: { sessionId, executionId, threadKey, inputLines: string[],
 *              model?, repo?: {url, branch?}, requesterContext?, transcript? }
 *     response: application/x-ndjson, one JSON object per line:
 *       {"kind":"output","payload":{"text":"…"}}
 *       {"kind":"output","payload":{"tool":"…","summary":"…"}}
 *       {"kind":"error","payload":{"message":"…"}}
 *       {"kind":"done","payload":{"ok":boolean,"summary":"…"}}   (terminal)
 *     Duplicate in-flight executionId → HTTP 409 {error:"execution_in_flight"}
 *   GET /health
 *
 * `SessionEventDO` (edge/src/store/session-event-do.ts) is the source of
 * truth for what happened on a thread: every NDJSON line this client reads is
 * mirrored into the event log via `appendEvent` *before* this function
 * returns, in stream order, awaited one at a time — the A2 render-obligation
 * alarm replays exactly what was appended here if the Worker isolate dies
 * mid-stream.
 */
import type { Env } from "../env.js";
import type { SessionEventsRpc } from "../store/conversation-state-do.js";
import type { PreparedAttachment } from "../slack/download-files.js";
import type { PermissionSnapshotV1 } from "../permissions/contract.js";

/** SPEC.md §3.6: transcript re-feed is truncated to 24k chars from the most recent end. */
const TRANSCRIPT_MAX_CHARS = 24_000;

export interface RunHarnessTurnArgs {
  /** Deterministic per-thread key, e.g. `slack:{channel}:{threadTs}` — also the SessionEventDO idFromName seed. */
  threadKey: string;
  /** Not part of the /turn wire body (threadKey + sessionId already identify the session) — reserved for caller-side logging/telemetry. */
  conversationKey: string;
  /** Stable identity supplied by Slack ingress; reused across redelivery. */
  executionId: string;
  /** Stable forwarded-message identity used for durable dedup. */
  forwardedMessageId: string;
  prompt: string;
  /** Bounded inline/staged attachment envelope; never flattened to omission text. */
  attachments?: PreparedAttachment[];
  /** Omitted only by legacy/internal callers; production selection is explicit. */
  harnessType?: "claudecode" | "claudex";
  model?: string;
  /** `[Requester Context]` block (SPEC §5-A5 item 5) — built by the caller (agent-turn.ts). */
  requesterContext?: string;
  /** Full thread transcript for a harness restart re-feed; truncated here regardless of who built it. */
  transcript?: string;
  /** This repo turn must produce a new commit before it can succeed. */
  codingTask?: boolean;
  /** True only after an upstream HITL approval for remote git writes. */
  remoteGitApproved?: boolean;
  /** Approved turn must push/open and verify a requester-attributed PR. */
  createPullRequest?: boolean;
  /** Redacted informational snapshot; the sandbox Worker enriches its own section. */
  permissionSnapshot?: PermissionSnapshotV1;
  /** Called once per `output` event carrying a text delta (best-effort live rendering hook — unused in v1's single-final-post path, kept for a later incremental-render phase). */
  onText?: (delta: string) => void;
}

export type HarnessFailureKind =
  | "unavailable"
  | "duplicate"
  | "concurrent"
  | "setup"
  | "auth"
  | "http"
  | "timeout"
  | "spawn_or_exit"
  | "missing_done"
  | "persistence"
  | "interrupted"
  | "postcondition"
  | "transport"
  | "harness";

export type RunHarnessTurnResult =
  | { ok: true; text: string; terminalPersisted?: true }
  | {
      ok: false;
      text: string;
      error: string;
      failureKind: HarnessFailureKind;
      interrupted?: boolean;
      terminalPersisted?: true;
    };

function failed(
  failureKind: HarnessFailureKind,
  error: string,
  text = "",
  terminalPersisted = false,
): RunHarnessTurnResult {
  return {
    ok: false,
    text,
    error,
    failureKind,
    ...(terminalPersisted ? { terminalPersisted: true as const } : {}),
    ...(failureKind === "interrupted" ? { interrupted: true } : {}),
  };
}

/** Central compatibility classifier until the pinned container protocol grows a code field. */
function classifyHarnessFailure(message: string): HarnessFailureKind {
  const normalized = message.toLowerCase();
  if (normalized.includes("postcondition_failed")) return "postcondition";
  if (
    normalized.includes("workdir") ||
    normalized.includes("git clone") ||
    normalized.includes("baseline commit")
  ) return "setup";
  if (normalized.includes("timed out") || normalized.includes("timeout")) return "timeout";
  if (
    normalized.includes("failed to start") ||
    normalized.includes("process error") ||
    normalized.includes("exited with code") ||
    normalized.includes("process exited")
  ) return "spawn_or_exit";
  return "harness";
}

/**
 * The slice of `SessionEventDO`'s RPC surface this client needs beyond the
 * `getState`/`replay` pair already typed as {@link SessionEventsRpc} in
 * `conversation-state-do.ts`. Hand-typed for the same reason that interface
 * is: Cloudflare's RPC `Provider<T>` mapped type collapses methods with
 * `payload: unknown` fields to `never`.
 */
interface SessionEventsFullRpc extends SessionEventsRpc {
  create(args: {
    threadKey: string;
    harnessType?: string;
    model?: string;
  }): Promise<{ sessionId: string; restarted: boolean }>;
  execute(args: {
    executionId: string;
    forwardedMessageId?: string;
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean; cancelled?: boolean }>;
  appendEvent(args: {
    executionId: string;
    kind: "output" | "error" | "done";
    payload: unknown;
  }): Promise<{ id: number }>;
}

class EventPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventPersistenceError";
  }
}

class ControlCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlCheckpointError";
  }
}

function truncateTranscript(transcript: string | undefined): string | undefined {
  if (!transcript) return undefined;
  if (transcript.length <= TRANSCRIPT_MAX_CHARS) return transcript;
  return transcript.slice(transcript.length - TRANSCRIPT_MAX_CHARS);
}

/**
 * Resolve how to reach the container: prefer the `HARNESS` service binding
 * (Worker→Worker via a public workers.dev URL hits CF's 1042 on the same
 * zone — same reason `bot-engine.ts` prefers `AGENT_RUNTIME` over `AGENT_URL`
 * fetch); fall back to a plain `fetch` against `HARNESS_URL`. Neither
 * configured → `undefined`, and the caller returns `harness_unavailable`
 * without throwing.
 */
function harnessFetcher(
  env: Env,
): ((init: RequestInit) => Promise<Response>) | undefined {
  const path = "/turn";
  if (env.HARNESS) {
    const url = env.HARNESS_URL
      ? new URL(path, env.HARNESS_URL).toString()
      : `https://harness${path}`;
    return (init) => env.HARNESS!.fetch(url, init);
  }
  if (env.HARNESS_URL) {
    const url = new URL(path, env.HARNESS_URL).toString();
    return (init) => fetch(url, init);
  }
  return undefined;
}

/** Authenticated exact-execution control request; safe/idempotent on misses. */
export async function interruptHarnessTurn(
  env: Env,
  args: { sessionId: string; threadKey: string; executionId: string },
): Promise<{ accepted: boolean; interrupted: boolean; approvalRevoked?: boolean }> {
  if (!env.HARNESS_AUTH_TOKEN || (!env.HARNESS && !env.HARNESS_URL)) {
    return { accepted: false, interrupted: false };
  }
  const url = env.HARNESS_URL
    ? new URL("/interrupt", env.HARNESS_URL).toString()
    : "https://harness/interrupt";
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.HARNESS_AUTH_TOKEN}`,
    },
    body: JSON.stringify(args),
  };
  const response = env.HARNESS
    ? await env.HARNESS.fetch(url, init)
    : await fetch(url, init);
  if (!response.ok) return { accepted: false, interrupted: false };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { accepted: false, interrupted: false };
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { interrupted?: unknown }).interrupted !== "boolean"
  ) {
    return { accepted: false, interrupted: false };
  }
  const result = body as {
    interrupted: boolean;
    approvalRevoked?: unknown;
  };
  return {
    accepted: true,
    interrupted: result.interrupted,
    ...(typeof result.approvalRevoked === "boolean"
      ? { approvalRevoked: result.approvalRevoked }
      : {}),
  };
}

/** Append an event durably. Callers must not expose or process it on failure. */
async function appendStrict(
  sessionDo: SessionEventsFullRpc,
  executionId: string,
  kind: "output" | "error" | "done",
  payload: unknown,
): Promise<void> {
  try {
    await sessionDo.appendEvent({ executionId, kind, payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EventPersistenceError(`${kind}: ${message}`);
  }
}

/** Record a failed terminal without ever disguising a storage failure as the original cause. */
async function persistFailure(
  sessionDo: SessionEventsFullRpc,
  executionId: string,
  failureKind: HarnessFailureKind,
  message: string,
  text: string,
): Promise<RunHarnessTurnResult> {
  let errorAppendFailure: string | undefined;
  try {
    await appendStrict(sessionDo, executionId, "error", { message });
  } catch (err) {
    errorAppendFailure = err instanceof Error ? err.message : String(err);
  }
  try {
    await appendStrict(sessionDo, executionId, "done", {
      ok: false,
      summary: message,
    });
  } catch (err) {
    return failed(
      "persistence",
      `terminal_persistence_failed: ${err instanceof Error ? err.message : String(err)}`,
      text,
      false,
    );
  }
  return errorAppendFailure
    ? failed("persistence", `event_persistence_failed: ${errorAppendFailure}`, text, true)
    : failed(failureKind, message, text, true);
}

async function interrupted(
  sessionDo: SessionEventsFullRpc,
  executionId: string,
): Promise<boolean> {
  const state = await sessionDo.getState();
  return (
    state.interruptedExecutionId === executionId ||
    (state.interrupted && state.executing?.executionId !== executionId)
  );
}

/** A control-plane read after execute() is authoritative, never best-effort. */
async function interruptedStrict(
  sessionDo: SessionEventsFullRpc,
  executionId: string,
): Promise<boolean> {
  try {
    return await interrupted(sessionDo, executionId);
  } catch (err) {
    throw new ControlCheckpointError(
      `interrupt_checkpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run one turn against the Claude Code harness container. Never throws:
 * every failure path (missing bindings, duplicate execution, fetch failure,
 * a stream that ends without a terminal `done`) resolves to
 * `{ ok: false, error }` after the event log has been given a terminal
 * `done` event of its own — the "the event log must always terminate"
 * invariant from GOAL.md's never-silent house rule.
 */
export async function runHarnessTurn(
  env: Env,
  args: RunHarnessTurnArgs,
): Promise<RunHarnessTurnResult> {
  const harnessType = args.harnessType ?? "claudecode";
  const fetcher = harnessFetcher(env);
  if (!fetcher || !env.SESSION_EVENTS || !env.HARNESS_AUTH_TOKEN) {
    return failed("unavailable", "harness_unavailable");
  }

  const sessionDo = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName(args.threadKey),
  ) as unknown as SessionEventsFullRpc;

  let created: { sessionId: string; restarted: boolean };
  try {
    created = await sessionDo.create({
      threadKey: args.threadKey,
      harnessType,
      model: args.model,
    });
  } catch (err) {
    return failed("setup", err instanceof Error ? err.message : String(err));
  }

  const executionId = args.executionId;
  let executed: { accepted: boolean; duplicate: boolean; cancelled?: boolean };
  try {
    executed = await sessionDo.execute({
      executionId,
      forwardedMessageId: args.forwardedMessageId,
      inputLines: [args.prompt],
    });
  } catch (err) {
    return failed("persistence", err instanceof Error ? err.message : String(err));
  }
  if (!executed.accepted) {
    if (executed.cancelled) return failed("interrupted", "interrupted");
    if (executed.duplicate) {
      let state: Awaited<ReturnType<SessionEventsFullRpc["getState"]>>;
      try {
        state = await sessionDo.getState();
      } catch (err) {
        return failed(
          "persistence",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (state.executing?.executionId !== executionId) {
        return failed("duplicate", "duplicate_execution");
      }
    } else {
      return failed("concurrent", "execution_in_flight");
    }
  }

  // Give a Stop that lands immediately after admission an exact durable
  // checkpoint before any container request (and therefore any repo work or
  // remote write) can begin.
  try {
    if (await interruptedStrict(sessionDo, executionId)) {
      return failed("interrupted", "interrupted");
    }
  } catch (err) {
    return failed(
      "persistence",
      `control_persistence_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body: Record<string, unknown> = {
    sessionId: created.sessionId,
    executionId,
    forwardedMessageId: args.forwardedMessageId,
    threadKey: args.threadKey,
    inputLines: [args.prompt],
    harnessType,
    remoteGitApproved: args.remoteGitApproved === true,
  };
  if (args.attachments?.length) body.attachments = args.attachments;
  if (args.model) body.model = args.model;
  if (args.requesterContext) body.requesterContext = args.requesterContext;
  // SPEC §3.6: the caller supplies the transcript re-feed; we truncate it
  // here regardless of whether this create() actually restarted, so a
  // caller that always passes the current transcript doesn't need to know
  // about restart semantics.
  const transcript = truncateTranscript(args.transcript);
  if (transcript) body.transcript = transcript;
  if (env.HARNESS_REPO_URL) body.repo = { url: env.HARNESS_REPO_URL };
  if (args.codingTask) body.codingTask = true;
  if (args.createPullRequest) body.createPullRequest = true;
  if (args.permissionSnapshot) body.permissionSnapshot = args.permissionSnapshot;

  let accumulatedText = "";
  let sawDone = false;
  let doneOk = false;
  let doneSummary: string | undefined;
  let lastHarnessError: string | undefined;

  /** Parse + mirror one NDJSON line into the event log, in order, awaited. */
  const consumeLine = async (line: string): Promise<boolean> => {
    let parsed: { kind?: string; payload?: unknown };
    try {
      parsed = JSON.parse(line) as { kind?: string; payload?: unknown };
    } catch {
      // Malformed line from the container — never crash the stream over it.
      console.error("[harness-client] malformed NDJSON line", line.slice(0, 200));
      return false;
    }

    if (parsed.kind === "output") {
      const payload = (parsed.payload ?? {}) as {
        text?: string;
        tool?: string;
        summary?: string;
      };
      await appendStrict(sessionDo, executionId, "output", payload);
      if (typeof payload.text === "string" && payload.text) {
        accumulatedText += payload.text;
        args.onText?.(payload.text);
      }
    } else if (parsed.kind === "error") {
      await appendStrict(sessionDo, executionId, "error", parsed.payload ?? {});
      const payload = (parsed.payload ?? {}) as { message?: unknown };
      if (typeof payload.message === "string") lastHarnessError = payload.message;
    } else if (parsed.kind === "done") {
      const payload = (parsed.payload ?? {}) as { ok?: boolean; summary?: string };
      // A successful result is impossible unless the terminal event is
      // durably committed. Do not swallow this append failure.
      await appendStrict(sessionDo, executionId, "done", payload);
      sawDone = true;
      doneOk = payload.ok === true;
      doneSummary = payload.summary;
      return true;
    }
    // Unknown kinds are ignored — forward compatibility with new event types.
    return false;
  };

  const abortController = new AbortController();
  try {
    const res = await fetcher({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.HARNESS_AUTH_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (res.status === 409) {
      return failed("concurrent", "execution_in_flight");
    }
    if (!res.ok || !res.body) {
      const error = `harness /turn failed: HTTP ${res.status}`;
      return persistFailure(
        sessionDo,
        executionId,
        res.status === 401 || res.status === 403 ? "auth" : "http",
        error,
        accumulatedText,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal = false;
    let pendingRead = reader.read();

    while (!terminal) {
      const read = pendingRead.then((result) => ({ type: "read" as const, result }));
      const poll = new Promise<{ type: "poll" }>((resolve) =>
        setTimeout(() => resolve({ type: "poll" }), 100),
      );
      const next = await Promise.race([read, poll]);
      if (next.type === "poll") {
        if (await interruptedStrict(sessionDo, executionId)) {
          abortController.abort();
          await reader.cancel().catch(() => undefined);
          return failed("interrupted", "interrupted", accumulatedText);
        }
        continue;
      }
      const { done, value } = next.result;
      if (!done) pendingRead = reader.read();
      if (value && value.length > 0) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        buffer += decoder.decode(); // flush any trailing multi-byte sequence
        const rest = buffer.trim();
        if (rest) terminal = await consumeLine(rest);
        break;
      }
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line && (await consumeLine(line))) {
          terminal = true;
          buffer = "";
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } catch (err) {
    // A persistence failure invalidates the stream just as surely as a
    // transport failure: stop consuming container output immediately.
    abortController.abort();
    if (err instanceof ControlCheckpointError) {
      return failed(
        "persistence",
        `control_persistence_failed: ${err.message}`,
        accumulatedText,
      );
    }
    try {
      if (await interruptedStrict(sessionDo, executionId)) {
        return failed("interrupted", "interrupted", accumulatedText);
      }
    } catch (checkpointErr) {
      return failed(
        "persistence",
        `control_persistence_failed: ${checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr)}`,
        accumulatedText,
      );
    }
    const persistenceFailure = err instanceof EventPersistenceError;
    const message = err instanceof Error ? err.message : String(err);
    return persistFailure(
      sessionDo,
      executionId,
      persistenceFailure ? "persistence" : "transport",
      persistenceFailure ? `event_persistence_failed: ${message}` : message,
      accumulatedText,
    );
  }

  if (!sawDone) {
    // The event log must always terminate (GOAL.md never-silent house
    // rule) — synthesize the terminal events ourselves so a replay/alarm
    // recovery downstream never sees an execution stuck "executing" forever.
    const message = "harness stream ended without a done event";
    return persistFailure(
      sessionDo,
      executionId,
      "missing_done",
      message,
      accumulatedText,
    );
  }

  return doneOk
    ? { ok: true, text: accumulatedText, terminalPersisted: true }
    : failed(
        classifyHarnessFailure(lastHarnessError ?? doneSummary ?? "harness turn failed"),
        lastHarnessError ?? doneSummary ?? "harness turn failed",
        accumulatedText,
        true,
      );
}
