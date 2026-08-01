import { describe, expect, it } from "vitest";
import { classifyRouterHeuristics } from "../src/router/heuristics.js";
import { buildRuntimeCapabilityEvidence } from "../src/runtime-evidence.js";
import { resolveHarnessCapabilityProfile } from "../src/harness/capability-profile.js";
import { assertTenantId, tenantScope } from "../src/tenancy.js";
import { BuzzContractError, normalizeBuzzInboundEvent } from "../src/buzz/contract.js";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const EVENT = "a".repeat(64);
const PUBKEY = "b".repeat(64);

function buzzEvent(channelId = CHANNEL): Record<string, unknown> {
  return {
    id: EVENT,
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    kind: 9,
    content: "hello",
    tags: [["h", channelId]],
  };
}

describe("cross-repository conformance matrix", () => {
  it("keeps tenant identity and storage scope separate from untrusted formatting", () => {
    expect(assertTenantId("team-A")).toBe("team-A");
    expect(tenantScope("team-A")).toEqual({ teamId: "team-A" });
    for (const value of [" team-A", "team-A ", "team:A", "team\u0000A", ""]) {
      expect(() => assertTenantId(value)).toThrow("tenant_id_invalid");
    }
  });

  it("requires Buzz channel binding before an event becomes application data", () => {
    expect(normalizeBuzzInboundEvent(buzzEvent(), CHANNEL).channelId).toBe(CHANNEL);
    expect(() => normalizeBuzzInboundEvent(buzzEvent("22222222-2222-4222-8222-222222222222"), CHANNEL))
      .toThrowError(new BuzzContractError("buzz_channel_binding_mismatch"));
  });

  it("keeps router classification and Tier 1 gate evidence bounded", () => {
    expect(classifyRouterHeuristics("where is the deploy runbook?")).toMatchObject({ tierDecided: 1, classifierPath: "heuristic" });
    expect(classifyRouterHeuristics("summarize the incident and draft an RFC").classifierPath).toBe("model_required");
    const evidence = buildRuntimeCapabilityEvidence({
      ENVIRONMENT: "production",
      KNOWLEDGE: {} as never,
      KNOWLEDGE_ACTOR_TOKEN_SECRET: "configured",
      SUPERMEMORY_URL: "https://knowledge.example",
    });
    expect(evidence.knowledge).toMatchObject({ namespaceConfigured: true, actorTokenConfigured: true, searchEndpointConfigured: true });
    expect(JSON.stringify(evidence)).not.toContain("configured");
  });

  it("advertises native Nanocodex limits instead of inheriting CLI capabilities", () => {
    expect(resolveHarnessCapabilityProfile({
      harnessType: "nanocodex",
      model: "gpt-5.6-sol",
      nativeResponses: true,
      source: "provider_reported",
    })).toMatchObject({
      mode: "native_responses",
      modelAllowed: true,
      capabilities: {
        toolCalls: false,
        codingWorkspace: false,
        persistentCheckpoint: true,
        fullHistoryReplay: true,
      },
    });
  });
});
