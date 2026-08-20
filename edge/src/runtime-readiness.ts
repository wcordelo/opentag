import type { RuntimeCapabilityEvidence } from "./runtime-evidence.js";
import type { RuntimeDependencyProbes } from "./runtime-probes.js";

export type RuntimeReadinessProfile = "core" | "knowledge" | "full";

export type RuntimeReadiness = Readonly<{
  version: 1;
  profile: RuntimeReadinessProfile;
  ok: boolean;
  blockers: string[];
  checks: Readonly<Record<string, boolean>>;
}>;

export function parseRuntimeReadinessProfile(
  value: string | undefined,
  defaultProfile: RuntimeReadinessProfile,
): RuntimeReadinessProfile | undefined {
  const profile = value?.trim() || defaultProfile;
  return profile === "core" || profile === "knowledge" || profile === "full"
    ? profile
    : undefined;
}

export function evaluateRuntimeReadiness(input: {
  profile: RuntimeReadinessProfile;
  production: boolean;
  durabilityOk: boolean;
  runtime: RuntimeCapabilityEvidence;
  probes?: RuntimeDependencyProbes;
}): RuntimeReadiness {
  const productionAgentBinding = !input.production || input.runtime.agent.serviceBindingConfigured;
  const checks: Record<string, boolean> = {
    environment: input.runtime.environmentConfigured,
    durability: input.durabilityOk,
    slackBotToken: input.runtime.slack.botTokenConfigured,
    slackSigningSecret: input.runtime.slack.signingSecretConfigured,
    agentUrl: input.runtime.agent.urlConfigured,
    agentTarget: input.production
      ? productionAgentBinding
      : input.runtime.agent.serviceBindingConfigured || input.runtime.agent.urlConfigured,
    agentReachable: input.probes?.agentReachable ?? false,
    agentModel: input.runtime.agent.modelConfigured,
    sessionEvents: input.runtime.durability.sessionEventsConfigured,
    deferredIngress: input.runtime.durability.deferredIngressConfigured,
    slackRateLimit: input.runtime.durability.slackRateLimitConfigured,
    deliveryMetrics: input.runtime.telemetry.deliveryMetricsConfigured,
    knowledgeNamespace: input.runtime.knowledge.namespaceConfigured,
    knowledgeQueue: input.runtime.knowledge.queueDeliveryConfigured,
    knowledgeObserver: input.runtime.knowledge.observerConfigured,
  };

  if (input.profile === "knowledge" || input.profile === "full") {
    checks.knowledgeSearchService = input.runtime.knowledge.searchServiceBindingConfigured;
    checks.knowledgeSearchReachable = input.probes?.knowledgeSearchReachable ?? false;
    checks.knowledgeIndexGeneration = input.runtime.knowledge.indexGenerationConfigured;
    checks.knowledgeCodeGraph = input.runtime.knowledge.codeGraphConfigured;
    checks.codeGraphReachable = input.probes?.codeGraphReachable ?? false;
    checks.knowledgeReconciliation = input.runtime.knowledge.reconciliationConfigured;
    checks.knowledgeActorToken = input.runtime.knowledge.actorTokenConfigured;
    checks.knowledgeConsumerActive = !input.runtime.knowledge.consumerPaused;
  }

  if (input.profile === "full") {
    checks.buzzWake = input.runtime.buzz.wakeConfigured;
    checks.platformEffects = input.runtime.platformEffects.dispatchConfigured;
    checks.harnessTarget = input.runtime.harness.serviceBindingConfigured ||
      input.runtime.harness.urlConfigured;
    checks.harnessReachable = input.probes?.harnessReachable ?? false;
    checks.harnessAuth = input.runtime.harness.authConfigured;
    checks.harnessRepository = input.runtime.harness.repositoryConfigured;
    checks.nativeNanocodex = input.runtime.harness.nativeNanocodexConfigured;
    checks.credentialBroker = input.runtime.credentialBroker.serviceBindingConfigured &&
      input.runtime.credentialBroker.authConfigured;
    checks.credentialBrokerReachable = input.probes?.credentialBrokerReachable ?? false;
    checks.platformEffecterReachable = input.probes?.platformEffecterReachable ?? false;
    checks.oauth = input.runtime.oauth.stateNamespaceConfigured &&
      input.runtime.oauth.allowedRedirectOriginsConfigured;
  }

  const blockers = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    version: 1,
    profile: input.profile,
    ok: blockers.length === 0,
    blockers,
    checks,
  };
}
