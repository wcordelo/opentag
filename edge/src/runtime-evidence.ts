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
    searchEndpointConfigured: boolean;
    actorTokenConfigured: boolean;
  }>;
  platformEffects: Readonly<{
    stateNamespaceConfigured: boolean;
    queueConfigured: boolean;
    effecterConfigured: boolean;
    dispatchConfigured: boolean;
  }>;
  buzz: Readonly<{
    relayConfigured: boolean;
    tenantDirectoryConfigured: boolean;
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
}>;

type RuntimeEvidenceEnv = Partial<Pick<
  Env,
  | "ENVIRONMENT"
  | "AGENT_RUNTIME"
  | "AGENT_URL"
  | "AGENT_MODEL"
  | "HARNESS"
  | "HARNESS_URL"
  | "HARNESS_REPO_URL"
  | "NANOCODEX_NATIVE_RESPONSES"
  | "CONNECTOR_CREDENTIALS"
  | "CONNECTOR_CREDENTIAL_BROKER_TOKEN"
  | "KNOWLEDGE"
  | "KNOWLEDGE_QUEUE"
  | "KNOWLEDGE_QUEUE_NAME"
  | "KNOWLEDGE_DLQ_NAME"
  | "KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED"
  | "KNOWLEDGE_RECONCILIATION_TEAM_IDS"
  | "PLATFORM_STATE"
  | "PLATFORM_EFFECTS_QUEUE"
  | "PLATFORM_EFFECTS_QUEUE_NAME"
  | "PLATFORM_EFFECTER"
  | "EFFECTOR_AUTH_TOKEN"
  | "SUPERMEMORY_URL"
  | "KNOWLEDGE_ACTOR_TOKEN_SECRET"
  | "BUZZ_RELAY_HTTP_BASE_URL"
  | "BUZZ_CHANNEL_TENANT_MAP"
  | "OAUTH_STATE"
  | "OAUTH_ALLOWED_REDIRECT_ORIGINS"
  | "BOT_STATE"
  | "SESSION_EVENTS"
  | "DEFERRED_INGRESS"
  | "SLACK_RATE_LIMIT"
>>;

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function buildRuntimeCapabilityEvidence(
  env: RuntimeEvidenceEnv,
): RuntimeCapabilityEvidence {
  return {
    version: 1,
    environmentConfigured: configured(env.ENVIRONMENT),
    agent: {
      serviceBindingConfigured: Boolean(env.AGENT_RUNTIME),
      urlConfigured: configured(env.AGENT_URL),
      modelConfigured: configured(env.AGENT_MODEL),
    },
    harness: {
      serviceBindingConfigured: Boolean(env.HARNESS),
      urlConfigured: configured(env.HARNESS_URL),
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
        configured(env.KNOWLEDGE_RECONCILIATION_TEAM_IDS),
      searchEndpointConfigured: configured(env.SUPERMEMORY_URL),
      actorTokenConfigured: configured(env.KNOWLEDGE_ACTOR_TOKEN_SECRET),
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
      relayConfigured: configured(env.BUZZ_RELAY_HTTP_BASE_URL),
      tenantDirectoryConfigured: configured(env.BUZZ_CHANNEL_TENANT_MAP),
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
  };
}
