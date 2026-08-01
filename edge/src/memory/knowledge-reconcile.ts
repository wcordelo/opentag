import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  createKnowledgeJob,
  slackSourceKey,
  type KnowledgeJob,
} from "./knowledge-contract.js";
import { parseKnowledgeJob } from "./knowledge-jobs.js";
import type { KnowledgeDO } from "./knowledge-do.js";
import {
  knowledgeDescriptorKey,
  type EnqueueKnowledgeResult,
  type KnowledgeDlqReplayDisposition,
  type KnowledgeLedgerRow,
  type KnowledgeReconcileCoordinator,
  type KnowledgeReconcileCoordinatorClaim,
} from "./knowledge-ledger.js";
import type { WorkspaceConfigDO } from "../config/workspace-config-do.js";
import {
  isTrackedKnowledgeSourceEnabled,
  type TrackedKnowledgeSource,
} from "../config/knowledge-config.js";
import { routeKnowledgeQueueName } from "./knowledge-queue-routing.js";
import { operatorStub, tenantStub } from "../tenancy.js";

export const KNOWLEDGE_OPERATOR_DO_KEY = "knowledge-operator-control-v1";

export type ReconcileSource = {
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  configVersion: number;
  enabled: boolean;
  desiredRevision?: string;
  indexedRevision?: string;
  localDocumentId?: string;
  status: string;
  incompleteReason?: string;
  tombstonedAt?: string;
  leaseExpiresAt?: number;
};

export type ReconcileAction =
  | { action: "noop"; sourceKey: string; reason: "converged" | "lease_active" | "awaiting_queue" }
  | { action: "resume_poll"; sourceKey: string; localDocumentId: string }
  | { action: "retry_fetch"; sourceKey: string; reason: string }
  | { action: "enqueue"; sourceKey: string; job: KnowledgeJob }
  | { action: "blocked"; sourceKey: string; reason: "unsupported_update_contract" | "unsupported_delete_contract" | "permanent_failure" };

/** Deterministic one-source plan. Tombstones always win and can never enqueue. */
export function planKnowledgeReconciliation(
  source: ReconcileSource,
  requestedAt: string,
  nowMs = Date.now(),
): ReconcileAction {
  const sourceKey = slackSourceKey(source.teamId, source.channelId, source.threadTs);
  const canonicalJob = createKnowledgeJob({
    teamId: source.teamId,
    projectId: source.projectId,
    channelId: source.channelId,
    threadTs: source.threadTs,
    configVersion: source.configVersion,
    requestedAt,
    reason: "reconcile",
  });
  if (source.tombstonedAt || !source.enabled) {
    return { action: "blocked", sourceKey, reason: "unsupported_delete_contract" };
  }
  if (source.status === "permanent_failure") {
    return { action: "blocked", sourceKey, reason: "permanent_failure" };
  }
  if (
    ["leased", "fetching", "writing", "polling"].includes(source.status) &&
    (source.leaseExpiresAt ?? 0) > nowMs
  ) {
    return { action: "noop", sourceKey, reason: "lease_active" };
  }
  if (
    source.localDocumentId &&
    source.desiredRevision &&
    source.desiredRevision !== source.indexedRevision
  ) {
    if (
      source.status === "processing_unconfirmed" ||
      source.status === "polling" ||
      source.status === "writing" ||
      ((source.leaseExpiresAt ?? 0) <= nowMs && source.status === "leased")
    ) {
      return { action: "resume_poll", sourceKey, localDocumentId: source.localDocumentId };
    }
    if (source.indexedRevision) {
      return { action: "blocked", sourceKey, reason: "unsupported_update_contract" };
    }
  }
  if (source.status === "incomplete" || source.incompleteReason) {
    return {
      action: "retry_fetch",
      sourceKey,
      reason: source.incompleteReason ?? "incomplete_thread",
    };
  }
  if (source.indexedRevision && source.indexedRevision === source.desiredRevision) {
    return { action: "noop", sourceKey, reason: "converged" };
  }
  if (source.status === "pending" || source.status === "queued") {
    return { action: "noop", sourceKey, reason: "awaiting_queue" };
  }
  return {
    action: "enqueue",
    sourceKey,
    job: canonicalJob,
  };
}

