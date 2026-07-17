/**
 * Minimal Slack Web API helpers (fetch-based, no @slack/web-api / Bolt).
 */
import type { PlatformUser } from "@copilotkit/channels-ui";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { SlackRateLimitDO } from "./slack-rate-limit-do.js";

export type SlackWebClient = {
  authTest(): Promise<{ ok: boolean; userId?: string; error?: string }>;
  postMessage(args: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: unknown[];
    attachments?: unknown[];
    client_msg_id?: string;
  }): Promise<{ ok: boolean; ts?: string; error?: string; duplicate?: boolean }>;
  updateMessage(args: {
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ok: boolean; error?: string }>;
  setStatus(args: {
    channel_id: string;
    thread_ts: string;
    status: string;
    loading_messages?: string[];
  }): Promise<void>;
  setTitle(args: {
    channel_id: string;
    thread_ts: string;
    title: string;
  }): Promise<void>;
  addReaction(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<{ ok: boolean; error?: string }>;
  removeReaction(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<{ ok: boolean; error?: string }>;
  lookupUserByQuery(query: string): Promise<PlatformUser | undefined>;
  resolveUser(userId: string): Promise<PlatformUser>;
  getThreadMessages(args: {
    channel: string;
    threadTs: string;
    limit?: number;
  }): Promise<
    Array<{
      text?: string;
      ts?: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      client_msg_id?: string;
      blocks?: unknown[];
      attachments?: unknown[];
      files?: unknown[];
    }>
  >;
  /** Bounded exact lookup after an ambiguously successful placeholder post. */
  findMessageByClientMessageId(args: {
    channel: string;
    threadTs?: string;
    clientMessageId: string;
    limit?: number;
  }): Promise<{ found: boolean; ts?: string }>;
  getChannelHistory(args: {
    channel: string;
    limit?: number;
  }): Promise<
    Array<{
      text?: string;
      ts?: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      blocks?: unknown[];
      attachments?: unknown[];
      files?: unknown[];
    }>
  >;
  getFileInfo(fileId: string): Promise<{
    id?: string;
    name?: string;
    mimetype?: string;
    filetype?: string;
    url_private?: string;
    size?: number;
  } | undefined>;
};

/** A parsed Slack `ok:false` is a definitive rejection, unlike a thrown
 * transport error where the request may already have been applied. */
export class SlackApiError extends Error {
  readonly definitive = true;
  constructor(readonly method: string, readonly slackError: string) {
    super(`${method} failed: ${slackError}`);
    this.name = "SlackApiError";
  }
}

export interface SlackRateScheduler {
  run<T>(channel: string, operation: () => Promise<T>): Promise<T>;
}

export interface SlackWebClientOptions {
  /** Shared scheduler; pass one instance to every renderer in an isolate. */
  scheduler?: SlackRateScheduler;
  /** Bounded HTTP-429 retries. Defaults to two retries after the first call. */
  maxRateLimitRetries?: number;
  /** Injectable sleep seam for deterministic Retry-After tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Serializes Slack writes per channel and spaces their dispatches. The state is
 * intentionally supplied by the composition root so every renderer shares one
 * discipline instead of constructing independent stream-local timers.
 */
export class SlackChannelRateScheduler implements SlackRateScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 1_000,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async run<T>(channel: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(channel) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.catch(() => undefined).then(() => tail);
    this.tails.set(channel, queued);
    await prior.catch(() => undefined);
    try {
      const waitMs = Math.max(0, (this.nextAllowedAt.get(channel) ?? 0) - this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      this.nextAllowedAt.set(channel, this.now() + this.minIntervalMs);
      return await operation();
    } finally {
      release();
      if (this.tails.get(channel) === queued) this.tails.delete(channel);
    }
  }
}

const sharedSchedulers = new Map<string, SlackChannelRateScheduler>();

class DurableSlackRateScheduler implements SlackRateScheduler {
  constructor(
    private readonly namespace: DurableObjectNamespace<SlackRateLimitDO>,
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async run<T>(channel: string, operation: () => Promise<T>): Promise<T> {
    const stub = this.namespace.get(this.namespace.idFromName(channel)) as unknown as {
      reserve(args: { minIntervalMs: number }): Promise<{ delayMs: number }>;
    };
    const { delayMs } = await stub.reserve({ minIntervalMs: this.minIntervalMs });
    if (delayMs > 0) await this.sleep(delayMs);
    return operation();
  }
}

const durableSchedulers = new WeakMap<object, SlackRateScheduler>();

/**
 * Production uses a Durable Object reservation per channel, shared across
 * Worker isolates. The module singleton remains only a local/test fallback.
 */
export function sharedSlackRateScheduler(
  environment?: string,
  namespace?: DurableObjectNamespace<SlackRateLimitDO>,
): SlackRateScheduler {
  if (namespace) {
    let scheduler = durableSchedulers.get(namespace as object);
    if (!scheduler) {
      scheduler = new DurableSlackRateScheduler(
        namespace,
        environment === "production" ? 1_000 : 0,
      );
      durableSchedulers.set(namespace as object, scheduler);
    }
    return scheduler;
  }
  if (environment === "production") {
    throw new Error("SLACK_RATE_LIMIT is required for production Slack egress");
  }
  const key = environment === "production" ? "production" : "non-production";
  let scheduler = sharedSchedulers.get(key);
  if (!scheduler) {
    scheduler = new SlackChannelRateScheduler(key === "production" ? 1_000 : 0);
    sharedSchedulers.set(key, scheduler);
  }
  return scheduler;
}

export function retryAfterMs(response: Response): number {
  const raw = response.headers.get("Retry-After");
  if (!raw) return 1_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1_000;
}

export function isDefinitiveSlackFailure(error: unknown): boolean {
  return error instanceof SlackApiError;
}

/**
 * Best-effort GitHub handle extraction (GOAL.md Phase A5 / SPEC.md §5-A5
 * item 5). Only explicitly named `github` /
 * `github_url` profile fields are trusted; arbitrary status/profile text must
 * never establish attribution. Named fields accept URL, @handle, and plain
 * handle forms.
 */
const GITHUB_HANDLE_RE = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/|$)/i;
const PLAIN_GITHUB_HANDLE_RE = /^@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;
const GITHUB_PROFILE_FIELD_NAMES = new Set(["github", "github_url"]);

function githubHandleFromFieldValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return (
      trimmed.match(GITHUB_HANDLE_RE)?.[1] ??
      trimmed.match(PLAIN_GITHUB_HANDLE_RE)?.[1]
    );
  }
  if (value && typeof value === "object" && "value" in value) {
    return githubHandleFromFieldValue((value as { value?: unknown }).value);
  }
  return undefined;
}

function githubHandleFromNamedProfileField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  for (const [key, fieldValue] of Object.entries(value)) {
    if (GITHUB_PROFILE_FIELD_NAMES.has(key.toLowerCase())) {
      const handle = githubHandleFromFieldValue(fieldValue);
      if (handle) return handle;
    }

    if (fieldValue && typeof fieldValue === "object") {
      const field = fieldValue as Record<string, unknown>;
      const fieldName = field.name ?? field.label;
      if (
        typeof fieldName === "string" &&
        GITHUB_PROFILE_FIELD_NAMES.has(fieldName.toLowerCase())
      ) {
        const handle = githubHandleFromFieldValue(field.value);
        if (handle) return handle;
      }
    }

    const nested = githubHandleFromNamedProfileField(fieldValue);
    if (nested) return nested;
  }
  return undefined;
}

