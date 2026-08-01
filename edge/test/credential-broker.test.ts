import { describe, expect, it, vi } from "vitest";
import {
  credentialReferenceId,
  issueConnectorAuthorization,
  parseCredentialReference,
} from "../src/connectors/authorization.js";
import {
  resolveCredentialBearer,
  validateCredentialBrokerRequest,
} from "../src/connectors/credential-broker.js";

const reference = parseCredentialReference({
  schemaVersion: 1,
  ref: credentialReferenceId("google", "workspace-drive"),
  provider: "google",
  name: "workspace-drive",
  version: 3,
  status: "active",
  scopes: ["drive.readonly"],
  subject: "workspace:T1",
  issuedAt: "2099-08-01T19:00:00.000Z",
  expiresAt: "2099-08-01T21:00:00.000Z",
});

const bundle = {
  id: "drive-readers",
  tools: ["search_drive"],
  mcpEndpoints: [],
  secretRefs: [],
  revision: 4,
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

describe("credential broker client protocol", () => {
  it("sends complete immutable labels and internal authentication", async () => {
    const immutable = await labels();
    let requestBody: unknown;
    let requestHeaders: Headers | undefined;
    const broker = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          schemaVersion: 1,
          ref: reference.ref,
          version: reference.version,
          accessToken: "runtime-only-token",
          expiresAt: "2099-08-01T20:00:30.000Z",
        });
      }),
    };

    await expect(resolveCredentialBearer(broker, reference, immutable, {
      brokerAuthToken: "internal-only",
    })).resolves.toBe("runtime-only-token");
    expect(requestHeaders?.get("authorization")).toBe("Bearer internal-only");
    expect(requestBody).toMatchObject({
      schemaVersion: 1,
      reference: { ref: reference.ref, version: reference.version },
      labels: {
        connectorId: "google_drive",
        action: "search",
        digest: immutable.digest,
      },
    });
  });

  it("rejects a client request whose reference does not match its labels", async () => {
    const immutable = await labels();
    expect(() => validateCredentialBrokerRequest({
      schemaVersion: 1,
      reference: { ref: reference.ref, version: reference.version + 1 },
      labels: immutable,
    })).toThrow("credential_broker_reference_mismatch");
  });

  it("rejects an expired broker response before it reaches a connector", async () => {
    const immutable = await labels();
    const broker = {
      fetch: vi.fn(async () => Response.json({
        schemaVersion: 1,
        ref: reference.ref,
        version: reference.version,
        accessToken: "runtime-only-token",
        expiresAt: "2000-08-01T20:00:30.000Z",
      })),
    };
    await expect(resolveCredentialBearer(broker, reference, immutable)).rejects.toThrow(
      "connector_credential_resolution_expired",
    );
  });
});