type KnowledgeOperationsEnv = {
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
};

async function doRequest<T>(
  namespace: DurableObjectNamespace<any>,
  objectName: string,
  path: string,
  body: unknown,
): Promise<T> {
  const tenantNamespace = namespace as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
  };
  const stub = objectName === KNOWLEDGE_OPERATOR_DO_KEY
    ? operatorStub(tenantNamespace, objectName)
    : tenantStub(tenantNamespace, objectName);
  const response = await stub.fetch(`https://do${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${path.replaceAll("/", "_")}_http_${response.status}:${detail.slice(0, 256)}`);
  }
  return response.json() as Promise<T>;
}

async function loadAuthoritativeSource(
  env: KnowledgeOperationsEnv,
  row: Pick<KnowledgeLedgerRow, "teamId" | "projectId" | "channelId">,
): Promise<TrackedKnowledgeSource | undefined> {
  const source = await doRequest<TrackedKnowledgeSource>(
    env.WORKSPACE_CONFIG,
    row.teamId,
    "/getTrackedKnowledgeSource",
    { teamId: row.teamId, projectId: row.projectId, channelId: row.channelId },
  );
  if (
    !isTrackedKnowledgeSourceEnabled(source) ||
    source.teamId !== row.teamId ||
    source.projectId !== row.projectId ||
    source.channelId !== row.channelId
  ) {
    return undefined;
  }
  return source;
}

type KnowledgeDescriptorState = {
  ledger: KnowledgeLedgerRow | null;
  outbox: {
    descriptorKey: string;
    job: KnowledgeJob;
    status: string;
    attemptCount: number;
    lastError?: string;
  } | null;
};

export type KnowledgeDescriptorDisposition =
  | "accepted"
  | "accepted_response_lost"
  | "duplicate"
  | "converged"
  | "superseded";

function isEnqueueKnowledgeResult(value: unknown): value is EnqueueKnowledgeResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<EnqueueKnowledgeResult>;
  return typeof result.accepted === "boolean" &&
    typeof result.descriptorKey === "string" &&
    ["new", "superseded", "duplicate", "out_of_order"].includes(result.reason ?? "");
}

function sameLedgerIdentity(ledger: KnowledgeLedgerRow, job: KnowledgeJob): boolean {
  return ledger.sourceKey === job.sourceKey &&
    ledger.teamId === job.teamId &&
    ledger.projectId === job.projectId &&
    ledger.channelId === job.channelId &&
    ledger.threadTs === job.threadTs;
}

export async function proveKnowledgeDescriptorDisposition(
  env: KnowledgeOperationsEnv,
  job: KnowledgeJob,
  responseLost: boolean,
): Promise<KnowledgeDescriptorDisposition | undefined> {
  const state = await doRequest<KnowledgeDescriptorState>(
    env.KNOWLEDGE,
    job.teamId,
    "/state",
    { sourceKey: job.sourceKey },
  );
  const ledger = state.ledger;
  if (!ledger || !sameLedgerIdentity(ledger, job)) return undefined;
  const source = await loadAuthoritativeSource(env, ledger);
  if (!source || source.configVersion !== ledger.configVersion) return undefined;

  const exactDescriptor = ledger.configVersion === job.configVersion &&
    ledger.requestedAt === job.requestedAt;
  if (
    ledger.status === "indexed" &&
    ledger.desiredRevision &&
    ledger.desiredRevision === ledger.indexedRevision &&
    ledger.configVersion >= job.configVersion &&
    ledger.requestedAt >= job.requestedAt
  ) {
    return "converged";
  }
  if (exactDescriptor) {
    if (
      responseLost &&
      (
        state.outbox?.descriptorKey === knowledgeDescriptorKey(job) ||
        ledger.status !== "pending"
      )
    ) {
      return "accepted_response_lost";
    }
    return "duplicate";
  }
  if (
    ledger.configVersion > job.configVersion ||
    (ledger.configVersion === job.configVersion && ledger.requestedAt > job.requestedAt)
  ) {
    return "superseded";
  }
  return undefined;
}

/**
 * A 2xx descriptor response is transport success only. Recovery state may
 * advance only after application acceptance or an authoritative ledger proof.
 */
