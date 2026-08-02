import { describe, expect, it, vi } from "vitest";
import { credentialReferenceId, issueConnectorAuthorization, parseCredentialReference } from "../src/connectors/authorization.js";
import { connectorLabelsDigest } from "../src/connectors/credential-broker.js";
import { deriveInternalTenantId } from "../src/platform/tenant-id.js";
import { credentialBrokerApp } from "../workers/credential-broker/src/index.js";

const reference = parseCredentialReference({
  schemaVersion: 1,
  ref: credentialReferenceId("google", "workspace-drive"),
  provider: "google",
  name: "workspace-drive",
  version: 2,
  status: "active",
  scopes: ["drive.readonly"],
  subject: "workspace:T1",
  issuedAt: "2099-08-01T19:00:00.000Z",
});

const PRINCIPAL_ID = "22222222-2222-5222-8222-222222222222";
const MARKETPLACE_VERSION = "2026-08-01";

const bundle = {
  id: "drive-readers",
  tools: [],
  mcpEndpoints: [],
  secretRefs: [],
  revision: 1,
  status: "active" as const,
  connectorGrants: [{
    connectorId: "google_drive",
    actions: ["search"],
    scope: "project" as const,
    projectId: "P1",
    credentialRef: reference.ref,
  }],
};

async function requestBody() {
  const tenantId = await deriveInternalTenantId({
    externalPlatform: "slack",
    externalTenantId: "T1",
  });
  return (await issueConnectorAuthorization({
    bundle,
    credential: reference,
    identity: {
      workspaceId: "T1",
      projectId: "P1",
      channelId: "C1",
      requesterId: PRINCIPAL_ID,
      principalId: PRINCIPAL_ID,
      actorKind: "human",
      executionId: "exec-1",
      threadKey: "thread-1",
    },
    connectorId: "google_drive",
    action: "search",
    platformBinding: {
      schemaVersion: 1,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantId,
      principalId: PRINCIPAL_ID,
      identityLinkVersion: 2,
      authorizationVersion: 3,
      tenantLocatorVersion: 1,
      oauthGrantVersion: 4,
      marketplaceVersion: MARKETPLACE_VERSION,
    },
    now: Date.parse("2099-08-01T20:00:00.000Z"),
  })).labels;
}

function metadata(tenantId: string, status: "active" | "revoked" = "active") {
  return {
    schemaVersion: 1,
    tenantId,
    credentialRef: reference.ref,
    backend: "external_kms",
    provider: "google",
    subject: reference.subject,
    scopes: ["drive.readonly"],
    version: reference.version,
    status,
    issuedAt: "2099-08-01T19:00:00.000Z",
  };
}

function oauthGrant(tenantId: string, status: "active" | "revoked" = "active") {
  return {
    schemaVersion: 1,
    tenantId,
    principalId: PRINCIPAL_ID,
    connectorId: "google_drive",
    marketplaceVersion: MARKETPLACE_VERSION,
    credentialRef: reference.ref,
    providerSubject: "google:user:123",
    scopes: ["drive.readonly"],
    version: 4,
    status,
    issuedAt: "2099-08-01T19:00:00.000Z",
    expiresAt: "2099-08-01T21:00:00.000Z",
  };
}

function marketplace() {
  return {
    schemaVersion: 1,
    connectorId: "google_drive",
    provider: "google",
    version: MARKETPLACE_VERSION,
    status: "curated",
    authMode: "oauth2",
    actions: ["search"],
    oauthScopes: ["drive.readonly"],
    trustReviewRef: "review:drive-read-only",
  };
}

function identityResolution(tenantId: string) {
  const verifiedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    status: "resolved",
    principal: {
      tenantId,
      principalId: PRINCIPAL_ID,
      kind: "human",
      status: "active",
      authorizationVersion: 3,
    },
    identityLink: {
      tenantId,
      principalId: PRINCIPAL_ID,
      subject: {
        platform: "slack",
        platformTenantId: "T1",
        platformSubjectId: "U1",
      },
      proofType: "external-issuer",
      proofDigest: "sha256:identity-proof",
      verifiedAt,
      identityLinkVersion: 2,
    },
  };
}

function platformState(tenantId: string, credentialStatus: "active" | "revoked" = "active") {
  const stateStub = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/identity-link/resolve") return Response.json(identityResolution(tenantId));
      if (path === "/tenant-locator/resolve") {
        return Response.json({
          status: "resolved",
          locator: {
            schemaVersion: 1,
            platform: "slack",
            platformTenantId: "T1",
            tenantId,
            version: 1,
            status: "active",
            updatedAt: "2099-08-01T19:00:00.000Z",
          },
        });
      }
      if (path === "/oauth/get") return Response.json(oauthGrant(tenantId));
      if (path === "/marketplace/list") return Response.json({ entries: [marketplace()] });
      if (path === "/credential/get") return Response.json(metadata(tenantId, credentialStatus));
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  };
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stateStub),
    stateStub,
  };
}

