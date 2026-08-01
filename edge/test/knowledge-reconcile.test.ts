import { describe, expect, it, vi } from "vitest";
import {
  handleKnowledgeDlq,
  inspectKnowledgeDlq,
  parseKnowledgeReconciliationTeamScope,
  planKnowledgeDlqReplay,
  planKnowledgeReconciliation,
  replayDurableKnowledgeDlqRecord,
  runKnowledgeReconciliationPage,
  runScheduledKnowledgeReconciliation,
  submitKnowledgeDescriptor,
} from "../src/memory/knowledge-reconcile.js";
import {
  createKnowledgeJob,
} from "../src/memory/knowledge-contract.js";
import { knowledgeDescriptorKey } from "../src/memory/knowledge-ledger.js";

const source = {
  teamId: "T1", projectId: "P1", channelId: "C1", threadTs: "1.0",
  configVersion: 3, enabled: true, status: "pending",
};

describe("knowledge reconciliation and DLQ operations", () => {
  it("requires a bounded exact scheduler team scope", () => {
    expect(parseKnowledgeReconciliationTeamScope("T1,T2")).toEqual(["T1", "T2"]);
    expect(() => parseKnowledgeReconciliationTeamScope(undefined))
      .toThrow("knowledge_reconciliation_team_scope_missing");
    expect(() => parseKnowledgeReconciliationTeamScope("T1,T1"))
      .toThrow("knowledge_reconciliation_team_scope_invalid");
    expect(() => parseKnowledgeReconciliationTeamScope("T*"))
      .toThrow("knowledge_reconciliation_team_scope_invalid");
  });

  it("gives tombstones precedence and blocks unsupported mutation contracts", () => {
    expect(planKnowledgeReconciliation({ ...source, tombstonedAt: "2026-07-19T00:00:00.000Z" }, "2026-07-19T01:00:00.000Z"))
      .toMatchObject({ action: "blocked", reason: "unsupported_delete_contract" });
    expect(planKnowledgeReconciliation({
      ...source, status: "indexed", localDocumentId: "doc-1", desiredRevision: "sha256:new", indexedRevision: "sha256:old",
    }, "2026-07-19T01:00:00.000Z")).toMatchObject({ action: "blocked", reason: "unsupported_update_contract" });
    expect(planKnowledgeReconciliation({
      ...source, status: "permanent_failure", incompleteReason: "not_in_channel",
    }, "2026-07-19T01:00:00.000Z")).toEqual({
      action: "blocked",
      sourceKey: "slack:T1:C1:1_0",
      reason: "permanent_failure",
    });
  });

  it("resumes the same known ID and retries incomplete fetches safely", () => {
    expect(planKnowledgeReconciliation({
      ...source, status: "processing_unconfirmed", localDocumentId: "doc-1", desiredRevision: "sha256:one",
    }, "2026-07-19T01:00:00.000Z")).toEqual({
      action: "resume_poll", sourceKey: "slack:T1:C1:1_0", localDocumentId: "doc-1",
    });
    expect(planKnowledgeReconciliation({
      ...source, status: "incomplete", incompleteReason: "cursor_missing",
    }, "2026-07-19T01:00:00.000Z")).toMatchObject({ action: "retry_fetch", reason: "cursor_missing" });
  });

  it("does not steal a live lease and requeues an expired lease", () => {
    expect(planKnowledgeReconciliation({
      ...source,
      status: "leased",
      leaseExpiresAt: 2_000,
    }, "2026-07-19T01:00:00.000Z", 1_000)).toMatchObject({
      action: "noop",
      reason: "lease_active",
    });
    expect(planKnowledgeReconciliation({
      ...source,
      status: "leased",
      leaseExpiresAt: 500,
    }, "2026-07-19T01:00:00.000Z", 1_000)).toMatchObject({
      action: "enqueue",
      job: expect.objectContaining({ reason: "reconcile" }),
    });
  });

  it("uses canonical job validation for every enqueue plan", () => {
    expect(() => planKnowledgeReconciliation(
      { ...source, configVersion: 0 },
      "2026-07-19T01:00:00.000Z",
    )).toThrow("configVersion");
    expect(() => planKnowledgeReconciliation(
      { ...source, projectId: "bad:project" },
      "2026-07-19T01:00:00.000Z",
    )).toThrow("projectId");
    expect(() => planKnowledgeReconciliation(source, "not-a-timestamp"))
      .toThrow("canonical ISO timestamp");
  });

  it("makes DLQ inspection observable and replay exact and explicit", () => {
    const records = [
      { messageId: "m2", sourceKey: "slack:T1:C1:2_0", attempts: 3 },
      { messageId: "m1", sourceKey: "slack:T1:C1:1_0", attempts: 2 },
    ];
    expect(inspectKnowledgeDlq(records, 1)).toMatchObject({ count: 2, truncated: true });
    expect(planKnowledgeDlqReplay(records, "slack:T1:C1:1_0")).toMatchObject({ action: "replay_one", record: records[1] });
    expect(() => planKnowledgeDlqReplay(records, "slack:T1:C1:*")).toThrow("exact sourceKey");
  });

  it("continues a durable page with the current source config version", async () => {
    const descriptors: unknown[] = [];
    const knowledgeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/reconcile/start") {
        return Response.json({ runId: "run-1", status: "running" });
      }
      if (path === "/reconcile/claim") {
        return Response.json({
          run: {
            status: "running",
            createdAt: "2026-07-19T03:00:00.000Z",
            scannedCount: 0,
            enqueuedCount: 0,
            skippedCount: 0,
          },
          pageToken: "page-1",
          rows: [{
            ...source,
            sourceKey: "slack:T1:C1:1_0",
            requestedAt: "2026-07-19T01:00:00.000Z",
            reason: "event",
            status: "retryable_failure",
            queueAttempts: 3,
            pollCount: 0,
            createdAt: "2026-07-19T01:00:00.000Z",
            updatedAt: "2026-07-19T02:00:00.000Z",
          }],
        });
      }
      if (path === "/descriptor") {
        const job = await request.json() as ReturnType<typeof createKnowledgeJob>;
        descriptors.push(job);
        return Response.json({
          accepted: true,
          reason: "new",
          descriptorKey: knowledgeDescriptorKey(job),
        });
      }
      if (path === "/reconcile/commit") {
        return Response.json({
          status: "running",
          cursor: "slack:T1:C1:1_0",
          scannedCount: 1,
          enqueuedCount: 1,
          skippedCount: 0,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const workspaceFetch = async () => Response.json({
      ...source,
      schemaVersion: 1,
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 4,
      updatedAt: "2026-07-19T02:00:00.000Z",
    });
    const namespace = (fetcher: typeof knowledgeFetch) => ({
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetcher }),
    });
    const result = await runKnowledgeReconciliationPage({
      KNOWLEDGE: namespace(knowledgeFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never, { teamId: "T1", runId: "run-1", limit: 1 });
    expect(result).toMatchObject({ scannedCount: 1, enqueuedCount: 1 });
    expect(descriptors).toEqual([
      expect.objectContaining({ configVersion: 4, reason: "reconcile" }),
    ]);
  });

  it("captures a real DLQ batch before ack and replays one exact current record", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T01:00:00.000Z",
      reason: "event",
    });
    const calls: string[] = [];
    const descriptors: unknown[] = [];
    const knowledgeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === "/state") {
        return Response.json({ ledger: { lastErrorCode: "local_timeout" } });
      }
      if (path === "/dlq/capture") return Response.json({ recordId: "kdlq-1" });
      if (path === "/dlq/replay/claim") {
        return Response.json({
          recordId: "kdlq-1",
          body: job,
          sourceKey: job.sourceKey,
          teamId: job.teamId,
          replayRequestedAt: "2026-07-19T03:00:00.000Z",
        });
      }
      if (path === "/descriptor") {
        const replayJob = await request.json() as ReturnType<typeof createKnowledgeJob>;
        descriptors.push(replayJob);
        return Response.json({
          accepted: true,
          reason: "new",
          descriptorKey: knowledgeDescriptorKey(replayJob),
        });
      }
      if (path === "/dlq/replay/complete") return Response.json({ status: "replayed" });
      if (path === "/dlq/replay/release") return Response.json({ released: true });
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const workspaceFetch = async () => Response.json({
      schemaVersion: 1,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T02:00:00.000Z",
    });
    const namespace = (fetcher: typeof knowledgeFetch) => ({
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetcher }),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    await handleKnowledgeDlq({
      queue: "knowledge-dlq",
      messages: [{
        id: "message-1",
        body: job,
        attempts: 4,
        timestamp: new Date("2026-07-19T02:00:00.000Z"),
        ack,
        retry,
      }],
    } as never, {
      KNOWLEDGE: namespace(knowledgeFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(calls).toContain("/dlq/capture");

    await expect(replayDurableKnowledgeDlqRecord({
      KNOWLEDGE: namespace(knowledgeFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never, {
      recordId: "kdlq-1",
      expectedSourceKey: job.sourceKey,
      rootCauseCorrectionRef: "incident-123-fixed",
    })).resolves.toMatchObject({ replayed: true });
    expect(descriptors).toEqual([
      expect.objectContaining({
        sourceKey: job.sourceKey,
        reason: "reconcile",
        requestedAt: "2026-07-19T03:00:00.000Z",
      }),
    ]);
    expect(calls.filter((path) => path === "/dlq/replay/complete")).toHaveLength(1);
  });

  it("classifies exact duplicate and accepted-but-response-lost descriptors from ledger proof", async () => {
    const reconcileJob = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T03:00:00.000Z",
      reason: "reconcile",
    });
    const exactState = {
      ledger: {
        ...reconcileJob,
        status: "pending",
        queueAttempts: 0,
        pollCount: 0,
        createdAt: reconcileJob.requestedAt,
        updatedAt: reconcileJob.requestedAt,
      },
      outbox: {
        descriptorKey: knowledgeDescriptorKey(reconcileJob),
        job: reconcileJob,
        status: "pending",
        attemptCount: 0,
      },
    };
    const workspaceFetch = async () => Response.json({
      ...source,
      schemaVersion: 1,
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T02:00:00.000Z",
    });
    const namespace = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => ({
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetcher }),
    });

    const duplicateFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/descriptor") {
        return Response.json({
          accepted: false,
          reason: "duplicate",
          descriptorKey: knowledgeDescriptorKey(reconcileJob),
        });
      }
      if (path === "/state") return Response.json(exactState);
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    await expect(submitKnowledgeDescriptor({
      KNOWLEDGE: namespace(duplicateFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never, reconcileJob)).resolves.toEqual({
      disposition: "duplicate",
      enqueued: false,
    });

    const responseLostFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/descriptor") throw new Error("response_lost_after_commit");
      if (path === "/state") return Response.json(exactState);
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    await expect(submitKnowledgeDescriptor({
      KNOWLEDGE: namespace(responseLostFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never, reconcileJob)).resolves.toEqual({
      disposition: "accepted_response_lost",
      enqueued: false,
    });
  });

  it("scheduled reconciliation completes a durable cursor without manual calls", async () => {
    const reconcileRow = {
      ...source,
      sourceKey: "slack:T1:C1:1_0",
      requestedAt: "2026-07-19T01:00:00.000Z",
      reason: "event",
      status: "retryable_failure",
      queueAttempts: 3,
      pollCount: 0,
      createdAt: "2026-07-19T01:00:00.000Z",
      updatedAt: "2026-07-19T02:00:00.000Z",
    };
    let claimCount = 0;
    const paths: string[] = [];
    const coordinator = {
      coordinatorKey: "scheduled-reconciliation-v1",
      triggerId: "2026-07-25T12:00:00.000Z",
      scopeDigest: `sha256:${"a".repeat(64)}`,
      teamIds: ["T1"],
      cycleId: "cycle-1",
      teamIndex: 0,
      activeRunId: "cycle-1:0",
      status: "running",
      leaseToken: "lease-1",
      leaseExpiresAt: Date.now() + 60_000,
      nextAttemptAt: 0,
      errorCount: 0,
      pageCount: 0,
      completedTeamCount: 0,
      configDriftCount: 0,
      startedAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    } as const;
    const knowledgeFetch = async (
      objectName: string,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(`${objectName}:${path}`);
      if (path === "/reconcile/coordinator/claim") {
        return Response.json({
          decision: "acquired",
          coordinator,
          configDrifted: false,
        });
      }
      if (path === "/reconcile/start") {
        return Response.json({ runId: "cycle-1:0", status: "running" });
      }
      if (path === "/reconcile/claim") {
        claimCount += 1;
        return Response.json(claimCount === 1 ? {
          run: {
            status: "running",
            createdAt: "2026-07-25T12:00:00.000Z",
            updatedAt: "2026-07-25T12:00:00.000Z",
            scannedCount: 0,
            enqueuedCount: 0,
            skippedCount: 0,
          },
          pageToken: "page-1",
          rows: [reconcileRow],
        } : {
          run: {
            status: "complete",
            cursor: reconcileRow.sourceKey,
            createdAt: "2026-07-25T12:00:00.000Z",
            updatedAt: "2026-07-25T12:00:01.000Z",
            scannedCount: 1,
            enqueuedCount: 1,
            skippedCount: 0,
          },
          rows: [],
        });
      }
      if (path === "/descriptor") {
        const descriptor = await request.json() as ReturnType<typeof createKnowledgeJob>;
        return Response.json({
          accepted: true,
          reason: "new",
          descriptorKey: knowledgeDescriptorKey(descriptor),
        });
      }
      if (path === "/reconcile/commit") {
        return Response.json({
          status: "running",
          cursor: reconcileRow.sourceKey,
          createdAt: "2026-07-25T12:00:00.000Z",
          updatedAt: "2026-07-25T12:00:01.000Z",
          scannedCount: 1,
          enqueuedCount: 1,
          skippedCount: 0,
        });
      }
      if (path === "/reconcile/coordinator/page") {
        return Response.json({ ...coordinator, pageCount: 1 });
      }
      if (path === "/reconcile/coordinator/advance") {
        return Response.json({
          ...coordinator,
          status: "complete",
          teamIndex: 1,
          pageCount: 1,
          completedTeamCount: 1,
          completedAt: "2026-07-25T12:00:02.000Z",
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const workspaceFetch = async () => Response.json({
      ...source,
      schemaVersion: 1,
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T02:00:00.000Z",
    });
    const knowledgeNamespace = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          knowledgeFetch(name, input, init),
      }),
    };
    const workspaceNamespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: workspaceFetch }),
    };
    const result = await runScheduledKnowledgeReconciliation({
      KNOWLEDGE: knowledgeNamespace,
      WORKSPACE_CONFIG: workspaceNamespace,
      KNOWLEDGE_QUEUE: {},
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge-dlq",
      KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED: "true",
      KNOWLEDGE_RECONCILIATION_TEAM_IDS: "T1",
    } as never, {
      scheduledAt: "2026-07-25T12:00:00.000Z",
      now: () => Date.parse("2026-07-25T12:00:02.000Z"),
    });
    expect(result).toMatchObject({
      status: "complete",
      pagesProcessed: 1,
      teamsCompleted: 1,
    });
    expect(paths.filter((path) => path === "T1:/reconcile/claim")).toHaveLength(2);
    expect(paths).toContain("knowledge-operator-control-v1:/reconcile/coordinator/advance");
  });

  it("keeps a partial scheduler page uncommitted and persists bounded backoff", async () => {
    const paths: string[] = [];
    const coordinator = {
      coordinatorKey: "scheduled-reconciliation-v1",
      triggerId: "2026-07-25T12:00:00.000Z",
      scopeDigest: `sha256:${"b".repeat(64)}`,
      teamIds: ["T1"],
      cycleId: "cycle-failure",
      teamIndex: 0,
      activeRunId: "cycle-failure:0",
      status: "running",
      leaseToken: "lease-failure",
      leaseExpiresAt: Date.now() + 60_000,
      nextAttemptAt: 0,
      errorCount: 0,
      pageCount: 0,
      completedTeamCount: 0,
      configDriftCount: 0,
      startedAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    } as const;
    const rejectedJob = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-25T12:00:00.001Z",
      reason: "reconcile",
    });
    const knowledgeFetch = async (
      objectName: string,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(`${objectName}:${path}`);
      if (path === "/reconcile/coordinator/claim") {
        return Response.json({ decision: "acquired", coordinator, configDrifted: false });
      }
      if (path === "/reconcile/start") return Response.json({ status: "running" });
      if (path === "/reconcile/claim") {
        return Response.json({
          run: {
            status: "running",
            createdAt: "2026-07-25T12:00:00.000Z",
            updatedAt: "2026-07-25T12:00:00.000Z",
            scannedCount: 0,
            enqueuedCount: 0,
            skippedCount: 0,
          },
          pageToken: "page-partial",
          rows: [{
            ...rejectedJob,
            reason: "event",
            status: "retryable_failure",
            queueAttempts: 2,
            pollCount: 0,
            createdAt: "2026-07-25T11:00:00.000Z",
            updatedAt: "2026-07-25T11:30:00.000Z",
          }],
        });
      }
      if (path === "/descriptor") {
        return Response.json({
          accepted: false,
          reason: "out_of_order",
          descriptorKey: knowledgeDescriptorKey(rejectedJob),
        });
      }
      if (path === "/state") return Response.json({ ledger: null, outbox: null });
      if (path === "/reconcile/coordinator/fail") {
        return Response.json({
          ...coordinator,
          status: "backoff",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: Date.parse("2026-07-25T12:00:30.000Z"),
          errorCount: 1,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const workspaceFetch = async () => Response.json({
      ...source,
      schemaVersion: 1,
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-25T11:00:00.000Z",
    });
    const knowledgeNamespace = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          knowledgeFetch(name, input, init),
      }),
    };
    const result = await runScheduledKnowledgeReconciliation({
      KNOWLEDGE: knowledgeNamespace,
      WORKSPACE_CONFIG: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: workspaceFetch }),
      },
      KNOWLEDGE_QUEUE: {},
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge-dlq",
      KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED: "true",
      KNOWLEDGE_RECONCILIATION_TEAM_IDS: "T1",
    } as never, {
      scheduledAt: "2026-07-25T12:00:00.000Z",
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "backoff",
      pagesProcessed: 0,
      teamsCompleted: 0,
      nextAttemptAt: Date.parse("2026-07-25T12:00:30.000Z"),
    });
    expect(paths).not.toContain("T1:/reconcile/commit");
    expect(paths).toContain("knowledge-operator-control-v1:/reconcile/coordinator/fail");
  });

  it("persists a superseded DLQ disposition instead of falsely reporting replay", async () => {
    const original = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T01:00:00.000Z",
      reason: "event",
    });
    const completionBodies: unknown[] = [];
    const knowledgeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/dlq/replay/claim") {
        return Response.json({
          recordId: "kdlq-1",
          body: original,
          sourceKey: original.sourceKey,
          teamId: original.teamId,
          replayRequestedAt: "2026-07-19T03:00:00.000Z",
        });
      }
      if (path === "/descriptor") {
        const replayJob = await request.json() as typeof original;
        return Response.json({
          accepted: false,
          reason: "duplicate",
          descriptorKey: knowledgeDescriptorKey(replayJob),
        });
      }
      if (path === "/state") {
        return Response.json({
          ledger: {
            ...original,
            requestedAt: "2026-07-19T04:00:00.000Z",
            reason: "event",
            status: "queued",
            queueAttempts: 1,
            pollCount: 0,
            createdAt: original.requestedAt,
            updatedAt: "2026-07-19T04:00:00.000Z",
          },
          outbox: null,
        });
      }
      if (path === "/dlq/replay/complete") {
        completionBodies.push(await request.json());
        return Response.json({ status: "disposed", replayDisposition: "superseded" });
      }
      if (path === "/dlq/replay/release") return Response.json({ released: true });
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const workspaceFetch = async () => Response.json({
      ...source,
      schemaVersion: 1,
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T04:00:00.000Z",
    });
    const namespace = (fetcher: typeof knowledgeFetch) => ({
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetcher }),
    });
    await expect(replayDurableKnowledgeDlqRecord({
      KNOWLEDGE: namespace(knowledgeFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never, {
      recordId: "kdlq-1",
      expectedSourceKey: original.sourceKey,
      rootCauseCorrectionRef: "incident-123-fixed",
    })).resolves.toEqual({
      recordId: "kdlq-1",
      sourceKey: original.sourceKey,
      replayed: false,
      disposition: "superseded",
    });
    expect(completionBodies).toEqual([{
      recordId: "kdlq-1",
      disposition: "superseded",
    }]);
  });
});
