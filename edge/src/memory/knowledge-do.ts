/**
 * Longer-term knowledge store (PRODUCT.md Phase 3).
 */
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace, Queue } from "@cloudflare/workers-types";
import type { SqlExecutor } from "../store/sql.js";
import {
  KnowledgeLedger,
  type KnowledgeOutcome,
} from "./knowledge-ledger.js";
import { parseKnowledgeJob } from "./knowledge-jobs.js";
import type { KnowledgeJob } from "./knowledge-contract.js";
import {
  knowledgeBackfillManifestDigest,
  type KnowledgeBackfillCandidate,
  type KnowledgeBackfillDiscoveryChannelStatus,
  type KnowledgeBackfillManifest,
  type KnowledgeBackfillPageDisposition,
  type KnowledgeBackfillScope,
} from "./knowledge-backfill.js";
import type {
  VerifiedKnowledgeBackfillApproval,
} from "./knowledge-backfill-authorization.js";

export type KnowledgeRecord = {
  id: string;
  teamId: string;
  channelId: string | null;
  title: string;
  body: string;
  blobKey?: string;
  updatedAt: string;
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  blob_key TEXT,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge(team_id, channel_id)`,
];

type KnowledgeDOEnv = {
  /** Optional until the approved C1 Queue/DLQ binding gate. */
  KNOWLEDGE_QUEUE?: Queue<KnowledgeJob>;
};

const OUTBOX_BATCH_LIMIT = 10;
const MAX_OUTBOX_BACKOFF_MS = 5 * 60_000;
const UNBOUND_QUEUE_RETRY_MS = 60_000;

function mapRow(row: {
  id: string;
  team_id: string;
  channel_id: string;
  title: string;
  body: string;
  blob_key: string | null;
  updated_at: string;
}): KnowledgeRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    channelId: row.channel_id || null,
    title: row.title,
    body: row.body,
    blobKey: row.blob_key ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class KnowledgeDO extends DurableObject<KnowledgeDOEnv> {
  private readonly ledger: KnowledgeLedger;

  constructor(ctx: DurableObjectState, env: KnowledgeDOEnv) {
    super(ctx, env);
    const sql = this.ctx.storage.sql as unknown as SqlExecutor;
    this.ledger = new KnowledgeLedger(sql, (fn) => this.ctx.storage.transactionSync(fn));
    // Additive migration and crash recovery complete before any RPC observes
    // the legacy knowledge table or the descriptor ledger.
    void this.ctx.blockConcurrencyWhile(async () => {
      for (const statement of DDL) sql.exec(statement);
      this.ledger.migrate();
      this.ledger.recoverSending(Date.now());
      await this.armPendingOutbox();
    });
  }

  private sql(): SqlExecutor {
    return this.ctx.storage.sql as unknown as SqlExecutor;
  }

  private async armPendingOutbox(notBefore = Date.now()): Promise<void> {
    const pendingAt = this.ledger.earliestPendingAt();
    if (pendingAt === undefined) return;
    const target = Math.max(notBefore, pendingAt);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || target < current) await this.ctx.storage.setAlarm(target);
  }

  async alarm(): Promise<void> {
    for (let processed = 0; processed < OUTBOX_BATCH_LIMIT; processed += 1) {
      const now = Date.now();
      const item = this.ledger.claimDueOutbox(now);
      if (!item) break;
      if (!this.env.KNOWLEDGE_QUEUE) {
        this.ledger.markOutboxFailed(
          item,
          "knowledge_queue_binding_unavailable",
          now,
          UNBOUND_QUEUE_RETRY_MS,
        );
        break;
      }
      try {
        await this.env.KNOWLEDGE_QUEUE.send(item.job);
        this.ledger.markOutboxSent(item, Date.now());
      } catch (error) {
        const delay = Math.min(
          MAX_OUTBOX_BACKOFF_MS,
          1_000 * 2 ** Math.min(8, Math.max(0, item.attemptCount - 1)),
        );
        this.ledger.markOutboxFailed(
          item,
          error instanceof Error ? error.message : "queue_send_failed",
          Date.now(),
          delay,
        );
      }
    }
    await this.armPendingOutbox();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.sql();

    if (url.pathname === "/descriptor" && request.method === "POST") {
      try {
        const job = parseKnowledgeJob(await request.json());
        if (job.reason === "backfill") {
          throw new Error("backfill descriptors require approved manifest execution");
        }
        const result = this.ledger.enqueue(job, Date.now());
        if (result.accepted) await this.armPendingOutbox(Date.now() + 2_000);
        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid knowledge descriptor" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/lease" && request.method === "POST") {
      try {
        const body = await request.json() as {
          job: unknown;
          authoritativeConfigVersion: number;
          leaseToken: string;
          leaseMs?: number;
        };
        const job = parseKnowledgeJob(body.job);
        if (!Number.isSafeInteger(body.authoritativeConfigVersion) || body.authoritativeConfigVersion < 1) {
          throw new Error("authoritativeConfigVersion is invalid");
        }
        if (!body.leaseToken) throw new Error("leaseToken is required");
        return Response.json(this.ledger.acquireLease(
          job,
          body.authoritativeConfigVersion,
          body.leaseToken,
          Date.now(),
          Math.min(5 * 60_000, Math.max(1_000, body.leaseMs ?? 60_000)),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid knowledge lease" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/outcome" && request.method === "POST") {
      const body = await request.json() as {
        sourceKey?: string;
        leaseToken?: string;
        outcome?: KnowledgeOutcome;
      };
      if (!body.sourceKey || !body.leaseToken || !body.outcome) {
        return Response.json({ error: "invalid knowledge outcome" }, { status: 400 });
      }
      const recorded = this.ledger.recordOutcome(
        body.sourceKey,
        body.leaseToken,
        body.outcome,
        Date.now(),
      );
      return Response.json({ recorded });
    }

    if (url.pathname === "/prepareRevision" && request.method === "POST") {
      try {
        const body = await request.json() as { sourceKey?: string; leaseToken?: string; desiredRevision?: string };
        if (!body.sourceKey || !body.leaseToken || !body.desiredRevision) throw new Error("invalid revision preparation");
        return Response.json(this.ledger.prepareRevision(body.sourceKey, body.leaseToken, body.desiredRevision, Date.now()));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "invalid revision preparation" }, { status: 400 });
      }
    }

    if (url.pathname === "/localAccepted" && request.method === "POST") {
      try {
        const body = await request.json() as {
          sourceKey?: string;
          leaseToken?: string;
          localDocumentId?: string;
          desiredRevision?: string;
          workflowStatus?: string;
          pollDeadlineAt?: number;
          nextPollAt?: number;
        };
        if (!body.sourceKey || !body.leaseToken || !body.localDocumentId || !body.desiredRevision || !body.workflowStatus ||
          !Number.isFinite(body.pollDeadlineAt) || !Number.isFinite(body.nextPollAt)) {
          throw new Error("invalid Local acceptance");
        }
        return Response.json({ recorded: this.ledger.recordLocalAccepted({
          sourceKey: body.sourceKey,
          leaseToken: body.leaseToken,
          localDocumentId: body.localDocumentId,
          desiredRevision: body.desiredRevision,
          workflowStatus: body.workflowStatus,
          pollDeadlineAt: body.pollDeadlineAt!,
          nextPollAt: body.nextPollAt!,
        }, Date.now()) });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "invalid Local acceptance" }, { status: 400 });
      }
    }

    if (url.pathname === "/stale" && request.method === "POST") {
      try {
        const body = await request.json() as { job: unknown };
        this.ledger.markStale(parseKnowledgeJob(body.job), Date.now());
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid stale descriptor" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/reconcile/start" && request.method === "POST") {
      try {
        const body = await request.json() as { runId?: string };
        return Response.json(this.ledger.startReconcileRun(body.runId ?? "", Date.now()));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile run" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/reconcile/claim" && request.method === "POST") {
      try {
        const body = await request.json() as { runId?: string; limit?: number };
        return Response.json(this.ledger.claimReconcilePage(
          body.runId ?? "",
          body.limit ?? 25,
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile page claim" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/reconcile/commit" && request.method === "POST") {
      try {
        const body = await request.json() as {
          runId?: string;
          pageToken?: string;
          enqueued?: number;
          skipped?: number;
        };
        return Response.json(this.ledger.commitReconcilePage(
          body.runId ?? "",
          body.pageToken ?? "",
          { enqueued: body.enqueued ?? -1, skipped: body.skipped ?? -1 },
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile page commit" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/reconcile/coordinator/claim" && request.method === "POST") {
      try {
        const body = await request.json() as {
          coordinatorKey?: string;
          triggerId?: string;
          scopeDigest?: string;
          teamIds?: string[];
          cycleId?: string;
          leaseToken?: string;
          leaseMs?: number;
        };
        return Response.json(this.ledger.claimReconcileCoordinator({
          coordinatorKey: body.coordinatorKey ?? "",
          triggerId: body.triggerId ?? "",
          scopeDigest: body.scopeDigest ?? "",
          teamIds: body.teamIds ?? [],
          cycleId: body.cycleId ?? "",
          leaseToken: body.leaseToken ?? "",
          leaseMs: body.leaseMs ?? 0,
        }, Date.now()));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile coordinator claim" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/reconcile/coordinator/page" && request.method === "POST") {
      try {
        const body = await request.json() as {
          coordinatorKey?: string;
          leaseToken?: string;
          leaseMs?: number;
        };
        return Response.json(this.ledger.checkpointReconcileCoordinatorPage(
          body.coordinatorKey ?? "",
          body.leaseToken ?? "",
          body.leaseMs ?? 0,
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile coordinator page" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/reconcile/coordinator/advance" && request.method === "POST") {
      try {
        const body = await request.json() as {
          coordinatorKey?: string;
          leaseToken?: string;
        };
        return Response.json(this.ledger.advanceReconcileCoordinatorTeam(
          body.coordinatorKey ?? "",
          body.leaseToken ?? "",
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile coordinator advance" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/reconcile/coordinator/release" && request.method === "POST") {
      try {
        const body = await request.json() as {
          coordinatorKey?: string;
          leaseToken?: string;
        };
        return Response.json(this.ledger.releaseReconcileCoordinator(
          body.coordinatorKey ?? "",
          body.leaseToken ?? "",
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile coordinator release" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/reconcile/coordinator/fail" && request.method === "POST") {
      try {
        const body = await request.json() as {
          coordinatorKey?: string;
          leaseToken?: string;
          errorCode?: string;
          retryAt?: number;
        };
        return Response.json(this.ledger.failReconcileCoordinator(
          body.coordinatorKey ?? "",
          body.leaseToken ?? "",
          body.errorCode ?? "",
          body.retryAt ?? 0,
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid reconcile coordinator failure" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/dlq/capture" && request.method === "POST") {
      try {
        return Response.json(this.ledger.captureDlqRecord(await request.json() as {
          messageId: string;
          queueName: string;
          body: unknown;
          sourceKey?: string;
          teamId?: string;
          attempts: number;
          lastErrorCode?: string;
          capturedAt: string;
        }));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid DLQ record" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/dlq/list" && request.method === "POST") {
      try {
        const body = await request.json() as { cursor?: number; limit?: number };
        return Response.json(this.ledger.listDlqRecords(body.cursor ?? 0, body.limit ?? 25));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid DLQ inspection" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/dlq/get" && request.method === "POST") {
      try {
        const body = await request.json() as { recordId?: string };
        return Response.json({ record: this.ledger.getDlqRecord(body.recordId ?? "") ?? null });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid DLQ record lookup" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/dlq/replay/claim" && request.method === "POST") {
      try {
        const body = await request.json() as {
          recordId?: string;
          replayReference?: string;
        };
        return Response.json(this.ledger.claimDlqReplay(
          body.recordId ?? "",
          body.replayReference ?? "",
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid DLQ replay claim" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/dlq/replay/release" && request.method === "POST") {
      try {
        const body = await request.json() as { recordId?: string };
        this.ledger.releaseDlqReplay(body.recordId ?? "", Date.now());
        return Response.json({ released: true });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid DLQ replay release" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/dlq/replay/complete" && request.method === "POST") {
      try {
        const body = await request.json() as {
          recordId?: string;
          disposition?: Parameters<KnowledgeLedger["completeDlqReplay"]>[1];
        };
        if (!body.disposition) throw new Error("DLQ replay disposition is required");
        return Response.json(this.ledger.completeDlqReplay(
          body.recordId ?? "",
          body.disposition,
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid DLQ replay completion" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/discovery/start" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          scopeDigest?: string;
          scope?: KnowledgeBackfillScope;
          createdAt?: string;
        };
        const digest = await knowledgeBackfillManifestDigest(body.scope);
        if (digest !== body.scopeDigest) {
          throw new Error("backfill discovery scope digest mismatch");
        }
        return Response.json(this.ledger.startBackfillDiscovery({
          manifestId: body.manifestId ?? "",
          scopeDigest: digest,
          scope: body.scope as KnowledgeBackfillScope,
          createdAt: body.createdAt ?? "",
        }));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill discovery start" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/discovery/get" && request.method === "POST") {
      const body = await request.json() as {
        manifestId?: string;
        includeCandidates?: boolean;
      };
      return Response.json({
        discovery: body.manifestId
          ? this.ledger.getBackfillDiscovery(
            body.manifestId,
            body.includeCandidates === true,
          ) ?? null
          : null,
      });
    }

    if (url.pathname === "/backfill/discovery/merge" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          scopeDigest?: string;
          channelId?: string;
          expectedStatus?: KnowledgeBackfillDiscoveryChannelStatus;
          expectedCursor?: string | null;
          nextStatus?: KnowledgeBackfillDiscoveryChannelStatus;
          nextCursor?: string | null;
          candidates?: KnowledgeBackfillCandidate[];
          mergedAt?: string;
        };
        return Response.json(this.ledger.mergeBackfillDiscoveryPage({
          manifestId: body.manifestId ?? "",
          scopeDigest: body.scopeDigest ?? "",
          channelId: body.channelId ?? "",
          expectedStatus: body.expectedStatus as "unvisited" | "pending",
          expectedCursor: body.expectedCursor ?? null,
          nextStatus: body.nextStatus as "pending" | "exhausted",
          nextCursor: body.nextCursor ?? null,
          candidates: Array.isArray(body.candidates) ? body.candidates : [],
          mergedAt: body.mergedAt ?? "",
        }));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill discovery page" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/discovery/block" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          scopeDigest?: string;
          reason?: string;
        };
        return Response.json(this.ledger.blockBackfillDiscovery(
          body.manifestId ?? "",
          body.scopeDigest ?? "",
          body.reason ?? "",
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill discovery block" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/manifest" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          manifestDigest?: string;
          manifest?: KnowledgeBackfillManifest;
          createdAt?: string;
        };
        const digest = await knowledgeBackfillManifestDigest(body.manifest);
        if (digest !== body.manifestDigest) throw new Error("backfill manifest digest mismatch");
        return Response.json(this.ledger.putBackfillManifest({
          manifestId: body.manifestId ?? "",
          manifestDigest: digest,
          manifest: body.manifest as KnowledgeBackfillManifest,
          createdAt: body.createdAt ?? "",
        }));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill manifest" },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/backfill/get" && request.method === "POST") {
      const body = await request.json() as { manifestId?: string };
      return Response.json({
        manifest: body.manifestId
          ? this.ledger.getBackfillManifest(body.manifestId) ?? null
          : null,
      });
    }

    if (url.pathname === "/backfill/approve" && request.method === "POST") {
      try {
        const body = await request.json() as {
          approval?: VerifiedKnowledgeBackfillApproval;
        };
        const approval = body.approval;
        if (
          !approval ||
          approval.version !== 1 ||
          approval.gate !== "P1" ||
          approval.approverKind !== "human" ||
          !approval.approvalId ||
          !/^sha256:[a-f0-9]{64}$/.test(approval.artifactDigest) ||
          !/^sha256:[a-f0-9]{64}$/.test(approval.manifestDigest)
        ) {
          throw new Error("verified backfill approval evidence is invalid");
        }
        const stored = this.ledger.getBackfillManifest(approval.manifestId);
        if (!stored) throw new Error("backfill manifest does not exist");
        const storedDigest = await knowledgeBackfillManifestDigest(stored.manifest);
        if (
          storedDigest !== stored.manifestDigest ||
          storedDigest !== approval.manifestDigest
        ) {
          throw new Error("backfill manifest digest mismatch");
        }
        return Response.json(
          this.ledger.approveBackfillManifest(approval, Date.now()),
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill approval" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/claim" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          manifestDigest?: string;
          limit?: number;
        };
        const stored = this.ledger.getBackfillManifest(body.manifestId ?? "");
        if (!stored) throw new Error("backfill manifest does not exist");
        const storedDigest = await knowledgeBackfillManifestDigest(stored.manifest);
        if (storedDigest !== stored.manifestDigest || storedDigest !== body.manifestDigest) {
          throw new Error("backfill manifest digest mismatch");
        }
        return Response.json(this.ledger.claimBackfillPage(
          body.manifestId ?? "",
          body.manifestDigest ?? "",
          body.limit ?? 10,
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill page claim" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/enqueue" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          manifestDigest?: string;
          pageToken?: string;
          job?: unknown;
        };
        const job = parseKnowledgeJob(body.job);
        if (job.reason !== "backfill") throw new Error("approved manifest may enqueue only backfill jobs");
        const stored = this.ledger.getBackfillManifest(body.manifestId ?? "");
        const manifestJobs = (stored?.manifest as { jobs?: unknown } | undefined)?.jobs;
        if (
          !stored ||
          stored.manifestDigest !== body.manifestDigest ||
          stored.approvalGate !== "P1" ||
          !stored.approvalReference ||
          stored.pendingPageToken !== body.pageToken ||
          !Array.isArray(manifestJobs) ||
          !manifestJobs.some((candidate) =>
            JSON.stringify(candidate) === JSON.stringify(job)) ||
          !stored.pendingJobs?.some((candidate) =>
            JSON.stringify(candidate) === JSON.stringify(job))
        ) {
          throw new Error("backfill job is not in the current approved manifest page");
        }
        const storedDigest = await knowledgeBackfillManifestDigest(stored.manifest);
        if (storedDigest !== stored.manifestDigest) {
          throw new Error("backfill manifest digest mismatch");
        }
        this.ledger.assertBackfillApprovalActive(
          body.manifestId ?? "",
          body.manifestDigest ?? "",
          Date.now(),
        );
        const result = this.ledger.enqueue(job, Date.now());
        if (result.accepted) await this.armPendingOutbox(Date.now() + 2_000);
        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid approved backfill job" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/result" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          manifestDigest?: string;
          pageToken?: string;
          descriptorKey?: string;
          disposition?: KnowledgeBackfillPageDisposition;
        };
        return Response.json(this.ledger.recordBackfillJobDisposition({
          manifestId: body.manifestId ?? "",
          manifestDigest: body.manifestDigest ?? "",
          pageToken: body.pageToken ?? "",
          descriptorKey: body.descriptorKey ?? "",
          disposition: body.disposition as KnowledgeBackfillPageDisposition,
        }, Date.now()));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill job result" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/fail" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          manifestDigest?: string;
          pageToken?: string;
          descriptorKey?: string;
          errorCode?: string;
        };
        return Response.json(this.ledger.recordBackfillPageFailure({
          manifestId: body.manifestId ?? "",
          manifestDigest: body.manifestDigest ?? "",
          pageToken: body.pageToken ?? "",
          descriptorKey: body.descriptorKey ?? "",
          errorCode: body.errorCode ?? "",
        }, Date.now()));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill page failure" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/backfill/commit" && request.method === "POST") {
      try {
        const body = await request.json() as {
          manifestId?: string;
          manifestDigest?: string;
          pageToken?: string;
        };
        return Response.json(this.ledger.commitBackfillPage(
          body.manifestId ?? "",
          body.manifestDigest ?? "",
          body.pageToken ?? "",
          Date.now(),
        ));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid backfill page commit" },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/state" && request.method === "POST") {
      const body = await request.json() as { sourceKey?: string };
      if (!body.sourceKey) return Response.json({ error: "sourceKey is required" }, { status: 400 });
      return Response.json({
        ledger: this.ledger.get(body.sourceKey) ?? null,
        outbox: this.ledger.getOutbox(body.sourceKey) ?? null,
      });
    }

    if (url.pathname === "/write" && request.method === "POST") {
      const rec = (await request.json()) as KnowledgeRecord;
      const id = rec.id || crypto.randomUUID();
      const updatedAt = rec.updatedAt || new Date().toISOString();
      sql.exec(
        `INSERT INTO knowledge (id, team_id, channel_id, title, body, blob_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           blob_key = excluded.blob_key,
           updated_at = excluded.updated_at`,
        id,
        rec.teamId,
        rec.channelId ?? "",
        rec.title,
        rec.body,
        rec.blobKey ?? null,
        updatedAt,
      );
      return Response.json({ ...rec, id, updatedAt });
    }

    if (url.pathname === "/search" && request.method === "POST") {
      const body = (await request.json()) as {
        teamId: string;
        channelId?: string | null;
        query: string;
        limit?: number;
      };
      const limit = body.limit ?? 10;
      const q = `%${body.query.toLowerCase()}%`;
      const rows = sql
        .exec<{
          id: string;
          team_id: string;
          channel_id: string;
          title: string;
          body: string;
          blob_key: string | null;
          updated_at: string;
        }>(
          `SELECT * FROM knowledge
           WHERE team_id = ?
             AND (channel_id = '' OR channel_id = ?)
             AND (lower(title) LIKE ? OR lower(body) LIKE ?)
           ORDER BY updated_at DESC
           LIMIT ?`,
          body.teamId,
          body.channelId ?? "",
          q,
          q,
          limit,
        )
        .toArray();
      return Response.json(rows.map(mapRow));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function memorySearch(
  ns: DurableObjectNamespace<KnowledgeDO>,
  teamId: string,
  channelId: string | undefined,
  query: string,
  limit = 10,
): Promise<KnowledgeRecord[]> {
  const stub = ns.get(ns.idFromName(teamId));
  return stub
    .fetch("https://do/search", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: channelId ?? null, query, limit }),
    })
    .then((r) => r.json()) as Promise<KnowledgeRecord[]>;
}

export async function memoryWrite(
  ns: DurableObjectNamespace<KnowledgeDO>,
  record: KnowledgeRecord,
): Promise<KnowledgeRecord> {
  const stub = ns.get(ns.idFromName(record.teamId));
  return stub
    .fetch("https://do/write", {
      method: "POST",
      body: JSON.stringify(record),
    })
    .then((r) => r.json()) as Promise<KnowledgeRecord>;
}
