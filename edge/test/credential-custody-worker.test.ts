import { describe, expect, it, vi } from "vitest";
import {
  credentialReferenceId,
  issueConnectorAuthorization,
  parseCredentialReference,
} from "../src/connectors/authorization.js";
import { deriveInternalTenantId } from "../src/platform/tenant-id.js";
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

async function labels(credential = reference) {
  return (await issueConnectorAuthorization({
    bundle,
    credential,
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

async function requestBody(
  connectorLabels: Awaited<ReturnType<typeof labels>>,
  status: "active" | "revoked" = "active",
  credential = reference,
) {
  const tenantId = await deriveInternalTenantId({
    externalPlatform: "slack",
    externalTenantId: connectorLabels.workspaceId,
  });
  return {
    schemaVersion: 1,
    tenantId,
    reference: { ref: credential.ref, version: credential.version },
    labels: connectorLabels,
    credential: {
      schemaVersion: 1,
      tenantId,
      credentialRef: credential.ref,
      backend: "external_kms",
      provider: credential.provider,
      subject: credential.subject,
      scopes: credential.scopes,
      version: credential.version,
      status,
      issuedAt: credential.issuedAt,
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    },
  };
}

type MetadataOptions = Readonly<{
  credentialRef?: string;
  provider?: string;
  scopes?: readonly string[];
  version?: number;
  expiresAt?: string;
}>;

function metadata(
  tenantId: string,
  status: "active" | "revoked" = "active",
  options: MetadataOptions = {},
) {
  return {
    schemaVersion: 1,
    tenantId,
    credentialRef: options.credentialRef ?? reference.ref,
    backend: "external_kms",
    provider: options.provider ?? "google",
    subject: reference.subject,
    scopes: options.scopes ?? ["drive.readonly"],
    version: options.version ?? reference.version,
    status,
    issuedAt: "2099-08-01T19:00:00.000Z",
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  };
}

type CustodyTestOptions = Readonly<{
  credential?: () => unknown;
  authorization?: () => Response | Promise<Response>;
  requestBodies?: unknown[];
  requestTenants?: string[];
  bindingConfig?: readonly Record<string, unknown>[];
}>;

function durableObjects(
  tenantId: string,
  status: "active" | "revoked" = "active",
  options: CustodyTestOptions = {},
) {
  const workspaceStub = {
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      options.requestBodies?.push(JSON.parse(String(init?.body)));
      const tenant = new Headers(init?.headers).get("x-opentag-tenant-id");
      if (tenant) options.requestTenants?.push(tenant);
      return await (options.authorization?.() ?? Response.json({ ok: true }));
    }),
  };
  const stateStub = {
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      options.requestBodies?.push(JSON.parse(String(init?.body)));
      return Response.json(options.credential?.() ?? metadata(tenantId, status));
    }),
  };
  return {
    WORKSPACE_CONFIG: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => workspaceStub),
    },
    PLATFORM_STATE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => stateStub),
    },
  };
}

async function envBindings(
  secret: SecretsStoreSecret = { get: vi.fn(async () => "drive-token") },
  status: "active" | "revoked" = "active",
  options: CustodyTestOptions = {},
) {
  const tenantId = await deriveInternalTenantId({
    externalPlatform: "slack",
    externalTenantId: "T1",
  });
  return {
    CUSTODY_AUTH_TOKEN: "custody-secret",
    CUSTODY_BINDINGS_JSON: JSON.stringify(options.bindingConfig ?? [{
      ref: reference.ref,
      version: reference.version,
      binding: "GOOGLE_DRIVE_TOKEN_V2",
      expiresAt: "2099-08-01T20:10:00.000Z",
    }]),
    GOOGLE_DRIVE_TOKEN_V2: secret,
    ...durableObjects(tenantId, status, options),
  };
}

type SecretsStoreSecret = { get(): Promise<string> };

