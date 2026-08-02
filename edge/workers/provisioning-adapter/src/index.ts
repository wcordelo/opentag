import { Hono } from "hono";
import {
  assertProvisioningAdapterReceiptMatches,
  ProvisioningContractError,
  validateProvisioningAdapterReceipt,
  validateProvisioningStepRequest,
  type ProvisioningStepReceipt,
} from "../../../src/platform/provisioning-contract.js";

type ProvisioningAdapterEnv = {
  Bindings: {
    /** Internal caller bearer; never a provider credential. */
    PROVISIONING_ADAPTER_AUTH_TOKEN?: string;
    /** Optional separately authenticated bootstrap/resource adapter. */
    PROVISIONING_PROVIDER_ADAPTER?: Fetcher;
    PROVISIONING_PROVIDER_ADAPTER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

class ProvisioningAdapterWorkerError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 503) {
    super(code);
    this.name = "ProvisioningAdapterWorkerError";
  }
}

const app = new Hono<ProvisioningAdapterEnv>();

function requireAuth(
  env: ProvisioningAdapterEnv["Bindings"],
  authorization: string | undefined,
): void {
  if (!env.PROVISIONING_ADAPTER_AUTH_TOKEN) {
    throw new ProvisioningAdapterWorkerError("provisioning_adapter_auth_unconfigured", 503);
  }
  if (authorization !== `Bearer ${env.PROVISIONING_ADAPTER_AUTH_TOKEN}`) {
    throw new ProvisioningAdapterWorkerError("unauthorized", 401);
  }
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "provisioning-adapter",
  configured: Boolean(c.env.PROVISIONING_ADAPTER_AUTH_TOKEN),
  providerAdapterConfigured: Boolean(
    c.env.PROVISIONING_PROVIDER_ADAPTER && c.env.PROVISIONING_PROVIDER_ADAPTER_AUTH_TOKEN,
  ),
}));

app.post("/provision-step", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ProvisioningAdapterWorkerError("invalid_json", 400);
    }

    let request;
    try {
      request = validateProvisioningStepRequest(body);
    } catch (error) {
      if (error instanceof ProvisioningContractError) {
        throw new ProvisioningAdapterWorkerError(error.code, 400);
      }
      throw new ProvisioningAdapterWorkerError("provisioning_step_request_invalid", 400);
    }

    if (!c.env.PROVISIONING_PROVIDER_ADAPTER || !c.env.PROVISIONING_PROVIDER_ADAPTER_AUTH_TOKEN) {
      throw new ProvisioningAdapterWorkerError("provisioning_provider_adapter_unconfigured", 503);
    }

    const response = await c.env.PROVISIONING_PROVIDER_ADAPTER.fetch(
      "https://provisioning-provider-adapter/provision-step",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.env.PROVISIONING_PROVIDER_ADAPTER_AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      throw new ProvisioningAdapterWorkerError(
        "provisioning_provider_adapter_rejected",
        response.status >= 500 ? 503 : 400,
      );
    }

    let receipt: ProvisioningStepReceipt;
    try {
      receipt = validateProvisioningAdapterReceipt(await response.json());
      assertProvisioningAdapterReceiptMatches(request, receipt);
    } catch (error) {
      if (error instanceof ProvisioningContractError) {
        throw new ProvisioningAdapterWorkerError(error.code, 503);
      }
      throw new ProvisioningAdapterWorkerError("provisioning_provider_receipt_invalid", 503);
    }
    return c.json({
      ok: true,
      status: receipt.outcome === "complete" ? "completed" : "failed",
      receipt,
    }, 202);
  } catch (error) {
    if (error instanceof ProvisioningAdapterWorkerError) {
      return c.json({ error: error.code }, error.status);
    }
    // Do not serialize requests, provider responses, or arbitrary errors into
    // logs; adapters may accidentally include credentials in exceptions.
    console.error(
      "[provisioning-adapter] request failed",
      error instanceof ProvisioningContractError ? error.code : "internal",
    );
    return c.json({ error: "provisioning_adapter_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export { app as provisioningAdapterApp };
export default { fetch: app.fetch };