function extractGithubHandle(profile: unknown): string | undefined {
  return githubHandleFromNamedProfileField(profile);
}

function preferredSlackName(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function createSlackWebClient(
  botToken: string,
  options: SlackWebClientOptions = {},
): SlackWebClient {
  // Slack Web API: prefer form-urlencoded. JSON bodies break several methods
  // (notably users.info → user_not_found / no profile.email).
  const headers = {
    Authorization: `Bearer ${botToken}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  function encodeForm(body: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        params.set(key, String(value));
      } else {
        // blocks, attachments, etc. must be JSON strings in form bodies
        params.set(key, JSON.stringify(value));
      }
    }
    return params.toString();
  }

  async function api<T extends Record<string, unknown>>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T & { ok: boolean; error?: string }> {
    // Never pass an empty-string body: undici hangs indefinitely on POST with
    // body "" (e.g. auth.test with no args).
    const encoded = body ? encodeForm(body) : "";
    const channel = typeof body?.channel === "string"
      ? body.channel
      : typeof body?.channel_id === "string"
        ? body.channel_id
        : undefined;
    const maxRetries = options.maxRateLimitRetries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      const dispatch = async (): Promise<Response> =>
        fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers,
          body: encoded || undefined,
        });
      // Each HTTP attempt, including Retry-After replays, owns a fresh durable
      // channel slot. Reserving only once around the whole retry loop lets a
      // bot retry race a research write in another script.
      const res = channel && options.scheduler
        ? await options.scheduler.run(channel, dispatch)
        : await dispatch();
      if (res.status === 429 && attempt < maxRetries) {
        await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          retryAfterMs(res),
        );
        continue;
      }
      return (await res.json()) as T & { ok: boolean; error?: string };
    }
  }

  const userCache = new Map<string, PlatformUser>();

  return {
    async authTest() {
      const r = await api<{ user_id?: string }>("auth.test", {});
      return { ok: r.ok, userId: r.user_id, error: r.error };
    },
    async postMessage(args) {
      const r = await api<{ ts?: string }>("chat.postMessage", args);
      // A replay of the same client_msg_id can be reported as an explicit
      // duplicate instead of returning the original timestamp. The original
      // idempotent write is already visible, so this is a committed success.
      if (!r.ok && (r.error === "duplicate_message" || r.error === "duplicate_client_msg_id")) {
        return { ok: true, ts: r.ts, error: r.error, duplicate: true };
      }
      if (!r.ok) throw new SlackApiError("chat.postMessage", r.error ?? "unknown");
      return { ok: r.ok, ts: r.ts, error: r.error };
    },
    async updateMessage(args) {
      const r = await api("chat.update", args);
      if (!r.ok) throw new SlackApiError("chat.update", r.error ?? "unknown");
      return { ok: r.ok, error: r.error };
    },
    async setStatus(args) {
      const r = await api("assistant.threads.setStatus", args);
      if (!r.ok) {
        throw new SlackApiError("assistant.threads.setStatus", r.error ?? "unknown");
      }
    },
    async setTitle(args) {
      const r = await api("assistant.threads.setTitle", args);
      if (!r.ok) {
        throw new SlackApiError("assistant.threads.setTitle", r.error ?? "unknown");
      }
    },
    async addReaction(args) {
      const r = await api("reactions.add", {
        channel: args.channel,
        timestamp: args.timestamp,
        name: args.name,
      });
      return { ok: r.ok, error: r.error };
    },
    async removeReaction(args) {
      const r = await api("reactions.remove", {
        channel: args.channel,
        timestamp: args.timestamp,
        name: args.name,
      });
      return { ok: r.ok, error: r.error };
    },
    async resolveUser(userId) {
      const cached = userCache.get(userId);
      // Prefer a cache hit that already has email. Incomplete entries (id-only)
      // are refreshed so a transient users.info miss does not stick forever.
      if (cached?.email) return cached;
      // `timezone`/`githubHandle` are OpenTag extensions (not on PlatformUser);
      // agent-turn reads both.
      let user: PlatformUser & { timezone?: string; githubHandle?: string } = {
        id: userId,
      };
      try {
        const r = await api<{
          user?: {
            id?: string;
            name?: string;
            real_name?: string;
            tz?: string;
            profile?: {
              real_name?: string;
              real_name_normalized?: string;
              display_name?: string;
              display_name_normalized?: string;
              email?: string;
              fields?: unknown;
              status_text?: string;
            };
          };
        }>("users.info", { user: userId });
        const u = r.user;
        if (r.ok && u?.id) {
          let githubHandle = extractGithubHandle(u.profile);
          // users.profile.get with labels is authoritative for custom profile
          // fields. users.info remains the source for identity/email/timezone.
          try {
            const profileResult = await api<{ profile?: { fields?: unknown } }>(
              "users.profile.get",
              { user: userId, include_labels: true },
            );
            if (profileResult.ok) {
              githubHandle = extractGithubHandle(profileResult.profile) ?? githubHandle;
            } else {
              console.warn("[slack] users.profile.get failed", userId, profileResult.error);
            }
          } catch (err) {
            console.warn(
              "[slack] users.profile.get error",
              userId,
              err instanceof Error ? err.message : err,
            );
          }
          user = {
            id: u.id,
            name: preferredSlackName(
              u.profile?.display_name,
              u.profile?.display_name_normalized,
              u.profile?.real_name,
              u.profile?.real_name_normalized,
              u.real_name,
              u.name,
            ),
            handle: u.name,
            email: u.profile?.email,
            ...(u.tz ? { timezone: u.tz } : {}),
            ...(githubHandle ? { githubHandle } : {}),
          };
          if (!user.email) {
            console.warn(
              "[slack] users.info returned no email for",
              userId,
              "— need users:read.email scope and a reinstall if missing",
            );
          }
        } else if (!r.ok) {
          console.warn("[slack] users.info failed", userId, r.error);
        }
      } catch (err) {
        console.warn(
          "[slack] users.info error",
          userId,
          err instanceof Error ? err.message : err,
        );
      }
      userCache.set(userId, user);
      return user;
    },
    async lookupUserByQuery(rawQuery) {
      const query = rawQuery.trim().toLowerCase();
      if (!query) return undefined;

      try {
        // Email fast-path
        if (query.includes("@")) {
          const r = await api<{
            user?: {
              id?: string;
              name?: string;
              real_name?: string;
              profile?: { email?: string; display_name?: string };
            };
          }>("users.lookupByEmail", { email: rawQuery.trim() });
          if (r.ok && r.user?.id) {
            return {
              id: r.user.id,
              name: r.user.real_name ?? r.user.name,
              handle: r.user.name,
              email: r.user.profile?.email,
            };
          }
        }

        let cursor: string | undefined;
        do {
          const r = await api<{
            members?: Array<{
              id?: string;
              name?: string;
              real_name?: string;
              deleted?: boolean;
              is_bot?: boolean;
              profile?: { display_name?: string; email?: string };
            }>;
            response_metadata?: { next_cursor?: string };
          }>("users.list", { cursor, limit: 200 });
          if (!r.ok) return undefined;
          for (const m of r.members ?? []) {
            if (!m.id || m.deleted || m.is_bot) continue;
            const candidates = [
              m.name,
              m.real_name,
              m.profile?.display_name,
              m.profile?.email,
            ]
              .filter((s): s is string => Boolean(s))
              .map((s) => s.toLowerCase());
            if (candidates.some((c) => c === query || c.startsWith(query))) {
              return {
                id: m.id,
                name: m.real_name ?? m.name,
                handle: m.name,
                email: m.profile?.email,
              };
            }
          }
          cursor = r.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch {
        return undefined;
      }
      return undefined;
    },
    async getThreadMessages({ channel, threadTs, limit = 100 }) {
      try {
        const r = await api<{
          messages?: Array<{
            text?: string;
            ts?: string;
            user?: string;
            bot_id?: string;
            subtype?: string;
            client_msg_id?: string;
            blocks?: unknown[];
            attachments?: unknown[];
            files?: unknown[];
          }>;
        }>("conversations.replies", {
          channel,
          ts: threadTs,
          limit,
        });
        if (!r.ok) {
          console.error(
            "[slack] conversations.replies failed",
            r.error,
            channel,
            threadTs,
          );
          return [];
        }
        return r.messages ?? [];
      } catch (err) {
        console.error(
          "[slack] conversations.replies threw",
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    },
    async findMessageByClientMessageId({
      channel,
      threadTs,
      clientMessageId,
      limit = 100,
    }) {
      const method = threadTs ? "conversations.replies" : "conversations.history";
      const r = await api<{
        messages?: Array<{ ts?: string; client_msg_id?: string }>;
      }>(method, {
        channel,
        ...(threadTs ? { ts: threadTs } : {}),
        limit: Math.min(100, Math.max(1, limit)),
        inclusive: true,
      });
      if (!r.ok) {
        throw new SlackApiError(method, r.error ?? "unknown");
      }
      const match = (r.messages ?? []).find(
        (message) => message.client_msg_id === clientMessageId,
      );
      return match?.ts ? { found: true, ts: match.ts } : { found: false };
    },
    async getFileInfo(fileId) {
      const r = await api<{
        file?: {
          id?: string;
          name?: string;
          mimetype?: string;
          filetype?: string;
          url_private?: string;
          size?: number;
        };
      }>("files.info", { file: fileId });
      if (!r.ok) throw new SlackApiError("files.info", r.error ?? "unknown");
      return r.file;
    },
    async getChannelHistory({ channel, limit = 50 }) {
      try {
        const r = await api<{
          messages?: Array<{
            text?: string;
            ts?: string;
            user?: string;
            bot_id?: string;
            subtype?: string;
            blocks?: unknown[];
            attachments?: unknown[];
            files?: unknown[];
          }>;
        }>("conversations.history", {
          channel,
          limit,
        });
        if (!r.ok) {
          console.error(
            "[slack] conversations.history failed",
            r.error,
            channel,
          );
          return [];
        }
        // API returns newest-first; normalize to oldest → newest.
        return [...(r.messages ?? [])].reverse();
      } catch (err) {
        console.error(
          "[slack] conversations.history threw",
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    },
  };
}
