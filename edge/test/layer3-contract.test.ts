import { describe, expect, it } from "vitest";
import {
  provisioningPlan,
  REQUIRED_PROVISIONING_STEPS,
  validateBillingPlan,
  validateBillingUsageCheck,
  validateConnectorMarketplaceEntry,
  validateConnectorOAuthGrant,
  validateCredentialCustodyReference,
  validateMemoryDeletionRequest,
  validateMemoryGovernancePolicy,
  validatePlatformEffectIntent,
  validateProvisioningRequest,
  validateUsageMeterEvent,
} from "../src/platform/layer3-contract.js";

const now = "2026-08-01T20:00:00.000Z";

describe("Layer 3 platform contracts", () => {
  it("builds a complete idempotent provisioning plan without performing it", () => {
    const request = validateProvisioningRequest({
      schemaVersion: 1,
      requestId: "req-1",
      idempotencyKey: "install-T1-1",
      externalPlatform: "slack",
      externalTenantId: "T1",
      requestedByExternalSubject: "U1",
      isolationMode: "shared_worker_per_tenant_do",
      custodyBackend: "external_kms",
      requestedAt: now,
    });
    expect(provisioningPlan(request)).toEqual(REQUIRED_PROVISIONING_STEPS);
  });

  it("keeps custody references opaque and rejects secret material", () => {
    expect(validateCredentialCustodyReference({
      schemaVersion: 1,
      tenantId: "T1",
      credentialRef: "credential:google_drive:workspace",
      backend: "external_kms",
      provider: "google",
      subject: "acct-1",
      scopes: ["drive.readonly"],
      version: 1,
      status: "active",
      issuedAt: now,
    })).toMatchObject({ credentialRef: "credential:google_drive:workspace", version: 1 });
    expect(() => validateCredentialCustodyReference({
      schemaVersion: 1,
      tenantId: "T1",
      credentialRef: "credential:x:y",
      backend: "external_kms",
      provider: "x",
      subject: "s",
      scopes: [],
      version: 1,
      status: "active",
      issuedAt: now,
      accessToken: "never",
    })).toThrow("secret_material_forbidden");
    expect(() => validateCredentialCustodyReference({
      schemaVersion: 1,
      tenantId: "T1",
      credentialRef: "credential:x:y",
      backend: "external_kms",
      provider: "x",
      subject: "s",
      scopes: [],
      version: 1,
      status: "active",
      issuedAt: now,
      Authorization: "never",
    })).toThrow("secret_material_forbidden");
  });

  it("validates curated connector OAuth and trust metadata", () => {
    expect(validateConnectorMarketplaceEntry({
      schemaVersion: 1,
      connectorId: "google_drive",
      provider: "google",
      version: "v1",
      status: "curated",
      authMode: "oauth2",
      actions: ["search"],
      oauthScopes: ["drive.readonly"],
      trustReviewRef: "review:google-drive:v1",
    })).toMatchObject({ status: "curated", authMode: "oauth2" });
    expect(validateConnectorOAuthGrant({
      schemaVersion: 1,
      tenantId: "T1",
      principalId: "U1",
      connectorId: "google_drive",
      credentialRef: "credential:google_drive:workspace",
      providerSubject: "acct-1",
      scopes: ["drive.readonly"],
      version: 1,
      status: "active",
      issuedAt: now,
    })).toMatchObject({ connectorId: "google_drive", status: "active" });
  });

  it("links metering to the same durable execution identity", () => {
    expect(validateUsageMeterEvent({
      schemaVersion: 1,
      eventId: "meter-1",
      idempotencyKey: "exec-1:knowledge:1",
      tenantId: "T1",
      executionId: "exec-1",
      tier: 1,
      metric: "knowledge_query",
      quantity: 1,
      unit: "count",
      planRevision: 1,
      occurredAt: now,
    })).toMatchObject({ executionId: "exec-1", tier: 1 });
  });

  it("validates versioned billing periods and bounded limits", () => {
    expect(validateBillingPlan({
      schemaVersion: 1,
      tenantId: "T1",
      planId: "starter",
      revision: 2,
      status: "active",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      limits: {
        knowledge_query: 100,
        agent_tokens: 100_000,
        connector_calls: null,
        container_ms: 1_000_000,
      },
      overagePolicy: "block",
      updatedAt: now,
    })).toMatchObject({ planId: "starter", revision: 2 });
    expect(validateBillingUsageCheck({
      schemaVersion: 1,
      tenantId: "T1",
      metric: "knowledge_query",
      quantity: 3,
      planRevision: 2,
      occurredAt: "2026-08-01T20:00:00.000Z",
    })).toMatchObject({ quantity: 3, planRevision: 2 });
    expect(() => validateBillingPlan({
      schemaVersion: 1,
      tenantId: "T1",
      planId: "starter",
      revision: 2,
      status: "active",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      limits: {
        knowledge_query: 100,
        agent_tokens: 100_000,
        connector_calls: null,
        container_ms: 1_000_000,
      },
      overagePolicy: "block",
      updatedAt: now,
    })).toThrow("billing_period_invalid");
    expect(() => validateBillingPlan({
      schemaVersion: 1,
      tenantId: "T1",
      planId: "starter",
      revision: 2,
      status: "active",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      limits: {
        knowledge_query: 100,
        agent_tokens: 100_000,
        connector_calls: null,
        container_ms: 1_000_000,
      },
      overagePolicy: "block",
      updatedAt: now,
      accessToken: "never",
    })).toThrow("secret_material_forbidden");
  });

  it("makes memory retention and deletion explicit, not best effort", () => {
    expect(validateMemoryGovernancePolicy({
      schemaVersion: 1,
      tenantId: "T1",
      retentionDays: 365,
      optedOutChannelIds: ["C-private"],
      deletionEpoch: 2,
      adminVisibility: "metadata_only",
      updatedAt: now,
    })).toMatchObject({ retentionDays: 365, deletionEpoch: 2 });
    expect(validateMemoryDeletionRequest({
      schemaVersion: 1,
      requestId: "delete-1",
      idempotencyKey: "delete-1",
      tenantId: "T1",
      sourceKeys: ["slack:T1:C1:123"],
      requestedByPrincipalId: "U1",
      requestedAt: now,
      deletionEpoch: 2,
    })).toMatchObject({ sourceKeys: ["slack:T1:C1:123"] });
  });

  it("limits platform effects to bounded secret-free metadata", () => {
    expect(validatePlatformEffectIntent({
      schemaVersion: 1,
      intentId: "effect-1",
      idempotencyKey: "effect-key-1",
      scope: "tenant",
      tenantId: "T1",
      kind: "memory_deletion",
      targetRef: "memory-deletion:delete-1",
      metadata: {
        deletionEpoch: 2,
        requestId: "delete-1",
        nested: { sourceCount: 1 },
      },
      requestedAt: now,
    })).toMatchObject({ kind: "memory_deletion", metadata: { deletionEpoch: 2 } });
    expect(() => validatePlatformEffectIntent({
      schemaVersion: 1,
      intentId: "effect-2",
      idempotencyKey: "effect-key-2",
      scope: "tenant",
      tenantId: "T1",
      kind: "connector_oauth",
      targetRef: "google_drive",
      metadata: { nested: { accessToken: "never" } },
      requestedAt: now,
    })).toThrow("effect_metadata_key_invalid");
    expect(() => validatePlatformEffectIntent({
      schemaVersion: 1,
      intentId: "effect-3",
      idempotencyKey: "effect-key-3",
      scope: "platform",
      tenantId: "T1",
      kind: "marketplace",
      targetRef: "google_drive",
      metadata: {},
      requestedAt: now,
    })).toThrow("effect_platform_tenant_forbidden");
  });
});
