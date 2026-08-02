import { describe, expect, it, vi } from "vitest";
import { validatePlatformEffectIntent } from "../src/platform/layer3-contract.js";
import type { PlatformEffectClaim, PlatformEffectReceipt } from "../src/platform/layer3-contract.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

const { default: worker } = await import("../workers/platform-effecter/src/index.js");

const intent = validatePlatformEffectIntent({
  schemaVersion: 1,
  intentId: "effect:credential:rotate:worker",
  idempotencyKey: "credential-rotate-worker",
  scope: "tenant",
  tenantId: "tenant-1",
  kind: "credential_custody",
  targetRef: "credential:google:workspace",
  metadata: { operation: "rotate", provider: "google", version: 2 },
  requestedAt: "2026-08-01T22:00:00.000Z",
});

function receipt(status: PlatformEffectReceipt["status"]): PlatformEffectReceipt {
  return {
    schemaVersion: 1,
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    scope: intent.scope,
    tenantId: intent.tenantId,
    kind: intent.kind,
    targetRef: intent.targetRef,
    status,
    attempts: 1,
    retryable: status === "failed",
    availableAt: "2026-08-01T22:00:00.000Z",
    requestedAt: intent.requestedAt,
    updatedAt: "2026-08-01T22:00:00.000Z",
  };
}

const claim: PlatformEffectClaim = {
  intent,
  receipt: receipt("leased"),
  leaseToken: "lease-1",
  leaseOwner: "effecter-1",
  leaseExpiresAt: "2026-08-01T22:05:00.000Z",
};

function environment(token?: string): { bindings: Record<string, unknown>; paths: string[] } {
  const paths: string[] = [];
  const stub = {
    async fetch(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path === "/effect/claim") return Response.json(claim);
      if (path === "/effect/fail") return Response.json({
        ok: true,
        receipt: receipt("failed"),
      });
      return Response.json({ error: "unexpected_path" }, { status: 404 });
    },
  };
  return {
    paths,
    bindings: {
      PLATFORM_STATE: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
      ...(token === undefined ? {} : { EFFECTOR_AUTH_TOKEN: token }),
    },
  };
}

async function fetchWorker(
  path: string,
  options: {
    token?: string;
    body?: unknown;
    authorization?: string;
  } = {},
): Promise<{ response: Response; body: Record<string, unknown>; paths: string[] }> {
  const setup = environment(options.token);
  const response = await worker.fetch(new Request(`https://effecter${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), setup.bindings as never, {} as never);
  return { response, body: await response.json() as Record<string, unknown>, paths: setup.paths };
}

describe("platform effecter Worker", () => {
  it("does not expose an unauthenticated or unconfigured execution boundary", async () => {
    const missing = await fetchWorker("/run", {
      body: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
    });
    expect(missing.response.status).toBe(503);
    expect(missing.body.error).toBe("effecter_unconfigured");

    const wrong = await fetchWorker("/run", {
      token: "expected",
      authorization: "Bearer wrong",
      body: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
    });
    expect(wrong.response.status).toBe(401);
    expect(wrong.body.error).toBe("unauthorized");
  });

  it("claims through the bot ledger and terminally fails without a provider adapter", async () => {
    const result = await fetchWorker("/run", {
      token: "expected",
      authorization: "Bearer expected",
      body: {
        scope: "tenant",
        tenantId: "tenant-1",
        intentId: intent.intentId,
        workerId: "effecter-1",
      },
    });
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "failed",
      adapterConfigured: false,
      errorCode: "effect_adapter_unconfigured",
    });
    expect(result.paths).toEqual(["/effect/claim", "/effect/fail"]);
  });
});
