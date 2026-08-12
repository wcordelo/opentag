import { describe, expect, it, vi } from "vitest";
import { credentialReferenceId, issueConnectorAuthorization, parseCredentialReference } from "../src/connectors/authorization.js";
import { deriveInternalTenantId } from "../src/platform/tenant-id.js";
import { credentialBrokerApp } from "../workers/credential-broker/src/index.js";
import { credentialCustodyApp } from "../workers/credential-custody/src/index.js";

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
  return (await issueConnectorAuthorization({
    bundle,
    credential: reference,
    identity: {
      workspaceId: "T1",
      projectId: "P1",
      channelId: "C1",
      requesterId: "U1",
      actorKind: "human",
      executionId: "exec-1",
      threadKey: "thread-1",
    },
    connectorId: "google_drive",
    action: "search",
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

describe("credential broker Worker", () => {
  it("does not claim provider resolution until custody is ready", async () => {
    const notReady = await credentialBrokerApp.fetch(
      new Request("https://broker/health"),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: {} as never,
        PLATFORM_STATE: {} as never,
        CUSTODY: { fetch: vi.fn(async () => Response.json({
          ok: true,
          providerResolutionEnabled: false,
        })) } as never,
        CUSTODY_AUTH_TOKEN: "custody-secret",
      },
    );
    await expect(notReady.json()).resolves.toMatchObject({
      ok: true,
      providerResolutionEnabled: false,
    });

    const ready = await credentialBrokerApp.fetch(
      new Request("https://broker/health"),
      {
        BROKER_AUTH_TOKEN: "broker-secret",
        WORKSPACE_CONFIG: {} as never,
        PLATFORM_STATE: {} as never,
        CUSTODY: { fetch: vi.fn(async () => Response.json({
          ok: true,
          providerResolutionEnabled: true,
        })) } as never,
        CUSTODY_AUTH_TOKEN: "custody-secret",
      },
    );
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      providerResolutionEnabled: true,
    });
  });

  it("revalidates platform metadata before asking custody for a token", async () => {
    const labels = await requestBody();
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: labels.workspaceId,
    });
    let stateBody: unknown;
    let authorizationBody: unknown;
    let authorizationTenant: string | null = null;
    let custodyBody: Record<string, unknown> | undefined;
    let custodyAuthorization: string | null | undefined;
    const workspaceStub = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorizationBody = JSON.parse(String(init?.body));
        authorizationTenant = new Headers(init?.headers).get("x-opentag-tenant-id");
        return Response.json({ ok: true });
      }),
    };
    const stateStub = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        stateBody = JSON.parse(String(init?.body));
        return Response.json(metadata(tenantId));
      }),
    };
    const state = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => stateStub),
    };
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
    expect(authorizationTenant).toBe("T1");
    expect(stateBody).toEqual({ credentialRef: reference.ref });
    expect(custodyBody).toMatchObject({
      tenantId,
      reference: { ref: reference.ref, version: reference.version },
      credential: { provider: "google", scopes: ["drive.readonly"] },
    });
    expect(custodyAuthorization).toBe("Bearer custody-secret");
    expect(JSON.stringify(custodyBody)).not.toContain("custody-only-token");
  });

  it("resolves through the real broker-to-custody boundary with tenant revalidation", async () => {
    const labels = await requestBody();
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: labels.workspaceId,
    });
    const token = "broker-custody-integration-token";
    const requestBodies: unknown[] = [];
    const secret = { get: vi.fn(async () => token) };
    const workspaceStub = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }),
    };
    const stateStub = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return Response.json(metadata(tenantId));
      }),
    };
    const workspace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => workspaceStub),
    };
    const state = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => stateStub),
    };
    const custodyEnv = {
      CUSTODY_AUTH_TOKEN: "custody-secret",
      CUSTODY_BINDINGS_JSON: JSON.stringify([{
        ref: reference.ref,
        version: reference.version,
        binding: "GOOGLE_DRIVE_TOKEN_V2",
        expiresAt: "2099-08-01T20:10:00.000Z",
      }]),
      GOOGLE_DRIVE_TOKEN_V2: secret,
      WORKSPACE_CONFIG: workspace,
      PLATFORM_STATE: state,
    };
    const custody = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        credentialCustodyApp.fetch(new Request(input, init), custodyEnv as never)),
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
          labels,
        }),
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
    await expect(response.json()).resolves.toMatchObject({
      ref: reference.ref,
      version: reference.version,
      accessToken: token,
    });
    expect(secret.get).toHaveBeenCalledOnce();
    expect(custody.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(requestBodies)).not.toContain(token);
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
        PLATFORM_STATE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => Response.json(metadata(tenantId)) }),
        } as never,
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
        PLATFORM_STATE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => Response.json(metadata(tenantId, "revoked")) }),
        } as never,
        CUSTODY: custody as never,
        CUSTODY_AUTH_TOKEN: "custody-secret",
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "credential_revoked" });
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
