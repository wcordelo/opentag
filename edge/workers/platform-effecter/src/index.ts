import { Hono } from "hono";
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import type { PlatformStateDO } from "../../../src/platform/platform-state-do.js";
import {
  createRemotePlatformEffectAdapter,
  type PlatformEffectAdapters,
  type PlatformEffectStateClient,
  PlatformEffectRunnerError,
  runPlatformEffect,
  validatePlatformEffectRunRequest,
} from "../../../src/platform/effect-runner.js";
import type {
  PlatformEffectClaim,
  PlatformEffectKind,
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
    /** Each effect family has its own least-privilege provider boundary. */
    PROVISIONING_EFFECT_ADAPTER?: Fetcher;
    PROVISIONING_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    IDENTITY_CUSTODY_EFFECT_ADAPTER?: Fetcher;
    IDENTITY_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    CREDENTIAL_CUSTODY_EFFECT_ADAPTER?: Fetcher;
    CREDENTIAL_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    CONNECTOR_OAUTH_EFFECT_ADAPTER?: Fetcher;
    CONNECTOR_OAUTH_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    CONNECTOR_EFFECT_ADAPTER?: Fetcher;
    CONNECTOR_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    MARKETPLACE_EFFECT_ADAPTER?: Fetcher;
    MARKETPLACE_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    BILLING_METER_EFFECT_ADAPTER?: Fetcher;
    BILLING_METER_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    MEMORY_DELETION_EFFECT_ADAPTER?: Fetcher;
    MEMORY_DELETION_EFFECT_ADAPTER_AUTH_TOKEN?: string;
    ENVIRONMENT?: string;
  };
};

const app = new Hono<Env>();

const EFFECT_ADAPTER_KINDS: readonly PlatformEffectKind[] = [
  "provisioning",
  "identity_custody",
  "credential_custody",
  "connector_oauth",
  "connector_effect",
  "marketplace",
  "billing_meter",
  "memory_deletion",
];

type EffectAdapterBindingName =
  | "PROVISIONING_EFFECT_ADAPTER"
  | "IDENTITY_CUSTODY_EFFECT_ADAPTER"
  | "CREDENTIAL_CUSTODY_EFFECT_ADAPTER"
  | "CONNECTOR_OAUTH_EFFECT_ADAPTER"
  | "CONNECTOR_EFFECT_ADAPTER"
  | "MARKETPLACE_EFFECT_ADAPTER"
  | "BILLING_METER_EFFECT_ADAPTER"
  | "MEMORY_DELETION_EFFECT_ADAPTER";

type EffectAdapterAuthName =
  | "PROVISIONING_EFFECT_ADAPTER_AUTH_TOKEN"
  | "IDENTITY_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN"
  | "CREDENTIAL_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN"
  | "CONNECTOR_OAUTH_EFFECT_ADAPTER_AUTH_TOKEN"
  | "CONNECTOR_EFFECT_ADAPTER_AUTH_TOKEN"
  | "MARKETPLACE_EFFECT_ADAPTER_AUTH_TOKEN"
  | "BILLING_METER_EFFECT_ADAPTER_AUTH_TOKEN"
  | "MEMORY_DELETION_EFFECT_ADAPTER_AUTH_TOKEN";

const EFFECT_ADAPTER_CONFIG: ReadonlyArray<Readonly<{
  kind: PlatformEffectKind;
  binding: EffectAdapterBindingName;
  authToken: EffectAdapterAuthName;
}>> = [
  {
    kind: "provisioning",
    binding: "PROVISIONING_EFFECT_ADAPTER",
    authToken: "PROVISIONING_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "identity_custody",
    binding: "IDENTITY_CUSTODY_EFFECT_ADAPTER",
    authToken: "IDENTITY_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "credential_custody",
    binding: "CREDENTIAL_CUSTODY_EFFECT_ADAPTER",
    authToken: "CREDENTIAL_CUSTODY_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "connector_oauth",
    binding: "CONNECTOR_OAUTH_EFFECT_ADAPTER",
    authToken: "CONNECTOR_OAUTH_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "connector_effect",
    binding: "CONNECTOR_EFFECT_ADAPTER",
    authToken: "CONNECTOR_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "marketplace",
    binding: "MARKETPLACE_EFFECT_ADAPTER",
    authToken: "MARKETPLACE_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "billing_meter",
    binding: "BILLING_METER_EFFECT_ADAPTER",
    authToken: "BILLING_METER_EFFECT_ADAPTER_AUTH_TOKEN",
  },
  {
    kind: "memory_deletion",
    binding: "MEMORY_DELETION_EFFECT_ADAPTER",
    authToken: "MEMORY_DELETION_EFFECT_ADAPTER_AUTH_TOKEN",
  },
];

type AdapterConfigurationState = "configured" | "missing_binding" | "missing_auth" | "unconfigured";

function adapterConfiguration(
  env: Env["Bindings"],
): Record<PlatformEffectKind, AdapterConfigurationState> {
  return Object.fromEntries(EFFECT_ADAPTER_CONFIG.map((config) => {
    const bindingConfigured = Boolean(env[config.binding]);
    const authConfigured = Boolean(env[config.authToken]?.trim());
    const state: AdapterConfigurationState = bindingConfigured && authConfigured
      ? "configured"
      : bindingConfigured
        ? "missing_auth"
        : authConfigured
          ? "missing_binding"
          : "unconfigured";
    return [config.kind, state];
  })) as Record<PlatformEffectKind, AdapterConfigurationState>;
}

function configuredAdapters(env: Env["Bindings"]): PlatformEffectAdapters {
  const adapters: PlatformEffectAdapters = {};
  for (const config of EFFECT_ADAPTER_CONFIG) {
    const binding = env[config.binding];
    const token = env[config.authToken];
    if (binding && token?.trim()) {
      adapters[config.kind] = createRemotePlatformEffectAdapter(binding, token);
    }
  }
  return adapters;
}

function configuredAdapterKinds(
  env: Env["Bindings"],
): PlatformEffectKind[] {
  const states = adapterConfiguration(env);
  return EFFECT_ADAPTER_KINDS.filter((kind) => states[kind] === "configured");
}

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
    renew: (body) => call<{ ok: true; leaseExpiresAt: string; receipt: PlatformEffectReceipt }>("/effect/renew", body),
    fail: (body) => call<{ ok: true; receipt: PlatformEffectReceipt }>("/effect/fail", body),
  };
}

app.get("/health", (c) => {
  const adapterConfigurationState = adapterConfiguration(c.env);
  const adapterKinds = configuredAdapterKinds(c.env);
  return c.json({
    ok: true,
    role: "platform-effecter",
    configured: Boolean(c.env.EFFECTOR_AUTH_TOKEN),
    effectQueueConfigured: Boolean(c.env.PLATFORM_EFFECTS_QUEUE),
    adapterConfigured: adapterKinds.length > 0,
    adapterKinds,
    adapterConfiguration: adapterConfigurationState,
    providerEffectsEnabled: adapterKinds.length > 0,
  });
});

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
    const result = await runPlatformEffect({
      request,
      state: stateClient(stub),
      adapters: configuredAdapters(c.env),
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
