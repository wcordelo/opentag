import { describe, expect, it } from "vitest";
import {
  IDENTITY_LINK_SCHEMA_VERSION,
  IdentityLinkContractError,
  identityLinkResolutionFromRecord,
  PlatformStateIdentityLinkReader,
  validateIdentityLinkRecord,
  validateIdentityLinkResolution,
} from "../src/platform/identity-link.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const SUBJECT = {
  platform: "slack" as const,
  platformTenantId: "T1",
  platformSubjectId: "U1",
};
const PRINCIPAL_VALUE = {
  tenantId: TENANT,
  principalId: PRINCIPAL,
  kind: "human" as const,
  status: "active" as const,
  authorizationVersion: 3,
};
const LINK = {
  tenantId: TENANT,
  principalId: PRINCIPAL,
  subject: SUBJECT,
  proofType: "slack_admin_attestation",
  proofDigest: "sha256:identity-proof",
  verifiedAt: "2026-08-01T19:00:00.000Z",
  identityLinkVersion: 1,
};
const RECORD = {
  schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
  tenantId: TENANT,
  subject: SUBJECT,
  principal: PRINCIPAL_VALUE,
  identityLink: LINK,
  version: 1,
  status: "active" as const,
  updatedAt: "2026-08-01T20:00:00.000Z",
};

describe("identity link contract", () => {
  it("binds one external subject to one active internal principal", () => {
    const record = validateIdentityLinkRecord(RECORD);
    expect(record).toMatchObject({
      tenantId: TENANT,
      subject: SUBJECT,
      principal: { principalId: PRINCIPAL, status: "active" },
      identityLink: { identityLinkVersion: 1 },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(identityLinkResolutionFromRecord(record)).toMatchObject({
      status: "resolved",
      principal: { tenantId: TENANT, principalId: PRINCIPAL },
    });
    expect(validateIdentityLinkResolution({
      status: "resolved",
      principal: PRINCIPAL_VALUE,
      identityLink: LINK,
    })).toMatchObject({ status: "resolved", identityLink: { identityLinkVersion: 1 } });
  });

  it("rejects relationship mismatches, stale proof data, and secret-shaped fields", () => {
    expect(() => validateIdentityLinkRecord({
      ...RECORD,
      identityLink: { ...LINK, principalId: "33333333-3333-4333-8333-333333333333" },
    })).toThrow(new IdentityLinkContractError("identity_link_subject_mismatch", 409));
    expect(() => validateIdentityLinkRecord({
      ...RECORD,
      identityLink: { ...LINK, identityLinkVersion: 2 },
    })).toThrow(new IdentityLinkContractError("identity_link_version_mismatch", 409));
    expect(() => validateIdentityLinkRecord({
      ...RECORD,
      token: "provider-token",
    })).toThrow(new IdentityLinkContractError("identity_link_record_field_invalid"));
    expect(() => validateIdentityLinkRecord({
      ...RECORD,
      identityLink: { ...LINK, proofDigest: "bearer provider-token" },
    })).toThrow(new IdentityLinkContractError("proof_digest_invalid"));
  });

  it("treats expiry and revocation as inactive without inventing a principal", () => {
    expect(() => validateIdentityLinkRecord({
      ...RECORD,
      identityLink: {
        ...LINK,
        expiresAt: "2026-08-01T21:00:00.000Z",
      },
    })).toThrow(new IdentityLinkContractError("identity_link_inactive"));
    const revoked = validateIdentityLinkRecord({
      ...RECORD,
      version: 2,
      identityLink: { ...LINK, identityLinkVersion: 2 },
      status: "revoked",
      updatedAt: "2026-08-01T21:00:00.000Z",
      revokedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(identityLinkResolutionFromRecord(revoked)).toEqual({ status: "inactive" });
  });
});

describe("PlatformStateIdentityLinkReader", () => {
  it("addresses the locator-selected tenant object and rejects bad responses", async () => {
    const calls: string[] = [];
    const reader = new PlatformStateIdentityLinkReader({
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (input) => {
          calls.push(`${String(id)}:${new URL(String(input)).pathname}`);
          return Response.json({
            status: "resolved",
            principal: PRINCIPAL_VALUE,
            identityLink: LINK,
          });
        },
      }),
    });
    await expect(reader.resolve(SUBJECT, TENANT)).resolves.toMatchObject({
      status: "resolved",
      principal: { principalId: PRINCIPAL },
    });
    expect(calls).toEqual([`tenant:${TENANT}:/identity-link/resolve`]);

    const unavailable = new PlatformStateIdentityLinkReader({
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
    });
    await expect(unavailable.resolve(SUBJECT, TENANT))
      .rejects.toThrow(new IdentityLinkContractError("identity_link_unavailable", 503));

    const malformed = new PlatformStateIdentityLinkReader({
      idFromName: (name) => name,
      get: () => ({ fetch: async () => Response.json({ status: "resolved", principal: PRINCIPAL_VALUE }) }),
    });
    await expect(malformed.resolve(SUBJECT, TENANT))
      .rejects.toThrow(new IdentityLinkContractError("identity_link_response_invalid", 503));
  });

  it("preserves not-found and inactive resolutions from the tenant object", async () => {
    const reader = new PlatformStateIdentityLinkReader({
      idFromName: (name) => name,
      get: () => ({ fetch: async () => Response.json({ status: "not_found" }) }),
    });
    await expect(reader.resolve(SUBJECT, TENANT)).resolves.toEqual({ status: "not_found" });
  });
});