async function resolveRequest(body: unknown, env: unknown): Promise<Response> {
  return await credentialCustodyApp.fetch(
    new Request("https://custody/resolve", {
      method: "POST",
      headers: {
        authorization: "Bearer custody-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env as never,
  );
}

describe("credential custody Worker", () => {
  it("resolves a configured Secrets Store binding without accepting token material", async () => {
    const secret = { get: vi.fn(async () => "drive-token") };
    const requestBodies: unknown[] = [];
    const requestTenants: string[] = [];
    const body = await requestBody(await labels());
    const response = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer custody-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      await envBindings(secret, "active", { requestBodies, requestTenants }) as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      ref: reference.ref,
      version: reference.version,
      accessToken: "drive-token",
      expiresAt: "2099-08-01T20:01:00.000Z",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(secret.get).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toContain("drive-token");
    expect(requestBodies).toHaveLength(4);
    expect(requestTenants[0]).toBe("T1");
    expect(JSON.stringify(requestBodies)).not.toContain("drive-token");
  });

  it("rejects a credential revoked after the Secrets Store read", async () => {
    const connectorLabels = await labels();
    const body = await requestBody(connectorLabels);
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: connectorLabels.workspaceId,
    });
    let status: "active" | "revoked" = "active";
    const token = "revoked-during-resolution-token";
    const secret = {
      get: vi.fn(async () => {
        status = "revoked";
        return token;
      }),
    };
    const requestBodies: unknown[] = [];
    const response = await resolveRequest(
      body,
      await envBindings(secret, "active", {
        requestBodies,
        credential: () => metadata(tenantId, status),
      }),
    );
    const responseText = await response.text();
    expect(response.status).toBe(403);
    expect(responseText).toBe(JSON.stringify({ error: "credential_revoked" }));
    expect(responseText).not.toContain(token);
    expect(secret.get).toHaveBeenCalledOnce();
    expect(requestBodies).toHaveLength(4);
    expect(JSON.stringify(requestBodies)).not.toContain(token);
  });

  it("rejects a credential rotated after the Secrets Store read", async () => {
    const connectorLabels = await labels();
    const body = await requestBody(connectorLabels);
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: connectorLabels.workspaceId,
    });
    let version = reference.version;
    const token = "rotated-during-resolution-token";
    const secret = {
      get: vi.fn(async () => {
        version += 1;
        return token;
      }),
    };
    const requestBodies: unknown[] = [];
    const response = await resolveRequest(
      body,
      await envBindings(secret, "active", {
        requestBodies,
        credential: () => metadata(tenantId, "active", { version }),
      }),
    );
    const responseText = await response.text();
    expect(response.status).toBe(403);
    expect(responseText).toBe(JSON.stringify({ error: "credential_version_mismatch" }));
    expect(responseText).not.toContain(token);
    expect(secret.get).toHaveBeenCalledOnce();
    expect(requestBodies).toHaveLength(4);
    expect(JSON.stringify(requestBodies)).not.toContain(token);
  });

  it.each([
    ["provider", { provider: "linear" }, "credential_provider_mismatch"],
    ["scope", { scopes: ["drive.metadata.readonly"] }, "credential_scope_missing"],
  ] as const)("rejects a %s policy mismatch introduced during resolution", async (_kind, mismatch, expected) => {
    const connectorLabels = await labels();
    const body = await requestBody(connectorLabels);
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: connectorLabels.workspaceId,
    });
    let mismatched = false;
    const secret = {
      get: vi.fn(async () => {
        mismatched = true;
        return "policy-mismatch-token";
      }),
    };
    const response = await resolveRequest(
      body,
      await envBindings(secret, "active", {
        credential: () => metadata(tenantId, "active", mismatched ? mismatch : {}),
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: expected });
    expect(secret.get).toHaveBeenCalledOnce();
  });

  it.each([
    ["ref", { ref: "credential:google:other", version: reference.version }],
    ["version", { ref: reference.ref, version: reference.version + 1 }],
  ] as const)("rejects a binding %s mismatch before reading the secret", async (_kind, binding) => {
    const connectorLabels = await labels();
    const body = await requestBody(connectorLabels);
    const secret = { get: vi.fn(async () => "unreachable-token") };
    const response = await resolveRequest(
      body,
      await envBindings(secret, "active", {
        bindingConfig: [{
          ...binding,
          binding: "GOOGLE_DRIVE_TOKEN_V2",
          expiresAt: "2099-08-01T20:10:00.000Z",
        }],
      }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "credential_custody_binding_not_found" });
    expect(secret.get).not.toHaveBeenCalled();
  });

  it.each([
    ["ref", { credentialRef: "credential:google:other" }, "credential_reference_mismatch"],
    ["version", { version: reference.version + 1 }, "credential_version_mismatch"],
  ] as const)("rejects an authoritative credential %s mismatch before reading the secret", async (_kind, mismatch, expected) => {
    const connectorLabels = await labels();
    const body = await requestBody(connectorLabels);
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: connectorLabels.workspaceId,
    });
    const secret = { get: vi.fn(async () => "unreachable-token") };
    const response = await resolveRequest(
      body,
      await envBindings(secret, "active", {
        credential: () => metadata(tenantId, "active", mismatch),
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: expected });
    expect(secret.get).not.toHaveBeenCalled();
  });

  it("bounds the returned token expiry by the current authorization and credential", async () => {
    const expiringReference = parseCredentialReference({
      ...reference,
      expiresAt: "2099-08-01T20:00:30.000Z",
    });
    const connectorLabels = await labels(expiringReference);
    const body = await requestBody(connectorLabels, "active", expiringReference);
    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: connectorLabels.workspaceId,
    });
    const response = await resolveRequest(
      body,
      await envBindings(undefined, "active", {
        credential: () => metadata(tenantId, "active", {
          expiresAt: "2099-08-01T20:00:30.000Z",
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accessToken: "drive-token",
      expiresAt: "2099-08-01T20:00:30.000Z",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redacts Secrets Store failures from responses, logs, and DO metadata", async () => {
    const connectorLabels = await labels();
    const body = await requestBody(connectorLabels);
    const token = "secret-store-error-token";
    const secret = {
      get: vi.fn(async () => {
        throw new Error(token);
      }),
    };
    const requestBodies: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await resolveRequest(
        body,
        await envBindings(secret, "active", { requestBodies }),
      );
      const responseText = await response.text();
      expect(response.status).toBe(503);
      expect(responseText).toBe(JSON.stringify({ error: "credential_custody_secret_unavailable" }));
      expect(responseText).not.toContain(token);
      expect(JSON.stringify(requestBodies)).not.toContain(token);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails closed without custody auth or a binding map", async () => {
    const body = await requestBody(await labels());
    const unauthorized = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { CUSTODY_BINDINGS_JSON: (await envBindings()).CUSTODY_BINDINGS_JSON } as never,
    );
    expect(unauthorized.status).toBe(503);
    await expect(unauthorized.json()).resolves.toEqual({ error: "credential_custody_auth_unconfigured" });

    const noBindings = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer custody-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { CUSTODY_AUTH_TOKEN: "custody-secret" } as never,
    );
    expect(noBindings.status).toBe(503);
    await expect(noBindings.json()).resolves.toEqual({ error: "workspace_config_unavailable" });
  });

  it("rejects tampered labels, revoked references, and missing bindings", async () => {
    const validLabels = await labels();
    const tamperedLabels = { ...validLabels, action: "write" };
    const tampered = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer custody-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(await requestBody(tamperedLabels)),
      }),
      await envBindings() as never,
    );
    expect(tampered.status).toBe(403);
    await expect(tampered.json()).resolves.toEqual({ error: "connector_labels_tampered" });

    const revoked = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer custody-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(await requestBody(validLabels, "active")),
      }),
      await envBindings(undefined, "revoked") as never,
    );
    expect(revoked.status).toBe(403);
    await expect(revoked.json()).resolves.toEqual({ error: "credential_revoked" });

    const missingBinding = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: {
          authorization: "Bearer custody-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(await requestBody(validLabels)),
      }),
      { ...(await envBindings()), GOOGLE_DRIVE_TOKEN_V2: undefined } as never,
    );
    expect(missingBinding.status).toBe(503);
    await expect(missingBinding.json()).resolves.toEqual({ error: "credential_custody_secret_binding_unavailable" });
  });
});