export async function submitKnowledgeDescriptor(
  env: KnowledgeOperationsEnv,
  job: KnowledgeJob,
): Promise<{ disposition: KnowledgeDescriptorDisposition; enqueued: boolean }> {
  let result: unknown;
  try {
    result = await doRequest<unknown>(
      env.KNOWLEDGE,
      job.teamId,
      "/descriptor",
      job,
    );
  } catch (error) {
    const disposition = await proveKnowledgeDescriptorDisposition(env, job, true).catch(() => undefined);
    if (disposition) {
      return {
        disposition,
        enqueued: false,
      };
    }
    throw error;
  }
  if (!isEnqueueKnowledgeResult(result)) {
    throw new Error("knowledge_descriptor_result_malformed");
  }
  if (result.accepted) {
    return { disposition: "accepted", enqueued: true };
  }
  const disposition = await proveKnowledgeDescriptorDisposition(env, job, false);
  if (disposition) return { disposition, enqueued: false };
  throw new Error(`knowledge_descriptor_rejected_${result.reason}`);
}

function stableReconcileRequestedAt(
  runCreatedAt: string,
  rowRequestedAt: string,
): string {
  return new Date(Math.max(
    Date.parse(runCreatedAt),
    Date.parse(rowRequestedAt) + 1,
  )).toISOString();
}

/**
 * Executes one restart-safe reconciliation page. The KnowledgeDO does not
 * advance its durable cursor until every exact row has been checked against
 * the current WorkspaceConfigDO and every selected descriptor is durably
 * accepted. A crash returns the same claimed page on the next call.
 */
export async function runKnowledgeReconciliationPage(
  env: KnowledgeOperationsEnv,
  input: { teamId: string; runId?: string; limit?: number },
): Promise<{
  runId: string;
  status: "running" | "complete";
  cursor?: string;
  scannedCount: number;
  enqueuedCount: number;
  skippedCount: number;
  createdAt: string;
  updatedAt: string;
  pageScannedCount: number;
  oldestRowUpdatedAt?: string;
  descriptorDispositions: Partial<Record<KnowledgeDescriptorDisposition, number>>;
}> {
  if (!input.teamId || input.teamId.length > 256 || /[*?]/.test(input.teamId)) {
    throw new Error("one exact teamId is required for reconciliation");
  }
  const runId = input.runId ?? crypto.randomUUID();
  await doRequest(
    env.KNOWLEDGE,
    input.teamId,
    "/reconcile/start",
    { runId },
  );
  const page = await doRequest<{
    run: {
      status: "running" | "complete";
      cursor?: string;
      createdAt: string;
      updatedAt: string;
      scannedCount: number;
      enqueuedCount: number;
      skippedCount: number;
    };
    pageToken?: string;
    rows: KnowledgeLedgerRow[];
  }>(
    env.KNOWLEDGE,
    input.teamId,
    "/reconcile/claim",
    { runId, limit: input.limit ?? 25 },
  );
  if (!page.pageToken || page.rows.length === 0) {
    return {
      runId,
      ...page.run,
      pageScannedCount: 0,
      descriptorDispositions: {},
    };
  }

  let enqueued = 0;
  let skipped = 0;
  const descriptorDispositions: Partial<Record<KnowledgeDescriptorDisposition, number>> = {};
  for (const row of page.rows) {
    const source = await loadAuthoritativeSource(env, row);
    if (!source) {
      skipped += 1;
      continue;
    }
    const requestedAt = stableReconcileRequestedAt(page.run.createdAt, row.requestedAt);
    const action = planKnowledgeReconciliation({
      ...row,
      configVersion: source.configVersion,
      enabled: source.enabled,
    }, requestedAt);
    if (action.action === "noop" || action.action === "blocked") {
      skipped += 1;
      continue;
    }
    const job = action.action === "enqueue"
      ? action.job
      : createKnowledgeJob({
        teamId: row.teamId,
        projectId: row.projectId,
        channelId: row.channelId,
        threadTs: row.threadTs,
        configVersion: source.configVersion,
        requestedAt,
        reason: "reconcile",
      });
    const submitted = await submitKnowledgeDescriptor(env, job);
    descriptorDispositions[submitted.disposition] =
      (descriptorDispositions[submitted.disposition] ?? 0) + 1;
    if (submitted.enqueued) enqueued += 1;
    else skipped += 1;
  }
  const committed = await doRequest<{
    status: "running" | "complete";
    cursor?: string;
    scannedCount: number;
    enqueuedCount: number;
    skippedCount: number;
    createdAt: string;
    updatedAt: string;
  }>(
    env.KNOWLEDGE,
    input.teamId,
    "/reconcile/commit",
    { runId, pageToken: page.pageToken, enqueued, skipped },
  );
  return {
    runId,
    ...committed,
    pageScannedCount: page.rows.length,
    oldestRowUpdatedAt: page.rows
      .map((row) => row.updatedAt)
      .sort()[0],
    descriptorDispositions,
  };
}

