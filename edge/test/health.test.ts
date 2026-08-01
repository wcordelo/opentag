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
      KNOWLEDGE_RECONCILIATION_TEAM_IDS: "T123",
      SUPERMEMORY_URL: "https://memory.example.test",
      BUZZ_RELAY_HTTP_BASE_URL: "https://relay.example.test",
      BUZZ_CHANNEL_TENANT_MAP: "{\"C123\":\"tenant\"}",
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
        repositoryConfigured: true,
        nativeNanocodexConfigured: false,
      },
      knowledge: {
        namespaceConfigured: false,
        queueDeliveryConfigured: true,
        reconciliationConfigured: true,
        searchEndpointConfigured: true,
        actorTokenConfigured: false,
      },
      buzz: {
        relayConfigured: true,
        tenantDirectoryConfigured: true,
      },
      durability: {
        botStateConfigured: false,
        sessionEventsConfigured: false,
        deferredIngressConfigured: false,
        slackRateLimitConfigured: false,
      },
    });
  });

  it("does not treat incomplete optional contracts as ready", () => {
    expect(buildRuntimeCapabilityEvidence({
      KNOWLEDGE_QUEUE_NAME: "knowledge",
      KNOWLEDGE_DLQ_NAME: "wrong-dlq-name",
      KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED: "true",
    }).knowledge).toEqual({
      namespaceConfigured: false,
      queueDeliveryConfigured: false,
      reconciliationConfigured: false,
      searchEndpointConfigured: false,
      actorTokenConfigured: false,
    });
  });
});
