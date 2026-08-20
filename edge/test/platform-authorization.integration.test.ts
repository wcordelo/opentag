import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/config/workspace-config-do.js", () => ({
  loadConnectorAuthorization: vi.fn(async (_namespace: unknown, input: Record<string, unknown>) => ({
    labels: {
      credentialRef: CREDENTIAL_REF,
      platformBinding: input.platformBinding,
    },
    credential: workspaceCredential,
  })),
}));

const { PlatformStateDO } = await import("../src/platform/platform-state-do.js");
import { PlatformStateConnectorAuthorizationReader } from "../src/connectors/authorization-snapshot.js";
import { loadPlatformConnectorAuthorization } from "../src/connectors/platform-authorization.js";
import { bindRequestContext, slackTurnIdentitySync } from "../src/request-context.js";
import { slackObligationThreadKey } from "../src/slack/obligation-thread-key.js";
import { REQUIRED_PROVISIONING_STEPS } from "../src/platform/layer3-contract.js";
import { TENANT_LOCATOR_OBJECT_NAME } from "../src/platform/tenant-locator.js";
import { platformTenantObjectName } from "../src/platform/tenant-routing.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

type PlatformStateInstance = InstanceType<typeof PlatformStateDO>;
type PlatformStateStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

const NOW = "2026-08-01T20:00:00.000Z";
const EXPIRES = "2099-08-01T20:00:00.000Z";
const EXTERNAL_TENANT = "T-platform-acceptance";
const EXTERNAL_SUBJECT = "U-platform-acceptance";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_REF = "credential:google:workspace-drive";
const MARKETPLACE_VERSION = "2026-08-01";

const marketplace = {
  schemaVersion: 1,
  connectorId: "google_drive",
  provider: "google",
  version: MARKETPLACE_VERSION,
  status: "curated",
  authMode: "oauth2",
  actions: ["search"],
  oauthScopes: ["drive.readonly"],
  trustReviewRef: "review:google-drive-read-only",
} as const;

const workspaceCredential = {
  schemaVersion: 1,
  ref: CREDENTIAL_REF,
  provider: "google",
  name: "workspace-drive",
  version: 1,
  status: "active",
  scopes: ["drive.readonly"],
  subject: "google:user:platform-acceptance",
  issuedAt: NOW,
  expiresAt: EXPIRES,
} as const;

function sqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> {
      const statement = db.prepare(query);
      const params = bindings as Array<string | number | null | bigint>;
      const returnsRows = /^\s*select/i.test(query) || /\breturning\b/i.test(query);
      const rows = returnsRows
        ? statement.all(...params) as T[]
        : (statement.run(...params), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
      };
    },
  };
}

function transaction(db: DatabaseSync) {
  return <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}

function makeState(): { state: PlatformStateInstance; close: () => void } {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: sqliteExecutor(db),
      transactionSync: transaction(db),
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
  return {
    state: new PlatformStateDO(ctx as never, {} as never),
    close: () => db.close(),
  };
}

