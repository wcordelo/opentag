import type { SlackRateScheduler } from "./web-api.js";
import { KNOWLEDGE_EXECUTION_BUDGETS } from "../memory/knowledge-contract.js";

export type SlackThreadMessage = {
  text?: string;
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  client_msg_id?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: unknown[];
  [key: string]: unknown;
};

export type SlackThreadPage = {
  ok: boolean;
  error?: string;
  messages?: SlackThreadMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

export type KnowledgeThreadIncompleteReason =
  | "page_cap"
  | "message_cap"
  | "byte_cap"
  | "cursor_missing"
  | "cursor_loop"
  | "slack_error"
  | "retry_exhausted"
  | "transport_error"
  | "timeout";

export type CompleteThread = {
  status: "complete";
  messages: SlackThreadMessage[];
  pages: number;
  bytes: number;
};

export type IncompleteThread = {
  status: "incomplete";
  reason: KnowledgeThreadIncompleteReason;
  cursor?: string;
  pages: number;
  messages: number;
  bytes: number;
};

export type KnowledgeThreadFetchOutcome = CompleteThread | IncompleteThread;

export type KnowledgeThreadPageReader = (args: {
  channel: string;
  threadTs: string;
  cursor?: string;
  limit: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}) => Promise<SlackThreadPage>;

export type KnowledgeThreadFetchLimits = {
  maxPages: number;
  maxMessages: number;
  maxBytes: number;
  pageSize: number;
};

export const DEFAULT_KNOWLEDGE_THREAD_LIMITS: KnowledgeThreadFetchLimits = {
  maxPages: 20,
  maxMessages: 1_000,
  maxBytes: 2_000_000,
  pageSize: 100,
};

export const MAX_KNOWLEDGE_RETRY_AFTER_MS = 10_000;
export const DEFAULT_KNOWLEDGE_THREAD_FETCH_TIMEOUT_MS =
  KNOWLEDGE_EXECUTION_BUDGETS.slackThreadFetchMs;
export const DEFAULT_KNOWLEDGE_SLACK_ATTEMPT_TIMEOUT_MS =
  KNOWLEDGE_EXECUTION_BUDGETS.slackAttemptMs;

export class KnowledgeThreadFetchError extends Error {
  constructor(readonly reason: "retry_exhausted" | "transport_error" | "timeout") {
    super(reason);
    this.name = "KnowledgeThreadFetchError";
  }
}

const encoder = new TextEncoder();

function messageBytes(message: SlackThreadMessage): number {
  return encoder.encode(JSON.stringify(message)).byteLength;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

/**
 * Fetches a complete bounded thread. Any ambiguity/cap returns `incomplete`;
 * callers therefore cannot silently normalize a partial response.
 */
export async function fetchKnowledgeThread(args: {
  channel: string;
  threadTs: string;
  readPage: KnowledgeThreadPageReader;
  limits?: Partial<KnowledgeThreadFetchLimits>;
  overallTimeoutMs?: number;
}): Promise<KnowledgeThreadFetchOutcome> {
  const limits = {
    ...DEFAULT_KNOWLEDGE_THREAD_LIMITS,
    ...args.limits,
  };
  positiveInteger(limits.maxPages, "maxPages");
  positiveInteger(limits.maxMessages, "maxMessages");
  positiveInteger(limits.maxBytes, "maxBytes");
  positiveInteger(limits.pageSize, "pageSize");
  const overallTimeoutMs = positiveInteger(
    args.overallTimeoutMs ?? DEFAULT_KNOWLEDGE_THREAD_FETCH_TIMEOUT_MS,
    "overallTimeoutMs",
  );
  const overallController = new AbortController();
  const overallDeadlineAt = Date.now() + overallTimeoutMs;
  const overallTimer = setTimeout(() => overallController.abort(), overallTimeoutMs);

  try {
    const messages: SlackThreadMessage[] = [];
    const seenTimestamps = new Set<string>();
    const seenClientIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let bytes = 0;

    for (;;) {
      if (pages >= limits.maxPages) {
        return { status: "incomplete", reason: "page_cap", cursor, pages, messages: messages.length, bytes };
      }
      let page: SlackThreadPage;
      try {
        const pagePromise = args.readPage({
          channel: args.channel,
          threadTs: args.threadTs,
          cursor,
          limit: Math.min(200, limits.pageSize),
          signal: overallController.signal,
          deadlineAt: overallDeadlineAt,
        });
        page = await Promise.race([
          pagePromise,
          new Promise<never>((_, reject) => {
            overallController.signal.addEventListener(
              "abort",
              () => reject(new KnowledgeThreadFetchError("timeout")),
              { once: true },
            );
          }),
        ]);
      } catch (error) {
        const reason = error instanceof KnowledgeThreadFetchError
          ? error.reason
          : overallController.signal.aborted
            ? "timeout"
            : "transport_error";
        return { status: "incomplete", reason, cursor, pages, messages: messages.length, bytes };
      }
      pages += 1;
      if (!page.ok || !Array.isArray(page.messages)) {
        return { status: "incomplete", reason: "slack_error", cursor, pages, messages: messages.length, bytes };
      }

      for (const message of page.messages) {
        const ts = typeof message.ts === "string" && message.ts ? message.ts : undefined;
        const clientId = typeof message.client_msg_id === "string" && message.client_msg_id
          ? message.client_msg_id
          : undefined;
        if ((ts && seenTimestamps.has(ts)) || (clientId && seenClientIds.has(clientId))) continue;
        const nextBytes = bytes + messageBytes(message);
        if (messages.length + 1 > limits.maxMessages) {
          return { status: "incomplete", reason: "message_cap", cursor, pages, messages: messages.length + 1, bytes: nextBytes };
        }
        if (nextBytes > limits.maxBytes) {
          return { status: "incomplete", reason: "byte_cap", cursor, pages, messages: messages.length + 1, bytes: nextBytes };
        }
        messages.push(message);
        bytes = nextBytes;
        if (ts) seenTimestamps.add(ts);
        if (clientId) seenClientIds.add(clientId);
      }

      const nextCursor = page.response_metadata?.next_cursor?.trim() || undefined;
      const more = page.has_more === true || nextCursor !== undefined;
      if (!more) return { status: "complete", messages, pages, bytes };
      if (!nextCursor) {
        return { status: "incomplete", reason: "cursor_missing", cursor, pages, messages: messages.length, bytes };
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        return { status: "incomplete", reason: "cursor_loop", cursor: nextCursor, pages, messages: messages.length, bytes };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } finally {
    clearTimeout(overallTimer);
  }
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after") ?? "1");
  return Math.min(
    MAX_KNOWLEDGE_RETRY_AFTER_MS,
    Math.max(1_000, Number.isFinite(seconds) ? seconds * 1_000 : 1_000),
  );
}

/** Form-urlencoded Slack page reader with bounded Retry-After handling. */
export function createSlackKnowledgePageReader(args: {
  botToken: string;
  scheduler?: SlackRateScheduler;
  maxRateLimitRetries?: number;
  perAttemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}): KnowledgeThreadPageReader {
  const fetchImpl = args.fetch ?? fetch;
  const maxRetries = args.maxRateLimitRetries ?? 2;
  const perAttemptTimeoutMs = positiveInteger(
    args.perAttemptTimeoutMs ?? DEFAULT_KNOWLEDGE_SLACK_ATTEMPT_TIMEOUT_MS,
    "perAttemptTimeoutMs",
  );
  const now = args.now ?? Date.now;
  return async ({ channel, threadTs, cursor, limit, signal, deadlineAt }) => {
    const form = new URLSearchParams({ channel, ts: threadTs, limit: String(limit) });
    if (cursor) form.set("cursor", cursor);
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted || (deadlineAt !== undefined && deadlineAt <= now())) {
        throw new KnowledgeThreadFetchError("timeout");
      }
      const attemptController = new AbortController();
      const forwardAbort = () => attemptController.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const remainingMs = deadlineAt === undefined
        ? perAttemptTimeoutMs
        : Math.min(perAttemptTimeoutMs, Math.max(1, deadlineAt - now()));
      const attemptTimer = setTimeout(() => attemptController.abort(), remainingMs);
      const cleanupAttempt = () => {
        clearTimeout(attemptTimer);
        signal?.removeEventListener("abort", forwardAbort);
      };
      let response: Response;
      try {
        const operation = () => fetchImpl("https://slack.com/api/conversations.replies", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.botToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: attemptController.signal,
        });
        response = await Promise.race([
          args.scheduler ? args.scheduler.run(channel, operation) : operation(),
          new Promise<never>((_, reject) => {
            attemptController.signal.addEventListener(
              "abort",
              () => reject(new KnowledgeThreadFetchError("timeout")),
              { once: true },
            );
          }),
        ]);
      } catch {
        cleanupAttempt();
        if (attemptController.signal.aborted || signal?.aborted) {
          throw new KnowledgeThreadFetchError("timeout");
        }
        throw new KnowledgeThreadFetchError("transport_error");
      }
      if (response.status === 429) {
        cleanupAttempt();
        if (attempt >= maxRetries) throw new KnowledgeThreadFetchError("retry_exhausted");
        const waitMs = retryAfterMs(response);
        if (signal?.aborted || (deadlineAt !== undefined && now() + waitMs > deadlineAt)) {
          throw new KnowledgeThreadFetchError("timeout");
        }
        await Promise.race([
          (args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(waitMs),
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new KnowledgeThreadFetchError("timeout")),
              { once: true },
            );
          }),
        ]);
        continue;
      }
      if (!response.ok) {
        cleanupAttempt();
        throw new KnowledgeThreadFetchError("transport_error");
      }
      try {
        return await Promise.race([
          response.json() as Promise<SlackThreadPage>,
          new Promise<never>((_, reject) => {
            attemptController.signal.addEventListener(
              "abort",
              () => reject(new KnowledgeThreadFetchError("timeout")),
              { once: true },
            );
          }),
        ]);
      } catch {
        if (attemptController.signal.aborted || signal?.aborted) {
          throw new KnowledgeThreadFetchError("timeout");
        }
        throw new KnowledgeThreadFetchError("transport_error");
      } finally {
        cleanupAttempt();
      }
    }
  };
}
