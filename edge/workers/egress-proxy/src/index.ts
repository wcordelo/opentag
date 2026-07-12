/**
 * Egress Proxy Worker — application-level HTTP proxy for Sandbox containers.
 *
 * Per DECISIONS.md §2 / invariant #2:
 * - Containers hold no API keys; only a short-lived AGENT_TOKEN.
 * - Proxy allowlists hosts, injects real secrets, logs every call, forwards via fetch().
 * - Transparent TCP interception is intentionally not attempted.
 */
export interface Env {
  ALLOWED_HOSTS: string[] | string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GITHUB_TOKEN?: string;
  /** Active container session tokens (DECISIONS.md §2). */
  AGENT_STATE: KVNamespace;
  /** Service binding back to orchestrator Worker for execution-log append. */
  ORCHESTRATOR_SERVICE: Fetcher;
}

interface ProxyRequestBody {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  containerId?: string;
  sessionId?: string;
  teamId?: string;
}

function parseAllowedHosts(raw: string[] | string): string[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((h) => typeof h === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through to comma-split
  }
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

function authHeaderForHost(host: string, env: Env): string | null {
  if (host === "api.anthropic.com") {
    return env.ANTHROPIC_API_KEY ? `Bearer ${env.ANTHROPIC_API_KEY}` : null;
  }
  if (host === "api.openai.com") {
    return env.OPENAI_API_KEY ? `Bearer ${env.OPENAI_API_KEY}` : null;
  }
  if (host === "api.github.com") {
    return env.GITHUB_TOKEN ? `Bearer ${env.GITHUB_TOKEN}` : null;
  }
  return null;
}

async function logExecution(
  env: Env,
  entry: {
    teamId?: string;
    containerId?: string;
    sessionId?: string;
    host: string;
    path: string;
    method: string;
    status: number;
    durationMs: number;
  },
): Promise<void> {
  // Logging is best-effort — never fail the proxied request because of it.
  if (!entry.teamId) return;
  try {
    await env.ORCHESTRATOR_SERVICE.fetch(
      new Request("https://orchestrator/internal/execution-logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      }),
    );
  } catch (err) {
    console.error("egress log failed", err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, worker: "opentag-egress-proxy" });
    }

    // Application-level proxy: containers POST { url, method, headers, body }
    // to this worker rather than using a transparent CONNECT tunnel.
    if (url.pathname === "/proxy" && request.method === "POST") {
      const started = Date.now();
      let payload: ProxyRequestBody;
      try {
        payload = (await request.json()) as ProxyRequestBody;
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }

      if (!payload.url) {
        return Response.json({ error: "url_required" }, { status: 400 });
      }

      const agentToken =
        request.headers.get("x-agent-token") ??
        request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
        undefined;
      if (!agentToken || !(await env.AGENT_STATE.get(`agent_token:${agentToken}`))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      let upstream: URL;
      try {
        upstream = new URL(payload.url);
      } catch {
        return Response.json({ error: "invalid_url" }, { status: 400 });
      }

      const allowed = parseAllowedHosts(env.ALLOWED_HOSTS);
      const host = upstream.hostname;
      const method = (payload.method ?? "GET").toUpperCase();
      const containerId =
        payload.containerId ?? request.headers.get("x-agent-container-id") ?? undefined;
      const sessionId =
        payload.sessionId ?? request.headers.get("x-agent-session-id") ?? undefined;
      const teamId =
        payload.teamId ?? request.headers.get("x-agent-team-id") ?? undefined;

      if (!allowed.includes(host)) {
        await logExecution(env, {
          teamId,
          containerId,
          sessionId,
          host,
          path: upstream.pathname,
          method,
          status: 403,
          durationMs: Date.now() - started,
        });
        return Response.json(
          { error: "host_not_allowed", host },
          { status: 403 },
        );
      }

      const headers = new Headers(payload.headers ?? {});
      // Strip any Authorization the container tried to send — proxy owns secrets.
      headers.delete("Authorization");
      const injected = authHeaderForHost(host, env);
      if (injected) {
        headers.set("Authorization", injected);
      }
      // Anthropic also expects x-api-key; inject when present.
      if (host === "api.anthropic.com" && env.ANTHROPIC_API_KEY) {
        headers.set("x-api-key", env.ANTHROPIC_API_KEY);
      }

      const upstreamRes = await fetch(upstream.toString(), {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD"
            ? undefined
            : (payload.body ?? undefined),
      });

      await logExecution(env, {
        teamId,
        containerId,
        sessionId,
        host,
        path: upstream.pathname,
        method,
        status: upstreamRes.status,
        durationMs: Date.now() - started,
      });

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: upstreamRes.headers,
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
