import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueConnectorAuthorization,
  parseCredentialReference,
} from "../src/connectors/authorization.js";
import { createLinearWriteApproval } from "../src/connectors/linear-write.js";
import { platformProviderAdapterApp } from "../workers/platform-provider-adapter/src/index.js";

const NOW = Date.parse("2026-08-03T20:00:00.000Z");
const LINEAR_TEAM_ID = "11111111-1111-4111-8111-111111111111";
const LINEAR_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "ABCDEFGHIJKLMNOP";
const TOKEN = "linear-provider-secret";

type FixtureOptions = Readonly<{
  brokerError?: string;
  providerResponse?: unknown;
  credentialScopes?: readonly string[];
}>;

type Fixture = {
  env: Record<string, unknown>;
  body: { schemaVersion: 1; intent: Record<string, unknown> };
  resolverRequests: unknown[];
  brokerRequests: unknown[];
  providerRequests: Array<{ headers: Headers; body: Record<string, unknown> }>;
  storeRecords: Map<string, { status: "completed" | "ambiguous"; receipt: unknown }>;
};

function resolutionCredential(scopes: readonly string[] = ["issues:create"]) {
  return parseCredentialReference({
    schemaVersion: 1,
    ref: "credential:linear:controlled",
    provider: "linear",
    name: "controlled",
    version: 1,
    status: "active",
    scopes,
    subject: "workspace:controlled-linear-test",
    issuedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString(),
  });
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const credential = resolutionCredential(options.credentialScopes);
  const bundle = {
    id: "linear-test-bundle",
    tools: [],
    mcpEndpoints: [],
    secretRefs: [],
    revision: 4,
    status: "active" as const,
    connectorGrants: [{
      connectorId: "linear",
      actions: ["create_issue"],
      scope: "project" as const,
      projectId: "P1",
      credentialRef: credential.ref,
    }],
  };
  const authorization = await issueConnectorAuthorization({
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
    connectorId: "linear",
    action: "create_issue",
    now: NOW,
    lifetimeMs: 60_000,
  });
  const approval = await createLinearWriteApproval({
    approvalId: APPROVAL_ID,
    teamId: LINEAR_TEAM_ID,
    channelId: "C1",
    requesterId: "U1",
    executionId: "exec-1",
    threadKey: "thread-1",
    draft: {
      title: "Controlled provider issue",
      description: "Created by the isolated provider adapter test.",
      team: LINEAR_TEAM_ID,
    },
    now: NOW,
  });
  const requestRef = `linear-write-approval:${APPROVAL_ID}`;
  const intent: Record<string, unknown> = {
    schemaVersion: 1,
    intentId: "effect:linear:create-issue:1",
    idempotencyKey: "linear-effect-idempotency-1",
    scope: "tenant",
    tenantId: "tenant-internal-T1",
    kind: "connector_effect",
    targetRef: "connector:linear:create_issue",
    metadata: {
      action: "create_issue",
      authorizationDigest: authorization.labels.digest,
      connectorId: "linear",
      credentialRef: credential.ref,
      credentialVersion: credential.version,
      requestDigest: approval.draftDigest,
      requestRef,
      requestRevision: 1,
    },
    requestedAt: new Date(NOW).toISOString(),
  };
  const body = { schemaVersion: 1 as const, intent };
  const resolverRequests: unknown[] = [];
  const brokerRequests: unknown[] = [];
  const providerRequests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const storeRecords = new Map<string, { status: "completed" | "ambiguous"; receipt: unknown }>();
  const reservations = new Map<string, { reservationId: string; key: string }>();
  let reservationNumber = 0;

  const resolver = {
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      resolverRequests.push(JSON.parse(String(init?.body)));
      return Response.json({
        schemaVersion: 1,
        requestRef,
        requestRevision: 1,
        requestDigest: approval.draftDigest,
        authorizationDigest: authorization.labels.digest,
        labels: authorization.labels,
        credential,
        approval,
      });
    }),
  };
  const broker = {
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      brokerRequests.push(JSON.parse(String(init?.body)));
      if (options.brokerError) {
        return Response.json({ error: options.brokerError }, { status: 403 });
      }
      return Response.json({
        schemaVersion: 1,
        ref: credential.ref,
        version: credential.version,
        accessToken: TOKEN,
        expiresAt: new Date(NOW + 30_000).toISOString(),
      });
    }),
  };
  const idempotency = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/reserve") {
        const key = String(request.key);
        const existing = storeRecords.get(key);
        if (existing) return Response.json({ schemaVersion: 1, ...existing });
        const active = reservations.get(key);
        if (active) return Response.json({ schemaVersion: 1, status: "conflict" });
        reservationNumber += 1;
        const reservation = { reservationId: `reservation-${reservationNumber}`, key };
        reservations.set(key, reservation);
        return Response.json({ schemaVersion: 1, status: "reserved", reservationId: reservation.reservationId });
      }
      const reservation = [...reservations.values()].find((candidate) => candidate.reservationId === request.reservationId);
      if (!reservation) return Response.json({ error: "reservation_not_found" }, { status: 409 });
      if (path === "/complete" || path === "/ambiguous") {
        const status = path === "/complete" ? "completed" : "ambiguous";
        storeRecords.set(reservation.key, { status, receipt: request.receipt });
        reservations.delete(reservation.key);
        return Response.json({ schemaVersion: 1, status: "stored" });
      }
      if (path === "/release") {
        reservations.delete(reservation.key);
        return Response.json({ schemaVersion: 1, status: "released" });
      }
      return Response.json({ error: "unexpected_path" }, { status: 404 });
    }),
  };

  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    providerRequests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json(options.providerResponse ?? {
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: LINEAR_ISSUE_ID,
            identifier: "OPTAG-1",
            title: "Controlled provider issue",
            url: "https://linear.app/controlled/issue/OPTAG-1",
          },
        },
      },
    });
  }));

  return {
    env: {
      PLATFORM_PROVIDER_ADAPTER_AUTH_TOKEN: "adapter-secret",
      PROVIDER_REQUEST_RESOLVER: resolver,
      PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN: "resolver-secret",
      CREDENTIAL_BROKER: broker,
      CREDENTIAL_BROKER_AUTH_TOKEN: "broker-secret",
      PROVIDER_IDEMPOTENCY_STORE: idempotency,
      PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN: "idempotency-secret",
      LINEAR_CONTROLLED_WORKSPACE_SUBJECT: "workspace:controlled-linear-test",
      LINEAR_API_URL: "https://linear.test/graphql",
    },
    body,
    resolverRequests,
    brokerRequests,
    providerRequests,
    storeRecords,
  };
}

