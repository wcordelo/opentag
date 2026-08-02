import { Hono } from "hono";
import {
  OAuthCallbackContractError,
  validateOAuthCallbackHandoff,
} from "../../../src/platform/oauth-callback-contract.js";

type OAuthEffecterEnv = {
  Bindings: {
    OAUTH_EFFECTER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

class OAuthEffecterError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 503) {
    super(code);
    this.name = "OAuthEffecterError";
  }
}

const app = new Hono<OAuthEffecterEnv>();

function requireAuth(env: OAuthEffecterEnv["Bindings"], authorization: string | undefined): void {
  if (!env.OAUTH_EFFECTER_AUTH_TOKEN) throw new OAuthEffecterError("oauth_effecter_unconfigured", 503);
  if (authorization !== `Bearer ${env.OAUTH_EFFECTER_AUTH_TOKEN}`) {
    throw new OAuthEffecterError("unauthorized", 401);
  }
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "oauth-effecter",
  configured: Boolean(c.env.OAUTH_EFFECTER_AUTH_TOKEN),
  providerExchangeEnabled: false,
}));

app.post("/callback", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OAuthEffecterError("invalid_json", 400);
    }
    try {
      validateOAuthCallbackHandoff(body);
    } catch (error) {
      if (error instanceof OAuthCallbackContractError) {
        throw new OAuthEffecterError(error.code, 400);
      }
      throw new OAuthEffecterError("oauth_callback_invalid", 400);
    }
    // The provider adapter is deliberately absent. Do not consume state or
    // claim a grant until exchange, custody, and marketplace checks are live.
    return c.json({ error: "oauth_provider_adapter_unconfigured" }, 503);
  } catch (error) {
    if (error instanceof OAuthEffecterError) return c.json({ error: error.code }, error.status);
    console.error("[oauth-effecter] request failed", error instanceof Error ? error.message : "unknown");
    return c.json({ error: "oauth_effecter_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export { app as oauthEffecterApp };
export default { fetch: app.fetch };