export const KNOWLEDGE_RECONCILE_COORDINATOR_KEY = "scheduled-reconciliation-v1";
export const KNOWLEDGE_RECONCILE_SCHEDULER_LIMITS = Object.freeze({
  pageSize: 25,
  maxPagesPerInvocation: 8,
  maxTeamsPerInvocation: 4,
  leaseMs: 5 * 60_000,
  initialBackoffMs: 30_000,
  maxBackoffMs: 60 * 60_000,
});

type ScheduledKnowledgeOperationsEnv = KnowledgeOperationsEnv & {
  KNOWLEDGE_QUEUE?: unknown;
  KNOWLEDGE_QUEUE_NAME?: string;
  KNOWLEDGE_DLQ_NAME?: string;
  KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED?: string;
  KNOWLEDGE_RECONCILIATION_TEAM_IDS?: string;
};

export function parseKnowledgeReconciliationTeamScope(value: string | undefined): string[] {
  if (!value) throw new Error("knowledge_reconciliation_team_scope_missing");
  const raw = value.split(",");
  const teamIds = raw.map((teamId) => teamId.trim());
  if (
    teamIds.length < 1 ||
    teamIds.length > 100 ||
    teamIds.some((teamId) =>
      !teamId || teamId.length > 128 || /[:*?\s\u0000-\u001f\u007f]/.test(teamId)
    ) ||
    new Set(teamIds).size !== teamIds.length
  ) {
    throw new Error("knowledge_reconciliation_team_scope_invalid");
  }
  return teamIds;
}

async function knowledgeTeamScopeDigest(teamIds: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(teamIds));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function reconciliationMetric(metric: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ metric, ...fields }));
}

