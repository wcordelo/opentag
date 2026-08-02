import { Hono } from "hono";
import {
  assertMemoryDeletionSourceReceiptMatches,
  MemoryDeletionContractError,
  validateMemoryDeletionSourceReceipt,
  validateMemoryDeletionSourceRequest,
  type MemoryDeletionReceipt,
} from "../../../src/platform/memory-deletion-contract.js";

type MemoryDeletionEnv = {
  Bindings: {
    /** Internal caller bearer; never a memory-provider credential. */
    MEMORY_DELETION_AUTH_TOKEN?: string;
    /** Optional separately authenticated memory-provider adapter. */
    MEMORY_PROVIDER_ADAPTER?: Fetcher;
    MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

class MemoryDeletionWorkerError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 503) {
    super(code);
    this.name = "MemoryDeletionWorkerError";
  }
}

const app = new Hono<MemoryDeletionEnv>();

function requireAuth(
  env: MemoryDeletionEnv["Bindings"],
  authorization: string | undefined,
): void {
  if (!env.MEMORY_DELETION_AUTH_TOKEN) {
    throw new MemoryDeletionWorkerError("memory_deletion_auth_unconfigured", 503);
  }
  if (authorization !== `Bearer ${env.MEMORY_DELETION_AUTH_TOKEN}`) {
    throw new MemoryDeletionWorkerError("unauthorized", 401);
  }
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "memory-deletion",
  configured: Boolean(c.env.MEMORY_DELETION_AUTH_TOKEN),
  providerAdapterConfigured: Boolean(
    c.env.MEMORY_PROVIDER_ADAPTER && c.env.MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN,
  ),
}));

app.post("/delete", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new MemoryDeletionWorkerError("invalid_json", 400);
    }

    let request;
    try {
      request = validateMemoryDeletionSourceRequest(body);
    } catch (error) {
      if (error instanceof MemoryDeletionContractError) {
        throw new MemoryDeletionWorkerError(error.code, 400);
      }
      throw new MemoryDeletionWorkerError("memory_deletion_request_invalid", 400);
    }

    if (!c.env.MEMORY_PROVIDER_ADAPTER || !c.env.MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN) {
      throw new MemoryDeletionWorkerError("memory_provider_adapter_unconfigured", 503);
    }

    const response = await c.env.MEMORY_PROVIDER_ADAPTER.fetch(
      "https://memory-provider-adapter/delete",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.env.MEMORY_PROVIDER_ADAPTER_AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      throw new MemoryDeletionWorkerError(
        "memory_provider_adapter_rejected",
        response.status >= 500 ? 503 : 400,
      );
    }

    let receipt: MemoryDeletionReceipt;
    try {
      receipt = validateMemoryDeletionSourceReceipt(await response.json());
      assertMemoryDeletionSourceReceiptMatches(request, receipt);
    } catch (error) {
      if (error instanceof MemoryDeletionContractError) {
        throw new MemoryDeletionWorkerError(error.code, 503);
      }
      throw new MemoryDeletionWorkerError("memory_provider_receipt_invalid", 503);
    }
    return c.json({ ok: true, status: "completed", receipt }, 202);
  } catch (error) {
    if (error instanceof MemoryDeletionWorkerError) {
      return c.json({ error: error.code }, error.status);
    }
    // Never serialize request bodies, provider responses, or arbitrary error
    // messages into logs because a memory provider may include user content.
    console.error(
      "[memory-deletion] request failed",
      error instanceof MemoryDeletionContractError ? error.code : "internal",
    );
    return c.json({ error: "memory_deletion_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export { app as memoryDeletionApp };
export default { fetch: app.fetch };
