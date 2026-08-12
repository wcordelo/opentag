import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueConnectorAuthorization, parseCredentialReference } from "../src/connectors/authorization.js";
import { createLinearWriteApproval } from "../src/connectors/linear-write.js";

vi.mock("cloudflare:workers", () => ({
    DurableObject: class {
    constructor(ctx: unknown) { Object.assign(this, { ctx }); }
  },
}));

const { default: resolverWorker, ProviderRequestDO } = await import(
  "../workers/platform-provider-request-resolver/src/index.js"
);
const { default: idempotencyWorker, ProviderIdempotencyDO } = await import(
  "../workers/platform-provider-idempotency/src/index.js"
);

type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T, options?: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

function storage(): Storage {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, value); },
    async delete(key: string) { return values.delete(key); },
  };
}

function namespace<T extends new (ctx: unknown, env: unknown) => { fetch(request: Request): Promise<Response> }>(Type: T) {
  const instances = new Map<string, InstanceType<T>>();
  return {
    idFromName(name: string) { return name; },
    get(id: string) {
      let instance = instances.get(id);
      if (!instance) {
        instance = new Type({ storage: storage() }, {}) as InstanceType<T>;
        instances.set(id, instance);
      }
      return instance;
    },
  };
}

async function fixture() {
  const now = Date.now();
  const credential = parseCredentialReference({
    schemaVersion: 1,
    ref: "credential:linear:controlled",
    provider: "linear",
    name: "controlled",
    version: 1,
    status: "active",
    scopes: ["issues:create"],
    subject: "workspace:controlled-linear-test",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
  });
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
    now,
    lifetimeMs: 60_000,
  });
  const approval = await createLinearWriteApproval({
    approvalId: "ABCDEFGHIJKLMNOP",
    teamId: "T1",
    channelId: "C1",
    requesterId: "U1",
    executionId: "exec-1",
    threadKey: "thread-1",
    draft: { title: "Provider support test", team: "T1" },
    now,
  });
  return { credential, labels: authorization.labels, approval };
}

describe("provider support Workers", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.now() }));

  it("registers and resolves an opaque request without accepting secrets", async () => {
    const values = await fixture();
    const requests = namespace(ProviderRequestDO);
    const env = {
      PROVIDER_REQUEST_RESOLVER_AUTH_TOKEN: "resolver-secret",
      REQUESTS: requests,
    };
    const body = {
      schemaVersion: 1,
      tenantId: "tenant-internal-T1",
      provider: "linear",
      action: "create_issue",
      requestRef: "linear-write-approval:ABCDEFGHIJKLMNOP",
      requestRevision: 1,
      requestDigest: values.approval.draftDigest,
      authorizationDigest: values.labels.digest,
      labels: values.labels,
      credential: values.credential,
      approval: values.approval,
    };
    const registered = await resolverWorker.fetch(new Request("https://resolver/register", {
      method: "POST",
      headers: { authorization: "Bearer resolver-secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env as never);
    expect(registered.status, JSON.stringify(await registered.clone().json())).toBe(200);
    const resolved = await resolverWorker.fetch(new Request("https://resolver/resolve", {
      method: "POST",
      headers: { authorization: "Bearer resolver-secret", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        tenantId: body.tenantId,
        provider: body.provider,
        action: body.action,
        requestRef: body.requestRef,
        requestRevision: body.requestRevision,
        requestDigest: body.requestDigest,
        authorizationDigest: body.authorizationDigest,
      }),
    }), env as never);
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ requestRef: body.requestRef, requestRevision: 1 });
    const secretField = { ...body, credential: { ...values.credential, accessToken: "never" } };
    const rejected = await resolverWorker.fetch(new Request("https://resolver/register", {
      method: "POST",
      headers: { authorization: "Bearer resolver-secret", "content-type": "application/json" },
      body: JSON.stringify(secretField),
    }), env as never);
    expect(rejected.status).toBe(400);
  });

  it("keeps idempotency reservation and completion durable and replay-safe", async () => {
    const records = namespace(ProviderIdempotencyDO);
    const env = {
      PROVIDER_IDEMPOTENCY_STORE_AUTH_TOKEN: "idempotency-secret",
      RECORDS: records,
    };
    const base = {
      schemaVersion: 1,
      operation: "reserve",
      key: "tenant-1|linear|create_issue|effect-1",
      tenantId: "tenant-1",
      provider: "linear",
      action: "create_issue",
      idempotencyKey: "effect-1",
      requestRef: "linear-write-approval:ABCDEFGHIJKLMNOP",
      requestRevision: 1,
      requestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      authorizationDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const call = (path: string, body: unknown) => idempotencyWorker.fetch(new Request(`https://idempotency${path}`, {
      method: "POST",
      headers: { authorization: "Bearer idempotency-secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env as never);
    const reserved = await call("/reserve", base);
    const reservedBody = await reserved.clone().json() as Record<string, unknown>;
    const reservation = await reserved.json() as { reservationId: string };
    expect(reserved.status, JSON.stringify(reservedBody)).toBe(200);
    const receipt = {
      schemaVersion: 1,
      tenantId: "tenant-1",
      provider: "linear",
      action: "create_issue",
      idempotencyKey: "effect-1",
      requestRef: base.requestRef,
      requestRevision: 1,
      requestDigest: base.requestDigest,
      authorizationDigest: base.authorizationDigest,
      status: "completed",
      externalReceiptRef: "linear-issue:issue-1",
      observedAt: new Date().toISOString(),
    };
    const completed = await call("/complete", {
      schemaVersion: 1,
      operation: "complete",
      key: base.key,
      reservationId: reservation.reservationId,
      receipt,
    });
    expect(completed.status).toBe(200);
    const duplicate = await call("/reserve", base);
    expect(await duplicate.json()).toMatchObject({ status: "completed", receipt });
  });
});
