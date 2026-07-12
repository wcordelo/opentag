/**
 * Minimal Slack Web API helpers (fetch-based, no @slack/web-api / Bolt).
 */
import type { PlatformUser } from "@copilotkit/channels-ui";

export type SlackWebClient = {
  authTest(): Promise<{ ok: boolean; userId?: string; error?: string }>;
  postMessage(args: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: unknown[];
    attachments?: unknown[];
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
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
    }>
  >;
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
    }>
  >;
};

export function createSlackWebClient(botToken: string): SlackWebClient {
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
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers,
      body: body ? encodeForm(body) : undefined,
    });
    return (await res.json()) as T & { ok: boolean; error?: string };
  }

  const userCache = new Map<string, PlatformUser>();

  return {
    async authTest() {
      const r = await api<{ user_id?: string }>("auth.test", {});
      return { ok: r.ok, userId: r.user_id, error: r.error };
    },
    async postMessage(args) {
      const r = await api<{ ts?: string }>("chat.postMessage", args);
      return { ok: r.ok, ts: r.ts, error: r.error };
    },
    async updateMessage(args) {
      const r = await api("chat.update", args);
      return { ok: r.ok, error: r.error };
    },
    async setStatus(args) {
      await api("assistant.threads.setStatus", args).catch(() => undefined);
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
      // `timezone` is an OpenTag extension (not on PlatformUser); agent-turn reads it.
      let user: PlatformUser & { timezone?: string } = { id: userId };
      try {
        const r = await api<{
          user?: {
            id?: string;
            name?: string;
            real_name?: string;
            tz?: string;
            profile?: {
              real_name?: string;
              display_name?: string;
              email?: string;
            };
          };
        }>("users.info", { user: userId });
        const u = r.user;
        if (r.ok && u?.id) {
          user = {
            id: u.id,
            name:
              u.real_name ??
              u.profile?.real_name ??
              u.profile?.display_name ??
              u.name,
            handle: u.name,
            email: u.profile?.email,
            ...(u.tz ? { timezone: u.tz } : {}),
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
    async getChannelHistory({ channel, limit = 50 }) {
      try {
        const r = await api<{
          messages?: Array<{
            text?: string;
            ts?: string;
            user?: string;
            bot_id?: string;
            subtype?: string;
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
