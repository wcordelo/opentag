import { describe, expect, it } from "vitest";
import { bindRequestContext, slackTurnIdentitySync } from "../src/request-context.js";
import {
  PlatformContractError,
  canonicalInternalPrincipalId,
  canonicalInternalTenantId,
  requireActiveTenantLocator,
  requireCurrentTenantLocatorVersion,
  validateExternalSubject,
  validatePlatformRequestContext,
  validateVerifiedIdentityLink,
} from "../src/platform/contract.js";
import {
  adaptSlackPermissionSnapshotV1,
  adaptVerifiedSlackRequestContext,
  adaptVerifiedSlackRequestContextFromPlatformState,
  adaptVerifiedSlackRequestContextFromRegistry,
} from "../src/platform/slack-v1-adapter.js";
import { bindPermissionSnapshot } from "../src/permissions/context.js";
import { buildPermissionSnapshot } from "../src/permissions/snapshot.js";
import { DEFAULT_BUNDLE } from "../src/config/access-bundle.js";

const TENANT = canonicalInternalTenantId("11111111-1111-4111-8111-111111111111");
const PRINCIPAL = canonicalInternalPrincipalId("22222222-2222-4222-8222-222222222222");
const NOW = new Date("2026-07-30T15:00:00.000Z");

function principal() {
  return {
    tenantId: TENANT,
    principalId: PRINCIPAL,
    kind: "human" as const,
    status: "active" as const,
    authorizationVersion: 3,
  };
}

function identityLink(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    principalId: PRINCIPAL,
    subject: {
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
    },
    proofType: "admin_attestation",
    proofDigest: "sha256:link-proof",
    verifiedAt: "2026-07-30T14:00:00.000Z",
    identityLinkVersion: 7,
    ...overrides,
  };
}

function turn() {
  return {
    record: {
      channelId: "C1",
      threadKey: "tenant:T1:slack:C1:1.0",
      conversationKey: "conversation-1",
      executionId: "execution-1",
      registeredAt: 1,
    },
  };
}

function requestContext(overrides: Record<string, unknown> = {}) {
  return {
    platform: "slack",
    externalTenantId: "T1",
    externalConversationId: "C1",
    externalThreadId: "1.0",
    externalEventId: "Ev1",
    actor: identityLink().subject,
    principal: principal(),
    identityLink: identityLink(),
    tenantLocatorVersion: 2,
    verifiedIngress: {
      method: "slack_signature_v0",
      evidenceDigest: "sha256:ingress-proof",
      verifiedAt: "2026-07-30T15:00:00.000Z",
    },
    preAdmittedTurn: turn(),
    ...overrides,
  };
}

function v1Snapshot() {
  return buildPermissionSnapshot({
    teamId: "T1",
    channelId: "C1",
    actor: { kind: "slack_user", userId: "U1" },
    config: {
      teamId: "T1",
      channelId: "C1",
      systemPrompt: "",
      policies: { allowMemoryWrite: false, allowTasks: false },
      accessBundleId: DEFAULT_BUNDLE.id,
      updatedAt: "now",
    },
    bundle: DEFAULT_BUNDLE,
    allToolNames: ["show_status"],
    allowedTools: ["show_status"],
    runtime: { harnessConnected: false },
    generatedAt: "2026-07-30T15:00:00.000Z",
  });
}

function admittedSlackRequest(overrides: Record<string, unknown> = {}) {
  const base = bindRequestContext({}, {
    teamId: "T1",
    requesterId: "U1",
    inbound: { channel: "C1", ts: "1.1", threadTs: "1.0", identity: "Ev1" },
  });
  const identity = slackTurnIdentitySync(base, "C1");
  return bindRequestContext({}, {
    teamId: "T1",
    requesterId: "U1",
    inbound: { channel: "C1", ts: "1.1", threadTs: "1.0", identity: "Ev1" },
    preAdmittedTurn: {
      record: {
        channelId: "C1",
        threadKey: "tenant:T1:slack:C1:1.0",
        conversationKey: "conversation-1",
        executionId: identity.executionId,
        registeredAt: 1,
      },
    },
    ...overrides,
  });
}

function slackAdapterInput(overrides: Record<string, unknown> = {}) {
  return {
    request: admittedSlackRequest(),
    channelId: "C1",
    threadId: "1.0",
    eventId: "Ev1",
    locator: { platform: "slack" as const, platformTenantId: "T1", tenantId: TENANT, version: 2, status: "active" as const },
    principal: principal(),
    identityLink: validateVerifiedIdentityLink(identityLink(), NOW),
    verifiedIngress: { method: "slack_signature_v0", evidenceDigest: "sha256:ingress-proof", verifiedAt: "2026-07-30T15:00:00.000Z" },
    ...overrides,
  };
}