async function post(
  state: PlatformStateInstance,
  path: string,
  body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await state.fetch(new Request(`https://platform-state${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

function namespace(states: Map<string, PlatformStateStub>) {
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => states.get(String(id))!,
  };
}

function stubFor(state: PlatformStateInstance): PlatformStateStub {
  return {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      return state.fetch(request);
    },
  };
}

async function seedPlatformFlow(): Promise<{
  tenantId: string;
  tenant: PlatformStateInstance;
  reserved: PlatformStateInstance;
  close: () => void;
}> {
  const tenant = makeState();
  const reserved = makeState();
  const request = {
    schemaVersion: 1,
    requestId: "platform-acceptance-request",
    idempotencyKey: "platform-acceptance-install",
    externalPlatform: "slack",
    externalTenantId: EXTERNAL_TENANT,
    requestedByExternalSubject: EXTERNAL_SUBJECT,
    isolationMode: "shared_worker_per_tenant_do",
    custodyBackend: "external_kms",
    requestedAt: NOW,
  } as const;

  const provisioned = await post(tenant.state, "/provision", request);
  expect(provisioned.response.status).toBe(200);
  const tenantId = provisioned.body.tenantId as string;
  for (const step of REQUIRED_PROVISIONING_STEPS) {
    const receipt = await post(tenant.state, "/provision/step", {
      schemaVersion: 1,
      idempotencyKey: request.idempotencyKey,
      step,
      outcome: "complete",
      externalReceiptRef: `receipt:${step}`,
      observedAt: NOW,
    });
    expect(receipt.response.status).toBe(200);
  }

  const locator = await post(reserved.state, "/tenant-locator", {
    schemaVersion: 1,
    platform: "slack",
    platformTenantId: EXTERNAL_TENANT,
    tenantId,
    version: 1,
    status: "active",
    updatedAt: NOW,
  });
  expect(locator.response.status).toBe(200);

  const subject = {
    platform: "slack",
    platformTenantId: EXTERNAL_TENANT,
    platformSubjectId: EXTERNAL_SUBJECT,
  } as const;
  const identityLink = await post(tenant.state, "/identity-link", {
    schemaVersion: 1,
    tenantId,
    subject,
    principal: {
      tenantId,
      principalId: PRINCIPAL_ID,
      kind: "human",
      status: "active",
      authorizationVersion: 1,
    },
    identityLink: {
      tenantId,
      principalId: PRINCIPAL_ID,
      subject,
      proofType: "slack_admin_attestation",
      proofDigest: "sha256:platform-acceptance-proof",
      verifiedAt: NOW,
      identityLinkVersion: 1,
    },
    version: 1,
    status: "active",
    updatedAt: NOW,
  });
  expect(identityLink.response.status).toBe(200);

  const credential = await post(tenant.state, "/credential", {
    schemaVersion: 1,
    tenantId,
    credentialRef: CREDENTIAL_REF,
    backend: "external_kms",
    provider: "google",
    subject: workspaceCredential.subject,
    scopes: ["drive.readonly"],
    version: 1,
    status: "active",
    issuedAt: NOW,
    expiresAt: EXPIRES,
  });
  expect(credential.response.status).toBe(200);

  const marketplaceResult = await post(reserved.state, "/marketplace", marketplace);
  expect(marketplaceResult.response.status).toBe(200);

  const grant = await post(tenant.state, "/oauth", {
    schemaVersion: 1,
    tenantId,
    principalId: PRINCIPAL_ID,
    connectorId: "google_drive",
    marketplaceVersion: MARKETPLACE_VERSION,
    credentialRef: CREDENTIAL_REF,
    providerSubject: workspaceCredential.subject,
    scopes: ["drive.readonly"],
    version: 1,
    status: "active",
    issuedAt: NOW,
    expiresAt: EXPIRES,
    marketplaceSnapshot: marketplace,
  });
  expect(grant.response.status).toBe(200);

  return {
    tenantId,
    tenant: tenant.state,
    reserved: reserved.state,
    close: () => {
      tenant.close();
      reserved.close();
    },
  };
}

function verifiedSlackContext() {
  const channelId = "C-platform-acceptance";
  const threadTs = "1710000000.000001";
  const inbound = {
    channel: channelId,
    ts: "1710000000.000002",
    threadTs,
    identity: "event-platform-acceptance",
  };
  const initial = bindRequestContext({}, {
    teamId: EXTERNAL_TENANT,
    requesterId: EXTERNAL_SUBJECT,
    inbound,
    verifiedIngress: {
      method: "slack_hmac_v0",
      evidenceDigest: "sha256:platform-acceptance-ingress",
      verifiedAt: NOW,
    },
  });
  const identity = slackTurnIdentitySync(initial, channelId);
  return {
    channelId,
    context: bindRequestContext({}, {
      teamId: EXTERNAL_TENANT,
      requesterId: EXTERNAL_SUBJECT,
      inbound,
      verifiedIngress: initial.verifiedIngress,
      preAdmittedTurn: {
        record: {
          channelId,
          threadKey: slackObligationThreadKey(EXTERNAL_TENANT, channelId, threadTs),
          conversationKey: "conversation-platform-acceptance",
          executionId: identity.executionId,
          registeredAt: Date.now(),
        },
      },
    }),
    executionId: identity.executionId,
    threadKey: slackObligationThreadKey(EXTERNAL_TENANT, channelId, threadTs),
  };
}

describe("platform authorization acceptance flow", () => {
  it("composes real locator, identity, marketplace, grant, and credential state", async () => {
    const seeded = await seedPlatformFlow();
    try {
      const state = namespace(new Map([
        [TENANT_LOCATOR_OBJECT_NAME, stubFor(seeded.reserved)],
        [platformTenantObjectName(seeded.tenantId), stubFor(seeded.tenant)],
      ]));
      const slack = verifiedSlackContext();
      const authorization = await loadPlatformConnectorAuthorization({
        env: {
          PLATFORM_STATE: state,
          WORKSPACE_CONFIG: {},
        } as never,
        context: slack.context,
        channelId: slack.channelId,
        projectId: "workspace",
        executionId: slack.executionId,
        threadKey: slack.threadKey,
        connectorId: "google_drive",
        action: "search",
      });

      expect(authorization.platformContext.principal).toMatchObject({
        tenantId: seeded.tenantId,
        principalId: PRINCIPAL_ID,
        status: "active",
      });
      expect(authorization.platformBinding).toMatchObject({
        platform: "slack",
        platformTenantId: EXTERNAL_TENANT,
        platformSubjectId: EXTERNAL_SUBJECT,
        tenantId: seeded.tenantId,
        principalId: PRINCIPAL_ID,
        tenantLocatorVersion: 1,
        oauthGrantVersion: 1,
        marketplaceVersion: MARKETPLACE_VERSION,
      });
      expect(authorization.authorization.credential).toMatchObject({
        ref: CREDENTIAL_REF,
        version: 1,
      });
    } finally {
      seeded.close();
    }
  });

  it("rejects the same authorization after the credential revokes its grant", async () => {
    const seeded = await seedPlatformFlow();
    try {
      const state = namespace(new Map([
        [TENANT_LOCATOR_OBJECT_NAME, stubFor(seeded.reserved)],
        [platformTenantObjectName(seeded.tenantId), stubFor(seeded.tenant)],
      ]));
      const slack = verifiedSlackContext();
      await post(seeded.tenant, "/credential/revoke", { credentialRef: CREDENTIAL_REF });

      await expect(loadPlatformConnectorAuthorization({
        env: {
          PLATFORM_STATE: state,
          WORKSPACE_CONFIG: {},
        } as never,
        context: slack.context,
        channelId: slack.channelId,
        projectId: "workspace",
        executionId: slack.executionId,
        threadKey: slack.threadKey,
        connectorId: "google_drive",
        action: "search",
      })).rejects.toThrow("connector_oauth_grant_inactive");
    } finally {
      seeded.close();
    }
  });

  it("rejects an old connector fence after the server-owned locator advances", async () => {
    const seeded = await seedPlatformFlow();
    try {
      const state = namespace(new Map([
        [TENANT_LOCATOR_OBJECT_NAME, stubFor(seeded.reserved)],
        [platformTenantObjectName(seeded.tenantId), stubFor(seeded.tenant)],
      ]));
      const advanced = await post(seeded.reserved, "/tenant-locator", {
        schemaVersion: 1,
        platform: "slack",
        platformTenantId: EXTERNAL_TENANT,
        tenantId: seeded.tenantId,
        version: 2,
        status: "active",
        updatedAt: "2026-08-01T20:01:00.000Z",
      });
      expect(advanced.response.status).toBe(200);

      await expect(new PlatformStateConnectorAuthorizationReader(state).resolve({
        tenantId: seeded.tenantId,
        principalId: PRINCIPAL_ID,
        platform: "slack",
        platformTenantId: EXTERNAL_TENANT,
        platformSubjectId: EXTERNAL_SUBJECT,
        tenantLocatorVersion: 1,
        connectorId: "google_drive",
        action: "search",
      })).rejects.toThrow("connector_tenant_locator_stale");
    } finally {
      seeded.close();
    }
  });
});
