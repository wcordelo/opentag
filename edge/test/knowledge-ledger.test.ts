import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeJob } from "../src/memory/knowledge-contract.js";
import { KnowledgeLedger } from "../src/memory/knowledge-ledger.js";
import {
  createKnowledgeBackfillDryRun,
  knowledgeBackfillManifestDigest,
  type KnowledgeBackfillScope,
} from "../src/memory/knowledge-backfill.js";
import type {
  VerifiedKnowledgeBackfillApproval,
} from "../src/memory/knowledge-backfill-authorization.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

const databases: DatabaseSync[] = [];

function makeLedger(existingDb?: DatabaseSync): KnowledgeLedger {
  const db = existingDb ?? new DatabaseSync(":memory:");
  if (!databases.includes(db)) databases.push(db);
  const sql: SqlExecutor = {
    exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      const statement = db.prepare(query);
      const params = bindings as Array<string | number | null | bigint>;
      const rows = /^\s*(select|pragma)/i.test(query)
        ? statement.all(...params) as T[]
        : (statement.run(...params), [] as T[]);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
      };
    },
  };
  const ledger = new KnowledgeLedger(sql, <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  ledger.migrate();
  return ledger;
}

function job(configVersion: number, requestedAt: string) {
  return createKnowledgeJob({
    teamId: "T1",
    projectId: "P1",
    channelId: "C1",
    threadTs: "171234.000100",
    configVersion,
    requestedAt,
    reason: "event",
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("KnowledgeLedger", () => {
  it("durably resumes every per-channel discovery state and never hides unvisited channels", () => {
    const ledger = makeLedger();
    const scope: KnowledgeBackfillScope = {
      schemaVersion: 2,
      manifestId: "discovery-1",
      teamId: "T1",
      projectId: "P1",
      channelIds: ["C1", "C2"],
      sources: [
        { channelId: "C1", configVersion: 3 },
        { channelId: "C2", configVersion: 4 },
      ],
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
      executionBudget: {
        maximumCount: 10,
        maximumRatePerMinute: 5,
        maximumErrors: 1,
      },
      releaseIds: ["worker:r1", "local:r2"],
      rollbackOwner: "operator:rollback",
    };
    const scopeDigest = `sha256:${"1".repeat(64)}`;
    expect(ledger.startBackfillDiscovery({
      manifestId: scope.manifestId,
      scopeDigest,
      scope,
      createdAt: "2026-07-01T00:00:00.000Z",
    })).toMatchObject({
      status: "discovering",
      candidateCount: 0,
      channels: [
        { channelId: "C1", status: "unvisited", pageCount: 0 },
        { channelId: "C2", status: "unvisited", pageCount: 0 },
      ],
    });
    const first = ledger.mergeBackfillDiscoveryPage({
      manifestId: scope.manifestId,
      scopeDigest,
      channelId: "C1",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "pending",
      nextCursor: "cursor-c1-2",
      candidates: [{
        channelId: "C1",
        threadTs: "1782896400.000100",
        observedAt: "2026-07-01T01:00:00.000Z",
      }],
      mergedAt: "2026-07-01T01:00:01.000Z",
    });
    expect(first.channels).toEqual([
      {
        channelId: "C1",
        configVersion: 3,
        status: "pending",
        cursor: "cursor-c1-2",
        pageCount: 1,
      },
      {
        channelId: "C2",
        configVersion: 4,
        status: "unvisited",
        cursor: undefined,
        pageCount: 0,
      },
    ]);
    expect(ledger.getBackfillDiscovery(scope.manifestId)).toEqual(first);
    expect(() => ledger.mergeBackfillDiscoveryPage({
      manifestId: scope.manifestId,
      scopeDigest,
      channelId: "C1",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "exhausted",
      nextCursor: null,
      candidates: [],
      mergedAt: "2026-07-01T01:00:02.000Z",
    })).toThrow("already advanced");
    ledger.mergeBackfillDiscoveryPage({
      manifestId: scope.manifestId,
      scopeDigest,
      channelId: "C1",
      expectedStatus: "pending",
      expectedCursor: "cursor-c1-2",
      nextStatus: "exhausted",
      nextCursor: null,
      candidates: [{
        channelId: "C1",
        threadTs: "1782896400.000100",
        observedAt: "2026-07-01T01:00:00.000Z",
      }],
      mergedAt: "2026-07-01T01:00:02.000Z",
    });
    const complete = ledger.mergeBackfillDiscoveryPage({
      manifestId: scope.manifestId,
      scopeDigest,
      channelId: "C2",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "exhausted",
      nextCursor: null,
      candidates: [],
      mergedAt: "2026-07-01T01:00:03.000Z",
    });
    expect(complete).toMatchObject({
      status: "complete",
      pages: 3,
      candidateCount: 1,
      channels: [
        { channelId: "C1", status: "exhausted", pageCount: 2 },
        { channelId: "C2", status: "exhausted", pageCount: 1 },
      ],
    });
    expect(ledger.getBackfillDiscovery(scope.manifestId, true)?.candidates)
      .toEqual([{
        channelId: "C1",
        threadTs: "1782896400.000100",
        observedAt: "2026-07-01T01:00:00.000Z",
      }]);
  });

  it("exhausts later channels before marking an over-count manifest permanently inert", () => {
    const ledger = makeLedger();
    const scope: KnowledgeBackfillScope = {
      schemaVersion: 2,
      manifestId: "over-budget",
      teamId: "T1",
      projectId: "P1",
      channelIds: ["C1", "C2"],
      sources: [
        { channelId: "C1", configVersion: 1 },
        { channelId: "C2", configVersion: 1 },
      ],
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
      executionBudget: {
        maximumCount: 1,
        maximumRatePerMinute: 1,
        maximumErrors: 0,
      },
      releaseIds: ["worker:r1"],
      rollbackOwner: "operator:rollback",
    };
    const scopeDigest = `sha256:${"2".repeat(64)}`;
    ledger.startBackfillDiscovery({
      manifestId: scope.manifestId,
      scopeDigest,
      scope,
      createdAt: scope.from,
    });
    const afterFirst = ledger.mergeBackfillDiscoveryPage({
      manifestId: scope.manifestId,
      scopeDigest,
      channelId: "C1",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "exhausted",
      nextCursor: null,
      candidates: [
        {
          channelId: "C1",
          threadTs: "1782896400.000100",
          observedAt: "2026-07-01T01:00:00.000Z",
        },
        {
          channelId: "C1",
          threadTs: "1782896401.000100",
          observedAt: "2026-07-01T01:00:01.000Z",
        },
      ],
      mergedAt: "2026-07-01T01:00:02.000Z",
    });
    expect(afterFirst).toMatchObject({
      status: "discovering",
      candidateCount: 2,
      channels: [
        { channelId: "C1", status: "exhausted" },
        { channelId: "C2", status: "unvisited" },
      ],
    });
    const terminal = ledger.mergeBackfillDiscoveryPage({
      manifestId: scope.manifestId,
      scopeDigest,
      channelId: "C2",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "exhausted",
      nextCursor: null,
      candidates: [],
      mergedAt: "2026-07-01T01:00:03.000Z",
    });
    expect(terminal).toMatchObject({
      status: "complete_over_budget",
      candidateCount: 2,
      channels: [
        { channelId: "C1", status: "exhausted" },
        { channelId: "C2", status: "exhausted" },
      ],
    });
  });

  it("renews expired P1 authority with stricter budgets without resetting pending state", async () => {
    const db = new DatabaseSync(":memory:");
    let ledger = makeLedger(db);
    const manifestId = "partial-page";
    const request = {
      manifestId,
      teamId: "T1",
      projectId: "P1",
      channelIds: ["C1"],
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
      limit: 2,
      maximumRatePerMinute: 2,
      maximumErrors: 1,
      releaseIds: ["worker:r1"],
      rollbackOwner: "operator:rollback",
      dryRun: true,
      sourceConfigVersions: { C1: 3 },
    };
    const scope: KnowledgeBackfillScope = {
      schemaVersion: 2,
      manifestId,
      teamId: request.teamId,
      projectId: request.projectId,
      channelIds: request.channelIds,
      sources: [{ channelId: "C1", configVersion: 3 }],
      from: request.from,
      to: request.to,
      executionBudget: {
        maximumCount: 2,
        maximumRatePerMinute: 2,
        maximumErrors: 1,
      },
      releaseIds: request.releaseIds,
      rollbackOwner: request.rollbackOwner,
    };
    const scopeDigest = `sha256:${"3".repeat(64)}`;
    ledger.startBackfillDiscovery({
      manifestId,
      scopeDigest,
      scope,
      createdAt: request.from,
    });
    ledger.mergeBackfillDiscoveryPage({
      manifestId,
      scopeDigest,
      channelId: "C1",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "exhausted",
      nextCursor: null,
      candidates: [
        {
          channelId: "C1",
          threadTs: "1782896400.000100",
          observedAt: "2026-07-01T01:00:00.000Z",
        },
        {
          channelId: "C1",
          threadTs: "1782896401.000100",
          observedAt: "2026-07-01T01:00:01.000Z",
        },
      ],
      mergedAt: "2026-07-01T01:00:02.000Z",
    });
    const manifest = createKnowledgeBackfillDryRun(request, [
      {
        channelId: "C1",
        threadTs: "1782896400.000100",
        observedAt: "2026-07-01T01:00:00.000Z",
      },
      {
        channelId: "C1",
        threadTs: "1782896401.000100",
        observedAt: "2026-07-01T01:00:01.000Z",
      },
    ], {
      status: "complete",
      pages: 1,
      channels: [{
        channelId: "C1",
        status: "exhausted",
        pageCount: 1,
      }],
    }).manifest;
    const manifestDigest = await knowledgeBackfillManifestDigest(manifest);
    ledger.putBackfillManifest({
      manifestId,
      manifestDigest,
      manifest,
      createdAt: request.from,
    });
    const approval: VerifiedKnowledgeBackfillApproval = {
      version: 1,
      approvalId: "approval-1",
      issuer: "external-p1",
      keyId: "ed25519-v1",
      gate: "P1",
      approverKind: "human",
      approverId: "operator:approver",
      manifestId,
      manifestDigest,
      teamId: "T1",
      projectId: "P1",
      channelIds: ["C1"],
      from: request.from,
      to: request.to,
      maximumCount: 2,
      maximumRatePerMinute: 2,
      maximumErrors: 1,
      releaseIds: request.releaseIds,
      rollbackOwner: request.rollbackOwner,
      issuedAt: "2026-07-01T01:00:03.000Z",
      expiresAt: "2026-07-01T01:00:06.000Z",
      artifactDigest: `sha256:${"4".repeat(64)}`,
    };
    ledger.approveBackfillManifest(
      approval,
      Date.parse("2026-07-01T01:00:04.000Z"),
    );
    expect(() => ledger.approveBackfillManifest(
      approval,
      Date.parse("2026-07-01T01:00:05.000Z"),
    )).toThrow("replayed");
    const claimed = ledger.claimBackfillPage(
      manifestId,
      manifestDigest,
      2,
      Date.parse("2026-07-01T01:00:05.000Z"),
    );
    // If the first enqueue begins at expiry, the claimed page remains intact
    // and no execution effect is authorized.
    expect(() => ledger.assertBackfillApprovalActive(
      manifestId,
      manifestDigest,
      Date.parse("2026-07-01T01:00:06.000Z"),
    )).toThrow("expired");
    const firstKey = `${manifest.jobs[0]!.sourceKey}|3|${
      manifest.jobs[0]!.requestedAt
    }|backfill`;
    const secondKey = `${manifest.jobs[1]!.sourceKey}|3|${
      manifest.jobs[1]!.requestedAt
    }|backfill`;
    ledger.recordBackfillJobDisposition({
      manifestId,
      manifestDigest,
      pageToken: claimed.pendingPageToken!,
      descriptorKey: firstKey,
      disposition: "accepted",
    }, Date.parse("2026-07-01T01:00:05.500Z"));
    expect(() => ledger.commitBackfillPage(
      manifestId,
      manifestDigest,
      claimed.pendingPageToken!,
      Date.parse("2026-07-01T01:00:06.500Z"),
    )).toThrow("expired");
    expect(() => ledger.recordBackfillPageFailure({
      manifestId,
      manifestDigest,
      pageToken: claimed.pendingPageToken!,
      descriptorKey: secondKey,
      errorCode: "backfill P1 approval is missing or expired",
    }, Date.parse("2026-07-01T01:00:06.500Z"))).toThrow("expired");
    expect(ledger.getBackfillManifest(manifestId)).toMatchObject({
      nextJobIndex: 0,
      executionErrorCount: 0,
      rateWindowReserved: 2,
      pendingResults: { [firstKey]: "accepted" },
    });
    // Recreate the ledger over the same durable SQLite state before renewal.
    ledger = makeLedger(db);

    const overlapping: VerifiedKnowledgeBackfillApproval = {
      ...approval,
      approvalId: "approval-overlap",
      artifactDigest: `sha256:${"5".repeat(64)}`,
      issuedAt: "2026-07-01T01:00:05.000Z",
      expiresAt: "2026-07-01T01:30:00.000Z",
    };
    expect(() => ledger.approveBackfillManifest(
      overlapping,
      Date.parse("2026-07-01T01:00:05.500Z"),
    )).toThrow("overlap");

    const renewal: VerifiedKnowledgeBackfillApproval = {
      ...approval,
      approvalId: "approval-2",
      artifactDigest: `sha256:${"6".repeat(64)}`,
      issuedAt: "2026-07-01T01:01:06.000Z",
      expiresAt: "2026-07-01T01:01:10.000Z",
      maximumRatePerMinute: 1,
      maximumErrors: 0,
    };
    expect(ledger.approveBackfillManifest(
      renewal,
      Date.parse("2026-07-01T01:01:06.500Z"),
    )).toMatchObject({
      status: "running",
      approvalReference: "approval-2",
      nextJobIndex: 0,
      executionErrorCount: 0,
      rateWindowReserved: 1,
      pendingPageToken: claimed.pendingPageToken,
      pendingJobs: claimed.pendingJobs,
      pendingResults: { [firstKey]: "accepted" },
      pendingError: undefined,
    });
    expect(ledger.listBackfillApprovalAudit(manifestId)).toEqual([
      expect.objectContaining({
        approvalId: "approval-1",
        supersedesApprovalId: undefined,
      }),
      expect.objectContaining({
        approvalId: "approval-2",
        supersedesApprovalId: "approval-1",
      }),
    ]);
    expect(() => ledger.approveBackfillManifest(
      renewal,
      Date.parse("2026-07-01T01:01:07.000Z"),
    )).toThrow("replayed");
    expect(ledger.claimBackfillPage(
      manifestId,
      manifestDigest,
      2,
      Date.parse("2026-07-01T01:01:07.000Z"),
    )).toMatchObject({
      pendingPageToken: claimed.pendingPageToken,
      pendingResults: { [firstKey]: "accepted" },
      rateWindowReserved: 1,
    });

    expect(() => ledger.recordBackfillJobDisposition({
      manifestId,
      manifestDigest,
      pageToken: claimed.pendingPageToken!,
      descriptorKey: secondKey,
      disposition: "superseded",
    }, Date.parse("2026-07-01T01:01:10.000Z"))).toThrow("expired");

    const looserBudget: VerifiedKnowledgeBackfillApproval = {
      ...renewal,
      approvalId: "approval-looser-budget",
      artifactDigest: `sha256:${"7".repeat(64)}`,
      issuedAt: "2026-07-01T01:01:10.000Z",
      expiresAt: "2026-07-01T01:01:20.000Z",
      maximumRatePerMinute: 2,
    };
    expect(() => ledger.approveBackfillManifest(
      looserBudget,
      Date.parse("2026-07-01T01:01:11.000Z"),
    )).toThrow("budget_loosened");

    const expiredRenewal: VerifiedKnowledgeBackfillApproval = {
      ...renewal,
      approvalId: "approval-expired-renewal",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      issuedAt: "2026-07-01T01:01:10.000Z",
      expiresAt: "2026-07-01T01:01:10.500Z",
    };
    expect(() => ledger.approveBackfillManifest(
      expiredRenewal,
      Date.parse("2026-07-01T01:01:11.000Z"),
    )).toThrow("expired");

    const secondRenewal: VerifiedKnowledgeBackfillApproval = {
      ...renewal,
      approvalId: "approval-3",
      artifactDigest: `sha256:${"8".repeat(64)}`,
      issuedAt: "2026-07-01T01:01:10.000Z",
      expiresAt: "2026-07-01T01:01:20.000Z",
    };
    ledger.approveBackfillManifest(
      secondRenewal,
      Date.parse("2026-07-01T01:01:11.000Z"),
    );
    ledger.recordBackfillJobDisposition({
      manifestId,
      manifestDigest,
      pageToken: claimed.pendingPageToken!,
      descriptorKey: secondKey,
      disposition: "superseded",
    }, Date.parse("2026-07-01T01:01:12.000Z"));
    expect(ledger.commitBackfillPage(
      manifestId,
      manifestDigest,
      claimed.pendingPageToken!,
      Date.parse("2026-07-01T01:01:13.000Z"),
    )).toMatchObject({
      status: "complete",
      nextJobIndex: 2,
      executionErrorCount: 0,
      rateWindowReserved: 1,
    });

    const driftScope = { ...scope, manifestId: "drifted" };
    ledger.startBackfillDiscovery({
      manifestId: "drifted",
      scopeDigest: `sha256:${"9".repeat(64)}`,
      scope: driftScope,
      createdAt: request.from,
    });
    expect(ledger.blockBackfillDiscovery(
      "drifted",
      `sha256:${"9".repeat(64)}`,
      "source_config_drift",
      Date.parse("2026-07-01T01:00:00.000Z"),
    )).toMatchObject({
      status: "blocked_config_drift",
      blockedReason: "source_config_drift",
    });
  });

  it("fences overlapping scheduler runs and resumes the same run after lease expiry", () => {
    const ledger = makeLedger();
    const base = {
      coordinatorKey: "scheduled-reconciliation-v1",
      triggerId: "2026-07-25T12:00:00.000Z",
      scopeDigest: `sha256:${"1".repeat(64)}`,
      teamIds: ["T1", "T2"],
      cycleId: "cycle-1",
      leaseMs: 10_000,
    };
    const first = ledger.claimReconcileCoordinator({
      ...base,
      leaseToken: "lease-1",
    }, 1_000);
    expect(first).toMatchObject({
      decision: "acquired",
      coordinator: { teamIndex: 0, activeRunId: "cycle-1:0" },
    });
    expect(ledger.claimReconcileCoordinator({
      ...base,
      leaseToken: "lease-overlap",
    }, 2_000)).toMatchObject({ decision: "busy" });
    expect(ledger.claimReconcileCoordinator({
      ...base,
      cycleId: "ignored-restart-cycle",
      leaseToken: "lease-restart",
    }, 11_001)).toMatchObject({
      decision: "acquired",
      coordinator: {
        cycleId: "cycle-1",
        teamIndex: 0,
        activeRunId: "cycle-1:0",
      },
    });
  });

  it("persists bounded scheduler backoff, config drift reset, and cycle completion", () => {
    const ledger = makeLedger();
    const base = {
      coordinatorKey: "scheduled-reconciliation-v1",
      triggerId: "2026-07-25T12:00:00.000Z",
      scopeDigest: `sha256:${"2".repeat(64)}`,
      teamIds: ["T1", "T2"],
      cycleId: "cycle-1",
      leaseToken: "lease-1",
      leaseMs: 10_000,
    };
    expect(ledger.claimReconcileCoordinator(base, 1_000).decision).toBe("acquired");
    expect(ledger.failReconcileCoordinator(
      base.coordinatorKey,
      base.leaseToken,
      "descriptor_unavailable",
      6_000,
      2_000,
    )).toMatchObject({
      status: "backoff",
      errorCount: 1,
      nextAttemptAt: 6_000,
    });
    expect(ledger.claimReconcileCoordinator({
      ...base,
      leaseToken: "lease-too-early",
    }, 5_000)).toMatchObject({ decision: "backoff" });
    expect(ledger.claimReconcileCoordinator({
      ...base,
      leaseToken: "lease-resume",
    }, 6_000)).toMatchObject({
      decision: "acquired",
      coordinator: { cycleId: "cycle-1", activeRunId: "cycle-1:0" },
    });

    const drifted = ledger.claimReconcileCoordinator({
      ...base,
      triggerId: "2026-07-25T12:05:00.000Z",
      scopeDigest: `sha256:${"3".repeat(64)}`,
      teamIds: ["T2"],
      cycleId: "cycle-drift",
      leaseToken: "lease-drift",
    }, 16_001);
    expect(drifted).toMatchObject({
      decision: "acquired",
      configDrifted: true,
      coordinator: {
        cycleId: "cycle-drift",
        teamIds: ["T2"],
        teamIndex: 0,
        configDriftCount: 1,
      },
    });
    expect(ledger.checkpointReconcileCoordinatorPage(
      base.coordinatorKey,
      "lease-drift",
      10_000,
      17_000,
    )).toMatchObject({ pageCount: 1 });
    expect(ledger.advanceReconcileCoordinatorTeam(
      base.coordinatorKey,
      "lease-drift",
      18_000,
    )).toMatchObject({
      status: "complete",
      completedTeamCount: 1,
      pageCount: 1,
    });
  });

  it("converges duplicate and out-of-order descriptors on the newest durable intent", () => {
    const ledger = makeLedger();
    const newest = job(2, "2026-07-19T02:00:00.000Z");
    expect(ledger.enqueue(newest, 2_000)).toMatchObject({ accepted: true, reason: "new" });
    expect(ledger.enqueue(newest, 2_001)).toMatchObject({ accepted: false, reason: "duplicate" });
    expect(ledger.enqueue(job(1, "2026-07-19T03:00:00.000Z"), 2_002))
      .toMatchObject({ accepted: false, reason: "out_of_order" });
    expect(ledger.enqueue(job(2, "2026-07-19T01:00:00.000Z"), 2_003))
      .toMatchObject({ accepted: false, reason: "duplicate" });
    expect(ledger.get(newest.sourceKey)).toMatchObject({
      configVersion: 2,
      requestedAt: newest.requestedAt,
      status: "pending",
    });
  });

  it("retains a failed Queue send as a recoverable pending outbox row", () => {
    const ledger = makeLedger();
    const descriptor = job(1, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    const claimed = ledger.claimDueOutbox(1_000)!;
    expect(claimed.attemptCount).toBe(1);
    ledger.markOutboxFailed(claimed, "queue unavailable", 1_000, 500);
    expect(ledger.getOutbox(descriptor.sourceKey)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError: "queue unavailable",
    });
    expect(ledger.claimDueOutbox(1_499)).toBeUndefined();
    expect(ledger.claimDueOutbox(1_500)).toMatchObject({ descriptorKey: claimed.descriptorKey });
  });

  it("treats configuration drift as a no-op and leases only the current descriptor", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    const item = ledger.claimDueOutbox(1_000)!;
    ledger.markOutboxSent(item, 1_001);

    expect(ledger.acquireLease(descriptor, 4, "wrong", 2_000, 60_000))
      .toEqual({ decision: "noop", reason: "config_drift" });
    const lease = ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(lease).toMatchObject({ decision: "lease", leaseToken: "lease-1" });
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "normalized",
      desiredRevision: "sha256:abc",
    }, 2_500)).toBe(true);
    expect(ledger.acquireLease(descriptor, 3, "lease-2", 3_000, 60_000))
      .toEqual({ decision: "noop", reason: "already_complete" });
  });

  it("persists the first Local ID before polling and resumes that same ID after timeout", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    const item = ledger.claimDueOutbox(1_000)!;
    ledger.markOutboxSent(item, 1_001);
    expect(ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000)).toMatchObject({ decision: "lease" });
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001))
      .toEqual({ decision: "add" });
    expect(ledger.recordLocalAccepted({
      sourceKey: descriptor.sourceKey,
      leaseToken: "lease-1",
      localDocumentId: "doc-1",
      desiredRevision: "sha256:one",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
    }, 2_002)).toBe(true);
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({ localDocumentId: "doc-1", status: "polling" });
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "processing_unconfirmed",
      desiredRevision: "sha256:one",
      localDocumentId: "doc-1",
      workflowStatus: "indexing",
      pollDeadlineAt: 10_000,
      nextPollAt: 12_000,
      pollCount: 3,
    }, 10_000)).toBe(true);
    expect(ledger.acquireLease(descriptor, 3, "lease-2", 12_000, 60_000)).toMatchObject({ decision: "lease" });
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-2", "sha256:one", 12_001))
      .toMatchObject({ decision: "poll", localDocumentId: "doc-1" });
  });

  it("blocks a changed indexed revision rather than guessing Local update semantics", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(original, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(original.sourceKey, "lease-1", "sha256:old", 2_001);
    ledger.recordLocalAccepted({
      sourceKey: original.sourceKey, leaseToken: "lease-1", localDocumentId: "doc-1",
      desiredRevision: "sha256:old",
      workflowStatus: "queued", pollDeadlineAt: 5_000, nextPollAt: 2_100,
    }, 2_002);
    ledger.recordOutcome(original.sourceKey, "lease-1", {
      status: "indexed", desiredRevision: "sha256:old", indexedRevision: "sha256:old",
      localDocumentId: "doc-1", workflowStatus: "done", pollCount: 2,
    }, 3_000);

    const edit = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(edit, 4_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(4_000)!, 4_001);
    ledger.acquireLease(edit, 3, "lease-2", 5_000, 60_000);
    expect(ledger.prepareRevision(edit.sourceKey, "lease-2", "sha256:new", 5_001))
      .toEqual({ decision: "blocked", reason: "unsupported_update_contract" });
  });

  it("releases the lease and restores indexed state for an unchanged newer event", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(original, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(original.sourceKey, "lease-1", "sha256:same", 2_001);
    ledger.recordLocalAccepted({
      sourceKey: original.sourceKey, leaseToken: "lease-1", localDocumentId: "doc-1",
      desiredRevision: "sha256:same",
      workflowStatus: "queued", pollDeadlineAt: 5_000, nextPollAt: 2_100,
    }, 2_002);
    ledger.recordOutcome(original.sourceKey, "lease-1", {
      status: "indexed", desiredRevision: "sha256:same", indexedRevision: "sha256:same",
      localDocumentId: "doc-1", workflowStatus: "done", pollCount: 1,
    }, 3_000);

    const duplicateContentEvent = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(duplicateContentEvent, 4_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(4_000)!, 4_001);
    ledger.acquireLease(duplicateContentEvent, 3, "lease-2", 5_000, 60_000);
    expect(ledger.prepareRevision(duplicateContentEvent.sourceKey, "lease-2", "sha256:same", 5_001))
      .toEqual({ decision: "noop", reason: "already_indexed" });
    expect(ledger.get(duplicateContentEvent.sourceKey)).toMatchObject({
      status: "indexed", desiredRevision: "sha256:same", indexedRevision: "sha256:same",
      leaseToken: undefined,
    });
  });

  it("issues no second external effect after lease expiry in an add-started crash window", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 1_000);
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001))
      .toEqual({ decision: "add" });

    // Simulate isolate loss after Local may have accepted the request but
    // before /localAccepted durably stores the returned internal ID.
    expect(ledger.acquireLease(descriptor, 3, "lease-2", 3_001, 1_000)).toMatchObject({ decision: "lease" });
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-2", "sha256:one", 3_002))
      .toEqual({ decision: "blocked", reason: "ambiguous_add_contract" });
    expect(ledger.get(descriptor.sourceKey)?.localDocumentId).toBeUndefined();
  });

  it("keeps a superseding descriptor before add on the newer intent only", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    const newer = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.enqueue(newer, 1_001);
    expect(ledger.acquireLease(original, 3, "old", 2_000, 70_000))
      .toEqual({ decision: "noop", reason: "stale_descriptor" });
    expect(ledger.acquireLease(newer, 3, "new", 2_001, 70_000))
      .toMatchObject({ decision: "lease" });
    expect(ledger.prepareRevision(newer.sourceKey, "new", "sha256:new", 2_002))
      .toEqual({ decision: "add" });
  });

  it("persists a late Local acceptance after add_started supersession without a second add", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.acquireLease(original, 3, "old", 2_000, 70_000);
    expect(ledger.prepareRevision(original.sourceKey, "old", "sha256:old", 2_001))
      .toEqual({ decision: "add" });
    const newer = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(newer, 2_002);
    expect(ledger.recordLocalAccepted({
      sourceKey: original.sourceKey,
      leaseToken: "old",
      localDocumentId: "doc-old",
      desiredRevision: "sha256:old",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
    }, 2_003)).toBe(true);
    ledger.acquireLease(newer, 3, "new", 2_003, 70_000);
    expect(ledger.prepareRevision(newer.sourceKey, "new", "sha256:new", 2_004))
      .toEqual({ decision: "blocked", reason: "unsupported_update_contract" });
    expect(ledger.get(newer.sourceKey)).toMatchObject({
      localDocumentId: "doc-old",
      localDocumentRevision: "sha256:old",
    });
  });

  it("binds an accepted Local ID to its own revision across supersession", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.acquireLease(original, 3, "old", 2_000, 70_000);
    ledger.prepareRevision(original.sourceKey, "old", "sha256:old", 2_001);
    expect(ledger.recordLocalAccepted({
      sourceKey: original.sourceKey,
      leaseToken: "old",
      localDocumentId: "doc-old",
      desiredRevision: "sha256:old",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
    }, 2_002)).toBe(true);

    const newer = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(newer, 2_003);
    expect(ledger.get(newer.sourceKey)).toMatchObject({
      desiredRevision: undefined,
      localDocumentId: "doc-old",
      localDocumentRevision: "sha256:old",
    });
    ledger.acquireLease(newer, 3, "new", 2_004, 70_000);
    expect(ledger.prepareRevision(newer.sourceKey, "new", "sha256:new", 2_005))
      .toEqual({ decision: "blocked", reason: "unsupported_update_contract" });
  });

  it("rejects stale terminal outcomes when superseded during polling or immediately before done", () => {
    for (const phase of ["during_polling", "before_terminal"] as const) {
      const ledger = makeLedger();
      const original = job(3, "2026-07-19T01:00:00.000Z");
      ledger.enqueue(original, 1_000);
      ledger.acquireLease(original, 3, `old-${phase}`, 2_000, 70_000);
      ledger.prepareRevision(original.sourceKey, `old-${phase}`, "sha256:old", 2_001);
      ledger.recordLocalAccepted({
        sourceKey: original.sourceKey,
        leaseToken: `old-${phase}`,
        localDocumentId: `doc-${phase}`,
        desiredRevision: "sha256:old",
        workflowStatus: phase === "during_polling" ? "indexing" : "queued",
        pollDeadlineAt: 10_000,
        nextPollAt: 2_100,
      }, 2_002);
      const newer = job(3, "2026-07-19T02:00:00.000Z");
      ledger.enqueue(newer, 2_003);
      expect(ledger.recordOutcome(original.sourceKey, `old-${phase}`, {
        status: "indexed",
        desiredRevision: "sha256:old",
        indexedRevision: "sha256:old",
        localDocumentId: `doc-${phase}`,
        workflowStatus: "done",
        pollCount: 1,
      }, 2_004)).toBe(false);
      expect(ledger.get(original.sourceKey)).toMatchObject({
        requestedAt: newer.requestedAt,
        indexedRevision: undefined,
        localDocumentRevision: "sha256:old",
      });
    }
  });

  it("retains tombstone precedence across a newer descriptor", () => {
    const ledger = makeLedger();
    const base = job(3, "2026-07-19T01:00:00.000Z");
    const deletion = {
      ...base,
      reason: "delete" as const,
      messageTs: base.threadTs,
    };
    ledger.enqueue(deletion, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(deletion, 3, "lease-1", 2_000, 60_000);
    ledger.recordOutcome(deletion.sourceKey, "lease-1", {
      status: "tombstoned", tombstonedAt: "2026-07-19T01:00:01.000Z",
      errorCode: "unsupported_delete_contract",
    }, 2_001);

    const later = job(3, "2026-07-19T02:00:00.000Z");
    expect(ledger.enqueue(later, 3_000)).toMatchObject({
      accepted: false,
      reason: "out_of_order",
    });
    expect(ledger.get(later.sourceKey)?.tombstonedAt).toBe("2026-07-19T01:00:01.000Z");
  });

  it("preserves a queued root delete across a later reply/edit race", () => {
    const ledger = makeLedger();
    const base = job(3, "2026-07-19T01:00:00.000Z");
    const deletion = createKnowledgeJob({
      teamId: base.teamId,
      projectId: base.projectId,
      channelId: base.channelId,
      threadTs: base.threadTs,
      messageTs: base.threadTs,
      configVersion: base.configVersion,
      requestedAt: "2026-07-19T02:00:00.000Z",
      reason: "delete",
    });
    expect(ledger.enqueue(deletion, 1_000)).toMatchObject({
      accepted: true,
      reason: "new",
    });
    const laterReplyDeletion = createKnowledgeJob({
      teamId: base.teamId,
      projectId: base.projectId,
      channelId: base.channelId,
      threadTs: base.threadTs,
      messageTs: "171234.000199",
      configVersion: base.configVersion,
      requestedAt: "2026-07-19T02:00:01.000Z",
      reason: "reply_delete",
    });
    expect(ledger.enqueue(laterReplyDeletion, 1_001)).toMatchObject({
      accepted: false,
      reason: "out_of_order",
    });
    expect(ledger.enqueue({
      ...base,
      requestedAt: "2026-07-19T02:00:02.000Z",
    }, 1_002)).toMatchObject({
      accepted: false,
      reason: "out_of_order",
    });
    expect(ledger.get(deletion.sourceKey)).toMatchObject({
      reason: "delete",
      requestedAt: deletion.requestedAt,
    });
    expect(ledger.getOutbox(deletion.sourceKey)?.job).toEqual(deletion);
  });

  it("keeps reply deletions as refetch mutations across duplicate and out-of-order races", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(original, 3, "index-lease", 1_002, 60_000);
    ledger.prepareRevision(original.sourceKey, "index-lease", "sha256:old", 1_003);
    ledger.recordLocalAccepted({
      sourceKey: original.sourceKey,
      leaseToken: "index-lease",
      localDocumentId: "doc-old",
      desiredRevision: "sha256:old",
      workflowStatus: "done",
      pollDeadlineAt: 2_000,
      nextPollAt: 1_500,
    }, 1_004);
    ledger.recordOutcome(original.sourceKey, "index-lease", {
      status: "indexed",
      desiredRevision: "sha256:old",
      indexedRevision: "sha256:old",
      localDocumentId: "doc-old",
      workflowStatus: "done",
      pollCount: 1,
    }, 1_005);

    const replyDeletion = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: original.threadTs,
      messageTs: "171234.000199",
      configVersion: 3,
      requestedAt: "2026-07-19T02:00:00.000Z",
      reason: "reply_delete",
    });
    expect(ledger.enqueue(replyDeletion, 2_000)).toMatchObject({
      accepted: true,
      reason: "superseded",
    });
    expect(ledger.enqueue(replyDeletion, 2_001)).toMatchObject({
      accepted: false,
      reason: "duplicate",
    });
    expect(ledger.enqueue({
      ...replyDeletion,
      requestedAt: "2026-07-19T01:30:00.000Z",
    }, 2_002)).toMatchObject({
      accepted: false,
      reason: "duplicate",
    });
    expect(ledger.get(replyDeletion.sourceKey)).toMatchObject({
      reason: "reply_delete",
      tombstonedAt: undefined,
      indexedRevision: "sha256:old",
    });
    const pending = ledger.claimDueOutbox(2_000)!;
    expect(pending.job).toMatchObject({
      reason: "reply_delete",
      threadTs: original.threadTs,
      messageTs: "171234.000199",
    });
    ledger.markOutboxSent(pending, 2_003);
    ledger.acquireLease(replyDeletion, 3, "reply-lease", 2_004, 60_000);
    expect(ledger.prepareRevision(
      replyDeletion.sourceKey,
      "reply-lease",
      "sha256:after-delete",
      2_005,
    )).toEqual({
      decision: "blocked",
      reason: "unsupported_update_contract",
    });
    expect(ledger.get(replyDeletion.sourceKey)?.tombstonedAt).toBeUndefined();
  });
});