describe("platform-neutral identity contracts", () => {
  it("accepts only an active explicit identity link and matching verified ingress", () => {
    const context = validatePlatformRequestContext(requestContext(), NOW);
    expect(context).toMatchObject({
      platform: "slack",
      principal: { tenantId: TENANT, principalId: PRINCIPAL, authorizationVersion: 3 },
      identityLink: { identityLinkVersion: 7 },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.preAdmittedTurn.record)).toBe(true);
  });

  it.each([
    ["different event actor", requestContext({ actor: { platform: "slack", platformTenantId: "T1", platformSubjectId: "U2" } }), "platform_request_identity_mismatch"],
    ["revoked link", requestContext({ identityLink: identityLink({ revokedAt: "2026-07-30T14:30:00.000Z" }) }), "platform_identity_link_inactive"],
    ["expired link", requestContext({ identityLink: identityLink({ expiresAt: "2026-07-30T14:30:00.000Z" }) }), "platform_identity_link_inactive"],
    ["legacy tenant inference", requestContext({ principal: { ...principal(), tenantId: "T1" } }), "platform_invalid_internal_tenant"],
    ["non-canonical external identifier", requestContext({ externalTenantId: "T1\n" }), "platform_invalid_external_tenant"],
    ["missing pre-admission", requestContext({ preAdmittedTurn: {} }), "platform_missing_pre_admitted_turn"],
  ])("fails closed for %s", (_label, input, code) => {
    expect(() => validatePlatformRequestContext(input, NOW)).toThrow(
      new PlatformContractError(code),
    );
  });

  it("has a read-only, fail-closed tenant-locator boundary", () => {
    const subject = validateExternalSubject(identityLink().subject);
    expect(requireActiveTenantLocator({
      status: "resolved",
      locator: { platform: "slack", platformTenantId: "T1", tenantId: TENANT, version: 2, status: "active" },
    }, subject)).toMatchObject({ tenantId: TENANT, version: 2 });
    expect(() => requireActiveTenantLocator({ status: "not_found" }, subject))
      .toThrow(new PlatformContractError("platform_tenant_locator_not_found"));
    expect(() => requireActiveTenantLocator({
      status: "resolved",
      locator: { platform: "slack", platformTenantId: "T2", tenantId: TENANT, version: 2, status: "active" },
    }, subject)).toThrow(new PlatformContractError("platform_tenant_locator_mismatch"));
  });

  it("rejects stale tenant-locator versions at an effect boundary", () => {
    const context = validatePlatformRequestContext(requestContext(), NOW);
    expect(() => requireCurrentTenantLocatorVersion(context, 3))
      .toThrow(new PlatformContractError("platform_stale_tenant_locator"));
    expect(() => requireCurrentTenantLocatorVersion(context, 2)).not.toThrow();
  });

  it("does not normalize, colon-join, or accept non-UUID internal IDs", () => {
    expect(() => canonicalInternalTenantId("tenant:one"))
      .toThrow(new PlatformContractError("platform_invalid_internal_tenant"));
    expect(() => canonicalInternalPrincipalId("２２２２２２２２-２２２２-４２２２-８２２２-２２２２２２２２２２２２"))
      .toThrow(new PlatformContractError("platform_invalid_internal_principal"));
    expect(() => validateVerifiedIdentityLink(identityLink({ expiresAt: "2026-07-30T15:00:00.000Z" }), NOW))
      .toThrow(new PlatformContractError("platform_identity_link_inactive"));
    expect(() => validateVerifiedIdentityLink(identityLink({ verifiedAt: "2026-07-30T15:06:00.000Z" }), NOW))
      .toThrow(new PlatformContractError("platform_identity_link_from_future"));
    expect(() => validatePlatformRequestContext(requestContext({
      verifiedIngress: { method: "slack_signature_v0", evidenceDigest: "sha256:ingress-proof", verifiedAt: "not-a-date" },
    }), NOW)).toThrow(new PlatformContractError("platform_invalid_verified_ingress"));
    expect(() => validatePlatformRequestContext(requestContext({
      verifiedIngress: { method: "slack_signature_v0", evidenceDigest: "sha256:ingress-proof", verifiedAt: "2026-07-30T15:06:00.000Z" },
    }), NOW)).toThrow(new PlatformContractError("platform_verified_ingress_from_future"));
  });
});

