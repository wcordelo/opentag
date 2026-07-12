/**
 * Unit tests for egress proxy allowlist + auth injection.
 * Upstream fetch is mocked so no real network calls are made.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker from "../index";
import type { Env } from "../index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const agentTokens = new Map<string, string>();
  return {
    ALLOWED_HOSTS: [
      "api.anthropic.com",
      "api.openai.com",
      "api.github.com",
      "registry.npmjs.org",
      "pkg.go.dev",
    ],
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENAI_API_KEY: "sk-openai-test",
    GITHUB_TOKEN: "ghp-test",
    AGENT_STATE: {
      get: vi.fn(async (key: string) => agentTokens.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        agentTokens.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        agentTokens.delete(key);
      }),
    } as unknown as KVNamespace,
    ORCHESTRATOR_SERVICE: {
      fetch: vi.fn(async () => Response.json({ ok: true })),
    } as unknown as Fetcher,
    ...overrides,
  };
}

const VALID_AGENT_TOKEN = "test-agent-token";

function proxyRequest(body: Record<string, unknown>, token = VALID_AGENT_TOKEN): Request {
  return new Request("https://egress/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("egress proxy", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      return new Response(JSON.stringify({ proxied: true, url: req.url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects disallowed hosts with 403", async () => {
    const env = makeEnv();
    await env.AGENT_STATE.put(
      `agent_token:${VALID_AGENT_TOKEN}`,
      JSON.stringify({ teamId: "T123", containerId: "c1", sessionId: "s1" }),
    );
    const res = await worker.fetch(
      proxyRequest({
        url: "https://evil.com/steal",
        method: "GET",
        teamId: "T123",
        containerId: "c1",
      }),
      env,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; host: string };
    expect(json.error).toBe("host_not_allowed");
    expect(json.host).toBe("evil.com");
    expect(env.ORCHESTRATOR_SERVICE.fetch).toHaveBeenCalled();
  });

  it("proxies allowed hosts and injects Anthropic auth", async () => {
    const env = makeEnv();
    await env.AGENT_STATE.put(
      `agent_token:${VALID_AGENT_TOKEN}`,
      JSON.stringify({ teamId: "T123", containerId: "c1", sessionId: "s1" }),
    );
    const res = await worker.fetch(
      proxyRequest({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: { Authorization: "Bearer stolen" },
        body: "{}",
        teamId: "T123",
        containerId: "c1",
      }),
      env,
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const upstreamInit = calls[0]![1] as RequestInit;
    const headers = new Headers(upstreamInit.headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-ant-test");
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
  });

  it("rejects requests without a valid agent token", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      proxyRequest({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        body: "{}",
      }, "invalid-token"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("GET /health returns ok", async () => {
    const res = await worker.fetch(
      new Request("https://egress/health"),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});