export async function runScheduledKnowledgeReconciliation(
  env: ScheduledKnowledgeOperationsEnv,
  input: {
    scheduledAt: string;
    now?: () => number;
    limits?: Partial<typeof KNOWLEDGE_RECONCILE_SCHEDULER_LIMITS>;
  },
): Promise<{
  status: "disabled" | "busy" | "backoff" | "running" | "complete";
  cycleId?: string;
  pagesProcessed: number;
  teamsCompleted: number;
  nextAttemptAt?: number;
}> {
  if (env.KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED !== "true") {
    return { status: "disabled", pagesProcessed: 0, teamsCompleted: 0 };
  }
  if (!env.KNOWLEDGE_QUEUE) {
    throw new Error("knowledge_reconciliation_requires_c1_queue_binding");
  }
  routeKnowledgeQueueName(env.KNOWLEDGE_QUEUE_NAME ?? "", env);
  const teamIds = parseKnowledgeReconciliationTeamScope(
    env.KNOWLEDGE_RECONCILIATION_TEAM_IDS,
  );
  if (
    !Number.isFinite(Date.parse(input.scheduledAt)) ||
    new Date(Date.parse(input.scheduledAt)).toISOString() !== input.scheduledAt
  ) {
    throw new Error("knowledge_reconciliation_scheduled_at_invalid");
  }
  const limits = {
    ...KNOWLEDGE_RECONCILE_SCHEDULER_LIMITS,
    ...input.limits,
  };
  if (
    !Number.isSafeInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > 100 ||
    !Number.isSafeInteger(limits.maxPagesPerInvocation) ||
    limits.maxPagesPerInvocation < 1 || limits.maxPagesPerInvocation > 32 ||
    !Number.isSafeInteger(limits.maxTeamsPerInvocation) ||
    limits.maxTeamsPerInvocation < 1 || limits.maxTeamsPerInvocation > 16 ||
    !Number.isSafeInteger(limits.leaseMs) ||
    limits.leaseMs < 10_000 || limits.leaseMs > 15 * 60_000
  ) {
    throw new Error("knowledge_reconciliation_scheduler_limits_invalid");
  }
  const now = input.now ?? Date.now;
  const scopeDigest = await knowledgeTeamScopeDigest(teamIds);
  const leaseToken = crypto.randomUUID();
  const claim = await doRequest<KnowledgeReconcileCoordinatorClaim>(
    env.KNOWLEDGE,
    KNOWLEDGE_OPERATOR_DO_KEY,
    "/reconcile/coordinator/claim",
    {
      coordinatorKey: KNOWLEDGE_RECONCILE_COORDINATOR_KEY,
      triggerId: input.scheduledAt,
      scopeDigest,
      teamIds,
      cycleId: crypto.randomUUID(),
      leaseToken,
      leaseMs: limits.leaseMs,
    },
  );
  if (claim.decision !== "acquired") {
    reconciliationMetric(`knowledge_reconcile_scheduler_${claim.decision}`, {
      cycleId: claim.coordinator.cycleId,
      scopeDigest,
      teamCount: teamIds.length,
      nextAttemptAt: claim.coordinator.nextAttemptAt,
    });
    return {
      status: claim.decision,
      cycleId: claim.coordinator.cycleId,
      pagesProcessed: 0,
      teamsCompleted: 0,
      ...(claim.decision === "backoff"
        ? { nextAttemptAt: claim.coordinator.nextAttemptAt }
        : {}),
    };
  }

  let coordinator: KnowledgeReconcileCoordinator = claim.coordinator;
  let pagesProcessed = 0;
  let teamsCompleted = 0;
  reconciliationMetric("knowledge_reconcile_run_started", {
    cycleId: coordinator.cycleId,
    runId: coordinator.activeRunId,
    scopeDigest,
    teamCount: teamIds.length,
    configDrifted: claim.configDrifted,
  });
  try {
    while (
      coordinator.status === "running" &&
      pagesProcessed < limits.maxPagesPerInvocation &&
      teamsCompleted < limits.maxTeamsPerInvocation
    ) {
      const teamId = coordinator.teamIds[coordinator.teamIndex];
      if (!teamId) throw new Error("knowledge_reconciliation_team_cursor_invalid");
      const page = await runKnowledgeReconciliationPage(env, {
        teamId,
        runId: coordinator.activeRunId,
        limit: limits.pageSize,
      });
      const lagSeconds = Math.max(
        0,
        Math.floor(
          (now() - Date.parse(page.oldestRowUpdatedAt ?? page.createdAt)) / 1_000,
        ),
      );
      reconciliationMetric("knowledge_reconcile_page_completed", {
        cycleId: coordinator.cycleId,
        runId: coordinator.activeRunId,
        teamOrdinal: coordinator.teamIndex,
        pageScannedCount: page.pageScannedCount,
        scannedCount: page.scannedCount,
        enqueuedCount: page.enqueuedCount,
        skippedCount: page.skippedCount,
        descriptorDispositions: page.descriptorDispositions,
        status: page.status,
      });
      reconciliationMetric("knowledge_reconcile_lag_seconds", {
        cycleId: coordinator.cycleId,
        runId: coordinator.activeRunId,
        teamOrdinal: coordinator.teamIndex,
        lagSeconds,
        oldestRowUpdatedAt: page.oldestRowUpdatedAt,
      });
      if (page.pageScannedCount > 0) {
        pagesProcessed += 1;
        coordinator = await doRequest<KnowledgeReconcileCoordinator>(
          env.KNOWLEDGE,
          KNOWLEDGE_OPERATOR_DO_KEY,
          "/reconcile/coordinator/page",
          {
            coordinatorKey: KNOWLEDGE_RECONCILE_COORDINATOR_KEY,
            leaseToken,
            leaseMs: limits.leaseMs,
          },
        );
      }
      if (page.status === "complete") {
        coordinator = await doRequest<KnowledgeReconcileCoordinator>(
          env.KNOWLEDGE,
          KNOWLEDGE_OPERATOR_DO_KEY,
          "/reconcile/coordinator/advance",
          {
            coordinatorKey: KNOWLEDGE_RECONCILE_COORDINATOR_KEY,
            leaseToken,
          },
        );
        teamsCompleted += 1;
      }
    }
    if (coordinator.status === "complete") {
      reconciliationMetric("knowledge_reconcile_run_completed", {
        cycleId: coordinator.cycleId,
        scopeDigest,
        pageCount: coordinator.pageCount,
        completedTeamCount: coordinator.completedTeamCount,
        errorCount: coordinator.errorCount,
      });
      return {
        status: "complete",
        cycleId: coordinator.cycleId,
        pagesProcessed,
        teamsCompleted,
      };
    }
    coordinator = await doRequest<KnowledgeReconcileCoordinator>(
      env.KNOWLEDGE,
      KNOWLEDGE_OPERATOR_DO_KEY,
      "/reconcile/coordinator/release",
      {
        coordinatorKey: KNOWLEDGE_RECONCILE_COORDINATOR_KEY,
        leaseToken,
      },
    );
    return {
      status: "running",
      cycleId: coordinator.cycleId,
      pagesProcessed,
      teamsCompleted,
    };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 256) : "unknown";
    const backoffMs = Math.min(
      limits.maxBackoffMs,
      limits.initialBackoffMs * 2 ** Math.min(6, coordinator.errorCount),
    );
    const retryAt = now() + backoffMs;
    const failed = await doRequest<KnowledgeReconcileCoordinator>(
      env.KNOWLEDGE,
      KNOWLEDGE_OPERATOR_DO_KEY,
      "/reconcile/coordinator/fail",
      {
        coordinatorKey: KNOWLEDGE_RECONCILE_COORDINATOR_KEY,
        leaseToken,
        errorCode,
        retryAt,
      },
    ).catch(() => undefined);
    reconciliationMetric("knowledge_reconcile_run_error", {
      cycleId: coordinator.cycleId,
      runId: coordinator.activeRunId,
      scopeDigest,
      errorCode,
      retryAt,
      errorCount: failed?.errorCount ?? coordinator.errorCount + 1,
    });
    return {
      status: "backoff",
      cycleId: coordinator.cycleId,
      pagesProcessed,
      teamsCompleted,
      nextAttemptAt: retryAt,
    };
  }
}

