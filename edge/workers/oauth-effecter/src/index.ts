import { Hono } from "hono";
import {
  OAuthCallbackContractError,
  validateOAuthCallbackHandoff,
} from "../../../src/platform/oauth-callback-contract.js";
import {
  OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION,
  OAuthProviderAdapterContractError,
  validateOAuthProviderAdapterReceipt,
} from "../../../src/platform/oauth-provider-contract.js";

type OAuthEffecterEnv = {
  Bindings: {
    OAUTH_EFFECTER_AUTH_TOKEN?: string;
    /** Separately authenticated provider exchange and custody boundary. */
    OAUTH_PROVIDER_ADAPTER?: Fetcher;
    /** Internal service-binding bearer; never a provider credential. */
    OAUTH_PROVIDER_ADAPTER_AUTH_TOKEN?: string;
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
  providerAdapterConfigured: Boolean(
    c.env.OAUTH_PROVIDER_ADAPTER && c.env.OAUTH_PROVIDER_ADAPTER_AUTH_TOKEN,
  ),
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
    let handoff;
    try {
      handoff = validateOAuthCallbackHandoff(body);
    } catch (error) {
      if (error instanceof OAuthCallbackContractError) {
        throw new OAuthEffecterError(error.code, 400);
      }
      throw new OAuthEffecterError("oauth_callback_invalid", 400);
    }
    if (!c.env.OAUTH_PROVIDER_ADAPTER || !c.env.OAUTH_PROVIDER_ADAPTER_AUTH_TOKEN) {
      throw new OAuthEffecterError("oauth_provider_adapter_unconfigured", 503);
    }
    const response = await c.env.OAUTH_PROVIDER_ADAPTER.fetch("https://oauth-provider-adapter/exchange", {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.env.OAUTH_PROVIDER_ADAPTER_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      // The code is held only for the authenticated provider request. The
      // effecter never persists or logs the callback handoff.
      body: JSON.stringify({
        schemaVersion: OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION,
        handoff,
      }),
    });
    if (!response.ok) {
      throw new OAuthEffecterError(
        "oauth_provider_adapter_rejected",
        response.status >= 500 ? 503 : 400,
      );
    }
    let receipt: unknown;
    try {
      receipt = await response.json();
      validateOAuthProviderAdapterReceipt(receipt);
    } catch (error) {
      if (error instanceof OAuthProviderAdapterContractError) {
        throw new OAuthEffecterError(error.code, 503);
      }
      throw new OAuthEffecterError("oauth_provider_receipt_invalid", 503);
    }
    return c.json({ ok: true, status: "completed", receipt }, 202);
  } catch (error) {
    if (error instanceof OAuthEffecterError) return c.json({ error: error.code }, error.status);
    console.error("[oauth-effecter] request failed", error instanceof Error ? error.message : "unknown");
    return c.json({ error: "oauth_effecter_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export { app as oauthEffecterApp };
export default { fetch: app.fetch };