async function execute(fixture: Fixture, body: unknown = fixture.body): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await platformProviderAdapterApp.fetch(
    new Request("https://provider-adapter/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer adapter-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    fixture.env as never,
  );
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("platform provider adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves an opaque approval through the broker and returns a strict Linear receipt", async () => {
    const fixture = await makeFixture();
    const result = await execute(fixture);

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: 1,
      status: "completed",
      externalReceiptRef: `linear-issue:${LINEAR_ISSUE_ID}`,
    });
    expect(fixture.providerRequests).toHaveLength(1);
    expect(fixture.providerRequests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(fixture.providerRequests[0]?.headers.get("idempotency-key")).toBe("linear-effect-idempotency-1");
    expect(fixture.brokerRequests).toHaveLength(3);
    expect(JSON.stringify(fixture.brokerRequests)).not.toContain(TOKEN);
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
    const stored = [...fixture.storeRecords.values()][0]?.receipt as Record<string, unknown>;
    expect(stored).toMatchObject({
      schemaVersion: 1,
      tenantId: "tenant-internal-T1",
      provider: "linear",
      action: "create_issue",
      idempotencyKey: "linear-effect-idempotency-1",
      status: "completed",
      externalReceiptRef: `linear-issue:${LINEAR_ISSUE_ID}`,
    });
    expect(Object.keys(stored).sort()).toEqual([
      "action",
      "authorizationDigest",
      "externalReceiptRef",
      "idempotencyKey",
      "observedAt",
      "provider",
      "requestDigest",
      "requestRef",
      "requestRevision",
      "schemaVersion",
      "status",
      "tenantId",
    ]);
  });

  it("does not advertise effects until credential custody is ready", async () => {
    const fixture = await makeFixture();
    fixture.env.CREDENTIAL_BROKER = {
      fetch: vi.fn(async () => Response.json({
        ok: true,
        providerResolutionEnabled: false,
      })),
    };
    const disabled = await platformProviderAdapterApp.fetch(
      new Request("https://provider-adapter/health"),
      fixture.env as never,
    );
    expect(await disabled.json()).toMatchObject({
      configured: true,
      controlledWorkspaceConfigured: true,
      providerEffectsEnabled: false,
      actions: [],
    });

    fixture.env.CREDENTIAL_BROKER = {
      fetch: vi.fn(async () => Response.json({
        ok: true,
        providerResolutionEnabled: true,
      })),
    };
    const enabled = await platformProviderAdapterApp.fetch(
      new Request("https://provider-adapter/health"),
      fixture.env as never,
    );
    expect(await enabled.json()).toMatchObject({
      providerEffectsEnabled: true,
      actions: ["linear/create_issue"],
    });
  });

  it("returns the durable duplicate receipt without resolving or calling Linear again", async () => {
    const fixture = await makeFixture();
    const first = await execute(fixture);
    const second = await execute(fixture);

    expect(second.response.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(fixture.providerRequests).toHaveLength(1);
    expect(fixture.resolverRequests).toHaveLength(1);
    expect(fixture.brokerRequests).toHaveLength(3);
  });

  it("fails closed when the broker reports a revoked credential", async () => {
    const fixture = await makeFixture({ brokerError: "credential_revoked" });
    const result = await execute(fixture);

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: 1,
      status: "failed",
      errorCode: "credential_revoked",
      retryable: false,
      retryAfterSeconds: 0,
    });
    expect(fixture.providerRequests).toHaveLength(0);
    expect(fixture.storeRecords.size).toBe(0);
  });

  it("fails closed when the resolved credential lacks the Linear write scope", async () => {
    const fixture = await makeFixture({ credentialScopes: ["issues:read"] });
    const result = await execute(fixture);

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: 1,
      status: "failed",
      errorCode: "credential_scope_missing",
      retryable: false,
      retryAfterSeconds: 0,
    });
    expect(fixture.providerRequests).toHaveLength(0);
    expect(fixture.brokerRequests).toHaveLength(0);
    expect(fixture.storeRecords.size).toBe(0);
  });

  it("rejects malformed or token-bearing envelopes before any binding call", async () => {
    const fixture = await makeFixture();
    const malformed = {
      ...fixture.body,
      providerToken: TOKEN,
    };
    const result = await execute(fixture, malformed);

    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ error: "provider_adapter_request_invalid" });
    expect(fixture.resolverRequests).toHaveLength(0);
    expect(fixture.brokerRequests).toHaveLength(0);
    expect(fixture.providerRequests).toHaveLength(0);
    expect(fixture.storeRecords.size).toBe(0);
  });

  it("records an ambiguous Linear response and suppresses a blind duplicate", async () => {
    const fixture = await makeFixture({
      providerResponse: {
        data: {
          issueCreate: {
            success: true,
            issue: { id: LINEAR_ISSUE_ID },
          },
        },
      },
    });
    const first = await execute(fixture);
    const second = await execute(fixture);

    expect(first.body).toEqual({
      schemaVersion: 1,
      status: "failed",
      errorCode: "linear_provider_response_ambiguous",
      retryable: false,
      retryAfterSeconds: 0,
    });
    expect(second.body).toEqual(first.body);
    expect(fixture.providerRequests).toHaveLength(1);
    expect([...fixture.storeRecords.values()][0]).toMatchObject({ status: "ambiguous" });
  });
});