describe("Slack V1 compatibility", () => {
  it("adapts only an explicitly located and linked Slack request into V2", () => {
    const platformContext = adaptVerifiedSlackRequestContext(slackAdapterInput());
    const snapshot = adaptSlackPermissionSnapshotV1(v1Snapshot(), platformContext);
    expect(snapshot).toMatchObject({
      version: 2,
      scope: { tenantId: TENANT, platform: "slack", externalTenantId: "T1", principalId: PRINCIPAL, tenantLocatorVersion: 2 },
    });
  });

  it("resolves the locator from the server-owned reader before adapting Slack", async () => {
    const { locator: _callerLocator, ...withoutCallerLocator } = slackAdapterInput();
    const context = await adaptVerifiedSlackRequestContextFromRegistry({
      ...withoutCallerLocator,
      locatorReader: {
        resolve: async (subject) => {
          expect(subject).toMatchObject({ platform: "slack", platformTenantId: "T1" });
          return {
            status: "resolved",
            locator: { platform: "slack", platformTenantId: "T1", tenantId: TENANT, version: 2, status: "active" },
          };
        },
      },
    });
    expect(context).toMatchObject({
      platform: "slack",
      principal: { tenantId: TENANT },
      tenantLocatorVersion: 2,
    });
  });

  it("resolves both the tenant and identity link from server-owned readers", async () => {
    const { locator: _callerLocator, principal: _callerPrincipal, identityLink: _callerLink, ...withoutCallerIdentity } = slackAdapterInput();
    const context = await adaptVerifiedSlackRequestContextFromPlatformState({
      ...withoutCallerIdentity,
      tenantLocatorReader: {
        resolve: async () => ({
          status: "resolved" as const,
          locator: { platform: "slack" as const, platformTenantId: "T1", tenantId: TENANT, version: 2, status: "active" as const },
        }),
      },
      identityLinkReader: {
        resolve: async (_subject, tenantId) => {
          expect(tenantId).toBe(TENANT);
          return {
            status: "resolved" as const,
            principal: principal(),
            identityLink: validateVerifiedIdentityLink(identityLink(), NOW),
          };
        },
      },
    });
    expect(context).toMatchObject({
      principal: { tenantId: TENANT, principalId: PRINCIPAL },
      identityLink: { identityLinkVersion: 7 },
      tenantLocatorVersion: 2,
    });
  });

  it("rejects a non-Slack shape at the shared V1 binding boundary", () => {
    const hostile = {
      ...v1Snapshot(),
      scope: { ...v1Snapshot().scope, platform: "buzz" },
    };
    expect(() => bindPermissionSnapshot({}, hostile as never)).toThrow(
      "permission_snapshot_v1_rejects_non_slack",
    );
  });

  it("rejects a missing Slack discriminator at the shared V1 binding boundary", () => {
    const hostile: unknown = {
      ...v1Snapshot(),
      scope: { ...v1Snapshot().scope, platform: undefined },
    };
    expect(() => bindPermissionSnapshot({}, hostile as never)).toThrow(
      new PlatformContractError("permission_snapshot_v1_rejects_non_slack"),
    );
  });

  it.each([
    ["wrong channel", { channelId: "C2" }, "platform_slack_ingress_tuple_mismatch"],
    ["wrong thread", { threadId: "1.1" }, "platform_slack_ingress_tuple_mismatch"],
    ["wrong event", { eventId: "Ev2" }, "platform_slack_ingress_tuple_mismatch"],
    ["foreign admission", {
      request: admittedSlackRequest({
        preAdmittedTurn: { record: { ...turn().record, channelId: "C2" } },
      }),
    }, "platform_slack_pre_admission_mismatch"],
  ])("rejects %s when adapting a verified Slack request", (_label, overrides, code) => {
    expect(() => adaptVerifiedSlackRequestContext(slackAdapterInput(overrides))).toThrow(
      new PlatformContractError(code),
    );
  });

  it("runtime-validates the V2 context before adapting a V1 snapshot", () => {
    expect(() => adaptSlackPermissionSnapshotV1(v1Snapshot(), {
      ...requestContext(),
      tenantLocatorVersion: 0,
    })).toThrow(new PlatformContractError("platform_invalid_tenant_locator_version"));
  });
});
