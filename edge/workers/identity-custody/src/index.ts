import { Hono } from "hono";
import {
  assertIdentityCustodyReceiptMatches,
  IdentityCustodyContractError,
  validateIdentityCustodyReceipt,
  validateIdentityCustodyRequest,
  type IdentityCustodyReceipt,
} from "../../../src/platform/identity-custody-contract.js";

type IdentityCustodyEnv = {
  Bindings: {
    /** Internal caller bearer; never a provider credential. */
    IDENTITY_CUSTODY_AUTH_TOKEN?: string;
    /** Optional separately authenticated key provider/custody adapter. */
    IDENTITY_PROVIDER_ADAPTER?: Fetcher;
    IDENTITY_PROVIDER_ADAPTER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

class IdentityCustodyWorkerError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 503) {
    super(code);
    this.name = "IdentityCustodyWorkerError";
  }
}

const app = new Hono<IdentityCustodyEnv>();

function requireAuth(
  env: IdentityCustodyEnv["Bindings"],
  authorization: string | undefined,
): void {
  if (!env.IDENTITY_CUSTODY_AUTH_TOKEN) {
    throw new IdentityCustodyWorkerError("identity_custody_auth_unconfigured", 503);
  }
  if (authorization !== `Bearer ${env.IDENTITY_CUSTODY_AUTH_TOKEN}`) {
    throw new IdentityCustodyWorkerError("unauthorized", 401);
  }
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "identity-custody",
  configured: Boolean(c.env.IDENTITY_CUSTODY_AUTH_TOKEN),
  providerAdapterConfigured: Boolean(
    c.env.IDENTITY_PROVIDER_ADAPTER && c.env.IDENTITY_PROVIDER_ADAPTER_AUTH_TOKEN,
  ),
}));

app.post("/identity", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new IdentityCustodyWorkerError("invalid_json", 400);
    }
    let request;
    try {
      request = validateIdentityCustodyRequest(body);
    } catch (error) {
      if (error instanceof IdentityCustodyContractError) {
        throw new IdentityCustodyWorkerError(error.code, 400);
      }
      throw new IdentityCustodyWorkerError("identity_custody_request_invalid", 400);
    }
    if (!c.env.IDENTITY_PROVIDER_ADAPTER || !c.env.IDENTITY_PROVIDER_ADAPTER_AUTH_TOKEN) {
      throw new IdentityCustodyWorkerError("identity_provider_adapter_unconfigured", 503);
    }
    const response = await c.env.IDENTITY_PROVIDER_ADAPTER.fetch(
      "https://identity-provider-adapter/identity",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.env.IDENTITY_PROVIDER_ADAPTER_AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      throw new IdentityCustodyWorkerError(
        "identity_provider_adapter_rejected",
        response.status >= 500 ? 503 : 400,
      );
    }
    let receipt: IdentityCustodyReceipt;
    try {
      receipt = validateIdentityCustodyReceipt(await response.json());
      assertIdentityCustodyReceiptMatches(request, receipt);
    } catch (error) {
      if (error instanceof IdentityCustodyContractError) {
        throw new IdentityCustodyWorkerError(error.code, 400);
      }
      throw new IdentityCustodyWorkerError("identity_provider_receipt_invalid", 400);
    }
    return c.json({ ok: true, status: "completed", receipt }, 202);
  } catch (error) {
    if (error instanceof IdentityCustodyWorkerError) {
      return c.json({ error: error.code }, error.status);
    }
    // Never serialize request bodies, adapter responses, or arbitrary error
    // messages into logs because a provider may include key material.
    console.error(
      "[identity-custody] request failed",
      error instanceof IdentityCustodyContractError ? error.code : "internal",
    );
    return c.json({ error: "identity_custody_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export { app as identityCustodyApp };
export default { fetch: app.fetch };