describe("credential broker Worker", () => {
  it("rejects legacy labels that lack the server-owned platform binding", async () => {
    const labels = await requestBody();
    const { platformBinding: _platformBinding, digest: _digest, ...legacyUnsigned } = labels;
    const legacyLabels = {
      ...legacyUnsigned,
      digest: await connectorLabelsDigest({ ...legacyUnsigned, digest: "" }),
    };
    const response = await credentialBrokerApp.fetch(
      new Request("https://broker/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer broker-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          reference: { ref: reference.ref, version: reference.version },
          labels: legacyLabels,
        }),
      }),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => Response.json({ ok: true }) }),
        } as never,
        PLATFORM_STATE: {} as never,
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "platform_authorization_required" });
  });

  it("revalidates platform metadata before asking custody for a token", async () => {
    const labels = await requestBody();
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: labels.workspaceId,
    });
    let stateBody: unknown;
    let authorizationBody: unknown;
    let custodyBody: Record<string, unknown> | undefined;
    let custodyAuthorization: string | null | undefined;
    const workspaceStub = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorizationBody = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      }),
    };
    const state = platformState(tenantId);
    state.stateStub.fetch.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      stateBody = JSON.parse(String(init?.body));
      const path = new URL(String(_input)).pathname;
      if (path === "/identity-link/resolve") return Response.json(identityResolution(tenantId));
      if (path === "/tenant-locator/resolve") {
        return Response.json({
          status: "resolved",
          locator: {
            schemaVersion: 1,
            platform: "slack",
            platformTenantId: "T1",
            tenantId,
            version: 1,
            status: "active",
            updatedAt: "2099-08-01T19:00:00.000Z",
          },
        });
      }
      if (path === "/oauth/get") return Response.json(oauthGrant(tenantId));
      if (path === "/marketplace/list") return Response.json({ entries: [marketplace()] });
      return Response.json(metadata(tenantId));
    });
    const workspace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => workspaceStub),
    };
    const custody = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        custodyBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        custodyAuthorization = new Headers(init?.headers).get("authorization");
        return Response.json({
          schemaVersion: 1,
          ref: reference.ref,
          version: reference.version,
          accessToken: "custody-only-token",
          expiresAt: "2099-08-01T20:00:30.000Z",
        });
      }),
    };

    const response = await credentialBrokerApp.fetch(
      new Request("https://broker/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer broker-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1, reference: { ref: reference.ref, version: reference.version }, labels }),
      }),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: workspace as never,
        PLATFORM_STATE: state as never,
        CUSTODY: custody as never,
        CUSTODY_AUTH_TOKEN: "custody-secret",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ref: reference.ref,
      version: reference.version,
      accessToken: "custody-only-token",
    });
    expect(authorizationBody).toEqual({ labels });
    expect(stateBody).toEqual({ credentialRef: reference.ref });
    expect(custodyBody).toMatchObject({
      tenantId,
      reference: { ref: reference.ref, version: reference.version },
      credential: { provider: "google", scopes: ["drive.readonly"] },
    });
    expect(custodyAuthorization).toBe("Bearer custody-secret");
    expect(JSON.stringify(custodyBody)).not.toContain("custody-only-token");
  });

  it("fails closed for missing authentication and missing custody", async () => {
    const labels = await requestBody();
    const unauthorized = await credentialBrokerApp.fetch(
      new Request("https://broker/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, reference: { ref: reference.ref, version: reference.version }, labels }),
      }),
      { BROKER_AUTH_TOKEN: "broker-secret" },
    );
    expect(unauthorized.status).toBe(401);

    const tenantId = await deriveInternalTenantId({ externalPlatform: "slack", externalTenantId: labels.workspaceId });
    const workspace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    };
    const noCustody = await credentialBrokerApp.fetch(
      new Request("https://broker/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer broker-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1, reference: { ref: reference.ref, version: reference.version }, labels }),
      }),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: workspace as never,
        PLATFORM_STATE: platformState(tenantId) as never,
      },
    );
    expect(noCustody.status).toBe(503);
    await expect(noCustody.json()).resolves.toEqual({ error: "credential_custody_unavailable" });
  });

  it("does not call custody for a revoked credential", async () => {
    const labels = await requestBody();
    const tenantId = await deriveInternalTenantId({ externalPlatform: "slack", externalTenantId: labels.workspaceId });
    const workspace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    };
    const custody = { fetch: vi.fn() };
    const response = await credentialBrokerApp.fetch(
      new Request("https://broker/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer broker-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1, reference: { ref: reference.ref, version: reference.version }, labels }),
      }),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: workspace as never,
        PLATFORM_STATE: platformState(tenantId, "revoked") as never,
        CUSTODY: custody as never,
        CUSTODY_AUTH_TOKEN: "custody-secret",
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "connector_credential_inactive" });
    expect(custody.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on a revoked access bundle before reading custody metadata", async () => {
    const labels = await requestBody();
    const state = { get: vi.fn() };
    const custody = { fetch: vi.fn() };
    const workspace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ error: "access_bundle_changed" }, { status: 403 }),
      }),
    };
    const response = await credentialBrokerApp.fetch(
      new Request("https://broker/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer broker-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1, reference: { ref: reference.ref, version: reference.version }, labels }),
      }),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: workspace as never,
        PLATFORM_STATE: state as never,
        CUSTODY: custody as never,
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "access_bundle_changed" });
    expect(state.get).not.toHaveBeenCalled();
    expect(custody.fetch).not.toHaveBeenCalled();
  });
});