export type KnowledgeDlqRecord = {
  recordId?: string;
  messageId: string;
  sourceKey: string;
  attempts: number;
  lastErrorCode?: string;
  status?: "pending" | "replaying" | "replayed" | "disposed";
};

export function inspectKnowledgeDlq(records: readonly KnowledgeDlqRecord[], limit = 100): {
  count: number;
  records: KnowledgeDlqRecord[];
  truncated: boolean;
} {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("DLQ inspection limit is invalid");
  }
  const ordered = [...records].sort((a, b) =>
    a.sourceKey.localeCompare(b.sourceKey) || a.messageId.localeCompare(b.messageId));
  return {
    count: records.length,
    records: ordered.slice(0, limit),
    truncated: records.length > limit,
  };
}

/** Replay is an explicit operator-selected exact source; there is no bulk replay. */
export function planKnowledgeDlqReplay(
  records: readonly KnowledgeDlqRecord[],
  exactSourceKey: string,
): { action: "replay_one"; record: KnowledgeDlqRecord } {
  if (!exactSourceKey || /[*?]/.test(exactSourceKey)) {
    throw new Error("an exact sourceKey is required");
  }
  const matches = records.filter((record) => record.sourceKey === exactSourceKey);
  if (matches.length !== 1) throw new Error("exactly one DLQ record must match the source");
  return { action: "replay_one", record: matches[0]! };
}

/**
 * Future C1 DLQ consumer seam. It durably captures each actual DLQ message
 * before acknowledging it; no live Queue/DLQ binding is added by this code.
 */
