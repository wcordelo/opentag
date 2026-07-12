import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { slackVerify } from "../slack-verify";
import type { AppEnv } from "../env";

async function sign(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
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
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function makeApp() {
  const app = new Hono<AppEnv>();
  app.post("/slack/events", slackVerify(), (c) => {
    const payload = c.get("slackPayload") as { type?: string; challenge?: string };
    if (payload?.type === "url_verification") {
      return c.json({ challenge: payload.challenge }, 200);
    }
    return c.json({ ok: true, rawLen: c.get("rawBody").length }, 200);
  });
  return app;
}

const SECRET = "test_signing_secret";

function testEnv() {
  return {
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-test",
    ORCHESTRATOR: {} as DurableObjectNamespace,
    RESEARCHER: {} as DurableObjectNamespace,
    VERIFIER: {} as DurableObjectNamespace,
    BLOBS: {} as R2Bucket,
    AGENT_STATE: {} as KVNamespace,
    WASM_DISPATCH: {} as Fetcher,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    ENVIRONMENT: "test",
    ALLOWED_HOSTS: [] as string[],
    EGRESS_PROXY_URL: "",
  };
}

describe("slackVerify", () => {
  it("accepts a valid signature", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(SECRET, ts, body);

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
      testEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("rejects a bad signature with 401 invalid_signature", async () => {
    const app = makeApp();
    const body = JSON.stringify({ type: "event_callback" });
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await app.request(
      "/slack/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Slack-Request-Timestamp": ts,
          "X-Slack-Signature": "v0=deadbeef",
        },
        body,
      },
      testEnv(),
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_signature");
  });

  it("rejects a stale timestamp with 401 stale_request", async () => {
    const app = makeApp();
    const body = JSON.stringify({ type: "event_callback" });
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const sig = await sign(SECRET, ts, body);

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
      testEnv(),
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("stale_request");
  });

  it("echoes url_verification challenge", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(SECRET, ts, body);

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
      testEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe("abc123");
  });
});
