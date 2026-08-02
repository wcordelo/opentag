import { Hono } from "hono";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { PlatformStateDO } from "../../../src/platform/platform-state-do.js";
import {
  type PlatformEffectStateClient,
  PlatformEffectRunnerError,
  runPlatformEffect,
  validatePlatformEffectRunRequest,
} from "../../../src/platform/effect-runner.js";
import type {
  PlatformEffectClaim,
  PlatformEffectReceipt,
} from "../../../src/platform/layer3-contract.js";
import {
  PLATFORM_MARKETPLACE_OBJECT_NAME,
  platformTenantObjectName,
} from "../../../src/platform/platform-state-do.js";
import {
  enqueuePlatformEffectWakeup,
  type PlatformEffectWakeup,
} from "../../../src/platform/effect-dispatch.js";
import type { Queue } from "@cloudflare/workers-types";

type Env = {
  Bindings: {
    PLATFORM_STATE: DurableObjectNamespace<PlatformStateDO>;
    PLATFORM_EFFECTS_QUEUE?: Queue<PlatformEffectWakeup>;
    EFFECTOR_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

const app = new Hono<Env>();

function requireEffectorAuth(c: { env: Env["Bindings"]; req: { header(name: string): string | undefined } }): Response | undefined {
  const expected = c.env.EFFECTOR_AUTH_TOKEN;
  if (!expected) return Response.json({ error: "effecter_unconfigured" }, { status: 503 });
  if (c.req.header("authorization") !== `Bearer ${expected}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return undefined;
}

function effectObjectName(request: ReturnType<typeof validatePlatformEffectRunRequest>): string {
  return request.scope === "platform"
    ? PLATFORM_MARKETPLACE_OBJECT_NAME
    : platformTenantObjectName(request.tenantId!);
}

function stateClient(
  stub: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
): PlatformEffectStateClient {
  async function call<T>(path: string, body: unknown): Promise<T> {
    const response = await stub.fetch(`https://platform-state${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.error === "string" && /^[a-z][a-z0-9_.-]{0,127}$/.test(payload.error)
        ? payload.error
        : "platform_state_request_failed";
      const status = response.status === 409 ? 409 : response.status === 503 ? 503 : 400;
      throw new PlatformEffectRunnerError(code, status);
    }
    return payload as T;
  }
  return {
    claim: (body) => call<PlatformEffectClaim>("/effect/claim", body),
    complete: (body) => call<{ ok: true; duplicate: boolean; receipt: PlatformEffectReceipt }>("/effect/complete", body),
    fail: (body) => call<{ ok: true; receipt: PlatformEffectReceipt }>("/effect/fail", body),
  };
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    role: "platform-effecter",
    configured: Boolean(c.env.EFFECTOR_AUTH_TOKEN),
    effectQueueConfigured: Boolean(c.env.PLATFORM_EFFECTS_QUEUE),
    adapterKinds: [],
    providerEffectsEnabled: false,
  }),
);

app.post("/run", async (c) => {
  const authError = requireEffectorAuth(c);
  if (authError) return authError;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  let request: ReturnType<typeof validatePlatformEffectRunRequest>;
  try {
    request = validatePlatformEffectRunRequest(body);
  } catch (error) {
    return c.json({ error: error instanceof PlatformEffectRunnerError ? error.code : "effect_run_request_invalid" }, 400);
  }
  const stub = c.env.PLATFORM_STATE.get(
    c.env.PLATFORM_STATE.idFromName(effectObjectName(request)),
  ) as unknown as { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  try {
    // No provider adapter is registered until custody/provider decisions are
    // approved. A live invocation therefore closes the intent as an explicit
    // terminal configuration failure, never as a fabricated success.
    const result = await runPlatformEffect({
      request,
      state: stateClient(stub),
      adapters: {},
    });
    if (
      result.receipt.status === "failed" &&
      result.receipt.retryable &&
      c.env.PLATFORM_EFFECTS_QUEUE
    ) {
      await enqueuePlatformEffectWakeup(
        c.env.PLATFORM_EFFECTS_QUEUE,
        effectObjectName(request),
        Math.min(900, Math.max(1, Math.ceil(
          (Date.parse(result.receipt.availableAt) - Date.now()) / 1_000,
        ))),
      );
    }
    return c.json(result);
  } catch (error) {
    if (error instanceof PlatformEffectRunnerError) {
      return c.json({ error: error.code }, error.status);
    }
    console.error("[platform-effecter] run failed", error instanceof Error ? error.message : "unknown");
    return c.json({ error: "platform_effecter_internal_error" }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("[platform-effecter] request failed", error instanceof Error ? error.message : "unknown");
  return c.json({ error: "platform_effecter_internal_error" }, 503);
});

export default { fetch: app.fetch };
