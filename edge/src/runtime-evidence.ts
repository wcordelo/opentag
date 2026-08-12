import type { Env } from "./env.js";
import { resolveAllowedRedirectOriginsEnv } from "./platform/oauth-state.js";
import { isPlatformEffectQueueName } from "./platform/effect-dispatch.js";

export type RuntimeCapabilityEvidence = Readonly<{
  version: 1;
  environmentConfigured: boolean;
  agent: Readonly<{
    serviceBindingConfigured: boolean;
    urlConfigured: boolean;
    modelConfigured: boolean;
  }>;
  harness: Readonly<{
    serviceBindingConfigured: boolean;
    urlConfigured: boolean;
    authConfigured: boolean;
    repositoryConfigured: boolean;
    nativeNanocodexConfigured: boolean;
  }>;
  credentialBroker: Readonly<{
    serviceBindingConfigured: boolean;
    authConfigured: boolean;
  }>;
  knowledge: Readonly<{
    namespaceConfigured: boolean;
    queueDeliveryConfigured: boolean;
    reconciliationConfigured: boolean;
    reconciliationTriggerConfigured: boolean;
    searchEndpointConfigured: boolean;
    searchServiceBindingConfigured: boolean;
    codeGraphServiceBindingConfigured: boolean;
    codeGraphConfigured: boolean;
    consumerPaused: boolean;
    indexGenerationConfigured: boolean;
    actorTokenConfigured: boolean;
    observerConfigured: boolean;
  }>;
  platformEffects: Readonly<{
    stateNamespaceConfigured: boolean;
    queueConfigured: boolean;
    effecterConfigured: boolean;
    dispatchConfigured: boolean;
  }>;
  buzz: Readonly<{
    signerConfigured: boolean;
    relayConfigured: boolean;
    allowedRelayOriginConfigured: boolean;
    tenantDirectoryConfigured: boolean;
    wakeConfigured: boolean;
  }>;
  oauth: Readonly<{
    stateNamespaceConfigured: boolean;
    allowedRedirectOriginsConfigured: boolean;
  }>;
  durability: Readonly<{
    botStateConfigured: boolean;
    sessionEventsConfigured: boolean;
    deferredIngressConfigured: boolean;
    slackRateLimitConfigured: boolean;
  }>;
  slack: Readonly<{
    botTokenConfigured: boolean;
    signingSecretConfigured: boolean;
  }>;
  telemetry: Readonly<{
    deliveryMetricsConfigured: boolean;
  }>;
}>;

type RuntimeEvidenceEnv = Partial<Pick<
  Env,
  | "ENVIRONMENT"
  | "AGENT_RUNTIME"
  | "AGENT_URL"
  | "AGENT_MODEL"
  | "HARNESS"
  | "HARNESS_URL"
  | "HARNESS_AUTH_TOKEN"
  | "HARNESS_REPO_URL"
  | "NANOCODEX_NATIVE_RESPONSES"
  | "CONNECTOR_CREDENTIALS"
  | "CONNECTOR_CREDENTIAL_BROKER_TOKEN"
  | "KNOWLEDGE"
  | "WORKSPACE_CONFIG"
  | "DEFERRED_INGRESS"
  | "KNOWLEDGE_QUEUE"
  | "KNOWLEDGE_QUEUE_NAME"
  | "KNOWLEDGE_DLQ_NAME"
  | "KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED"
  | "KNOWLEDGE_RECONCILIATION_CRON"
  | "KNOWLEDGE_RECONCILIATION_TEAM_IDS"
  | "PLATFORM_STATE"
  | "PLATFORM_EFFECTS_QUEUE"
  | "PLATFORM_EFFECTS_QUEUE_NAME"
  | "PLATFORM_EFFECTER"
  | "EFFECTOR_AUTH_TOKEN"
  | "SUPERMEMORY_URL"
  | "SUPERMEMORY_API_KEY"
  | "SUPERMEMORY_MIGRATION_MODE"
  | "SUPERMEMORY"
  | "SUPERMEMORY_SERVICE_AUTH_TOKEN"
  | "SUPERMEMORY_CONSUMER_MODE"
  | "SUPERMEMORY_INDEX_GENERATION"
  | "GRAPHIFY"
  | "GRAPHIFY_SERVICE_AUTH_TOKEN"
  | "KNOWLEDGE_ACTOR_TOKEN_SECRET"
  | "BUZZ_RELAY_HTTP_BASE_URL"
  | "BUZZ_OPEN_TAG_SIGNER_SECRET"
  | "BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN"
  | "BUZZ_CHANNEL_TENANT_MAP"
  | "OAUTH_STATE"
  | "OAUTH_ALLOWED_REDIRECT_ORIGINS"
  | "BOT_STATE"
  | "SESSION_EVENTS"
  | "DEFERRED_INGRESS"
  | "SLACK_RATE_LIMIT"
  | "SLACK_BOT_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "DELIVERY_METRICS"
>>;

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function validEnvironment(value: string | undefined): boolean {
  return value === "production" || value === "development" || value === "test";
}

