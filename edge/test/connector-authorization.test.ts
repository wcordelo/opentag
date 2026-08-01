import { describe, expect, it } from "vitest";
import {
  credentialReferenceId,
  issueConnectorAuthorization,
  parseCredentialReference,
  verifyConnectorAuthorizationCurrent,
  type CredentialReference,
} from "../src/connectors/authorization.js";
import {
  bindCitationAuthorization,
  type KnowledgeCitationBase,
} from "../src/memory/knowledge-contract.js";

const now = Date.parse("2026-08-01T20:00:00.000Z");

function credential(overrides: Partial<CredentialReference> = {}): CredentialReference {
  return parseCredentialReference({
    schemaVersion: 1,
    ref: credentialReferenceId("google", "workspace-drive"),
    provider: "google",
    name: "workspace-drive",
    version: 3,
    status: "active",
    scopes: ["drive.readonly"],
    subject: "workspace:T1",
    issuedAt: "2026-08-01T19:00:00.000Z",
    expiresAt: "2026-08-01T21:00:00.000Z",
    ...overrides,
  });
}

const bundle = {
  id: "drive-readers",
  tools: ["search"],
  mcpEndpoints: [],
  secretRefs: [],
  schemaVersion: 1 as const,
  revision: 7,
  status: "active" as const,
  connectorGrants: [
    {
      connectorId: "google_drive",
      actions: ["search"],
      scope: "project" as const,
      projectId: "P1",
      credentialRef: credentialReferenceId("google", "workspace-drive"),
    },
  ],
};

const identity = {
  workspaceId: "T1",
  projectId: "P1",
  channelId: "C1",
  requesterId: "U1",
  actorKind: "human" as const,
  executionId: "exec-1",
  threadKey: "T1:C1:thread-1",
};

describe("connector authorization foundation", () => {
  it("issues immutable labels with an opaque credential reference and citation proof", async () => {
    const issued = await issueConnectorAuthorization({
      bundle,
      credential: credential(),
      identity,
      connectorId: "google_drive",
      action: "search",
      now,
    });

    expect(Object.isFrozen(issued.labels)).toBe(true);
    expect(issued.labels).toMatchObject({
      workspaceId: "T1",
      projectId: "P1",
      connectorId: "google_drive",
      action: "search",
      accessBundleId: "drive-readers",
      accessBundleRevision: 7,
      credentialRef: "credential:google:workspace-drive",
      credentialVersion: 3,
    });
    expect(JSON.stringify(issued.labels)).not.toContain("drive.readonly");

    const citation: KnowledgeCitationBase = {
      sourceKey: "drive:T1:P1:file-1",
      sourceType: "custom_db",
      projectId: "P1",
      contentRevision: "sha256:document",
      excerpt: "bounded result",
      aclPolicyRef: "bundle:drive-readers",
      retrievedAt: "2026-08-01T20:00:01.000Z",
    };
    expect(bindCitationAuthorization(citation, issued.labels).authorization).toMatchObject({
      digest: issued.labels.digest,
      accessBundleRevision: 7,
      credentialVersion: 3,
    });
  });

  it("revalidates bundle and credential revocation at the effect boundary", async () => {
    const issued = await issueConnectorAuthorization({
      bundle,
      credential: credential(),
      identity,
      connectorId: "google_drive",
      action: "search",
      now,
    });
    await expect(verifyConnectorAuthorizationCurrent({
      labels: issued.labels,
      bundle,
      credential: credential(),
      now: now + 1_000,
    })).resolves.toBeUndefined();

    await expect(verifyConnectorAuthorizationCurrent({
      labels: issued.labels,
      bundle: { ...bundle, revision: 8 },
      credential: credential(),
      now: now + 1_000,
    })).rejects.toThrow("access_bundle_changed");

    await expect(verifyConnectorAuthorizationCurrent({
      labels: issued.labels,
      bundle,
      credential: credential({
        status: "revoked",
        revokedAt: "2026-08-01T20:00:30.000Z",
      }),
      now: now + 1_000,
    })).rejects.toThrow("credential_reference_revoked");
  });

  it("fails closed for missing grants, credentials, and tampered labels", async () => {
    await expect(issueConnectorAuthorization({
      bundle,
      credential: credential(),
      identity,
      connectorId: "google_drive",
      action: "write",
      now,
    })).rejects.toThrow("connector_action_not_granted");

    await expect(issueConnectorAuthorization({
      bundle,
      identity,
      connectorId: "google_drive",
      action: "search",
      now,
    })).rejects.toThrow("credential_reference_required");

    const issued = await issueConnectorAuthorization({
      bundle,
      credential: credential(),
      identity,
      connectorId: "google_drive",
      action: "search",
      now,
    });
    await expect(verifyConnectorAuthorizationCurrent({
      labels: { ...issued.labels, digest: "sha256:tampered" },
      bundle,
      credential: credential(),
      now: now + 1_000,
    })).rejects.toThrow("connector_labels_tampered");
  });
});
