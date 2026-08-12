import { describe, expect, it } from "vitest";
import { probeDurabilityHealth } from "../src/health.js";
import { buildRuntimeCapabilityEvidence } from "../src/runtime-evidence.js";

function namespace(healthCheck: () => Promise<unknown>) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({ healthCheck }),
  };
}

describe("durability health", () => {
  it("is healthy only when both required bindings answer", async () => {
    await expect(probeDurabilityHealth({
      BOT_STATE: namespace(async () => ({ ok: true })) as never,
      SESSION_EVENTS: namespace(async () => ({ ok: true })) as never,
      DEFERRED_INGRESS: namespace(async () => ({ ok: true })) as never,
      SLACK_RATE_LIMIT: namespace(async () => ({ ok: true })) as never,
    }, 10)).resolves.toEqual({
      ok: true,
      checks: {
        botState: "ok",
        sessionEvents: "ok",
        deferredIngress: "ok",
        slackRateLimit: "ok",
      },
    });
  });

  it("reports a broken SessionEventDO binding instead of static green metadata", async () => {
    await expect(probeDurabilityHealth({
      BOT_STATE: namespace(async () => ({ ok: true })) as never,
      SESSION_EVENTS: namespace(async () => { throw new Error("binding broken"); }) as never,
      DEFERRED_INGRESS: namespace(async () => ({ ok: true })) as never,
      SLACK_RATE_LIMIT: namespace(async () => ({ ok: true })) as never,
    }, 10)).resolves.toEqual({
      ok: false,
      checks: {
        botState: "ok",
        sessionEvents: "error",
        deferredIngress: "ok",
        slackRateLimit: "ok",
      },
    });
  });

  it("probes the platform-state binding when it is configured", async () => {
    await expect(probeDurabilityHealth({
      BOT_STATE: namespace(async () => ({ ok: true })) as never,
      SESSION_EVENTS: namespace(async () => ({ ok: true })) as never,
      DEFERRED_INGRESS: namespace(async () => ({ ok: true })) as never,
      SLACK_RATE_LIMIT: namespace(async () => ({ ok: true })) as never,
      PLATFORM_STATE: namespace(async () => ({ ok: true })) as never,
    }, 10)).resolves.toMatchObject({
      ok: true,
      checks: { platformState: "ok" },
    });
  });

  it("probes the OAuth state binding when it is configured", async () => {
    await expect(probeDurabilityHealth({
      BOT_STATE: namespace(async () => ({ ok: true })) as never,
      SESSION_EVENTS: namespace(async () => ({ ok: true })) as never,
      DEFERRED_INGRESS: namespace(async () => ({ ok: true })) as never,
      SLACK_RATE_LIMIT: namespace(async () => ({ ok: true })) as never,
      OAUTH_STATE: namespace(async () => ({ ok: true })) as never,
    }, 10)).resolves.toMatchObject({
      ok: true,
      checks: { oauthState: "ok" },
    });
  });
});

