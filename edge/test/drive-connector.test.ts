import { describe, expect, it, vi } from "vitest";
import {
  credentialReferenceId,
  issueConnectorAuthorization,
  parseCredentialReference,
  type CredentialReference,
} from "../src/connectors/authorization.js";
import type { CredentialBroker } from "../src/connectors/credential-broker.js";
import { searchGoogleDrive } from "../src/memory/connectors/drive-connector.js";

const credential = parseCredentialReference({
  schemaVersion: 1,
  ref: credentialReferenceId("google", "workspace-drive"),
  provider: "google",
  name: "workspace-drive",
  version: 1,
  status: "active",
  scopes: ["drive.readonly"],
  subject: "workspace:T1",
  issuedAt: "2026-08-01T19:00:00.000Z",
  expiresAt: "2026-08-01T21:00:00.000Z",
});

const bundle = {
  id: "drive-readers",
  tools: ["search_drive"],
  mcpEndpoints: [],
  secretRefs: [],
  revision: 1,
  status: "active" as const,
  connectorGrants: [{
    connectorId: "google_drive",
    actions: ["search"],
    scope: "project" as const,
    projectId: "P1",
    credentialRef: credential.ref,
  }],
};

async function authorization() {
  return issueConnectorAuthorization({
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
    now: Date.parse("2026-08-01T20:00:00.000Z"),
  });
}

describe("Google Drive connector", () => {
  it("performs bounded full-text search through the credential broker and binds citations", async () => {
    const issued = await authorization();
    const broker: CredentialBroker = {
      fetch: vi.fn(async () => Response.json({
        schemaVersion: 1,
        ref: credential.ref,
        version: credential.version,
        accessToken: "opaque-runtime-token",
      })),
    };
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    const revalidate = vi.fn(async () => {});
    const results = await searchGoogleDrive({
      workspaceId: "T1",
      projectId: "P1",
      query: "restore team's database",
      limit: 2,
      labels: issued.labels,
      bundle,
      credential,
      credentialBroker: broker,
      revalidate,
      now: Date.parse("2026-08-01T20:00:00.000Z"),
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          files: [
            {
              id: "file-1",
              name: "Restore runbook",
              mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-08-01T19:30:00.000Z",
              webViewLink: "https://drive.google.com/file/d/file-1/view",
              description: "Database recovery steps",
            },
          ],
        });
      },
    });
    expect(requestUrl).toContain("fullText+contains");
    expect(requestUrl).toContain("restore");
    expect(requestHeaders?.get("authorization")).toBe("Bearer opaque-runtime-token");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sourceType: "drive",
      sourceKey: "drive:T1:P1:file-1",
      fileId: "file-1",
      permalink: "https://drive.google.com/file/d/file-1/view",
      authorization: {
        accessBundleId: "drive-readers",
        accessBundleRevision: 1,
        credentialVersion: 1,
      },
    });
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it("fails closed without a read scope or credential broker", async () => {
    const issued = await authorization();
    await expect(searchGoogleDrive({
      workspaceId: "T1",
      projectId: "P1",
      query: "anything",
      labels: issued.labels,
      bundle,
      credential: parseCredentialReference({
        ...(credential as CredentialReference),
        scopes: [],
      }),
      now: Date.parse("2026-08-01T20:00:00.000Z"),
    })).rejects.toThrow("drive_read_scope_missing");
    await expect(searchGoogleDrive({
      workspaceId: "T1",
      projectId: "P1",
      query: "anything",
      labels: issued.labels,
      bundle,
      credential,
      now: Date.parse("2026-08-01T20:00:00.000Z"),
    })).rejects.toThrow("connector_credential_broker_unavailable");
  });
});
