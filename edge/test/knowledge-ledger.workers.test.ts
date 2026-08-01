import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createKnowledgeJob } from "../src/memory/knowledge-contract.js";
import {
  createKnowledgeBackfillDryRun,
  discoverAndStoreKnowledgeBackfill,
  knowledgeBackfillManifestDigest,
  type KnowledgeBackfillScope,
} from "../src/memory/knowledge-backfill.js";
import {
  verifyKnowledgeBackfillApproval,
} from "../src/memory/knowledge-backfill-authorization.js";
import {
  signKnowledgeBackfillApproval,
  TEST_KNOWLEDGE_BACKFILL_ISSUER,
  TEST_KNOWLEDGE_BACKFILL_KEY_ID,
  TEST_KNOWLEDGE_BACKFILL_PUBLIC_KEY,
} from "./helpers/knowledge-backfill-approval.js";
import worker from "../src/worker.js";
import { operatorStub, tenantStub } from "../src/tenancy.js";

describe("KnowledgeDO additive descriptor ledger", () => {
  it("resumes a global-page-capped multi-channel discovery with empty exhaustion cursors", async () => {
    const teamId = `knowledge-discovery-${crypto.randomUUID()}`;
    const config = tenantStub(env.WORKSPACE_CONFIG, teamId);
    for (const channelId of ["C1", "C2"]) {
      const configured = await config.fetch(
        "https://do/putTrackedKnowledgeSource",
        {
          method: "POST",
          body: JSON.stringify({
            teamId,
            projectId: "P1",
            channelId,
            enabled: true,
            readerPolicyRef: "bundle:test-readers",
            retentionDays: 30,
          }),
        },
      );
      expect(configured.ok).toBe(true);
    }
    let c1Page = 0;
    const fetchedChannels: string[] = [];
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = init?.body as URLSearchParams;
      const channelId = body.get("channel")!;
      fetchedChannels.push(channelId);
      if (channelId === "C1") {
        c1Page += 1;
        const hasMore = c1Page <= 20;
        return Response.json({
          ok: true,
          messages: [{
            ts: `${1784422800 + c1Page}.000100`,
          }],
          has_more: hasMore,
          response_metadata: {
            next_cursor: hasMore ? `c1-page-${c1Page + 1}` : "",
          },
        });
      }
      return Response.json({
        ok: true,
        messages: [{ ts: "1784422900.000100" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    });
    const input = {
      manifestId: `manifest-${crypto.randomUUID()}`,
      teamId,
      projectId: "P1",
      channelIds: ["C1", "C2"],
      from: "2026-07-19T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
      maximumCount: 100,
      maximumRatePerMinute: 10,
      maximumErrors: 1,
      releaseIds: ["worker:test-r1"],
      rollbackOwner: "operator:test-rollback",
      fetchImpl,
    };
    const first = await discoverAndStoreKnowledgeBackfill({
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test",
    }, input);
    expect(first).toMatchObject({
      status: "discovering",
      discovery: {
        pages: 20,
        channels: [
          { channelId: "C1", status: "pending", pageCount: 20 },
          { channelId: "C2", status: "unvisited", pageCount: 0 },
        ],
      },
    });
    expect(fetchedChannels).toEqual(Array(20).fill("C1"));

    const resumed = await discoverAndStoreKnowledgeBackfill({
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test",
    }, input);
    expect(resumed).toMatchObject({
      status: "dry_run",
      manifest: {
        manifestId: first.manifestId,
        count: 22,
        discovery: {
          status: "complete",
          pages: 22,
          channels: [
            { channelId: "C1", status: "exhausted", pageCount: 21 },
            { channelId: "C2", status: "exhausted", pageCount: 1 },
          ],
        },
      },
    });
    expect(fetchedChannels.slice(20)).toEqual(["C1", "C2"]);
  });

  it("resumes a caller-known manifest after the first Slack page fails", async () => {
    const teamId = `knowledge-discovery-first-failure-${crypto.randomUUID()}`;
    const manifestId = `manifest-${crypto.randomUUID()}`;
    const config = tenantStub(env.WORKSPACE_CONFIG, teamId);
    expect((await config.fetch(
      "https://do/putTrackedKnowledgeSource",
      {
        method: "POST",
        body: JSON.stringify({
          teamId,
          projectId: "P1",
          channelId: "C1",
          enabled: true,
          readerPolicyRef: "bundle:test-readers",
          retentionDays: 30,
        }),
      },
    )).ok).toBe(true);
    const input = {
      manifestId,
      teamId,
      projectId: "P1",
      channelIds: ["C1"],
      from: "2026-07-19T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
      maximumCount: 10,
      maximumRatePerMinute: 5,
      maximumErrors: 1,
      releaseIds: ["worker:test-r1"],
      rollbackOwner: "operator:test-rollback",
    };
    await expect(discoverAndStoreKnowledgeBackfill({
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test",
    }, {
      ...input,
      fetchImpl: async () => {
        throw new Error("simulated_first_page_transport_failure");
      },
    })).rejects.toThrow("simulated_first_page_transport_failure");

    const resumed = await discoverAndStoreKnowledgeBackfill({
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test",
    }, {
      ...input,
      fetchImpl: async () => Response.json({
        ok: true,
        messages: [{ ts: "1784422800.000100" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      }),
    });
    expect(resumed).toMatchObject({
      manifestId,
      status: "dry_run",
      manifest: {
        manifestId,
        count: 1,
        discovery: {
          status: "complete",
          channels: [
            { channelId: "C1", status: "exhausted", pageCount: 1 },
          ],
        },
      },
    });
  });

  it("permanently blocks a resumed discovery after authoritative source config drift", async () => {
    const teamId = `knowledge-discovery-drift-${crypto.randomUUID()}`;
    const config = tenantStub(env.WORKSPACE_CONFIG, teamId);
    const put = (readerPolicyRef: string) => config.fetch(
      "https://do/putTrackedKnowledgeSource",
      {
        method: "POST",
        body: JSON.stringify({
          teamId,
          projectId: "P1",
          channelId: "C1",
          enabled: true,
          readerPolicyRef,
          retentionDays: 30,
        }),
      },
    );
    expect((await put("bundle:v1")).ok).toBe(true);
    let page = 0;
    const fetchImpl = vi.fn(async () => {
      page += 1;
      return Response.json({
        ok: true,
        messages: [{ ts: `${1784422800 + page}.000100` }],
        has_more: true,
        response_metadata: { next_cursor: `page-${page + 1}` },
      });
    });
    const input = {
      manifestId: `manifest-${crypto.randomUUID()}`,
      teamId,
      projectId: "P1",
      channelIds: ["C1"],
      from: "2026-07-19T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
      maximumCount: 100,
      maximumRatePerMinute: 10,
      maximumErrors: 1,
      releaseIds: ["worker:test-r1"],
      rollbackOwner: "operator:test-rollback",
      fetchImpl,
    };
    const first = await discoverAndStoreKnowledgeBackfill({
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test",
    }, input);
    expect(first.status).toBe("discovering");
    expect((await put("bundle:v2")).ok).toBe(true);
    await expect(discoverAndStoreKnowledgeBackfill({
      ...env,
      SLACK_BOT_TOKEN: "xoxb-test",
    }, input)).rejects.toThrow("config drifted");
    const knowledge = tenantStub(env.KNOWLEDGE, teamId);
    const persisted = await knowledge.fetch(
      "https://do/backfill/discovery/get",
      {
        method: "POST",
        body: JSON.stringify({
          manifestId: first.manifestId,
          includeCandidates: false,
        }),
      },
    ).then((response) => response.json()) as {
      discovery: { status: string; blockedReason: string };
    };
    expect(persisted.discovery).toMatchObject({
      status: "blocked_config_drift",
      blockedReason: "source_config_drift",
    });
  });

  it("the Worker Queue entry retries unknown names before body parsing", async () => {
    const retry = vi.fn();
    const message = {
      id: "worker-entry-unknown",
      get body(): never {
        throw new Error("worker entry parsed an unknown Queue body");
      },
      retry,
    };
    await expect((worker as typeof worker & {
      queue(
        batch: MessageBatch<unknown>,
        bindings: Record<string, unknown>,
        ctx: ExecutionContext,
      ): Promise<void>;
    }).queue({
      queue: "arbitrary-queue",
      messages: [message],
    } as never, {
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge-dlq",
    }, {} as ExecutionContext)).rejects.toThrow("knowledge_queue_name_unknown");
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("keeps accepted Local IDs revision-bound at every descriptor interleaving boundary", async () => {
    for (const phase of [
      "before_add",
      "after_add_started",
      "after_local_accepted",
      "during_polling",
      "before_terminal",
    ] as const) {
      const teamId = `knowledge-interleave-${phase}-${crypto.randomUUID()}`;
      const stub = tenantStub(env.KNOWLEDGE, teamId);
      const original = createKnowledgeJob({
        teamId,
        projectId: "P1",
        channelId: "C1",
        threadTs: "171234.000100",
        configVersion: 3,
        requestedAt: "2026-07-19T01:00:00.000Z",
        reason: "event",
      });
      const newer = createKnowledgeJob({
        ...original,
        requestedAt: "2026-07-19T02:00:00.000Z",
      });
      const post = async <T>(path: string, body: unknown): Promise<T> =>
        stub.fetch(`https://do${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }).then((response) => response.json()) as Promise<T>;

      await post("/descriptor", original);
      if (phase === "before_add") {
        await post("/descriptor", newer);
        expect(await post("/lease", {
          job: original,
          authoritativeConfigVersion: 3,
          leaseToken: "old-before-add",
          leaseMs: 70_000,
        })).toMatchObject({ decision: "noop", reason: "stale_descriptor" });
        await post("/lease", {
          job: newer,
          authoritativeConfigVersion: 3,
          leaseToken: "new-before-add",
          leaseMs: 70_000,
        });
        expect(await post("/prepareRevision", {
          sourceKey: newer.sourceKey,
          leaseToken: "new-before-add",
          desiredRevision: "sha256:new",
        })).toEqual({ decision: "add" });
        continue;
      }

      const oldLease = `old-${phase}`;
      await post("/lease", {
        job: original,
        authoritativeConfigVersion: 3,
        leaseToken: oldLease,
        leaseMs: 70_000,
      });
      expect(await post("/prepareRevision", {
        sourceKey: original.sourceKey,
        leaseToken: oldLease,
        desiredRevision: "sha256:old",
      })).toEqual({ decision: "add" });
      if (phase !== "after_add_started") {
        expect(await post("/localAccepted", {
          sourceKey: original.sourceKey,
          leaseToken: oldLease,
          localDocumentId: `doc-${phase}`,
          desiredRevision: "sha256:old",
          workflowStatus: phase === "during_polling" ? "indexing" : "queued",
          pollDeadlineAt: Date.now() + 20_000,
          nextPollAt: Date.now(),
        })).toEqual({ recorded: true });
      }

      await post("/descriptor", newer);
      if (phase === "after_add_started") {
        expect(await post("/localAccepted", {
          sourceKey: original.sourceKey,
          leaseToken: oldLease,
          localDocumentId: `doc-${phase}`,
          desiredRevision: "sha256:old",
          workflowStatus: "queued",
          pollDeadlineAt: Date.now() + 20_000,
          nextPollAt: Date.now(),
        })).toEqual({ recorded: true });
      }
      if (phase === "during_polling" || phase === "before_terminal") {
        expect(await post("/outcome", {
          sourceKey: original.sourceKey,
          leaseToken: oldLease,
          outcome: {
            status: "indexed",
            desiredRevision: "sha256:old",
            indexedRevision: "sha256:old",
            localDocumentId: `doc-${phase}`,
            workflowStatus: "done",
            pollCount: 1,
          },
        })).toEqual({ recorded: false });
      }
      const newLease = `new-${phase}`;
      await post("/lease", {
        job: newer,
        authoritativeConfigVersion: 3,
        leaseToken: newLease,
        leaseMs: 70_000,
      });
      expect(await post("/prepareRevision", {
        sourceKey: newer.sourceKey,
        leaseToken: newLease,
        desiredRevision: "sha256:new",
      })).toEqual({
        decision: "blocked",
        reason: "unsupported_update_contract",
      });
      const state = await post<{
        ledger: { localDocumentRevision?: string; indexedRevision?: string };
      }>("/state", { sourceKey: newer.sourceKey });
      expect(state.ledger.localDocumentRevision).toBe("sha256:old");
      expect(state.ledger.indexedRevision).toBeUndefined();
    }
  });

  it("preserves manual memory rows while descriptors converge in the additive ledger", async () => {
    const teamId = `knowledge-ledger-${crypto.randomUUID()}`;
    const stub = tenantStub(env.KNOWLEDGE, teamId);
    const manual = {
      id: "manual-1",
      teamId,
      channelId: "C1",
      title: "Existing note",
      body: "must remain searchable",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    expect((await stub.fetch("https://do/write", {
      method: "POST",
      body: JSON.stringify(manual),
    })).ok).toBe(true);

    const current = createKnowledgeJob({
      teamId,
      projectId: "P1",
      channelId: "C1",
      threadTs: "171234.000100",
      configVersion: 2,
      requestedAt: "2026-07-19T02:00:00.000Z",
      reason: "event",
    });
    const accepted = await stub.fetch("https://do/descriptor", {
      method: "POST",
      body: JSON.stringify(current),
    }).then((response) => response.json()) as { accepted: boolean };
    expect(accepted.accepted).toBe(true);

    const older = { ...current, configVersion: 1, requestedAt: "2026-07-19T03:00:00.000Z" };
    const rejected = await stub.fetch("https://do/descriptor", {
      method: "POST",
      body: JSON.stringify(older),
    }).then((response) => response.json()) as { accepted: boolean; reason: string };
    expect(rejected).toEqual(expect.objectContaining({ accepted: false, reason: "out_of_order" }));

    const state = await stub.fetch("https://do/state", {
      method: "POST",
      body: JSON.stringify({ sourceKey: current.sourceKey }),
    }).then((response) => response.json()) as {
      ledger: { configVersion: number; requestedAt: string };
      outbox: { status: string };
    };
    expect(state.ledger).toMatchObject({ configVersion: 2, requestedAt: current.requestedAt });
    expect(state.outbox).toMatchObject({ status: "pending" });

    const search = await stub.fetch("https://do/search", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", query: "searchable" }),
    }).then((response) => response.json()) as Array<{ id: string }>;
    expect(search).toEqual([expect.objectContaining({ id: "manual-1" })]);
  });

  it("holds an uncommitted reconciliation page across continuation/restart", async () => {
    const teamId = `knowledge-reconcile-${crypto.randomUUID()}`;
    const stub = tenantStub(env.KNOWLEDGE, teamId);
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await stub.fetch(`https://do${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<T>;
    };
    for (const channelId of ["C1", "C2", "C3"]) {
      await post("/descriptor", createKnowledgeJob({
        teamId,
        projectId: "P1",
        channelId,
        threadTs: "171234.000100",
        configVersion: 3,
        requestedAt: "2026-07-19T01:00:00.000Z",
        reason: "event",
      }));
    }
    await post("/reconcile/start", { runId: "run-1" });
    const first = await post<{
      pageToken: string;
      rows: Array<{ sourceKey: string }>;
    }>("/reconcile/claim", { runId: "run-1", limit: 2 });
    const restarted = await post<typeof first>(
      "/reconcile/claim",
      { runId: "run-1", limit: 2 },
    );
    expect(restarted).toEqual(first);
    await post("/reconcile/commit", {
      runId: "run-1",
      pageToken: first.pageToken,
      enqueued: 0,
      skipped: 2,
    });
    const second = await post<{
      pageToken: string;
      rows: Array<{ sourceKey: string }>;
    }>("/reconcile/claim", { runId: "run-1", limit: 2 });
    expect(second.pageToken).not.toBe(first.pageToken);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.sourceKey).not.toBe(first.rows[0]!.sourceKey);
  });

  it("durably fences one scheduled reconciliation coordinator cycle", async () => {
    const stub = operatorStub(env.KNOWLEDGE, `knowledge-coordinator-${crypto.randomUUID()}`);
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await stub.fetch(`https://do${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<T>;
    };
    const claim = {
      coordinatorKey: "scheduled-reconciliation-v1",
      triggerId: "2026-07-25T12:00:00.000Z",
      scopeDigest: `sha256:${"c".repeat(64)}`,
      teamIds: ["T1"],
      cycleId: "cycle-1",
      leaseToken: "lease-1",
      leaseMs: 10_000,
    };
    expect(await post("/reconcile/coordinator/claim", claim)).toMatchObject({
      decision: "acquired",
      coordinator: {
        cycleId: "cycle-1",
        activeRunId: "cycle-1:0",
        teamIndex: 0,
      },
    });
    expect(await post("/reconcile/coordinator/claim", {
      ...claim,
      scopeDigest: `sha256:${"d".repeat(64)}`,
      teamIds: ["T2"],
      cycleId: "cycle-overlap",
      leaseToken: "lease-overlap",
    })).toMatchObject({
      decision: "busy",
      coordinator: { cycleId: "cycle-1", teamIds: ["T1"] },
    });
    expect(await post("/reconcile/coordinator/page", {
      coordinatorKey: claim.coordinatorKey,
      leaseToken: claim.leaseToken,
      leaseMs: 10_000,
    })).toMatchObject({ pageCount: 1 });
    expect(await post("/reconcile/coordinator/advance", {
      coordinatorKey: claim.coordinatorKey,
      leaseToken: claim.leaseToken,
    })).toMatchObject({
      status: "complete",
      completedTeamCount: 1,
      pageCount: 1,
    });
  });

  it("persists observable DLQ records and permits one exact replay claim", async () => {
    const stub = operatorStub(env.KNOWLEDGE, `knowledge-dlq-${crypto.randomUUID()}`);
    const post = (path: string, body: unknown) => stub.fetch(`https://do${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const body = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "171234.000100",
      configVersion: 3,
      requestedAt: "2026-07-19T01:00:00.000Z",
      reason: "event",
    });
    expect((await post("/dlq/capture", {
      messageId: "msg-1",
      queueName: "knowledge-dlq",
      body,
      sourceKey: body.sourceKey,
      teamId: body.teamId,
      attempts: 4,
      lastErrorCode: "local_timeout",
      capturedAt: "2026-07-19T02:00:00.000Z",
    })).ok).toBe(true);
    const listed = await post("/dlq/list", { cursor: 0, limit: 1 })
      .then((response) => response.json()) as {
        records: Array<{ recordId: string; status: string; lastErrorCode: string }>;
      };
    expect(listed.records).toEqual([
      expect.objectContaining({ status: "pending", lastErrorCode: "local_timeout" }),
    ]);
    const recordId = listed.records[0]!.recordId;
    expect((await post("/dlq/replay/claim", {
      recordId,
      replayReference: "incident-123-fixed",
    })).ok).toBe(true);
    expect((await post("/dlq/replay/complete", { recordId })).status).toBe(409);
    expect((await post("/dlq/replay/complete", {
      recordId,
      disposition: "accepted",
    })).ok).toBe(true);
    expect((await post("/dlq/replay/claim", {
      recordId,
      replayReference: "incident-123-fixed",
    })).status).toBe(409);

    expect((await post("/dlq/capture", {
      messageId: "msg-2",
      queueName: "knowledge-dlq",
      body,
      sourceKey: body.sourceKey,
      teamId: body.teamId,
      attempts: 4,
      capturedAt: "2026-07-19T03:00:00.000Z",
    })).ok).toBe(true);
    const second = await post("/dlq/list", { cursor: 1, limit: 1 })
      .then((response) => response.json()) as {
        records: Array<{ recordId: string }>;
      };
    const secondRecordId = second.records[0]!.recordId;
    expect((await post("/dlq/replay/claim", {
      recordId: secondRecordId,
      replayReference: "newer-event-converged",
    })).ok).toBe(true);
    const disposed = await post("/dlq/replay/complete", {
      recordId: secondRecordId,
      disposition: "superseded",
    }).then((response) => response.json()) as {
      status: string;
      replayDisposition: string;
    };
    expect(disposed).toMatchObject({
      status: "disposed",
      replayDisposition: "superseded",
    });
  });

  it("persists complete discovery, one-use external P1 evidence, and partial page dispositions", async () => {
    const teamId = `knowledge-backfill-${crypto.randomUUID()}`;
    const stub = tenantStub(env.KNOWLEDGE, teamId);
    const manifestId = "manifest-1";
    const scope: KnowledgeBackfillScope = {
      schemaVersion: 2,
      manifestId,
      teamId,
      projectId: "P1",
      channelIds: ["C1"],
      sources: [{ channelId: "C1", configVersion: 3 }],
      from: "2026-07-19T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
      executionBudget: {
        maximumCount: 2,
        maximumRatePerMinute: 2,
        maximumErrors: 1,
      },
      releaseIds: ["worker:test-r1", "local:test-r2"],
      rollbackOwner: "operator:test-rollback",
    };
    const scopeDigest = await knowledgeBackfillManifestDigest(scope);
    const candidates = [
      {
        channelId: "C1",
        threadTs: "1784422800.000100",
        observedAt: "2026-07-19T01:00:00.000Z",
      },
      {
        channelId: "C1",
        threadTs: "1784422801.000100",
        observedAt: "2026-07-19T01:00:01.000Z",
      },
    ];
    const manifest = createKnowledgeBackfillDryRun({
      manifestId,
      teamId,
      projectId: "P1",
      channelIds: ["C1"],
      from: scope.from,
      to: scope.to,
      limit: 2,
      maximumRatePerMinute: 2,
      maximumErrors: 1,
      releaseIds: scope.releaseIds,
      rollbackOwner: scope.rollbackOwner,
      dryRun: true,
      sourceConfigVersions: { C1: 3 },
    }, candidates, {
      status: "complete",
      pages: 1,
      channels: [{
        channelId: "C1",
        status: "exhausted",
        pageCount: 1,
      }],
    }).manifest;
    const manifestDigest = await knowledgeBackfillManifestDigest(manifest);
    const post = (path: string, body: unknown) => stub.fetch(`https://do${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect((await post("/backfill/discovery/start", {
      manifestId,
      scopeDigest,
      scope,
      createdAt: scope.from,
    })).ok).toBe(true);
    expect((await post("/backfill/discovery/merge", {
      manifestId,
      scopeDigest,
      channelId: "C1",
      expectedStatus: "unvisited",
      expectedCursor: null,
      nextStatus: "exhausted",
      nextCursor: null,
      candidates,
      mergedAt: "2026-07-19T01:00:02.000Z",
    })).ok).toBe(true);
    expect((await post("/backfill/manifest", {
      manifestId,
      manifestDigest: `sha256:${"0".repeat(64)}`,
      manifest,
      createdAt: scope.from,
    })).status).toBe(400);
    expect((await post("/backfill/manifest", {
      manifestId,
      manifestDigest,
      manifest: { ...manifest, count: 1 },
      createdAt: scope.from,
    })).status).toBe(400);
    expect((await post("/backfill/manifest", {
      manifestId,
      manifestDigest,
      manifest,
      createdAt: scope.from,
    })).ok).toBe(true);
    expect((await post("/descriptor", manifest.jobs[0])).status).toBe(400);
    expect((await post("/backfill/claim", {
      manifestId,
      manifestDigest,
      limit: 2,
    })).status).toBe(409);
    const adminSecret = (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET;
    const selfSupplied = await SELF.fetch(
      `https://worker/admin/knowledge/backfill/${manifestId}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          teamId,
          manifestDigest,
          approvedBy: "caller-controlled",
        }),
      },
    );
    expect(selfSupplied.status).toBe(400);
    await expect(selfSupplied.json()).resolves.toMatchObject({
      error: "knowledge_backfill_approval_request_contains_untrusted_fields",
    });
    const missingVerifier = await SELF.fetch(
      `https://worker/admin/knowledge/backfill/${manifestId}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ teamId, manifestDigest }),
      },
    );
    expect(missingVerifier.status).toBe(503);
    await expect(missingVerifier.json()).resolves.toMatchObject({
      error: "knowledge_backfill_approval_verifier_not_configured",
    });

    const artifact = await signKnowledgeBackfillApproval(
      manifest,
      manifestDigest,
      { approvalId: "approval-1" },
    );
    const approval = await verifyKnowledgeBackfillApproval(
      artifact,
      manifest,
      manifestDigest,
      {
        publicKey: TEST_KNOWLEDGE_BACKFILL_PUBLIC_KEY,
        issuer: TEST_KNOWLEDGE_BACKFILL_ISSUER,
        keyId: TEST_KNOWLEDGE_BACKFILL_KEY_ID,
      },
    );
    expect((await post("/backfill/approve", { approval })).ok).toBe(true);
    expect((await post("/backfill/approve", { approval })).status).toBe(409);

    const claimed = await post("/backfill/claim", {
      manifestId,
      manifestDigest,
      limit: 2,
    });
    if (!claimed.ok) throw new Error(await claimed.text());
    const claimedBody = await claimed.json() as {
      pendingPageToken: string;
      pendingJobs: typeof manifest.jobs;
    };
    expect(claimedBody).toMatchObject({
      status: "running",
      pendingJobs: [
        expect.objectContaining({ sourceKey: manifest.jobs[0]!.sourceKey }),
        expect.objectContaining({ sourceKey: manifest.jobs[1]!.sourceKey }),
      ],
    });
    expect((await post("/backfill/enqueue", {
      manifestId,
      manifestDigest,
      pageToken: "wrong-page",
      job: manifest.jobs[0],
    })).status).toBe(409);
    const firstResult = await post("/backfill/enqueue", {
      manifestId,
      manifestDigest,
      pageToken: claimedBody.pendingPageToken,
      job: manifest.jobs[0],
    }).then((response) => response.json()) as {
      accepted: boolean;
      descriptorKey: string;
    };
    expect(firstResult.accepted).toBe(true);
    expect((await post("/backfill/result", {
      manifestId,
      manifestDigest,
      pageToken: claimedBody.pendingPageToken,
      descriptorKey: firstResult.descriptorKey,
      disposition: "accepted",
    })).ok).toBe(true);
    expect((await post("/backfill/commit", {
      manifestId,
      manifestDigest,
      pageToken: claimedBody.pendingPageToken,
    })).status).toBe(409);
    const secondResult = await post("/backfill/enqueue", {
      manifestId,
      manifestDigest,
      pageToken: claimedBody.pendingPageToken,
      job: manifest.jobs[1],
    }).then((response) => response.json()) as {
      accepted: boolean;
      descriptorKey: string;
    };
    expect(secondResult.accepted).toBe(true);
    expect((await post("/backfill/result", {
      manifestId,
      manifestDigest,
      pageToken: claimedBody.pendingPageToken,
      descriptorKey: secondResult.descriptorKey,
      disposition: "accepted",
    })).ok).toBe(true);
    const committed = await post("/backfill/commit", {
      manifestId,
      manifestDigest,
      pageToken: claimedBody.pendingPageToken,
    }).then((response) => response.json()) as {
      status: string;
      nextJobIndex: number;
    };
    expect(committed).toMatchObject({
      status: "complete",
      nextJobIndex: 2,
    });
  });
});
