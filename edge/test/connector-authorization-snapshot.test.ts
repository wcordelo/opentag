import { describe, expect, it, vi } from "vitest";
import {
  parseConnectorAuthorizationPlatformBinding,
} from "../src/connectors/authorization.js";
import {
  assertConnectorAuthorizationSnapshotMatchesBinding,
  PlatformStateConnectorAuthorizationReader,
  validateConnectorAuthorizationSnapshot,
} from "../src/connectors/authorization-snapshot.js";
import { TENANT_LOCATOR_OBJECT_NAME } from "../src/platform/tenant-locator.js";
import { platformTenantObjectName } from "../src/platform/tenant-routing.js";

const TENANT = "11111111-1111-5111-8111-111111111111";
const PRINCIPAL = "22222222-2222-5222-8222-222222222222";
const REF = "credential:google:workspace-drive" as const;

const marketplace = {
  schemaVersion: 1,
  connectorId: "google_drive",
  provider: "google",
  version: "2026-08-01",
  status: "curated" as const,
  authMode: "oauth2" as const,
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
  status: "active" as const,
  issuedAt: "2099-08-01T19:00:00.000Z",
  expiresAt: "2099-08-01T21:00:00.000Z",
};

const credential = {
  schemaVersion: 1,
  tenantId: TENANT,
  credentialRef: REF,
  backend: "external_kms" as const,
  provider: "google",
  subject: "google:user:123",
  scopes: ["drive.readonly"],
  version: 9,
  status: "active" as const,
  issuedAt: "2099-08-01T19:00:00.000Z",
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

function namespace(overrides: {
  tenantLocatorVersion?: number;
  grant?: Record<string, unknown>;
  marketplace?: Record<string, unknown>;
  credential?: Record<string, unknown>;
} = {}) {
  const calls: string[] = [];
  const stub = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}:${String(init?.body ?? "")}`);
      if (url.pathname === "/tenant-locator/resolve") {
        return Response.json({
          status: "resolved",
          locator: {
            platform: "slack",
            platformTenantId: "T1",
            tenantId: TENANT,
            version: overrides.tenantLocatorVersion ?? 1,
            status: "active",
          },
        });
      }
      if (url.pathname === "/identity-link/resolve") return Response.json(identityResolution());
      if (url.pathname === "/oauth/get") return Response.json(overrides.grant ?? grant);
      if (url.pathname === "/credential/get") return Response.json(overrides.credential ?? credential);
      if (url.pathname === "/marketplace/list") {
        return Response.json({ entries: [overrides.marketplace ?? marketplace] });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  };
  const value = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  return { value, stub, calls };
}

describe("connector authorization snapshot", () => {
  it("composes the active OAuth grant, curated marketplace, and custody reference", async () => {
    const fake = namespace();
    const snapshot = await new PlatformStateConnectorAuthorizationReader(fake.value).resolve({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantLocatorVersion: 1,
      connectorId: "google_drive",
      action: "search",
    });

    expect(snapshot).toMatchObject({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      connectorId: "google_drive",
      action: "search",
      grant: { version: 4, credentialRef: REF },
      credential: { version: 9, credentialRef: REF },
      marketplace: { version: marketplace.version, status: "curated" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("accessToken");
    expect(fake.value.idFromName).toHaveBeenCalledWith(platformTenantObjectName(TENANT));
    expect(fake.value.idFromName).toHaveBeenCalledWith(TENANT_LOCATOR_OBJECT_NAME);

    const binding = parseConnectorAuthorizationPlatformBinding({
      schemaVersion: 1,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantId: TENANT,
      principalId: PRINCIPAL,
      identityLinkVersion: 2,
      authorizationVersion: 3,
      tenantLocatorVersion: 1,
      oauthGrantVersion: 4,
      marketplaceVersion: marketplace.version,
    });
    expect(() => assertConnectorAuthorizationSnapshotMatchesBinding(snapshot, binding, {
      connectorId: "google_drive",
      action: "search",
      credentialRef: REF,
      credentialVersion: 9,
    }, Date.parse("2099-08-01T20:00:00.000Z"))).not.toThrow();
  });

  it("rejects a stale or revoked platform record before custody", async () => {
    const revoked = namespace({
      grant: { ...grant, status: "revoked" },
    });
    await expect(new PlatformStateConnectorAuthorizationReader(revoked.value).resolve({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantLocatorVersion: 1,
      connectorId: "google_drive",
      action: "search",
    })).rejects.toThrow("connector_oauth_grant_inactive");

    const stale = validateConnectorAuthorizationSnapshot({
      schemaVersion: 1,
      tenantId: TENANT,
      principalId: PRINCIPAL,
      connectorId: "google_drive",
      action: "search",
      identity: identityResolution(),
      marketplace,
      grant,
      credential,
      observedAt: "2099-08-01T20:00:00.000Z",
    });
    const binding = parseConnectorAuthorizationPlatformBinding({
      schemaVersion: 1,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantId: TENANT,
      principalId: PRINCIPAL,
      identityLinkVersion: 2,
      authorizationVersion: 3,
      tenantLocatorVersion: 1,
      oauthGrantVersion: 5,
      marketplaceVersion: marketplace.version,
    });
    expect(() => assertConnectorAuthorizationSnapshotMatchesBinding(stale, binding, {
      connectorId: "google_drive",
      action: "search",
      credentialRef: REF,
      credentialVersion: 9,
    }, Date.parse("2099-08-01T20:00:00.000Z"))).toThrow("connector_authorization_snapshot_stale");
  });

  it("rejects provider scope drift even when each row is individually active", async () => {
    const fake = namespace({
      credential: { ...credential, scopes: ["drive.file"] },
    });
    await expect(new PlatformStateConnectorAuthorizationReader(fake.value).resolve({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantLocatorVersion: 1,
      connectorId: "google_drive",
      action: "search",
    })).rejects.toThrow("connector_scope_mismatch");
  });

  it("rejects a label whose tenant locator version is stale", async () => {
    const fake = namespace({ tenantLocatorVersion: 2 });
    await expect(new PlatformStateConnectorAuthorizationReader(fake.value).resolve({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      platform: "slack",
      platformTenantId: "T1",
      platformSubjectId: "U1",
      tenantLocatorVersion: 1,
      connectorId: "google_drive",
      action: "search",
    })).rejects.toThrow("connector_tenant_locator_stale");
  });
});
