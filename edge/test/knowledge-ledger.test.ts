import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeJob } from "../src/memory/knowledge-contract.js";
import { KnowledgeLedger } from "../src/memory/knowledge-ledger.js";
import { knowledgeLedgerTableSql } from "../src/memory/knowledge-ledger-migration.js";
import {
  createKnowledgeBackfillDryRun,
  knowledgeBackfillManifestDigest,
  type KnowledgeBackfillScope,
} from "../src/memory/knowledge-backfill.js";
import type {
  VerifiedKnowledgeBackfillApproval,
} from "../src/memory/knowledge-backfill-authorization.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";
import type { SlackConversationInventoryReceipt } from "../src/slack/conversation-inventory.js";

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

function markIndexed(
  ledger: KnowledgeLedger,
  source: ReturnType<typeof job>,
  revision = "sha256:one",
  localDocumentId = "doc-1",
  indexGeneration = "generation-1",
): void {
  ledger.enqueue(source, 1_000);
  ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
  ledger.acquireLease(source, source.configVersion, "lease-1", 1_002, 60_000);
  expect(ledger.prepareRevision(
    source.sourceKey,
    "lease-1",
    revision,
    1_003,
    { indexGeneration },
  )).toEqual({ decision: "add" });
  expect(ledger.recordLocalAccepted({
    sourceKey: source.sourceKey,
    leaseToken: "lease-1",
    localDocumentId,
    desiredRevision: revision,
    workflowStatus: "done",
    pollDeadlineAt: 2_000,
    nextPollAt: 1_500,
    indexGeneration,
  }, 1_004)).toBe(true);
  expect(ledger.recordOutcome(source.sourceKey, "lease-1", {
    status: "indexed",
    desiredRevision: revision,
    indexedRevision: revision,
    localDocumentId,
    workflowStatus: "done",
    pollCount: 1,
    indexGeneration,
  }, 1_005)).toBe(true);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("KnowledgeLedger", () => {
  it("exposes persisted queue, ledger, DLQ, reconciliation, and backfill state", () => {
    const ledger = makeLedger();
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    const source = job(1, "2026-07-01T00:00:00.000Z");
    expect(ledger.enqueue(source, now)).toMatchObject({ accepted: true });
    expect(ledger.startReconcileRun("reconcile-1", now)).toMatchObject({
      status: "running",
    });

    const snapshot = ledger.statusSnapshot(now);
    expect(snapshot.capturedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(snapshot.ledger).toEqual({
      total: 1,
      byStatus: { pending: 1 },
    });
    expect(snapshot.outbox).toEqual({
      pending: 1,
      sending: 0,
      due: 1,
      earliestPendingAt: now,
    });
    expect(snapshot.dlq).toEqual({
      total: 0,
      pending: 0,
      replaying: 0,
      replayed: 0,
      disposed: 0,
    });
    expect(snapshot.reconciliation).toMatchObject({
      running: 1,
      complete: 0,
      latest: { runId: "reconcile-1", status: "running" },
    });
    expect(snapshot.backfill).toEqual({
      active: 0,
      complete: 0,
    });
    expect(snapshot.threadFetch).toEqual({
      active: 0,
      messages: 0,
      bytes: 0,
    });
    expect(snapshot.inventory).toEqual({
      total: 0,
      complete: 0,
      incomplete: 0,
      invalid: 0,
    });
    expect(snapshot.messageThreadMap).toEqual({
      total: 0,
    });
    expect(snapshot.queryConvergence).toEqual({
      total: 0,
      queryable: 0,
      notFound: 0,
      failed: 0,
      unverified: 0,
    });
  });

  it("keeps query convergence durable, revisioned, and separate from provider indexing", () => {
    const ledger = makeLedger();
    const source = job(1, "2026-07-01T00:00:00.000Z");
    const generation = "supermemory-v1";
    const revision = "sha256:revision-one";
    ledger.enqueue(source, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(source, 1, "lease-1", 1_002, 70_000);
    expect(ledger.prepareRevision(source.sourceKey, "lease-1", revision, 1_003, {
      indexGeneration: generation,
    })).toEqual({ decision: "add" });
    expect(ledger.recordLocalAccepted({
      sourceKey: source.sourceKey,
      leaseToken: "lease-1",
      localDocumentId: "doc-1",
      desiredRevision: revision,
      workflowStatus: "queued",
      pollDeadlineAt: 20_000,
      nextPollAt: 1_004,
      indexGeneration: generation,
    }, 1_004)).toBe(true);
    expect(ledger.recordOutcome(source.sourceKey, "lease-1", {
      status: "indexed",
      desiredRevision: revision,
      indexedRevision: revision,
      localDocumentId: "doc-1",
      workflowStatus: "done",
      pollCount: 1,
      indexGeneration: generation,
    }, 1_005)).toBe(true);

    expect(ledger.getQueryConvergence(source.sourceKey)).toBeUndefined();
    expect(ledger.recordQueryConvergence({
      sourceKey: source.sourceKey,
      contentRevision: revision,
      indexGeneration: generation,
      localDocumentId: "doc-1",
      queryDigest: `sha256:${"a".repeat(64)}`,
      status: "not_found",
      providerResultCount: 0,
      matchingCitationCount: 0,
    }, 1_006)).toBe(true);
    expect(ledger.getQueryConvergence(source.sourceKey)).toMatchObject({
      sourceKey: source.sourceKey,
      contentRevision: revision,
      indexGeneration: generation,
      localDocumentId: "doc-1",
      status: "not_found",
      providerResultCount: 0,
      matchingCitationCount: 0,
    });
    expect(ledger.statusSnapshot(1_006).queryConvergence).toEqual({
      total: 1,
      queryable: 0,
      notFound: 1,
      failed: 0,
      unverified: 0,
    });

    expect(ledger.recordQueryConvergence({
      sourceKey: source.sourceKey,
      contentRevision: "sha256:stale",
      indexGeneration: generation,
      localDocumentId: "doc-1",
      queryDigest: `sha256:${"b".repeat(64)}`,
      status: "queryable",
      providerResultCount: 1,
      matchingCitationCount: 1,
    }, 1_007)).toBe(false);
    expect(() => ledger.recordQueryConvergence({
      sourceKey: source.sourceKey,
      contentRevision: revision,
      indexGeneration: generation,
      localDocumentId: "doc-1",
      queryDigest: `sha256:${"c".repeat(64)}`,
      status: "queryable",
      providerResultCount: 0,
      matchingCitationCount: 0,
    }, 1_008)).toThrow("queryable convergence requires a matching citation");
  });

  it("persists and resumes a thread fetch checkpoint only for the exact job", () => {
    const ledger = makeLedger();
    const source = job(1, "2026-07-01T00:00:00.000Z");
    ledger.enqueue(source, 1_000);
    ledger.saveThreadFetchCheckpoint(source, {
      cursor: "cursor-2",
      pages: 3,
      messages: [{ ts: "1.0", text: "partial" }],
      bytes: 42,
    }, 2_000);
    expect(ledger.getThreadFetchCheckpoint(source)).toEqual({
      cursor: "cursor-2",
      pages: 3,
      messages: [{ ts: "1.0", text: "partial" }],
      bytes: 42,
    });
    expect(ledger.statusSnapshot(2_000).threadFetch).toMatchObject({
      active: 1,
      messages: 1,
      bytes: 42,
    });
    expect(ledger.getThreadFetchCheckpoint(job(2, source.requestedAt))).toBeUndefined();
    ledger.clearThreadFetchCheckpoint(source);
    expect(ledger.getThreadFetchCheckpoint(source)).toBeUndefined();
    ledger.saveThreadFetchCheckpoint(source, {
      cursor: "cursor-old",
      pages: 1,
      messages: [{ ts: "1.0" }],
      bytes: 8,
    }, 3_000);
    ledger.pruneThreadFetchCheckpoints(10_000, 6_000);
    expect(ledger.getThreadFetchCheckpoint(source)).toBeUndefined();
  });

  it("rejects semantically invalid conversation inventory counts", () => {
    const ledger = makeLedger();
    const digest = `sha256:${"a".repeat(64)}`;
    const inventory: SlackConversationInventoryReceipt = {
      schemaVersion: 1,
      visibility: "installed_bot",
      status: "complete",
      pages: 1,
      visibleCount: -1,
      eligibleCount: 0,
      eligibleConversationIds: [],
      excludedCount: 0,
      excluded: [],
      excludedTruncated: false,
      inventoryDigest: digest,
    };
    expect(() => ledger.putBackfillConversationInventory({
      manifestId: "manifest-invalid-counts",
      inventoryDigest: digest,
      inventory,
      createdAt: "2026-07-01T00:00:00.000Z",
    })).toThrow("backfill conversation inventory is invalid");
  });

  it("persists body-free Slack message-to-thread mappings for deletion resolution", () => {
    const ledger = makeLedger();
    const source = job(1, "2026-07-01T00:00:00.000Z");
    expect(ledger.putSlackMessageThreads({
      teamId: source.teamId,
      projectId: source.projectId,
      channelId: source.channelId,
      threadTs: source.threadTs,
      sourceKey: source.sourceKey,
      messageTs: [source.threadTs, "171234.000199", "171234.000199", "not-a-ts"],
    }, 2_000)).toEqual({ stored: 2 });
    expect(ledger.getSlackMessageThread({
      teamId: source.teamId,
      channelId: source.channelId,
      messageTs: "171234.000199",
    })).toMatchObject({
      projectId: source.projectId,
      threadTs: source.threadTs,
      sourceKey: source.sourceKey,
    });
    expect(ledger.getSlackMessageThread({
      teamId: source.teamId,
      channelId: source.channelId,
      messageTs: "171234.000200",
    })).toBeUndefined();
    expect(ledger.statusSnapshot(2_000).messageThreadMap).toEqual({
      total: 2,
      oldestUpdatedAt: "1970-01-01T00:00:02.000Z",
      newestUpdatedAt: "1970-01-01T00:00:02.000Z",
    });
  });

  it("migrates the legacy Slack identity unique and keeps source types isolated", () => {
    const db = new DatabaseSync(":memory:");
    const legacyTable = knowledgeLedgerTableSql("knowledge_ledger")
      .replace(
        /    source_type TEXT NOT NULL DEFAULT 'slack'\n      CHECK \(source_type IN \('slack', 'wiki', 'code', 'custom_db', 'drive'\)\),\n/,
        "",
      )
      .replace(
        "UNIQUE(team_id, source_type, channel_id, thread_ts)",
        "UNIQUE(team_id, channel_id, thread_ts)",
      );
    db.exec(legacyTable);
    const ledger = makeLedger(db);
    const slack = job(1, "2026-07-01T00:00:00.000Z");
    const wiki = createKnowledgeJob({
      sourceType: "wiki",
      teamId: slack.teamId,
      projectId: slack.projectId,
      channelId: slack.channelId,
      threadTs: slack.threadTs,
      configVersion: 1,
      requestedAt: "2026-07-01T00:00:01.000Z",
      reason: "event",
    });

    expect(ledger.enqueue(slack, 1)).toMatchObject({ accepted: true });
    expect(ledger.enqueue(wiki, 2)).toMatchObject({ accepted: true });
    expect(ledger.get(slack.sourceKey)).toMatchObject({ sourceType: "slack" });
    expect(ledger.get(wiki.sourceKey)).toMatchObject({ sourceType: "wiki" });

    const indexes = db.prepare("PRAGMA index_list(knowledge_ledger)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const identityIndex = indexes.find((index) => index.unique === 1 && !index.name.includes("sqlite_autoindex_knowledge_ledger_1"));
    expect(identityIndex).toBeDefined();
    const indexColumns = db.prepare(`PRAGMA index_info("${identityIndex!.name.replaceAll('"', '""')}")`).all() as Array<{
      name: string;
      seqno: number;
    }>;
    expect(indexColumns.sort((left, right) => left.seqno - right.seqno).map((row) => row.name))
      .toContain("source_type");
  });

  it("derives DLQ source type from the typed source key and rejects mismatches", () => {
    const ledger = makeLedger();
    const wiki = createKnowledgeJob({
      sourceType: "wiki",
      teamId: "T1",
      projectId: "P1",
      channelId: "docs",
      threadTs: "page-1",
      configVersion: 1,
      requestedAt: "2026-07-01T00:00:00.000Z",
      reason: "event",
    });
    expect(ledger.captureDlqRecord({
      messageId: "wiki-dlq-1",
      queueName: "knowledge-dlq",
      body: wiki,
      sourceKey: wiki.sourceKey,
      attempts: 1,
      capturedAt: "2026-07-01T00:00:01.000Z",
    })).toMatchObject({ sourceKey: wiki.sourceKey, sourceType: "wiki" });
    expect(() => ledger.captureDlqRecord({
      messageId: "wiki-dlq-2",
      queueName: "knowledge-dlq",
      body: wiki,
      sourceKey: wiki.sourceKey,
      sourceType: "slack",
      attempts: 1,
      capturedAt: "2026-07-01T00:00:02.000Z",
    })).toThrow("DLQ source identity is invalid");
  });

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
    const firstKey = `${manifest.jobs[0]!.sourceType}|${manifest.jobs[0]!.sourceKey}|3|${
      manifest.jobs[0]!.requestedAt
    }|backfill`;
    const secondKey = `${manifest.jobs[1]!.sourceType}|${manifest.jobs[1]!.sourceKey}|3|${
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

  it("acks permanent_failure leases as noop so Queue redeliveries converge", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "local_add",
      errorCode: "local_rejected",
    }, 2_100)).toBe(true);
    expect(ledger.acquireLease(descriptor, 3, "lease-2", 3_000, 60_000))
      .toEqual({ decision: "noop", reason: "permanent_failure" });
  });

  it("reopens an exact terminal Local poll failure with an audit and fresh outbox job", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001);
    ledger.recordLocalAccepted({
      sourceKey: descriptor.sourceKey,
      leaseToken: "lease-1",
      localDocumentId: "doc-1",
      desiredRevision: "sha256:one",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
    }, 2_002);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "local_poll",
      errorCode: "local_document_failed",
    }, 2_003)).toBe(true);
    const recovered = ledger.recoverPermanentFailure({
      sourceKey: descriptor.sourceKey,
      teamId: descriptor.teamId,
      expectedConfigVersion: descriptor.configVersion,
      expectedRequestedAt: descriptor.requestedAt,
      operatorId: "operator-1",
      rootCauseCorrectionRef: "incident-123",
    }, 3_000);
    expect(recovered).toMatchObject({
      action: "reopened",
      sourceKey: descriptor.sourceKey,
    });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "pending",
      localDocumentId: "doc-1",
      lastErrorClass: undefined,
    });
    expect(ledger.getOutbox(descriptor.sourceKey)).toMatchObject({ status: "pending" });
    expect(ledger.statusSnapshot(3_000).recovery).toMatchObject({
      total: 1,
      reopened: 1,
      blocked: 0,
    });
  });

  it("audits and reopens an ambiguous add for provider identity probing", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "local_add",
      errorCode: "local_http_502",
    }, 2_002)).toBe(true);
    const result = ledger.recoverPermanentFailure({
      sourceKey: descriptor.sourceKey,
      teamId: descriptor.teamId,
      expectedConfigVersion: descriptor.configVersion,
      expectedRequestedAt: descriptor.requestedAt,
      operatorId: "operator-1",
      rootCauseCorrectionRef: "incident-123",
    }, 3_000);
    expect(result).toMatchObject({
      action: "reopened",
    });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "pending",
      lastLocalOperation: "add_started",
      localDocumentId: undefined,
      desiredRevision: "sha256:one",
    });
    expect(ledger.getOutbox(descriptor.sourceKey)).toMatchObject({ status: "pending" });
    const outbox = ledger.claimDueOutbox(3_000)!;
    ledger.markOutboxSent(outbox, 3_001);
    expect(ledger.acquireLease(outbox.job, 3, "lease-2", 3_002, 60_000))
      .toMatchObject({ decision: "lease" });
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-2", "sha256:one", 3_003))
      .toEqual({ decision: "blocked", reason: "ambiguous_add_contract" });
    expect(ledger.resolveAmbiguousAdd({
      sourceKey: descriptor.sourceKey,
      leaseToken: "lease-2",
      desiredRevision: "sha256:one",
      resolution: "not_found",
    }, 3_004)).toEqual({ decision: "add" });
    expect(ledger.statusSnapshot(3_000).recovery).toMatchObject({
      total: 1,
      reopened: 1,
      blocked: 0,
    });
  });

  it("reopens legacy ambiguous-add rows recorded under unsupported_capability", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "unsupported_capability",
      errorCode: "ambiguous_add_contract",
    }, 2_002)).toBe(true);
    expect(ledger.recoverPermanentFailure({
      sourceKey: descriptor.sourceKey,
      teamId: descriptor.teamId,
      expectedConfigVersion: descriptor.configVersion,
      expectedRequestedAt: descriptor.requestedAt,
      operatorId: "operator-1",
      rootCauseCorrectionRef: "incident-legacy-ambiguous-add",
    }, 3_000)).toMatchObject({ action: "reopened", sourceKey: descriptor.sourceKey });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "pending",
      lastLocalOperation: "add_started",
      desiredRevision: "sha256:one",
    });
  });

  it("reopens legacy ambiguous-add rows without a saved revision for normalized probing", () => {
    const db = new DatabaseSync(":memory:");
    const ledger = makeLedger(db);
    const descriptor = job(3, "2026-07-19T04:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:legacy", 2_001);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "unsupported_capability",
      errorCode: "ambiguous_add_contract",
    }, 2_002)).toBe(true);
    db.prepare(
      `UPDATE knowledge_ledger
       SET desired_revision = NULL, last_local_operation = 'add_started'
       WHERE source_key = ?`,
    ).run(descriptor.sourceKey);
    expect(ledger.recoverPermanentFailure({
      sourceKey: descriptor.sourceKey,
      teamId: descriptor.teamId,
      expectedConfigVersion: descriptor.configVersion,
      expectedRequestedAt: descriptor.requestedAt,
      operatorId: "operator-1",
      rootCauseCorrectionRef: "incident-legacy-ambiguous-add-no-revision",
    }, 3_000)).toMatchObject({ action: "reopened", sourceKey: descriptor.sourceKey });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "pending",
      lastLocalOperation: "add_started",
      desiredRevision: undefined,
    });
    expect(ledger.getOutbox(descriptor.sourceKey)).toMatchObject({ status: "pending" });
  });

  it("reopens historical mutation-contract failures with a durable Local ID", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T05:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001);
    ledger.recordLocalAccepted({
      sourceKey: descriptor.sourceKey,
      leaseToken: "lease-1",
      localDocumentId: "doc-1",
      desiredRevision: "sha256:one",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
    }, 2_002);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "preserve_indexed",
      errorClass: "unsupported_capability",
      errorCode: "unsupported_update_contract",
    }, 2_003)).toBe(true);
    expect(ledger.recoverPermanentFailure({
      sourceKey: descriptor.sourceKey,
      teamId: descriptor.teamId,
      expectedConfigVersion: descriptor.configVersion,
      expectedRequestedAt: descriptor.requestedAt,
      operatorId: "operator-1",
      rootCauseCorrectionRef: "incident-mutation-contract-repair",
    }, 3_000)).toMatchObject({ action: "reopened", sourceKey: descriptor.sourceKey });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "pending",
      localDocumentId: "doc-1",
      lastLocalOperation: undefined,
    });
  });

  it("persists the exact Slack terminal skip code and blocks reconciliation leases", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "slack_terminal_skip",
      errorCode: "not_in_channel",
    }, 2_100)).toBe(true);
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "permanent_failure",
      lastErrorClass: "slack_terminal_skip",
      lastErrorCode: "not_in_channel",
    });
    expect(ledger.acquireLease(descriptor, 3, "lease-2", 3_000, 60_000))
      .toEqual({ decision: "noop", reason: "permanent_failure" });
  });

  it("preserves add_started after a retryable add failure with no Local ID", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001))
      .toEqual({ decision: "add" });
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "retryable_failure",
      errorClass: "local_add",
      errorCode: "knowledge_unavailable",
    }, 2_200)).toBe(true);
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "retryable_failure",
    });
    expect(ledger.get(descriptor.sourceKey)?.lastLocalOperation).toBe("add_started");
    expect(ledger.get(descriptor.sourceKey)?.localDocumentId).toBeUndefined();
    ledger.acquireLease(descriptor, 3, "lease-2", 3_000, 60_000);
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-2", "sha256:one", 3_001))
      .toEqual({ decision: "blocked", reason: "ambiguous_add_contract" });
  });

  it("resolves an ambiguous add only while its lease and revision are current", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:one", 2_001))
      .toEqual({ decision: "add" });
    ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "retryable_failure",
      errorClass: "local_add",
      errorCode: "knowledge_http_503",
    }, 2_002);
    ledger.acquireLease(descriptor, 3, "lease-2", 3_000, 60_000);
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-2", "sha256:one", 3_001))
      .toEqual({ decision: "blocked", reason: "ambiguous_add_contract" });
    expect(ledger.resolveAmbiguousAdd({
      sourceKey: descriptor.sourceKey,
      leaseToken: "lease-2",
      desiredRevision: "sha256:one",
      resolution: "not_found",
    }, 3_002)).toEqual({ decision: "add" });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "writing",
      addAttemptToken: "lease-2",
      addAttemptRevision: "sha256:one",
    });

    const second = makeLedger();
    const secondDescriptor = job(3, "2026-07-19T02:00:00.000Z");
    second.enqueue(secondDescriptor, 1_000);
    second.markOutboxSent(second.claimDueOutbox(1_000)!, 1_001);
    second.acquireLease(secondDescriptor, 3, "lease-2", 2_000, 60_000);
    second.prepareRevision(secondDescriptor.sourceKey, "lease-2", "sha256:two", 2_001);
    second.recordOutcome(secondDescriptor.sourceKey, "lease-2", {
      status: "retryable_failure",
      errorClass: "local_add",
      errorCode: "knowledge_http_503",
    }, 2_002);
    second.acquireLease(secondDescriptor, 3, "lease-3", 3_000, 60_000);
    expect(second.prepareRevision(secondDescriptor.sourceKey, "lease-3", "sha256:two", 3_001))
      .toEqual({ decision: "blocked", reason: "ambiguous_add_contract" });
    expect(second.resolveAmbiguousAdd({
      sourceKey: secondDescriptor.sourceKey,
      leaseToken: "lease-3",
      desiredRevision: "sha256:two",
      resolution: "found",
      localDocumentId: "doc-existing",
      workflowStatus: "queued",
      pollDeadlineAt: 20_000,
      nextPollAt: 2_003,
    }, 3_002)).toEqual({
      decision: "poll",
      localDocumentId: "doc-existing",
      pollDeadlineAt: 20_000,
    });
    expect(second.get(secondDescriptor.sourceKey)).toMatchObject({
      status: "polling",
      localDocumentId: "doc-existing",
      localDocumentRevision: "sha256:two",
      lastLocalOperation: "add_accepted",
    });
  });

  it("adopts the normalized revision for a legacy ambiguous row that lost its revision", () => {
    const db = new DatabaseSync(":memory:");
    const ledger = makeLedger(db);
    const descriptor = job(3, "2026-07-19T03:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(ledger.prepareRevision(descriptor.sourceKey, "lease-1", "sha256:legacy", 2_001))
      .toEqual({ decision: "add" });
    ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "permanent_failure",
      errorClass: "local_add",
      errorCode: "local_http_502",
    }, 2_002);
    db.prepare(
      `UPDATE knowledge_ledger
       SET status = 'leased', lease_token = ?, lease_expires_at = ?, desired_revision = NULL,
           last_local_operation = 'add_started'
       WHERE source_key = ?`,
    ).run("legacy-lease", 100_000, descriptor.sourceKey);
    expect(ledger.resolveAmbiguousAdd({
      sourceKey: descriptor.sourceKey,
      leaseToken: "legacy-lease",
      desiredRevision: "sha256:recovered",
      resolution: "not_found",
    }, 3_000)).toEqual({ decision: "add" });
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      status: "writing",
      desiredRevision: "sha256:recovered",
      addAttemptRevision: "sha256:recovered",
    });
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

  it("switches an existing derived binding to a new index generation before replay", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(original, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(original, 3, "legacy-lease", 2_000, 60_000);
    expect(ledger.prepareRevision(original.sourceKey, "legacy-lease", "sha256:old", 2_001))
      .toEqual({ decision: "add" });
    expect(ledger.recordLocalAccepted({
      sourceKey: original.sourceKey,
      leaseToken: "legacy-lease",
      localDocumentId: "railway-doc-1",
      desiredRevision: "sha256:old",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
    }, 2_002)).toBe(true);
    expect(ledger.recordOutcome(original.sourceKey, "legacy-lease", {
      status: "indexed",
      desiredRevision: "sha256:old",
      indexedRevision: "sha256:old",
      localDocumentId: "railway-doc-1",
      workflowStatus: "done",
      pollCount: 1,
    }, 3_000)).toBe(true);

    const replay = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(replay, 4_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(4_000)!, 4_001);
    ledger.acquireLease(replay, 3, "cloudflare-lease", 5_000, 60_000);
    expect(ledger.prepareRevision(
      replay.sourceKey,
      "cloudflare-lease",
      "sha256:old",
      5_001,
      { indexGeneration: "cloudflare-r2-v1" },
    )).toEqual({ decision: "add" });
    expect(ledger.get(replay.sourceKey)).toMatchObject({
      derivedIndexGeneration: "cloudflare-r2-v1",
      localDocumentId: undefined,
      indexedRevision: undefined,
      lastLocalOperation: "add_started",
    });
    expect(ledger.recordLocalAccepted({
      sourceKey: replay.sourceKey,
      leaseToken: "cloudflare-lease",
      localDocumentId: "cloudflare-doc-1",
      desiredRevision: "sha256:old",
      workflowStatus: "queued",
      pollDeadlineAt: 15_000,
      nextPollAt: 5_100,
      indexGeneration: "cloudflare-r2-v1",
    }, 5_002)).toBe(true);
    expect(ledger.recordOutcome(replay.sourceKey, "cloudflare-lease", {
      status: "indexed",
      desiredRevision: "sha256:old",
      indexedRevision: "sha256:old",
      localDocumentId: "cloudflare-doc-1",
      workflowStatus: "done",
      pollCount: 1,
      indexGeneration: "cloudflare-r2-v1",
    }, 6_000)).toBe(true);
    expect(ledger.get(replay.sourceKey)).toMatchObject({
      status: "indexed",
      derivedIndexGeneration: "cloudflare-r2-v1",
      localDocumentId: "cloudflare-doc-1",
      indexedRevision: "sha256:old",
    });
  });

  it("rejects writes that omit the active derived-index generation", () => {
    const ledger = makeLedger();
    const descriptor = job(3, "2026-07-19T01:00:00.000Z");
    ledger.enqueue(descriptor, 1_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(1_000)!, 1_001);
    ledger.acquireLease(descriptor, 3, "lease-1", 2_000, 60_000);
    expect(ledger.prepareRevision(
      descriptor.sourceKey,
      "lease-1",
      "sha256:one",
      2_001,
      { indexGeneration: "cloudflare-r2-v1" },
    )).toEqual({ decision: "add" });
    expect(ledger.recordLocalAccepted({
      sourceKey: descriptor.sourceKey,
      leaseToken: "lease-1",
      localDocumentId: "cloudflare-doc-1",
      desiredRevision: "sha256:one",
      workflowStatus: "queued",
      pollDeadlineAt: 10_000,
      nextPollAt: 2_100,
      indexGeneration: "cloudflare-r2-v1",
    }, 2_002)).toBe(true);
    expect(ledger.recordOutcome(descriptor.sourceKey, "lease-1", {
      status: "indexed",
      desiredRevision: "sha256:one",
      indexedRevision: "sha256:one",
      localDocumentId: "cloudflare-doc-1",
      workflowStatus: "done",
      pollCount: 1,
    }, 3_000)).toBe(false);
    expect(ledger.get(descriptor.sourceKey)).toMatchObject({
      derivedIndexGeneration: "cloudflare-r2-v1",
      leaseToken: "lease-1",
      status: "polling",
    });
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
    expect(ledger.prepareRevision(edit.sourceKey, "lease-2", "sha256:new", 5_002, {
      mutationsVerified: true,
    })).toEqual({ decision: "update", localDocumentId: "doc-1" });
    expect(ledger.get(edit.sourceKey)).toMatchObject({
      status: "writing",
      lastLocalOperation: "update_started",
      desiredRevision: "sha256:new",
    });
  });

  it("records a Local update acceptance against the active lease and new revision", () => {
    const ledger = makeLedger();
    const original = job(3, "2026-07-19T01:00:00.000Z");
    markIndexed(ledger, original, "sha256:old", "doc-1", "generation-1");
    const edit = job(3, "2026-07-19T02:00:00.000Z");
    ledger.enqueue(edit, 4_000);
    ledger.markOutboxSent(ledger.claimDueOutbox(4_000)!, 4_001);
    ledger.acquireLease(edit, 3, "lease-2", 5_000, 60_000);
    expect(ledger.prepareRevision(edit.sourceKey, "lease-2", "sha256:new", 5_001, {
      mutationsVerified: true,
      indexGeneration: "generation-1",
    })).toEqual({ decision: "update", localDocumentId: "doc-1" });
    expect(ledger.recordLocalAccepted({
      sourceKey: edit.sourceKey,
      leaseToken: "lease-2",
      localDocumentId: "doc-1",
      desiredRevision: "sha256:new",
      workflowStatus: "done",
      pollDeadlineAt: 10_000,
      nextPollAt: 5_100,
      indexGeneration: "generation-1",
    }, 5_002)).toBe(true);
    expect(ledger.get(edit.sourceKey)).toMatchObject({
      status: "polling",
      localDocumentId: "doc-1",
      localDocumentRevision: "sha256:new",
      desiredRevision: "sha256:new",
      lastLocalOperation: "update_accepted",
    });
    expect(ledger.recordOutcome(edit.sourceKey, "lease-2", {
      status: "indexed",
      desiredRevision: "sha256:new",
      indexedRevision: "sha256:new",
      localDocumentId: "doc-1",
      workflowStatus: "done",
      pollCount: 1,
      indexGeneration: "generation-1",
    }, 5_003)).toBe(true);
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

  it("persists a fenced queryability receipt and replaces the same fence idempotently", () => {
    const db = new DatabaseSync(":memory:");
    const ledger = makeLedger(db);
    const source = job(1, "2026-07-01T00:00:00.000Z");
    const columns = db.prepare("PRAGMA table_info(knowledge_queryability_receipts)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "content_revision",
      "index_revision",
      "local_document_id",
      "derived_index_generation",
      "status",
      "provider_result_count",
      "accepted_citation_count",
      "created_at",
      "updated_at",
    ]));
    markIndexed(ledger, source);
    const identity = {
      sourceKey: source.sourceKey,
      sourceType: "slack" as const,
      teamId: source.teamId,
      projectId: source.projectId,
      channelId: source.channelId,
      threadTs: source.threadTs,
      contentRevision: "sha256:one",
      indexRevision: "sha256:one",
      localDocumentId: "doc-1",
      derivedIndexGeneration: "generation-1",
    };
    const first = ledger.recordQueryabilityReceipt({
      ...identity,
      status: "searchable",
      providerResultCount: 2,
      acceptedCitationCount: 1,
    }, 2_000);
    const replacement = ledger.recordQueryabilityReceipt({
      ...identity,
      status: "no_match",
      providerResultCount: 0,
      acceptedCitationCount: 0,
    }, 3_000);
    expect(first).toMatchObject({ status: "searchable", createdAt: "1970-01-01T00:00:02.000Z" });
    expect(replacement).toMatchObject({
      ...identity,
      status: "no_match",
      createdAt: first.createdAt,
      updatedAt: "1970-01-01T00:00:03.000Z",
    });
    expect(ledger.readQueryabilityReceipt(identity)).toEqual(replacement);
    expect(JSON.stringify(replacement)).not.toMatch(/body|query|secret/i);
  });

  it("fails closed for stale receipt fences and aggregates body-free status", () => {
    const ledger = makeLedger();
    const source = job(1, "2026-07-01T00:00:00.000Z");
    const identity = {
      sourceKey: source.sourceKey,
      sourceType: "slack" as const,
      teamId: source.teamId,
      projectId: source.projectId,
      channelId: source.channelId,
      threadTs: source.threadTs,
      contentRevision: "sha256:one",
      indexRevision: "sha256:one",
      localDocumentId: "doc-1",
      derivedIndexGeneration: "generation-1",
    };
    ledger.enqueue(source, 1_000);
    expect(() => ledger.recordQueryabilityReceipt({
      ...identity,
      status: "searchable",
      providerResultCount: 1,
      acceptedCitationCount: 1,
    }, 2_000)).toThrow("requires indexed status");
    markIndexed(ledger, source);
    ledger.recordQueryabilityReceipt({
      ...identity,
      status: "searchable",
      providerResultCount: 1,
      acceptedCitationCount: 1,
    }, 2_001);
    expect(() => ledger.recordQueryabilityReceipt({
      ...identity,
      derivedIndexGeneration: "generation-2",
      status: "no_match",
      providerResultCount: 0,
      acceptedCitationCount: 0,
    }, 2_002)).toThrow("generation mismatch");

    const second = createKnowledgeJob({
      teamId: "T1", projectId: "P1", channelId: "C2", threadTs: "171234.000200",
      configVersion: 1, requestedAt: "2026-07-01T00:00:01.000Z", reason: "event",
    });
    const third = createKnowledgeJob({
      teamId: "T1", projectId: "P1", channelId: "C3", threadTs: "171234.000300",
      configVersion: 1, requestedAt: "2026-07-01T00:00:02.000Z", reason: "event",
    });
    const fourth = createKnowledgeJob({
      teamId: "T1", projectId: "P1", channelId: "C4", threadTs: "171234.000400",
      configVersion: 1, requestedAt: "2026-07-01T00:00:03.000Z", reason: "event",
    });
    markIndexed(ledger, second);
    markIndexed(ledger, third);
    markIndexed(ledger, fourth);
    const receiptIdentity = (value: typeof second) => ({
      sourceKey: value.sourceKey,
      sourceType: "slack" as const,
      teamId: value.teamId,
      projectId: value.projectId,
      channelId: value.channelId,
      threadTs: value.threadTs,
      contentRevision: "sha256:one",
      indexRevision: "sha256:one",
      localDocumentId: "doc-1",
      derivedIndexGeneration: "generation-1",
    });
    ledger.recordQueryabilityReceipt({ ...receiptIdentity(second), status: "no_match", providerResultCount: 0, acceptedCitationCount: 0 }, 2_003);
    ledger.recordQueryabilityReceipt({ ...receiptIdentity(third), status: "provider_unavailable", providerResultCount: 0, acceptedCitationCount: 0 }, 2_003);
    const snapshot = ledger.statusSnapshot(2_003);
    expect(snapshot.queryability).toEqual({
      total: 4,
      byStatus: { unverified: 1, searchable: 1, no_match: 1, provider_unavailable: 1 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("message body");
    expect(JSON.stringify(snapshot)).not.toContain("query text");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
  });
});
