/**
 * Minimal Slack Web API helpers (fetch-based, no @slack/web-api / Bolt).
 */
export type SlackWebClient = {
  postMessage(args: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: unknown[];
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
  lookupUser(userId: string): Promise<
    { id: string; name?: string; username?: string } | undefined
  >;
};

export function createSlackWebClient(botToken: string): SlackWebClient {
  const headers = {
    Authorization: `Bearer ${botToken}`,
    "Content-Type": "application/json",
  };

  async function api<T extends Record<string, unknown>>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T & { ok: boolean; error?: string }> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return (await res.json()) as T & { ok: boolean; error?: string };
  }

  return {
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
    async lookupUser(userId) {
      const r = await api<{
        user?: { id?: string; name?: string; real_name?: string };
      }>("users.info", { user: userId });
      if (!r.ok || !r.user?.id) return undefined;
      return {
        id: r.user.id,
        name: r.user.real_name ?? r.user.name,
        username: r.user.name,
      };
    },
  };
}
