/**
 * M6-style Slack handler tests: HMAC path + research dispatch fan-out.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { slackVerify } from "../slack-verify";
import { handleSlackEvents } from "../slack-events";
import { handleSlackCommands } from "../slack-commands";
import type { AppEnv } from "../env";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`),
  );
  return `v0=${Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function makeApp(doFetch: ReturnType<typeof vi.fn<(req: Request) => Promise<Response>>>) {
  const app = new Hono<AppEnv>();
  app.post("/slack/events", slackVerify(), (c) => handleSlackEvents(c));
  app.post("/slack/commands", slackVerify(), (c) => handleSlackCommands(c));

  const stub = { fetch: doFetch };
  const env = {
    SLACK_SIGNING_SECRET: "test_secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    ORCHESTRATOR: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    RESEARCHER: {} as DurableObjectNamespace,
    VERIFIER: {} as DurableObjectNamespace,
    BLOBS: {} as R2Bucket,
    AGENT_STATE: {} as KVNamespace,
    WASM_DISPATCH: {
      fetch: async () =>
        Response.json({
          intent: "research",
          confidence: 1,
          extractedObjective: "Durable Objects",
        }),
    } as unknown as Fetcher,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    ENVIRONMENT: "test",
    ALLOWED_HOSTS: [] as string[],
    EGRESS_PROXY_URL: "",
  };

  return { app, env, stub };
}

describe("Slack research fan-out", () => {
  it("acks app_mention immediately and dispatches to per-workspace DO", async () => {
    const doFetch = vi.fn(async (_req: Request) =>
      Response.json({ status: "continuing", taskId: "t1" }),
    );
    const { app, env } = makeApp(doFetch);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_WORKSPACE",
      event_id: "Ev123",
      event: {
        type: "app_mention",
        text: "research Durable Objects",
        channel: "C1",
        ts: "111.222",
        user: "U1",
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign("test_secret", ts, body);

    const res = await app.request(
      "/slack/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": sig,
        },
        body,
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Detached fire-and-forget — give the microtask queue a turn
    await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
    const firstCall = doFetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    const req = firstCall![0] as unknown as Request;
    expect(new URL(req.url).pathname).toBe("/handleMention");
    const payload = (await req.clone().json()) as {
      threadKey: string;
      objective: string;
      eventId: string;
    };
    expect(payload.threadKey).toBe("slack:C1:111.222");
    expect(payload.objective).toBe("Durable Objects");
    expect(payload.eventId).toBe("Ev123");
  });

  it("ignores non-research mentions without DO dispatch", async () => {
    const doFetch = vi.fn(async (_req: Request) => Response.json({ ok: true }));
    const { app, env } = makeApp(doFetch);
    env.WASM_DISPATCH = {
      fetch: async () =>
        Response.json({ intent: "unknown", confidence: 0.5, extractedObjective: "hi" }),
    } as unknown as Fetcher;

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev999",
      event: {
        type: "app_mention",
        text: "hello bot",
        channel: "C1",
        ts: "1.0",
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign("test_secret", ts, body);

    const res = await app.request(
      "/slack/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": sig,
        },
        body,
      },
      env,
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("/research slash command acks with interim text and dispatches", async () => {
    const doFetch = vi.fn(async (_req: Request) => Response.json({ ok: true }));
    const { app, env } = makeApp(doFetch);

    const form = new URLSearchParams({
      command: "/research",
      text: "Cloudflare Workers",
      channel_id: "C9",
      team_id: "T9",
      user_id: "U9",
    }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign("test_secret", ts, form);

    const res = await app.request(
      "/slack/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": sig,
        },
        body: form,
      },
      env,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; response_type: string };
    expect(json.response_type).toBe("in_channel");
    expect(json.text).toContain("Research started");
    await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
  });
});
