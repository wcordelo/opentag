/**
 * Slack signature verification for the bot Worker (PRODUCT.md Phase 1).
 * Same contract as workers/orchestrator slack-verify — kept local so the bot
 * package does not depend on the research Worker tree.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";

const MAX_TIMESTAMP_SKEW_SECONDS = 300;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(signatureBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function slackVerify(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const timestamp = c.req.header("X-Slack-Request-Timestamp");
    const signature = c.req.header("X-Slack-Signature");
    const secret = c.env.SLACK_SIGNING_SECRET;

    if (!timestamp || !signature || !secret) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS
    ) {
      return c.json({ error: "stale_request" }, 401);
    }

    const rawBody = await c.req.text();
    const expected = await computeSlackSignature(secret, timestamp, rawBody);
    if (!timingSafeEqual(expected, signature)) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    let slackPayload: unknown;
    try {
      slackPayload = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    } catch {
      slackPayload = undefined;
    }

    c.set("rawBody", rawBody);
    c.set("slackPayload", slackPayload);
    c.set("verifiedIngress", Object.freeze({
      method: "slack_hmac_v0",
      // Bind the accepted signature to the exact body without retaining either
      // the body or signature in the turn context.
      evidenceDigest: await sha256Digest(`slack-hmac:v0:${timestamp}:${signature}:${rawBody}`),
      // Use Slack's signed timestamp so retries of the same delivery carry an
      // identical immutable evidence record into the deferred-ingress DO.
      verifiedAt: new Date(timestampSeconds * 1000).toISOString(),
    }));
    await next();
  };
}