export async function handleKnowledgeDlq(
  batch: MessageBatch<unknown>,
  env: KnowledgeOperationsEnv,
): Promise<void> {
  for (const message of batch.messages) {
    let job: KnowledgeJob | undefined;
    let lastErrorCode: string | undefined;
    try {
      job = parseKnowledgeJob(message.body);
      const state = await doRequest<{
        ledger?: { lastErrorCode?: string } | null;
      }>(
        env.KNOWLEDGE,
        job.teamId,
        "/state",
        { sourceKey: job.sourceKey },
      );
      lastErrorCode = state.ledger?.lastErrorCode;
    } catch {
      // Malformed DLQ messages remain inspectable but are never replayable.
    }
    try {
      await doRequest(
        env.KNOWLEDGE,
        KNOWLEDGE_OPERATOR_DO_KEY,
        "/dlq/capture",
        {
          messageId: message.id,
          queueName: batch.queue,
          body: message.body,
          sourceKey: job?.sourceKey,
          teamId: job?.teamId,
          attempts: Math.max(1, message.attempts),
          lastErrorCode,
          capturedAt: message.timestamp.toISOString(),
        },
      );
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

export async function inspectDurableKnowledgeDlq(
  env: Pick<KnowledgeOperationsEnv, "KNOWLEDGE">,
  input: { cursor?: number; limit?: number },
): Promise<unknown> {
  return doRequest(
    env.KNOWLEDGE,
    KNOWLEDGE_OPERATOR_DO_KEY,
    "/dlq/list",
    { cursor: input.cursor ?? 0, limit: input.limit ?? 25 },
  );
}

/**
 * Claims and replays exactly one durable DLQ record through the normal
 * descriptor/outbox seam. Current exact source/config must still match; a
 * stale record is released for later operator disposition and never widened.
 */
export async function replayDurableKnowledgeDlqRecord(
  env: KnowledgeOperationsEnv,
  input: {
    recordId: string;
    expectedSourceKey: string;
    rootCauseCorrectionRef: string;
  },
): Promise<{
  recordId: string;
  sourceKey: string;
  replayed: boolean;
  disposition: KnowledgeDlqReplayDisposition;
}> {
  if (!input.recordId || !input.expectedSourceKey || /[*?]/.test(input.expectedSourceKey)) {
    throw new Error("one exact DLQ recordId and sourceKey are required");
  }
  if (!input.rootCauseCorrectionRef || input.rootCauseCorrectionRef.length > 512) {
    throw new Error("a bounded root-cause correction reference is required");
  }
  const record = await doRequest<{
    recordId: string;
    body: unknown;
    sourceKey?: string;
    teamId?: string;
    replayRequestedAt?: string;
  }>(
    env.KNOWLEDGE,
    KNOWLEDGE_OPERATOR_DO_KEY,
    "/dlq/replay/claim",
    {
      recordId: input.recordId,
      replayReference: input.rootCauseCorrectionRef,
    },
  );
  try {
    const job = parseKnowledgeJob(record.body);
    if (
      record.sourceKey !== input.expectedSourceKey ||
      job.sourceKey !== input.expectedSourceKey ||
      record.teamId !== job.teamId ||
      !record.replayRequestedAt
    ) {
      throw new Error("DLQ exact record/source identity mismatch");
    }
    const source = await loadAuthoritativeSource(env, job);
    if (!source || source.configVersion !== job.configVersion) {
      throw new Error("DLQ replay rejected because authoritative config drifted");
    }
    const replayJob = createKnowledgeJob({
      teamId: job.teamId,
      projectId: job.projectId,
      channelId: job.channelId,
      threadTs: job.threadTs,
      configVersion: source.configVersion,
      requestedAt: record.replayRequestedAt,
      reason: "reconcile",
    });
    const submitted = await submitKnowledgeDescriptor(env, replayJob);
    const disposition = submitted.disposition as KnowledgeDlqReplayDisposition;
    await doRequest(
      env.KNOWLEDGE,
      KNOWLEDGE_OPERATOR_DO_KEY,
      "/dlq/replay/complete",
      { recordId: input.recordId, disposition },
    );
    return {
      recordId: input.recordId,
      sourceKey: input.expectedSourceKey,
      replayed: submitted.enqueued,
      disposition,
    };
  } catch (error) {
    await doRequest(
      env.KNOWLEDGE,
      KNOWLEDGE_OPERATOR_DO_KEY,
      "/dlq/replay/release",
      { recordId: input.recordId },
    ).catch(() => undefined);
    throw error;
  }
}