export function buildRuntimeCapabilityEvidence(
  env: RuntimeEvidenceEnv,
): RuntimeCapabilityEvidence {
  return {
    version: 1,
    environmentConfigured: validEnvironment(env.ENVIRONMENT),
    agent: {
      serviceBindingConfigured: Boolean(env.AGENT_RUNTIME),
      urlConfigured: configured(env.AGENT_URL),
      modelConfigured: configured(env.AGENT_MODEL),
    },
    harness: {
      serviceBindingConfigured: Boolean(env.HARNESS),
      urlConfigured: configured(env.HARNESS_URL),
      authConfigured: configured(env.HARNESS_AUTH_TOKEN),
      repositoryConfigured: configured(env.HARNESS_REPO_URL),
      nativeNanocodexConfigured: env.NANOCODEX_NATIVE_RESPONSES?.trim() === "true",
    },
    credentialBroker: {
      serviceBindingConfigured: Boolean(env.CONNECTOR_CREDENTIALS),
      authConfigured: configured(env.CONNECTOR_CREDENTIAL_BROKER_TOKEN),
    },
    knowledge: {
      namespaceConfigured: Boolean(env.KNOWLEDGE),
      queueDeliveryConfigured: Boolean(
        env.KNOWLEDGE_QUEUE &&
        configured(env.KNOWLEDGE_QUEUE_NAME) &&
        configured(env.KNOWLEDGE_DLQ_NAME) &&
        env.KNOWLEDGE_DLQ_NAME?.trim().endsWith("-dlq"),
      ),
      reconciliationConfigured:
        env.KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED?.trim() === "true" &&
        configured(env.KNOWLEDGE_RECONCILIATION_TEAM_IDS) &&
        configured(env.KNOWLEDGE_RECONCILIATION_CRON),
      reconciliationTriggerConfigured: configured(env.KNOWLEDGE_RECONCILIATION_CRON),
      searchEndpointConfigured: Boolean(
        env.SUPERMEMORY && configured(env.SUPERMEMORY_SERVICE_AUTH_TOKEN),
      ) || Boolean(
        env.SUPERMEMORY_MIGRATION_MODE?.trim() === "true" &&
        configured(env.SUPERMEMORY_URL) &&
        configured(env.SUPERMEMORY_API_KEY),
      ),
      searchServiceBindingConfigured: Boolean(
        env.SUPERMEMORY && configured(env.SUPERMEMORY_SERVICE_AUTH_TOKEN),
      ),
      codeGraphServiceBindingConfigured: Boolean(env.GRAPHIFY),
      codeGraphConfigured: Boolean(
        env.GRAPHIFY && configured(env.GRAPHIFY_SERVICE_AUTH_TOKEN),
      ),
      consumerPaused: env.SUPERMEMORY_CONSUMER_MODE?.trim() === "paused",
      indexGenerationConfigured: configured(env.SUPERMEMORY_INDEX_GENERATION),
      actorTokenConfigured: configured(env.KNOWLEDGE_ACTOR_TOKEN_SECRET),
      observerConfigured: Boolean(
        env.KNOWLEDGE && (env.DEFERRED_INGRESS || env.WORKSPACE_CONFIG),
      ),
    },
    platformEffects: {
      stateNamespaceConfigured: Boolean(env.PLATFORM_STATE),
      queueConfigured: Boolean(
        env.PLATFORM_EFFECTS_QUEUE && configured(env.PLATFORM_EFFECTS_QUEUE_NAME),
      ) && isPlatformEffectQueueName(env.PLATFORM_EFFECTS_QUEUE_NAME),
      effecterConfigured: Boolean(env.PLATFORM_EFFECTER),
      dispatchConfigured: Boolean(
        env.PLATFORM_STATE &&
        env.PLATFORM_EFFECTS_QUEUE &&
        isPlatformEffectQueueName(env.PLATFORM_EFFECTS_QUEUE_NAME) &&
        env.PLATFORM_EFFECTER &&
        configured(env.EFFECTOR_AUTH_TOKEN),
      ),
    },
    buzz: {
      signerConfigured: configured(env.BUZZ_OPEN_TAG_SIGNER_SECRET),
      relayConfigured: configured(env.BUZZ_RELAY_HTTP_BASE_URL),
      allowedRelayOriginConfigured: configured(env.BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN),
      tenantDirectoryConfigured: configured(env.BUZZ_CHANNEL_TENANT_MAP),
      wakeConfigured: Boolean(
        configured(env.BUZZ_OPEN_TAG_SIGNER_SECRET) &&
        configured(env.BUZZ_RELAY_HTTP_BASE_URL) &&
        configured(env.BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN) &&
        configured(env.BUZZ_CHANNEL_TENANT_MAP) &&
        env.BOT_STATE,
      ),
    },
    oauth: {
      stateNamespaceConfigured: Boolean(env.OAUTH_STATE),
      allowedRedirectOriginsConfigured:
        resolveAllowedRedirectOriginsEnv(env.OAUTH_ALLOWED_REDIRECT_ORIGINS).origins.length > 0,
    },
    durability: {
      botStateConfigured: Boolean(env.BOT_STATE),
      sessionEventsConfigured: Boolean(env.SESSION_EVENTS),
      deferredIngressConfigured: Boolean(env.DEFERRED_INGRESS),
      slackRateLimitConfigured: Boolean(env.SLACK_RATE_LIMIT),
    },
    slack: {
      botTokenConfigured: configured(env.SLACK_BOT_TOKEN),
      signingSecretConfigured: configured(env.SLACK_SIGNING_SECRET),
    },
    telemetry: {
      deliveryMetricsConfigured: Boolean(env.DELIVERY_METRICS),
    },
  };
}
