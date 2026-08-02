import { Hono } from "hono";
import {
  OAUTH_CALLBACK_SCHEMA_VERSION,
  validateOAuthCallbackHandoff,
  type OAuthCallbackHandoff,
} from "../../../src/platform/oauth-callback-contract.js";

const CALLBACK_PATH = "/oauth/callback";
const NONCE_COOKIE = "opentag_oauth_nonce";
const MAX_STATE_LENGTH = 256;
const MIN_STATE_LENGTH = 16;
const MAX_CODE_LENGTH = 4_096;
const MAX_ERROR_LENGTH = 128;
const MAX_ERROR_DESCRIPTION_LENGTH = 512;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type CallbackEnv = {
  Bindings: {
    /** Separately authenticated worker that owns provider exchange and custody. */
    OAUTH_EFFECTER?: Fetcher;
    /** Internal service-binding bearer; never a provider credential. */
    OAUTH_EFFECTER_AUTH_TOKEN?: string;
    /** Exact HTTPS origin configured as the provider callback URL. */
    OAUTH_CALLBACK_ORIGIN?: string;
  };
};

class OAuthCallbackError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 502 | 503) {
    super(code);
    this.name = "OAuthCallbackError";
  }
}

const app = new Hono<CallbackEnv>();

function bounded(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > max || CONTROL_RE.test(value)) {
    throw new OAuthCallbackError(`${field}_invalid`, 400);
  }
  return value;
}

function opaqueState(value: string | undefined): string {
  const state = bounded(value, "oauth_state", MAX_STATE_LENGTH);
  if (!state || state.length < MIN_STATE_LENGTH) {
    throw new OAuthCallbackError("oauth_state_invalid", 400);
  }
  return state;
}

function configuredOrigin(value: string | undefined): string {
  if (!value) throw new OAuthCallbackError("oauth_callback_unconfigured", 503);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthCallbackError("oauth_callback_origin_invalid", 503);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OAuthCallbackError("oauth_callback_origin_invalid", 503);
  }
  return url.origin;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      throw new OAuthCallbackError("oauth_nonce_cookie_invalid", 400);
    }
  }
  return undefined;
}

function parseCallback(request: Request, origin: string): OAuthCallbackHandoff {
  const url = new URL(request.url);
  const state = opaqueState(url.searchParams.get("state") ?? undefined);
  const nonce = opaqueState(cookieValue(request.headers.get("cookie") ?? undefined, NONCE_COOKIE));
  const code = bounded(url.searchParams.get("code") ?? undefined, "oauth_code", MAX_CODE_LENGTH);
  const error = bounded(url.searchParams.get("error") ?? undefined, "oauth_error", MAX_ERROR_LENGTH);
  const errorDescription = bounded(
    url.searchParams.get("error_description") ?? undefined,
    "oauth_error_description",
    MAX_ERROR_DESCRIPTION_LENGTH,
  );
  if (!code && !error) throw new OAuthCallbackError("oauth_result_missing", 400);
  if (code && error) throw new OAuthCallbackError("oauth_result_conflict", 400);
  try {
    return validateOAuthCallbackHandoff({
      schemaVersion: OAUTH_CALLBACK_SCHEMA_VERSION,
      state,
      nonce,
      callbackOrigin: origin,
      receivedAt: new Date().toISOString(),
      ...(code ? { code } : {}),
      ...(error ? { error } : {}),
      ...(errorDescription ? { errorDescription } : {}),
    });
  } catch (error) {
    throw new OAuthCallbackError(
      error instanceof Error ? error.message : "oauth_callback_invalid",
      400,
    );
  }
}

function responseForError(error: unknown): Response {
  if (error instanceof OAuthCallbackError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  console.error("[oauth-callback] request failed", error instanceof Error ? error.message : "unknown");
  return Response.json({ error: "oauth_callback_internal_error" }, { status: 503 });
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "oauth-callback",
  callbackOriginConfigured: Boolean(c.env.OAUTH_CALLBACK_ORIGIN),
  effecterConfigured: Boolean(c.env.OAUTH_EFFECTER),
  effecterAuthConfigured: Boolean(c.env.OAUTH_EFFECTER_AUTH_TOKEN),
  providerExchangeEnabled: Boolean(
    c.env.OAUTH_CALLBACK_ORIGIN &&
    c.env.OAUTH_EFFECTER &&
    c.env.OAUTH_EFFECTER_AUTH_TOKEN,
  ),
}));

app.get(CALLBACK_PATH, async (c) => {
  try {
    const origin = configuredOrigin(c.env.OAUTH_CALLBACK_ORIGIN);
    if (new URL(c.req.raw.url).origin !== origin) {
      throw new OAuthCallbackError("oauth_callback_origin_mismatch", 400);
    }
    if (!c.env.OAUTH_EFFECTER || !c.env.OAUTH_EFFECTER_AUTH_TOKEN) {
      throw new OAuthCallbackError("oauth_effecter_unavailable", 503);
    }
    const handoff = parseCallback(c.req.raw, origin);
    const response = await c.env.OAUTH_EFFECTER.fetch("https://oauth-effecter/callback", {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.env.OAUTH_EFFECTER_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      // This body is held only for the authenticated service request. The
      // callback worker never writes it to a Durable Object or logs it.
      body: JSON.stringify(handoff),
    });
    if (!response.ok) {
      throw new OAuthCallbackError("oauth_effecter_rejected", response.status >= 500 ? 502 : 400);
    }
    return c.json({ ok: true, status: "accepted" }, 202);
  } catch (error) {
    return responseForError(error);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error) => responseForError(error));

export { app as oauthCallbackApp };
export default { fetch: app.fetch };
