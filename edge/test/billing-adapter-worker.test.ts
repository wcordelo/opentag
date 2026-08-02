import { describe, expect, it, vi } from "vitest";
import {
  validateBillingAdapterReceipt,
  validateBillingAdapterRequest,
  type BillingAdapterReceipt,
  type BillingAdapterRequest,
} from "../src/platform/billing-adapter-contract.js";

const { default: worker } = await import("../workers/billing-adapter/src/index.js");

const request: BillingAdapterRequest = validateBillingAdapterRequest({
  schemaVersion: 1,
  operation: "meter",
  intentId: "effect:billing-meter:event-1",
  idempotencyKey: "billing-meter:meter-1",
  tenantId: "tenant-1",
  eventId: "event-1",
  executionId: "execution-1",
  tier: 1,
  metric: "knowledge_query",
  quantity: 2,
  unit: "count",
  planId: "plan-standard",
  planRevision: 3,
  amountMinor: 1250,
  currency: "USD",
  occurredAt: "2026-08-01T22:00:00.000Z",
});

const receipt: BillingAdapterReceipt = validateBillingAdapterReceipt({
  schemaVersion: 1,
  operation: "meter",
  intentId: request.intentId,
  tenantId: request.tenantId,
  eventId: request.eventId,
  idempotencyKey: request.idempotencyKey,
  executionId: request.executionId,
  planId: request.planId,
  planRevision: request.planRevision,
  amountMinor: request.amountMinor,
  currency: request.currency,
  provider: "billing-test",
  externalReceiptRef: "billing:evt-1",
  outcome: "accepted",
  reconciledAt: "2026-08-01T22:00:01.000Z",
});

type ProviderBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

function provider(
  response: Response | (() => Promise<Response>),
): { binding: ProviderBinding; calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> } {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  return {
    calls,
    binding: {
      async fetch(input, init) {
        calls.push({ input, init });
        return typeof response === "function" ? response() : response;
      },
    },
  };
}

async function callWorker(
  path: string,
  options: {
    internalToken?: string;
    providerBinding?: ProviderBinding;
    providerToken?: string;
    authorization?: string;
    body?: unknown;
  } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await worker.fetch(new Request(`https://billing-adapter${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), {
    ...(options.internalToken === undefined ? {} : { BILLING_ADAPTER_AUTH_TOKEN: options.internalToken }),
    ...(options.providerBinding === undefined ? {} : { BILLING_PROVIDER_ADAPTER: options.providerBinding }),
    ...(options.providerToken === undefined ? {} : { BILLING_PROVIDER_ADAPTER_AUTH_TOKEN: options.providerToken }),
  } as never, {} as never);
  const text = await response.text();
  return {
    response,
    body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>,
  };
}

describe("billing adapter Worker", () => {
  it("reports only binding presence and stays disabled by default", async () => {
    const disabled = await callWorker("/health", { internalToken: "internal" });
    expect(disabled.body).toMatchObject({
      ok: true,
      role: "billing-adapter",
      configured: true,
      providerAdapterConfigured: false,
    });

    const enabledProvider = provider(Response.json(receipt));
    const enabled = await callWorker("/health", {
      internalToken: "internal",
      providerBinding: enabledProvider.binding,
      providerToken: "provider-binding-token",
    });
    expect(enabled.body).toMatchObject({
      configured: true,
      providerAdapterConfigured: true,
    });
  });

  it("authenticates the caller and fails closed without a provider binding", async () => {
    const missingAuth = await callWorker("/meter", { body: request });
    expect(missingAuth.response.status).toBe(503);
    expect(missingAuth.body.error).toBe("billing_adapter_auth_unconfigured");

    const wrongAuth = await callWorker("/meter", {
      internalToken: "internal",
      authorization: "Bearer wrong",
      body: request,
    });
    expect(wrongAuth.response.status).toBe(401);
    expect(wrongAuth.body.error).toBe("unauthorized");

    const absentProvider = await callWorker("/meter", {
      internalToken: "internal",
      authorization: "Bearer internal",
      body: request,
    });
    expect(absentProvider.response.status).toBe(503);
    expect(absentProvider.body.error).toBe("billing_provider_adapter_unconfigured");

    const absentProviderToken = provider(Response.json(receipt));
    const missingProviderToken = await callWorker("/meter", {
      internalToken: "internal",
      authorization: "Bearer internal",
      providerBinding: absentProviderToken.binding,
      body: request,
    });
    expect(missingProviderToken.response.status).toBe(503);
    expect(missingProviderToken.body.error).toBe("billing_provider_adapter_unconfigured");
    expect(absentProviderToken.calls).toHaveLength(0);
  });

  it("forwards the fixed request with a separate binding bearer and validates the receipt", async () => {
    const upstream = provider(Response.json(receipt));
    const result = await callWorker("/meter", {
      internalToken: "internal",
      authorization: "Bearer internal",
      providerBinding: upstream.binding,
      providerToken: "provider-binding-token",
      body: request,
    });

    expect(result.response.status).toBe(202);
    expect(result.body).toMatchObject({ ok: true, operation: "meter" });
    expect(result.body.receipt).toEqual(receipt);
    expect(upstream.calls).toHaveLength(1);
    expect(String(upstream.calls[0]!.input)).toBe("https://billing-provider-adapter/meter");
    const init = upstream.calls[0]!.init!;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer provider-binding-token",
    );
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it("rejects a provider receipt mismatch without exposing provider response data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const upstream = provider(Response.json({
        ...receipt,
        tenantId: "tenant-other",
        providerSecret: "must-not-be-logged",
      }));
      const result = await callWorker("/meter", {
        internalToken: "internal",
        authorization: "Bearer internal",
        providerBinding: upstream.binding,
        providerToken: "provider-binding-token",
        body: request,
      });

      expect(result.response.status).toBe(503);
      expect(result.body.error).toBe("billing_provider_receipt_invalid");
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("must-not-be-logged");
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("provider-binding-token");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("treats a malformed provider response as an unavailable boundary", async () => {
    const upstream = provider(new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await callWorker("/meter", {
      internalToken: "internal",
      authorization: "Bearer internal",
      providerBinding: upstream.binding,
      providerToken: "provider-binding-token",
      body: request,
    });

    expect(result.response.status).toBe(503);
    expect(result.body.error).toBe("billing_provider_receipt_invalid");
  });

  it("does not call the provider for an arbitrary request field", async () => {
    const upstream = provider(Response.json(receipt));
    const result = await callWorker("/meter", {
      internalToken: "internal",
      authorization: "Bearer internal",
      providerBinding: upstream.binding,
      providerToken: "provider-binding-token",
      body: { ...request, payload: { cardNumber: "must-not-cross-boundary" } },
    });

    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe("billing_adapter_request_field_invalid");
    expect(upstream.calls).toHaveLength(0);
  });
});
