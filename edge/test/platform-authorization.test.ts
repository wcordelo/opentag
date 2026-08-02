import { describe, expect, it, vi } from "vitest";
import {
  isConnectorAuthorizationUnavailable,
  loadPlatformConnectorAuthorization,
} from "../src/connectors/platform-authorization.js";
import { bindRequestContext, slackTurnIdentitySync } from "../src/request-context.js";
import { slackObligationThreadKey } from "../src/slack/obligation-thread-key.js";

vi.mock("../src/config/workspace-config-do.js", () => ({
  loadConnectorAuthorization: vi.fn(async (_namespace: unknown, input: Record<string, unknown>) => ({
    labels: {
      credentialRef: REF,
      platformBinding: input.platformBinding,
    },
    credential: workspaceCredential,
  })),
}));

const TENANT = "11111111-1111-5111-8111-111111111111";
const PRINCIPAL = "22222222-2222-5222-8222-222222222222";
const REF = "credential:google:workspace-drive";
const NOW = new Date().toISOString();

const marketplace = {
  schemaVersion: 1,
  connectorId: "google_drive",
  provider: "google",
  version: "2026-08-01",
  status: "curated",
  authMode: "oauth2",
  actions: ["search"],
  oauthScopes: ["drive.readonly"],
  trustReviewRef: "review:drive-read-only",
};

const grant = {
  schemaVersion: 1,
  tenantId: TENANT,
  principalId: PRINCIPAL,
  connectorId: "google_drive",
  marketplaceVersion: marketplace.version,
  credentialRef: REF,
  providerSubject: "google:user:123",
  scopes: ["drive.readonly"],
  version: 4,
  status: "active",
  issuedAt: "2026-08-01T19:00:00.000Z",
  expiresAt: "2099-08-01T21:00:00.000Z",
};

const custodyReference = {
  schemaVersion: 1,
  tenantId: TENANT,
  credentialRef: REF,
  backend: "external_kms",
  provider: "google",
  subject: "google:user:123",
  scopes: ["drive.readonly"],
  version: 9,
  status: "active",
  issuedAt: "2026-08-01T19:00:00.000Z",
  expiresAt: "2099-08-01T21:00:00.000Z",
};

const workspaceCredential = {
  schemaVersion: 1,
  ref: REF,
  provider: "google",
  name: "workspace-drive",
  version: 9,
  status: "active",
  scopes: ["drive.readonly"],
  subject: "google:user:123",
  issuedAt: "2026-08-01T19:00:00.000Z",
  expiresAt: "2099-08-01T21:00:00.000Z",
};

function identityResolution() {
  return {
    status: "resolved",
    principal: {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      kind: "human",
      status: "active",
      authorizationVersion: 3,
    },
    identityLink: {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      subject: {
        platform: "slack",
        platformTenantId: "T1",
        platformSubjectId: "U1",
      },
      proofType: "external-issuer",
      proofDigest: "sha256:identity-proof",
      verifiedAt: new Date(Date.now() - 60_000).toISOString(),
      identityLinkVersion: 2,
    },
  };
}

function contextWithoutPlatformRecords() {
  const inbound = {
    channel: "C1",
    ts: "1.1",
    threadTs: "1.0",
    identity: "Ev1",
  };
  const first = bindRequestContext({}, {
    teamId: "T1",
    requesterId: "U1",
    inbound,
  });
  const identity = slackTurnIdentitySync(first, "C1");
  return bindRequestContext({}, {
    teamId: "T1",
    requesterId: "U1",
    inbound,
    verifiedIngress: {
      method: "slack_hmac_v0",
      evidenceDigest: "sha256:ingress-proof",
      verifiedAt: NOW,
    },
    preAdmittedTurn: {
      record: {
        channelId: "C1",
        threadKey: slackObligationThreadKey("T1", "C1", "1.0"),
        conversationKey: "conversation-1",
        executionId: identity.executionId,
        registeredAt: Date.now(),
      },
    },
  });
}

function platformNamespace() {
  const stub = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/tenant-locator/resolve") {
        return Response.json({
          status: "resolved",
          locator: {
            platform: "slack",
            platformTenantId: "T1",
            tenantId: TENANT,
            version: 6,
            status: "active",
          },
        });
      }
      if (path === "/identity-link/resolve") return Response.json(identityResolution());
      if (path === "/oauth/get") return Response.json(grant);
      if (path === "/marketplace/list") return Response.json({ entries: [marketplace] });
      if (path === "/credential/get") return Response.json(custodyReference);
      if (path === "/issueConnectorAuthorization") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          labels: {
            credentialRef: REF,
            platformBinding: body.platformBinding,
          },
          credential: workspaceCredential,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  return { namespace, stub };
}

function envWith(namespace: ReturnType<typeof platformNamespace>["namespace"]): Record<string, unknown> {
  const workspaceStub = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname !== "/issueConnectorAuthorization") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        labels: {
          credentialRef: REF,
          platformBinding: body.platformBinding,
        },
        credential: workspaceCredential,
      });
    }),
  };
  return {
    PLATFORM_STATE: namespace,
    WORKSPACE_CONFIG: {
      idFromName: vi.fn(() => "workspace"),
      get: vi.fn(() => workspaceStub),
    },
  };
}

describe("platform-bound connector authorization", () => {
  it("requires verified Slack ingress and composes server-owned records", async () => {
    const fake = platformNamespace();
    const result = await loadPlatformConnectorAuthorization({
      env: envWith(fake.namespace) as never,
      context: contextWithoutPlatformRecords(),
      channelId: "C1",
      projectId: "workspace",
      executionId: "execution-1",
      threadKey: "thread-1",
      connectorId: "google_drive",
      action: "search",
    });

    expect(result.platformContext.principal.principalId).toBe(PRINCIPAL);
    expect(result.snapshot.grant.version).toBe(4);
    expect(result.platformBinding).toMatchObject({
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantId: TENANT,
      principalId: PRINCIPAL,
      tenantLocatorVersion: 6,
      oauthGrantVersion: 4,
      marketplaceVersion: "2026-08-01",
    });
    expect(fake.namespace.get).toHaveBeenCalled();
  });

  it("fails closed before workspace authorization when ingress proof is absent", async () => {
    const fake = platformNamespace();
    const context = contextWithoutPlatformRecords();
    const legacyContext = { ...context, verifiedIngress: undefined };
    await expect(loadPlatformConnectorAuthorization({
      env: envWith(fake.namespace) as never,
      context: legacyContext,
      channelId: "C1",
      projectId: "workspace",
      executionId: "execution-1",
      threadKey: "thread-1",
      connectorId: "google_drive",
      action: "search",
    })).rejects.toThrow("connector_verified_ingress_required");
    expect(fake.namespace.get).not.toHaveBeenCalled();
  });

  it("classifies an unavailable platform foundation as retryable", () => {
    expect(isConnectorAuthorizationUnavailable(new Error("platform_state_unavailable"))).toBe(true);
    expect(isConnectorAuthorizationUnavailable(new Error("connector_oauth_grant_inactive"))).toBe(false);
  });
});
