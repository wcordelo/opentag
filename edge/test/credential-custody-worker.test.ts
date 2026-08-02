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

async function labels() {
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

async function requestBody(
  connectorLabels: Awaited<ReturnType<typeof labels>>,
  status: "active" | "revoked" = "active",
) {
  const tenantId = await deriveInternalTenantId({
    externalPlatform: "slack",
    externalTenantId: connectorLabels.workspaceId,
  });
  return {
    schemaVersion: 1,
    tenantId,
    reference: { ref: reference.ref, version: reference.version },
    labels: connectorLabels,
    credential: {
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
    },
  };
}

function bindings(secret: SecretsStoreSecret = { get: vi.fn(async () => "drive-token") }) {
  return {
    CUSTODY_AUTH_TOKEN: "custody-secret",
    CUSTODY_BINDINGS_JSON: JSON.stringify([{
      ref: reference.ref,
      version: reference.version,
      binding: "GOOGLE_DRIVE_TOKEN_V2",
      expiresAt: "2099-08-01T20:10:00.000Z",
    }]),
    GOOGLE_DRIVE_TOKEN_V2: secret,
  };
}

type SecretsStoreSecret = { get(): Promise<string> };

describe("credential custody Worker", () => {
  it("resolves a configured Secrets Store binding without accepting token material", async () => {
    const secret = { get: vi.fn(async () => "drive-token") };
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
      bindings(secret) as never,
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
  });

  it("fails closed without custody auth or a binding map", async () => {
    const body = await requestBody(await labels());
    const unauthorized = await credentialCustodyApp.fetch(
      new Request("https://custody/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { CUSTODY_BINDINGS_JSON: bindings().CUSTODY_BINDINGS_JSON } as never,
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
    await expect(noBindings.json()).resolves.toEqual({ error: "credential_custody_bindings_unconfigured" });
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
      bindings() as never,
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
        body: JSON.stringify(await requestBody(validLabels, "revoked")),
      }),
      bindings() as never,
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
      { ...bindings(), GOOGLE_DRIVE_TOKEN_V2: undefined } as never,
    );
    expect(missingBinding.status).toBe(503);
    await expect(missingBinding.json()).resolves.toEqual({ error: "credential_custody_secret_binding_unavailable" });
  });
});
