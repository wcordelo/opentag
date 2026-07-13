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
import {
  clearHarnessTurnAbort,
  registerHarnessTurnAbort,
} from "./turn-abort.js";

/** SPEC.md §3.6: transcript re-feed is truncated to 24k chars from the most recent end. */
const TRANSCRIPT_MAX_CHARS = 24_000;

export interface RunHarnessTurnArgs {
  /** Deterministic per-thread key, e.g. `slack:{channel}:{threadTs}` — also the SessionEventDO idFromName seed. */
  threadKey: string;
  /** Not part of the /turn wire body (threadKey + sessionId already identify the session) — reserved for caller-side logging/telemetry. */
  conversationKey: string;
  prompt: string;
  model?: string;
  /** `[Requester Context]` block (SPEC §5-A5 item 5) — built by the caller (agent-turn.ts). */
  requesterContext?: string;
  /** Full thread transcript for a harness restart re-feed; truncated here regardless of who built it. */
  transcript?: string;
  /** Called once per `output` event carrying a text delta (best-effort live rendering hook — unused in v1's single-final-post path, kept for a later incremental-render phase). */
  onText?: (delta: string) => void;
  /**
   * When set, reuse the execution already begun by `bot-engine.ts`
   * (`beginSessionExecution`) instead of generating a new id and calling
   * `execute()` again — keeps the render obligation and SessionEventDO slot aligned.
   */
  executionId?: string;
  /** Optional external abort (e.g. from `registerHarnessTurnAbort`). */
  signal?: AbortSignal;
}

export interface RunHarnessTurnResult {
  ok: boolean;
  text: string;
  error?: string;
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
    inputLines: string[];
  }): Promise<{ accepted: boolean; duplicate: boolean }>;
  appendEvent(args: {
    executionId: string;
    kind: "output" | "error" | "done";
    payload: unknown;
  }): Promise<{ id: number }>;
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

/** Append one event row, swallowing failures — a dead SessionEventDO must never crash the turn. */
async function safeAppend(
  sessionDo: SessionEventsFullRpc,
  executionId: string,
  kind: "output" | "error" | "done",
  payload: unknown,
): Promise<void> {
  try {
    await sessionDo.appendEvent({ executionId, kind, payload });
  } catch (err) {
    console.error(
      "[harness-client] appendEvent failed",
      kind,
      err instanceof Error ? err.message : err,
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
  const fetcher = harnessFetcher(env);
  if (!fetcher || !env.SESSION_EVENTS) {
    return { ok: false, text: "", error: "harness_unavailable" };
  }

  const sessionDo = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName(args.threadKey),
  ) as unknown as SessionEventsFullRpc;

  const signal = args.signal ?? registerHarnessTurnAbort(args.threadKey);

  try {
    const created = await sessionDo.create({
      threadKey: args.threadKey,
      harnessType: "claudecode",
      model: args.model,
    });

    const executionId = args.executionId ?? crypto.randomUUID();
    if (!args.executionId) {
      const executed = await sessionDo.execute({
        executionId,
        inputLines: [args.prompt],
      });
      if (!executed.accepted) {
        return {
          ok: false,
          text: "",
          error: executed.duplicate ? "duplicate_execution" : "execution_in_flight",
        };
      }
    }

    const body: Record<string, unknown> = {
      sessionId: created.sessionId,
      executionId,
      threadKey: args.threadKey,
      inputLines: [args.prompt],
    };
    if (args.model) body.model = args.model;
    if (args.requesterContext) body.requesterContext = args.requesterContext;
    // SPEC §3.6: the caller supplies the transcript re-feed; we truncate it
    // here regardless of whether this create() actually restarted, so a
    // caller that always passes the current transcript doesn't need to know
    // about restart semantics.
    const transcript = truncateTranscript(args.transcript);
    if (transcript) body.transcript = transcript;
    if (env.HARNESS_REPO_URL) body.repo = { url: env.HARNESS_REPO_URL };

    let accumulatedText = "";
    let sawDone = false;
    let doneOk = false;
    let doneSummary: string | undefined;

    /** Parse + mirror one NDJSON line into the event log, in order, awaited. */
    const consumeLine = async (line: string): Promise<void> => {
      let parsed: { kind?: string; payload?: unknown };
      try {
        parsed = JSON.parse(line) as { kind?: string; payload?: unknown };
      } catch {
        // Malformed line from the container — never crash the stream over it.
        console.error("[harness-client] malformed NDJSON line", line.slice(0, 200));
        return;
      }

      if (parsed.kind === "output") {
        const payload = (parsed.payload ?? {}) as {
          text?: string;
          tool?: string;
          summary?: string;
        };
        await safeAppend(sessionDo, executionId, "output", payload);
        if (typeof payload.text === "string" && payload.text) {
          accumulatedText += payload.text;
          args.onText?.(payload.text);
        }
      } else if (parsed.kind === "error") {
        await safeAppend(sessionDo, executionId, "error", parsed.payload ?? {});
      } else if (parsed.kind === "done") {
        const payload = (parsed.payload ?? {}) as { ok?: boolean; summary?: string };
        await safeAppend(sessionDo, executionId, "done", payload);
        sawDone = true;
        doneOk = payload.ok === true;
        doneSummary = payload.summary;
      }
      // Unknown kinds are ignored — forward compatibility with new event types.
    };

    try {
      const res = await fetcher({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      if (res.status === 409) {
        return { ok: false, text: "", error: "execution_in_flight" };
      }
      if (!res.ok || !res.body) {
        throw new Error(`harness /turn failed: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length > 0) {
          buffer += decoder.decode(value, { stream: true });
        }
        if (done) {
          buffer += decoder.decode(); // flush any trailing multi-byte sequence
          const rest = buffer.trim();
          if (rest) await consumeLine(rest);
          break;
        }
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) await consumeLine(line);
        }
      }
    } catch (err) {
      if (signal.aborted) {
        return { ok: false, text: accumulatedText, error: "aborted" };
      }
      const message = err instanceof Error ? err.message : String(err);
      await safeAppend(sessionDo, executionId, "error", { message });
      await safeAppend(sessionDo, executionId, "done", { ok: false, summary: message });
      return { ok: false, text: accumulatedText, error: message };
    }

    if (!sawDone) {
      // The event log must always terminate (GOAL.md never-silent house
      // rule) — synthesize the terminal events ourselves so a replay/alarm
      // recovery downstream never sees an execution stuck "executing" forever.
      const message = "harness stream ended without a done event";
      await safeAppend(sessionDo, executionId, "error", { message });
      await safeAppend(sessionDo, executionId, "done", { ok: false, summary: message });
      return { ok: false, text: accumulatedText, error: message };
    }

    return doneOk
      ? { ok: true, text: accumulatedText }
      : { ok: false, text: accumulatedText, error: doneSummary ?? "harness turn failed" };
  } finally {
    if (!args.signal) {
      clearHarnessTurnAbort(args.threadKey);
    }
  }
}
