import { Hono } from "hono";
import type { Fetcher } from "@cloudflare/workers-types";
import {
  assertBillingAdapterReceiptMatches,
  BillingAdapterContractError,
  validateBillingAdapterReceipt,
  validateBillingAdapterRequest,
  type BillingAdapterReceipt,
} from "../../../src/platform/billing-adapter-contract.js";

type BillingAdapterEnv = {
  Bindings: {
    /** Internal caller bearer; never a billing-provider credential. */
    BILLING_ADAPTER_AUTH_TOKEN?: string;
    /** Optional separately authenticated provider adapter. */
    BILLING_PROVIDER_ADAPTER?: Fetcher;
    BILLING_PROVIDER_ADAPTER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

class BillingAdapterWorkerError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 502 | 503) {
    super(code);
    this.name = "BillingAdapterWorkerError";
  }
}

const MAX_JSON_BYTES = 16 * 1024;

const app = new Hono<BillingAdapterEnv>();

function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBytes = new TextEncoder().encode(expected);
  const actualBytes = new TextEncoder().encode(actual);
  let difference = expectedBytes.length ^ actualBytes.length;
  const length = Math.max(expectedBytes.length, actualBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);
  }
  return difference === 0;
}

function requireAuth(
  env: BillingAdapterEnv["Bindings"],
  authorization: string | undefined,
): void {
  const expected = env.BILLING_ADAPTER_AUTH_TOKEN;
  if (!expected?.trim()) {
    throw new BillingAdapterWorkerError("billing_adapter_auth_unconfigured", 503);
  }
  const prefix = "Bearer ";
  const presented = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : undefined;
  if (!presented || !constantTimeEqual(expected, presented)) {
    throw new BillingAdapterWorkerError("unauthorized", 401);
  }
}

function providerConfigured(env: BillingAdapterEnv["Bindings"]): boolean {
  return Boolean(
    env.BILLING_PROVIDER_ADAPTER &&
    env.BILLING_PROVIDER_ADAPTER_AUTH_TOKEN?.trim(),
  );
}

function contentLengthTooLarge(request: Request): boolean {
  const raw = request.headers.get("content-length");
  return raw !== null && /^\d+$/.test(raw) && Number(raw) > MAX_JSON_BYTES;
}

async function readBoundedJson(
  stream: ReadableStream<Uint8Array> | null,
  tooLargeCode: string,
  invalidCode: string,
  status: 400 | 503,
): Promise<unknown> {
  if (!stream) throw new BillingAdapterWorkerError(invalidCode, status);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new BillingAdapterWorkerError(tooLargeCode, status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new BillingAdapterWorkerError(invalidCode, status);
  }
}

function safeContractCode(error: unknown, fallback: string): string {
  return error instanceof BillingAdapterContractError ? error.code : fallback;
}

function errorResponse(error: unknown): Response {
  if (error instanceof BillingAdapterWorkerError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof BillingAdapterContractError) {
    return Response.json({ error: error.code }, { status: 400 });
  }
  console.error(
    "[billing-adapter] request failed",
    error instanceof BillingAdapterContractError ? error.code : "internal",
  );
  return Response.json({ error: "billing_adapter_internal_error" }, { status: 503 });
}

app.get("/health", (c) => c.json({
  ok: true,
  role: "billing-adapter",
  configured: Boolean(c.env.BILLING_ADAPTER_AUTH_TOKEN?.trim()),
  providerAdapterConfigured: providerConfigured(c.env),
}));

app.post("/meter", async (c) => {
  try {
    requireAuth(c.env, c.req.header("authorization"));
    if (contentLengthTooLarge(c.req.raw)) {
      throw new BillingAdapterWorkerError("request_body_too_large", 400);
    }
    const body = await readBoundedJson(
      c.req.raw.body,
      "request_body_too_large",
      "invalid_json",
      400,
    );
    const request = validateBillingAdapterRequest(body);

    if (!providerConfigured(c.env)) {
      throw new BillingAdapterWorkerError(
        "billing_provider_adapter_unconfigured",
        503,
      );
    }

    let response: Response;
    try {
      response = await c.env.BILLING_PROVIDER_ADAPTER!.fetch(
        "https://billing-provider-adapter/meter",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${c.env.BILLING_PROVIDER_ADAPTER_AUTH_TOKEN!}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );
    } catch {
      throw new BillingAdapterWorkerError(
        "billing_provider_adapter_unavailable",
        503,
      );
    }

    if (!response.ok) {
      throw new BillingAdapterWorkerError(
        "billing_provider_adapter_rejected",
        response.status >= 500 ? 503 : 502,
      );
    }

    let receipt: BillingAdapterReceipt;
    try {
      const receiptBody = await readBoundedJson(
        response.body,
        "billing_provider_receipt_too_large",
        "billing_provider_receipt_invalid",
        503,
      );
      receipt = validateBillingAdapterReceipt(receiptBody);
      assertBillingAdapterReceiptMatches(request, receipt);
    } catch (error) {
      console.error(
        "[billing-adapter] provider receipt rejected",
        safeContractCode(error, "invalid_receipt"),
      );
      if (error instanceof BillingAdapterWorkerError) throw error;
      throw new BillingAdapterWorkerError("billing_provider_receipt_invalid", 503);
    }
    return c.json({ ok: true, operation: "meter", receipt }, 202);
  } catch (error) {
    if (
      error instanceof BillingAdapterWorkerError ||
      error instanceof BillingAdapterContractError
    ) {
      return errorResponse(error);
    }
    console.error(
      "[billing-adapter] provider exchange failed",
      safeContractCode(error, "internal"),
    );
    return Response.json(
      { error: "billing_adapter_internal_error" },
      { status: 503 },
    );
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error) => {
  if (error instanceof BillingAdapterWorkerError || error instanceof BillingAdapterContractError) {
    return errorResponse(error);
  }
  console.error("[billing-adapter] unhandled request failure", "internal");
  return Response.json(
    { error: "billing_adapter_internal_error" },
    { status: 503 },
  );
});

export { app as billingAdapterApp };
export default { fetch: app.fetch };
