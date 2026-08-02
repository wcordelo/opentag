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

const { PlatformStateDO } = await import("../src/platform/platform-state-do.js");
import { REQUIRED_PROVISIONING_STEPS } from "../src/platform/layer3-contract.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";
type PlatformStateInstance = InstanceType<typeof PlatformStateDO>;

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

function makeState() {
  const db = new DatabaseSync(":memory:");
  const sql = sqliteExecutor(db);
  const ctx = {
    storage: {
      sql,
      transactionSync: transaction(db),
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
  const state = new PlatformStateDO(ctx as never, {} as never);
  return { db, state, close: () => db.close() };
}

async function call(state: PlatformStateInstance, path: string, body: unknown): Promise<{
  response: Response;
  body: Record<string, unknown>;
}> {
  const response = await state.fetch(new Request(`https://do${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

const now = "2026-08-01T20:00:00.000Z";
const request = {
  schemaVersion: 1,
  requestId: "request-1",
  idempotencyKey: "install-1",
  externalPlatform: "slack",
  externalTenantId: "T-platform-state",
  requestedByExternalSubject: "U-admin",
  isolationMode: "shared_worker_per_tenant_do",
  custodyBackend: "external_kms",
  requestedAt: now,
} as const;

describe("PlatformStateDO", () => {
  it("durably advances provisioning and keeps retries idempotent", async () => {
    const { state, close } = makeState();
    try {
      const first = await call(state, "/provision", request);
      expect(first.response.status).toBe(200);
      expect(first.body).toMatchObject({
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: "requested",
        completedSteps: [],
      });
      expect(first.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);

      const duplicate = await call(state, "/provision", request);
      expect(duplicate.response.status).toBe(200);
      expect(duplicate.body.tenantId).toBe(first.body.tenantId);

      for (const step of REQUIRED_PROVISIONING_STEPS) {
        const advanced = await call(state, "/provision/step", {
          schemaVersion: 1,
          idempotencyKey: request.idempotencyKey,
          step,
          outcome: "complete",
          externalReceiptRef: `receipt:${step}`,
          observedAt: now,
        });
        expect(advanced.response.status).toBe(200);
      }
      const final = await call(state, "/provision/get", {
        tenantId: first.body.tenantId,
      });
      expect(final.body.status).toBe("active");
      expect(final.body.completedSteps).toEqual([...REQUIRED_PROVISIONING_STEPS]);

      const conflicting = await call(state, "/provision", {
        ...request,
        requestedByExternalSubject: "U-other",
      });
      expect(conflicting.response.status).toBe(409);
      expect(conflicting.body.error).toBe("provisioning_idempotency_conflict");
    } finally {
      close();
    }
  });

  it("persists custody references and makes revocation terminal", async () => {
    const { state, close } = makeState();
    try {
      const provisioned = await call(state, "/provision", request);
      const tenantId = provisioned.body.tenantId;
      const identity = {
        schemaVersion: 1,
        tenantId,
        identityRef: "identity:slack:bot",
        backend: "external_kms",
        publicKey: "ed25519-public-key",
        version: 1,
        status: "active",
        issuedAt: now,
      };
      expect((await call(state, "/identity", identity)).response.status).toBe(200);
      const identityRead = await call(state, "/identity/get", { identityRef: identity.identityRef });
      expect(identityRead.response.status).toBe(200);
      expect(identityRead.body).toMatchObject({
        identityRef: identity.identityRef,
        publicKey: identity.publicKey,
        version: identity.version,
      });
      expect((await call(state, "/identity/revoke", { identityRef: identity.identityRef })).response.status).toBe(200);
      expect((await call(state, "/identity", { ...identity, version: 2 })).body.error).toBe("identity_revoked");

      const credential = {
        schemaVersion: 1,
        tenantId,
        credentialRef: "credential:google:drive",
        backend: "external_kms",
        provider: "google",
        subject: "acct-1",
        scopes: ["drive.readonly"],
        version: 1,
        status: "active",
        issuedAt: now,
      };
      expect((await call(state, "/credential", credential)).response.status).toBe(200);
      expect((await call(state, "/credential/revoke", { credentialRef: credential.credentialRef })).response.status).toBe(200);
      expect((await call(state, "/credential", { ...credential, version: 2 })).body.error).toBe("credential_revoked");
    } finally {
      close();
    }
  });

  it("records marketplace, OAuth, metering, memory governance, and effect intents", async () => {
    const { state, close } = makeState();
    try {
      const provisioned = await call(state, "/provision", request);
      const tenantId = provisioned.body.tenantId;
      for (const step of REQUIRED_PROVISIONING_STEPS) {
        await call(state, "/provision/step", {
          schemaVersion: 1,
          idempotencyKey: request.idempotencyKey,
          step,
          outcome: "complete",
          externalReceiptRef: `receipt:${step}`,
          observedAt: now,
        });
      }
      const credential = {
        schemaVersion: 1,
        tenantId,
        credentialRef: "credential:google:drive",
        backend: "external_kms",
        provider: "google",
        subject: "acct-1",
        scopes: ["drive.readonly"],
        version: 1,
        status: "active",
        issuedAt: now,
      };
      await call(state, "/credential", credential);

      const marketplace = {
        schemaVersion: 1,
        connectorId: "google_drive",
        provider: "google",
        version: "v1",
        status: "curated",
        authMode: "oauth2",
        actions: ["search"],
        oauthScopes: ["drive.readonly"],
        trustReviewRef: "review:google-drive:v1",
      };
      expect((await call(state, "/marketplace", marketplace)).response.status).toBe(200);

      const grant = {
        schemaVersion: 1,
        tenantId,
        principalId: "principal-1",
        connectorId: "google_drive",
        marketplaceVersion: "v1",
        credentialRef: credential.credentialRef,
        providerSubject: "acct-1",
        scopes: ["drive.readonly"],
        version: 1,
        status: "active",
        issuedAt: now,
      };
      expect((await call(state, "/oauth", grant)).response.status).toBe(200);
      expect((await call(state, "/marketplace/revoke", {
        connectorId: marketplace.connectorId,
        version: marketplace.version,
      })).response.status).toBe(200);
      const revokedByMarketplace = await call(state, "/oauth/get", {
        tenantId,
        principalId: grant.principalId,
        connectorId: grant.connectorId,
      });
      expect(revokedByMarketplace.body.status).toBe("revoked");
      expect((await call(state, "/credential", { ...credential, version: 2 })).response.status).toBe(200);
      const revokedGrant = await call(state, "/oauth/get", {
        tenantId,
        principalId: grant.principalId,
        connectorId: grant.connectorId,
      });
      expect(revokedGrant.body.status).toBe("revoked");
      expect((await call(state, "/oauth/revoke", {
        tenantId,
        principalId: grant.principalId,
        connectorId: grant.connectorId,
      })).response.status).toBe(200);

      const meter = {
        schemaVersion: 1,
        eventId: "meter-1",
        idempotencyKey: "meter-key-1",
        tenantId,
        executionId: "execution-1",
        tier: 1,
        metric: "knowledge_query",
        quantity: 1,
        unit: "count",
        planRevision: 1,
        occurredAt: now,
      };
      expect((await call(state, "/meter", meter)).response.status).toBe(200);
      expect((await call(state, "/meter", meter)).body.duplicate).toBe(true);

      const policy = {
        schemaVersion: 1,
        tenantId,
        retentionDays: 30,
        optedOutChannelIds: ["C-private"],
        deletionEpoch: 1,
        adminVisibility: "metadata_only",
        updatedAt: now,
      };
      expect((await call(state, "/memory/policy", policy)).response.status).toBe(200);
      expect((await call(state, "/memory/policy", {
        ...policy,
        retentionDays: 31,
      })).body.error).toBe("memory_deletion_epoch_must_advance");
      const deletion = {
        schemaVersion: 1,
        requestId: "deletion-1",
        idempotencyKey: "deletion-key-1",
        tenantId,
        sourceKeys: ["slack:C-private:thread-1"],
        requestedByPrincipalId: "principal-1",
        requestedAt: now,
        deletionEpoch: 1,
      };
      const requested = await call(state, "/memory/deletion", deletion);
      expect(requested.response.status).toBe(200);
      expect(requested.body.status).toBe("requested");
      expect((await call(state, "/memory/deletion", deletion)).body.duplicate).toBe(true);
      const receipt = {
        schemaVersion: 1,
        idempotencyKey: "memory-receipt-key-1",
        requestId: deletion.requestId,
        tenantId,
        sourceKey: "slack:C-private:thread-1",
        deletionEpoch: 1,
        status: "deleted",
        observedAt: now,
        receiptRef: "memory:receipt-1",
      };
      const recordedReceipt = await call(state, "/memory/deletion/receipt", receipt);
      expect(recordedReceipt.response.status).toBe(200);
      expect(recordedReceipt.body.status).toBe("completed");
      expect((await call(state, "/memory/deletion/receipt", receipt)).body.duplicate).toBe(true);
      const completedDeletion = await call(state, "/memory/deletion/get", deletion.idempotencyKey);
      expect(completedDeletion.body).toMatchObject({
        status: "completed",
        receipts: [expect.objectContaining({ sourceKey: receipt.sourceKey, status: "deleted" })],
      });
      const duplicateAfterCompletion = await call(state, "/memory/deletion", deletion);
      expect(duplicateAfterCompletion.body).toMatchObject({ duplicate: true, status: "completed" });

      const effects = await call(state, "/effect/list", { scope: "tenant", tenantId });
      expect(effects.body.effects).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "provisioning", status: "pending" }),
        expect.objectContaining({ kind: "connector_oauth", targetRef: "google_drive" }),
        expect.objectContaining({ kind: "credential_custody", targetRef: credential.credentialRef }),
        expect.objectContaining({ kind: "billing_meter", targetRef: meter.eventId }),
        expect.objectContaining({ kind: "memory_deletion", targetRef: `memory-deletion:${deletion.idempotencyKey}` }),
      ]));
      const platformEffects = await call(state, "/effect/list", { scope: "platform" });
      expect(platformEffects.body.effects).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "marketplace", status: "pending", scope: "platform" }),
      ]));
    } finally {
      close();
    }
  });

  it("hands hosted effects across a leased, idempotent, secret-free boundary", async () => {
    const { state, close } = makeState();
    try {
      const provisioned = await call(state, "/provision", {
        ...request,
        requestId: "request-effects",
        idempotencyKey: "install-effects",
        externalTenantId: "T-platform-effects",
      });
      const tenantId = provisioned.body.tenantId as string;
      const listed = await call(state, "/effect/list", { scope: "tenant", tenantId });
      expect(listed.response.status).toBe(200);
      expect(listed.body.effects).toEqual([
        expect.objectContaining({
          kind: "provisioning",
          status: "pending",
          attempts: 0,
          tenantId,
        }),
      ]);
      const intentId = (listed.body.effects as Array<{ intentId: string }>)[0]!.intentId;

      const claimed = await call(state, "/effect/claim", {
        intentId,
        workerId: "provisioner-1",
        leaseSeconds: 30,
      });
      expect(claimed.response.status).toBe(200);
      expect(claimed.body.intent).toMatchObject({
        kind: "provisioning",
        metadata: { externalPlatform: "slack", custodyBackend: "external_kms" },
      });
      expect(claimed.body.receipt).toMatchObject({ status: "leased", attempts: 1 });
      const leaseToken = claimed.body.leaseToken as string;
      expect(leaseToken).toMatch(/^[0-9a-f-]{36}$/);

      const activeClaim = await call(state, "/effect/claim", {
        intentId,
        workerId: "provisioner-2",
      });
      expect(activeClaim.response.status).toBe(409);
      expect(activeClaim.body.error).toBe("effect_lease_active");

      const wrongCompletion = await call(state, "/effect/complete", {
        intentId,
        leaseToken: "wrong-token",
      });
      expect(wrongCompletion.response.status).toBe(409);
      expect(wrongCompletion.body.error).toBe("effect_lease_mismatch");

      const failed = await call(state, "/effect/fail", {
        intentId,
        leaseToken,
        errorCode: "external_timeout",
        retryable: true,
        retryAfterSeconds: 0,
      });
      expect(failed.response.status).toBe(200);
      expect(failed.body.receipt).toMatchObject({
        status: "failed",
        attempts: 1,
        retryable: true,
        lastErrorCode: "external_timeout",
      });

      const reclaimed = await call(state, "/effect/claim", {
        intentId,
        workerId: "provisioner-2",
        leaseSeconds: 30,
      });
      expect(reclaimed.body.receipt).toMatchObject({ status: "leased", attempts: 2 });
      const completed = await call(state, "/effect/complete", {
        intentId,
        leaseToken: reclaimed.body.leaseToken,
        externalReceiptRef: "cloud-resource:tenant-effects",
      });
      expect(completed.response.status).toBe(200);
      expect(completed.body.receipt).toMatchObject({
        status: "completed",
        attempts: 2,
        externalReceiptRef: "cloud-resource:tenant-effects",
      });

      const duplicate = await call(state, "/effect/complete", {
        intentId,
        leaseToken: "stale-token",
      });
      expect(duplicate.response.status).toBe(200);
      expect(duplicate.body.duplicate).toBe(true);
    } finally {
      close();
    }
  });
});