describe("runtime capability evidence", () => {
  it("reports only bounded configuration presence and never values", () => {
    expect(buildRuntimeCapabilityEvidence({
      ENVIRONMENT: "production",
      AGENT_URL: "https://agent.example.test/private",
      AGENT_MODEL: "gpt-5.5",
      HARNESS_REPO_URL: "https://github.com/example/repo",
      KNOWLEDGE_QUEUE: {} as never,
      KNOWLEDGE_QUEUE_NAME: "knowledge",
      KNOWLEDGE_DLQ_NAME: "knowledge-dlq",
      KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED: "true",
      KNOWLEDGE_RECONCILIATION_CRON: "*/15 * * * *",
      KNOWLEDGE_RECONCILIATION_TEAM_IDS: "T123",
      SUPERMEMORY_URL: "https://memory.example.test",
      SUPERMEMORY_API_KEY: "sm_fixture",
      SUPERMEMORY_MIGRATION_MODE: "true",
      GRAPHIFY: {} as never,
      GRAPHIFY_SERVICE_AUTH_TOKEN: "graphify-service-token",
      BUZZ_RELAY_HTTP_BASE_URL: "https://relay.example.test",
      BUZZ_OPEN_TAG_SIGNER_SECRET: "signer-secret",
      BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN: "https://relay.example.test",
      BUZZ_CHANNEL_TENANT_MAP: "{\"C123\":\"tenant\"}",
      BOT_STATE: {} as never,
      OAUTH_STATE: {} as never,
      OAUTH_ALLOWED_REDIRECT_ORIGINS: "https://app.example.test",
    })).toEqual({
      version: 1,
      environmentConfigured: true,
      agent: {
        serviceBindingConfigured: false,
        urlConfigured: true,
        modelConfigured: true,
      },
      harness: {
        serviceBindingConfigured: false,
        urlConfigured: false,
        authConfigured: false,
        repositoryConfigured: true,
        nativeNanocodexConfigured: false,
      },
      credentialBroker: {
        serviceBindingConfigured: false,
        authConfigured: false,
      },
      knowledge: {
        namespaceConfigured: false,
        queueDeliveryConfigured: true,
        reconciliationConfigured: true,
        reconciliationTriggerConfigured: true,
        searchEndpointConfigured: true,
        searchServiceBindingConfigured: false,
        codeGraphServiceBindingConfigured: true,
        codeGraphConfigured: true,
        consumerPaused: false,
        indexGenerationConfigured: false,
        actorTokenConfigured: false,
        observerConfigured: false,
      },
      platformEffects: {
        stateNamespaceConfigured: false,
        queueConfigured: false,
        effecterConfigured: false,
        dispatchConfigured: false,
      },
      buzz: {
        signerConfigured: true,
        relayConfigured: true,
        allowedRelayOriginConfigured: true,
        tenantDirectoryConfigured: true,
        wakeConfigured: true,
      },
      oauth: {
        stateNamespaceConfigured: true,
        allowedRedirectOriginsConfigured: true,
      },
      durability: {
        botStateConfigured: true,
        sessionEventsConfigured: false,
        deferredIngressConfigured: false,
        slackRateLimitConfigured: false,
      },
      slack: {
        botTokenConfigured: false,
        signingSecretConfigured: false,
      },
      telemetry: {
        deliveryMetricsConfigured: false,
      },
    });
  });

  it("does not treat incomplete optional contracts as ready", () => {
    expect(buildRuntimeCapabilityEvidence({
      KNOWLEDGE_QUEUE_NAME: "knowledge",
      KNOWLEDGE_DLQ_NAME: "wrong-dlq-name",
      KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED: "true",
      BUZZ_OPEN_TAG_SIGNER_SECRET: "signer-secret",
      BUZZ_RELAY_HTTP_BASE_URL: "https://relay.example.test",
      BUZZ_CHANNEL_TENANT_MAP: "{}",
    }).knowledge).toEqual({
      namespaceConfigured: false,
      queueDeliveryConfigured: false,
      reconciliationConfigured: false,
      reconciliationTriggerConfigured: false,
      searchEndpointConfigured: false,
      searchServiceBindingConfigured: false,
      codeGraphServiceBindingConfigured: false,
      codeGraphConfigured: false,
      consumerPaused: false,
      indexGenerationConfigured: false,
      actorTokenConfigured: false,
      observerConfigured: false,
    });
    expect(buildRuntimeCapabilityEvidence({
      BUZZ_OPEN_TAG_SIGNER_SECRET: "signer-secret",
      BUZZ_RELAY_HTTP_BASE_URL: "https://relay.example.test",
      BUZZ_CHANNEL_TENANT_MAP: "{}",
    }).buzz).toEqual({
      signerConfigured: true,
      relayConfigured: true,
      allowedRelayOriginConfigured: false,
      tenantDirectoryConfigured: true,
      wakeConfigured: false,
    });
    const evidence = buildRuntimeCapabilityEvidence({
      CONNECTOR_CREDENTIALS: {} as never,
      CONNECTOR_CREDENTIAL_BROKER_TOKEN: "broker-secret",
      PLATFORM_STATE: {} as never,
      PLATFORM_EFFECTS_QUEUE: {} as never,
      PLATFORM_EFFECTS_QUEUE_NAME: "opentag-platform-effects",
      PLATFORM_EFFECTER: {} as never,
      EFFECTOR_AUTH_TOKEN: "effector-secret",
    });
    expect(evidence.credentialBroker).toEqual({
      serviceBindingConfigured: true,
      authConfigured: true,
    });
    expect(evidence.platformEffects).toEqual({
      stateNamespaceConfigured: true,
      queueConfigured: true,
      effecterConfigured: true,
      dispatchConfigured: true,
    });
  });
});
