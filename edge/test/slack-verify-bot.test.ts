import { describe, expect, it } from "vitest";
import { slackVerify } from "../src/slack-verify.js";

async function sign(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`v0:${timestamp}:${body}`),
  );
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

describe("slackVerify (bot spine)", () => {
  it("rejects missing signature headers", async () => {
    const mw = slackVerify();
    const c = {
      req: {
        header: () => undefined,
        text: async () => "",
      },
      env: { SLACK_SIGNING_SECRET: "secret" },
      json: (body: unknown, status?: number) =>
        Response.json(body, { status: status ?? 200 }),
      set: () => undefined,
    };
    const res = (await mw(c as never, async () => undefined)) as Response;
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature", async () => {
    const secret = "test_signing_secret";
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(secret, timestamp, body);
    const sets: Record<string, unknown> = {};
    let nextCalled = false;
    const mw = slackVerify();
    const c = {
      req: {
        header: (name: string) => {
          if (name === "X-Slack-Request-Timestamp") return timestamp;
          if (name === "X-Slack-Signature") return signature;
          return undefined;
        },
        text: async () => body,
      },
      env: { SLACK_SIGNING_SECRET: secret },
      json: (b: unknown, status?: number) => Response.json(b, { status }),
      set: (k: string, v: unknown) => {
        sets[k] = v;
      },
    };
    await mw(c as never, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(sets["rawBody"]).toBe(body);
  });
});
