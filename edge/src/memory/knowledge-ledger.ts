import type { KnowledgeJob } from "./knowledge-contract.js";
import type { SqlExecutor, TransactionRunner } from "../store/sql.js";
import type {
  DurableKnowledgeBackfillDiscovery,
  KnowledgeBackfillCandidate,
  KnowledgeBackfillDiscoveryChannelStatus,
  KnowledgeBackfillDiscoveryStatus,
  KnowledgeBackfillManifest,
  KnowledgeBackfillPageDisposition,
  KnowledgeBackfillScope,
} from "./knowledge-backfill.js";
import type {
  VerifiedKnowledgeBackfillApproval,
} from "./knowledge-backfill-authorization.js";

export const KNOWLEDGE_LEDGER_DDL = [
  `CREATE TABLE IF NOT EXISTS knowledge_ledger (
    source_key TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    desired_revision TEXT,
    indexed_revision TEXT,
    local_document_id TEXT,
    local_document_revision TEXT,
    add_attempt_token TEXT,
    add_attempt_revision TEXT,
    local_workflow_status TEXT,
    poll_deadline_at INTEGER,
    next_poll_at INTEGER,
    poll_count INTEGER NOT NULL DEFAULT 0,
    last_local_operation TEXT,
    last_local_error TEXT,
    status TEXT NOT NULL,
    queue_attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    last_error_class TEXT,
    last_error_code TEXT,
    incomplete_reason TEXT,
    tombstoned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(team_id, channel_id, thread_ts)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_events (
    descriptor_key TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_outbox (
    source_key TEXT PRIMARY KEY,
    descriptor_key TEXT NOT NULL,
    job_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_due
   ON knowledge_outbox(status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS knowledge_reconcile_runs (
    run_id TEXT PRIMARY KEY,
    cursor_source_key TEXT,
    status TEXT NOT NULL,
    pending_page_token TEXT,
    pending_page_json TEXT,
    pending_end_cursor TEXT,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    enqueued_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_reconcile_coordinator (
    coordinator_key TEXT PRIMARY KEY,
    trigger_id TEXT NOT NULL,
    scope_digest TEXT NOT NULL,
    team_ids_json TEXT NOT NULL,
    cycle_id TEXT NOT NULL,
    team_index INTEGER NOT NULL,
    active_run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at INTEGER,
    next_attempt_at INTEGER NOT NULL,
    error_count INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    completed_team_count INTEGER NOT NULL DEFAULT 0,
    config_drift_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_dlq_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    queue_name TEXT NOT NULL,
    body_json TEXT NOT NULL,
    source_key TEXT,
    team_id TEXT,
    attempts INTEGER NOT NULL,
    last_error_code TEXT,
    status TEXT NOT NULL,
    replay_requested_at TEXT,
    replay_reference TEXT,
    replay_disposition TEXT,
    replayed_at TEXT,
    disposed_at TEXT,
    captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_dlq_records_status
   ON knowledge_dlq_records(status, id)`,
  `CREATE TABLE IF NOT EXISTS knowledge_backfill_manifests (
    manifest_id TEXT PRIMARY KEY,
    manifest_digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    status TEXT NOT NULL,
    approval_gate TEXT,
    approval_reference TEXT,
    approved_by TEXT,
    approved_at TEXT,
    next_job_index INTEGER NOT NULL DEFAULT 0,
    pending_page_token TEXT,
    pending_page_json TEXT,
    pending_end_index INTEGER,
    pending_results_json TEXT,
    pending_error_json TEXT,
    execution_error_count INTEGER NOT NULL DEFAULT 0,
    rate_window_started_at INTEGER,
    rate_window_reserved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_backfill_discoveries (
    manifest_id TEXT PRIMARY KEY,
    scope_digest TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    status TEXT NOT NULL,
    blocked_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_backfill_discovery_channels (
    manifest_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    cursor TEXT,
    page_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (manifest_id, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_backfill_candidates (
    manifest_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (manifest_id, channel_id, thread_ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_backfill_candidates_order
   ON knowledge_backfill_candidates(
     manifest_id, observed_at, channel_id, thread_ts
   )`,
  `CREATE TABLE IF NOT EXISTS knowledge_backfill_approvals (
    approval_id TEXT PRIMARY KEY,
    artifact_digest TEXT NOT NULL,
    issuer TEXT NOT NULL,
    key_id TEXT NOT NULL,
    approver_kind TEXT NOT NULL,
    approver_id TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_ids_json TEXT NOT NULL,
    from_time TEXT NOT NULL,
    to_time TEXT NOT NULL,
    maximum_count INTEGER NOT NULL,
    maximum_rate_per_minute INTEGER NOT NULL,
    maximum_errors INTEGER NOT NULL,
    release_ids_json TEXT NOT NULL,
    rollback_owner TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    supersedes_approval_id TEXT,
    consumed_at TEXT NOT NULL
  )`,
];

export type KnowledgeLedgerStatus =
  | "pending"
  | "queued"
  | "leased"
  | "fetching"
  | "incomplete"
  | "normalized"
  | "writing"
  | "polling"
  | "processing_unconfirmed"
  | "indexed"
  | "tombstoned"
  | "retryable_failure"
  | "permanent_failure"
  | "stale";

export type KnowledgeLedgerRow = {
  sourceKey: string;
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  configVersion: number;
  requestedAt: string;
  reason: KnowledgeJob["reason"];
  desiredRevision?: string;
  indexedRevision?: string;
  localDocumentId?: string;
  localDocumentRevision?: string;
  addAttemptToken?: string;
  addAttemptRevision?: string;
  localWorkflowStatus?: string;
  pollDeadlineAt?: number;
  nextPollAt?: number;
  pollCount: number;
  lastLocalOperation?: string;
  lastLocalError?: string;
  status: KnowledgeLedgerStatus;
  queueAttempts: number;
  leaseToken?: string;
  leaseExpiresAt?: number;
  lastErrorClass?: string;
  lastErrorCode?: string;
  incompleteReason?: string;
  tombstonedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type LedgerDbRow = {
  source_key: string;
  team_id: string;
  project_id: string;
  channel_id: string;
  thread_ts: string;
  config_version: number;
  requested_at: string;
  reason: KnowledgeJob["reason"];
  desired_revision: string | null;
  indexed_revision: string | null;
  local_document_id: string | null;
  local_document_revision: string | null;
  add_attempt_token: string | null;
  add_attempt_revision: string | null;
  local_workflow_status: string | null;
  poll_deadline_at: number | null;
  next_poll_at: number | null;
  poll_count: number;
  last_local_operation: string | null;
  last_local_error: string | null;
  status: KnowledgeLedgerStatus;
  queue_attempts: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error_class: string | null;
  last_error_code: string | null;
  incomplete_reason: string | null;
  tombstoned_at: string | null;
  created_at: string;
  updated_at: string;
};

type OutboxDbRow = {
  source_key: string;
  descriptor_key: string;
  job_json: string;
  status: "pending" | "sending";
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  updated_at: string;
};

type ReconcileRunDbRow = {
  run_id: string;
  cursor_source_key: string | null;
  status: "running" | "complete";
  pending_page_token: string | null;
  pending_page_json: string | null;
  pending_end_cursor: string | null;
  scanned_count: number;
  enqueued_count: number;
  skipped_count: number;
  created_at: string;
  updated_at: string;
};

type ReconcileCoordinatorDbRow = {
  coordinator_key: string;
  trigger_id: string;
  scope_digest: string;
  team_ids_json: string;
  cycle_id: string;
  team_index: number;
  active_run_id: string;
  status: "running" | "backoff" | "complete";
  lease_token: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  error_count: number;
  page_count: number;
  completed_team_count: number;
  config_drift_count: number;
  last_error_code: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
};

type DlqDbRow = {
  id: number;
  message_id: string;
  queue_name: string;
  body_json: string;
  source_key: string | null;
  team_id: string | null;
  attempts: number;
  last_error_code: string | null;
  status: "pending" | "replaying" | "replayed" | "disposed";
  replay_requested_at: string | null;
  replay_reference: string | null;
  replay_disposition: KnowledgeDlqReplayDisposition | null;
  replayed_at: string | null;
  disposed_at: string | null;
  captured_at: string;
  updated_at: string;
};

type BackfillManifestDbRow = {
  manifest_id: string;
  manifest_digest: string;
  manifest_json: string;
  status: "dry_run" | "approved" | "running" | "complete";
  approval_gate: string | null;
  approval_reference: string | null;
  approved_by: string | null;
  approved_at: string | null;
  next_job_index: number;
  pending_page_token: string | null;
  pending_page_json: string | null;
  pending_end_index: number | null;
  pending_results_json: string | null;
  pending_error_json: string | null;
  execution_error_count: number;
  rate_window_started_at: number | null;
  rate_window_reserved: number;
  created_at: string;
  updated_at: string;
};

type BackfillDiscoveryDbRow = {
  manifest_id: string;
  scope_digest: string;
  scope_json: string;
  status: KnowledgeBackfillDiscoveryStatus;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
};

type BackfillDiscoveryChannelDbRow = {
  manifest_id: string;
  channel_id: string;
  config_version: number;
  status: KnowledgeBackfillDiscoveryChannelStatus;
  cursor: string | null;
  page_count: number;
  updated_at: string;
};

type BackfillCandidateDbRow = {
  channel_id: string;
  thread_ts: string;
  observed_at: string;
};

type BackfillApprovalDbRow = {
  approval_id: string;
  artifact_digest: string;
  issuer: string;
  key_id: string;
  approver_kind: string;
  approver_id: string;
  manifest_id: string;
  manifest_digest: string;
  team_id: string;
  project_id: string;
  channel_ids_json: string;
  from_time: string;
  to_time: string;
  maximum_count: number;
  maximum_rate_per_minute: number;
  maximum_errors: number;
  release_ids_json: string;
  rollback_owner: string;
  issued_at: string;
  expires_at: string;
  supersedes_approval_id: string | null;
  consumed_at: string;
};

export type KnowledgeOutboxItem = {
  sourceKey: string;
  descriptorKey: string;
  job: KnowledgeJob;
  attemptCount: number;
};

export type EnqueueKnowledgeResult = {
  accepted: boolean;
  reason: "new" | "superseded" | "duplicate" | "out_of_order";
  descriptorKey: string;
};

export type LeaseKnowledgeResult =
  | { decision: "lease"; leaseToken: string; leaseExpiresAt: number }
  | { decision: "noop"; reason: "missing" | "stale_descriptor" | "already_complete" | "config_drift" }
  | { decision: "retry"; reason: "lease_active" | "permanent_failure"; retryAfterSeconds: number };

export type KnowledgeOutcome =
  | { status: "normalized"; desiredRevision: string }
  | { status: "indexed"; desiredRevision: string; indexedRevision: string; localDocumentId: string; workflowStatus: "done"; pollCount: number }
  | { status: "processing_unconfirmed"; desiredRevision: string; localDocumentId: string; workflowStatus: string; pollDeadlineAt: number; nextPollAt: number; pollCount: number }
  | { status: "tombstoned"; tombstonedAt: string; errorCode: "unsupported_delete_contract" }
  | { status: "retryable_failure"; errorClass: string; errorCode?: string; incompleteReason?: string }
  | { status: "permanent_failure"; errorClass: string; errorCode?: string };

export type PrepareRevisionResult =
  | { decision: "add" }
  | { decision: "poll"; localDocumentId: string; pollDeadlineAt?: number }
  | { decision: "noop"; reason: "already_indexed" }
  | { decision: "blocked"; reason: "tombstoned" | "unsupported_update_contract" | "ambiguous_add_contract" };

export type KnowledgeReconcileRun = {
  runId: string;
  cursor?: string;
  status: "running" | "complete";
  scannedCount: number;
  enqueuedCount: number;
  skippedCount: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeReconcilePage = {
  run: KnowledgeReconcileRun;
  pageToken?: string;
  rows: KnowledgeLedgerRow[];
};

export type KnowledgeReconcileCoordinator = {
  coordinatorKey: string;
  triggerId: string;
  scopeDigest: string;
  teamIds: string[];
  cycleId: string;
  teamIndex: number;
  activeRunId: string;
  status: "running" | "backoff" | "complete";
  leaseToken?: string;
  leaseExpiresAt?: number;
  nextAttemptAt: number;
  errorCount: number;
  pageCount: number;
  completedTeamCount: number;
  configDriftCount: number;
  lastErrorCode?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
};

export type KnowledgeReconcileCoordinatorClaim =
  | { decision: "acquired"; coordinator: KnowledgeReconcileCoordinator; configDrifted: boolean }
  | { decision: "busy"; coordinator: KnowledgeReconcileCoordinator }
  | { decision: "backoff"; coordinator: KnowledgeReconcileCoordinator }
  | { decision: "complete"; coordinator: KnowledgeReconcileCoordinator };

export type KnowledgeDlqReplayDisposition =
  | "accepted"
  | "accepted_response_lost"
  | "duplicate"
  | "converged"
  | "superseded";

export type DurableKnowledgeDlqRecord = {
  recordId: string;
  messageId: string;
  queueName: string;
  body: unknown;
  sourceKey?: string;
  teamId?: string;
  attempts: number;
  lastErrorCode?: string;
  status: "pending" | "replaying" | "replayed" | "disposed";
  replayRequestedAt?: string;
  replayReference?: string;
  replayDisposition?: KnowledgeDlqReplayDisposition;
  replayedAt?: string;
  disposedAt?: string;
  capturedAt: string;
};

export type DurableBackfillManifestRecord = {
  manifestId: string;
  manifestDigest: string;
  manifest: unknown;
  status: "dry_run" | "approved" | "running" | "complete";
  approvalGate?: string;
  approvalReference?: string;
  approvedBy?: string;
  approvedAt?: string;
  nextJobIndex: number;
  pendingPageToken?: string;
  pendingJobs?: KnowledgeJob[];
  pendingEndIndex?: number;
  pendingResults?: Record<string, KnowledgeBackfillPageDisposition>;
  pendingError?: {
    descriptorKey: string;
    errorCode: string;
    recordedAt: string;
  };
  executionErrorCount: number;
  rateWindowStartedAt?: number;
  rateWindowReserved: number;
  createdAt: string;
  updatedAt: string;
};

export type DurableBackfillApprovalAudit = {
  approvalId: string;
  artifactDigest: string;
  approverId: string;
  manifestId: string;
  manifestDigest: string;
  issuedAt: string;
  expiresAt: string;
  supersedesApprovalId?: string;
  consumedAt: string;
};

export function knowledgeDescriptorKey(job: KnowledgeJob): string {
  return `${job.sourceKey}|${job.configVersion}|${job.requestedAt}|${job.reason}${
    job.messageTs ? `|${job.messageTs}` : ""
  }`;
}

function ledgerRow(row: LedgerDbRow): KnowledgeLedgerRow {
  return {
    sourceKey: row.source_key,
    teamId: row.team_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    configVersion: row.config_version,
    requestedAt: row.requested_at,
    reason: row.reason,
    desiredRevision: row.desired_revision ?? undefined,
    indexedRevision: row.indexed_revision ?? undefined,
    localDocumentId: row.local_document_id ?? undefined,
    localDocumentRevision: row.local_document_revision ?? undefined,
    addAttemptToken: row.add_attempt_token ?? undefined,
    addAttemptRevision: row.add_attempt_revision ?? undefined,
    localWorkflowStatus: row.local_workflow_status ?? undefined,
    pollDeadlineAt: row.poll_deadline_at ?? undefined,
    nextPollAt: row.next_poll_at ?? undefined,
    pollCount: row.poll_count,
    lastLocalOperation: row.last_local_operation ?? undefined,
    lastLocalError: row.last_local_error ?? undefined,
    status: row.status,
    queueAttempts: row.queue_attempts,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    lastErrorClass: row.last_error_class ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    incompleteReason: row.incomplete_reason ?? undefined,
    tombstonedAt: row.tombstoned_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reconcileRun(row: ReconcileRunDbRow): KnowledgeReconcileRun {
  return {
    runId: row.run_id,
    cursor: row.cursor_source_key ?? undefined,
    status: row.status,
    scannedCount: row.scanned_count,
    enqueuedCount: row.enqueued_count,
    skippedCount: row.skipped_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reconcileCoordinator(row: ReconcileCoordinatorDbRow): KnowledgeReconcileCoordinator {
  return {
    coordinatorKey: row.coordinator_key,
    triggerId: row.trigger_id,
    scopeDigest: row.scope_digest,
    teamIds: JSON.parse(row.team_ids_json) as string[],
    cycleId: row.cycle_id,
    teamIndex: row.team_index,
    activeRunId: row.active_run_id,
    status: row.status,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    nextAttemptAt: row.next_attempt_at,
    errorCount: row.error_count,
    pageCount: row.page_count,
    completedTeamCount: row.completed_team_count,
    configDriftCount: row.config_drift_count,
    lastErrorCode: row.last_error_code ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function dlqRecord(row: DlqDbRow): DurableKnowledgeDlqRecord {
  return {
    recordId: `kdlq-${row.id}`,
    messageId: row.message_id,
    queueName: row.queue_name,
    body: JSON.parse(row.body_json) as unknown,
    sourceKey: row.source_key ?? undefined,
    teamId: row.team_id ?? undefined,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code ?? undefined,
    status: row.status,
    replayRequestedAt: row.replay_requested_at ?? undefined,
    replayReference: row.replay_reference ?? undefined,
    replayDisposition: row.replay_disposition ?? undefined,
    replayedAt: row.replayed_at ?? undefined,
    disposedAt: row.disposed_at ?? undefined,
    capturedAt: row.captured_at,
  };
}

function backfillManifestRecord(row: BackfillManifestDbRow): DurableBackfillManifestRecord {
  return {
    manifestId: row.manifest_id,
    manifestDigest: row.manifest_digest,
    manifest: JSON.parse(row.manifest_json) as unknown,
    status: row.status,
    approvalGate: row.approval_gate ?? undefined,
    approvalReference: row.approval_reference ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    nextJobIndex: row.next_job_index,
    pendingPageToken: row.pending_page_token ?? undefined,
    pendingJobs: row.pending_page_json
      ? JSON.parse(row.pending_page_json) as KnowledgeJob[]
      : undefined,
    pendingEndIndex: row.pending_end_index ?? undefined,
    pendingResults: row.pending_results_json
      ? JSON.parse(row.pending_results_json) as Record<
        string,
        KnowledgeBackfillPageDisposition
      >
      : undefined,
    pendingError: row.pending_error_json
      ? JSON.parse(row.pending_error_json) as {
        descriptorKey: string;
        errorCode: string;
        recordedAt: string;
      }
      : undefined,
    executionErrorCount: row.execution_error_count,
    rateWindowStartedAt: row.rate_window_started_at ?? undefined,
    rateWindowReserved: row.rate_window_reserved,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function backfillCandidate(row: BackfillCandidateDbRow): KnowledgeBackfillCandidate {
  return {
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    observedAt: row.observed_at,
  };
}

function parseDlqRecordId(recordId: string): number {
  const match = /^kdlq-([1-9][0-9]*)$/.exec(recordId);
  const id = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(id)) throw new Error("DLQ recordId is invalid");
  return id;
}

export class KnowledgeLedger {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly tx: TransactionRunner,
  ) {}

  migrate(): void {
    for (const statement of KNOWLEDGE_LEDGER_DDL) this.sql.exec(statement);
    const columns = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(knowledge_ledger)").toArray().map((row) => row.name));
    const additions = [
      ["local_document_id", "TEXT"],
      ["local_document_revision", "TEXT"],
      ["add_attempt_token", "TEXT"],
      ["add_attempt_revision", "TEXT"],
      ["local_workflow_status", "TEXT"],
      ["poll_deadline_at", "INTEGER"],
      ["next_poll_at", "INTEGER"],
      ["poll_count", "INTEGER NOT NULL DEFAULT 0"],
      ["last_local_operation", "TEXT"],
      ["last_local_error", "TEXT"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE knowledge_ledger ADD COLUMN ${name} ${definition}`);
    }
    const dlqColumns = new Set(this.sql.exec<{ name: string }>(
      "PRAGMA table_info(knowledge_dlq_records)",
    ).toArray().map((row) => row.name));
    if (!dlqColumns.has("replay_reference")) {
      this.sql.exec("ALTER TABLE knowledge_dlq_records ADD COLUMN replay_reference TEXT");
    }
    if (!dlqColumns.has("replay_disposition")) {
      this.sql.exec("ALTER TABLE knowledge_dlq_records ADD COLUMN replay_disposition TEXT");
    }
    if (!dlqColumns.has("disposed_at")) {
      this.sql.exec("ALTER TABLE knowledge_dlq_records ADD COLUMN disposed_at TEXT");
    }
    const backfillColumns = new Set(this.sql.exec<{ name: string }>(
      "PRAGMA table_info(knowledge_backfill_manifests)",
    ).toArray().map((row) => row.name));
    const backfillAdditions = [
      ["pending_results_json", "TEXT"],
      ["pending_error_json", "TEXT"],
      ["execution_error_count", "INTEGER NOT NULL DEFAULT 0"],
      ["rate_window_started_at", "INTEGER"],
      ["rate_window_reserved", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of backfillAdditions) {
      if (!backfillColumns.has(name)) {
        this.sql.exec(
          `ALTER TABLE knowledge_backfill_manifests ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    const approvalColumns = new Set(this.sql.exec<{ name: string }>(
      "PRAGMA table_info(knowledge_backfill_approvals)",
    ).toArray().map((row) => row.name));
    if (!approvalColumns.has("supersedes_approval_id")) {
      this.sql.exec(
        "ALTER TABLE knowledge_backfill_approvals ADD COLUMN supersedes_approval_id TEXT",
      );
    }
    this.sql.exec(
      `UPDATE knowledge_ledger
       SET local_document_revision = COALESCE(desired_revision, indexed_revision)
       WHERE local_document_id IS NOT NULL AND local_document_revision IS NULL`,
    );
  }

  enqueue(job: KnowledgeJob, nowMs: number): EnqueueKnowledgeResult {
    const descriptorKey = knowledgeDescriptorKey(job);
    const now = new Date(nowMs).toISOString();
    return this.tx(() => {
      const current = this.get(job.sourceKey);
      if (current) {
        if (job.configVersion < current.configVersion) {
          return { accepted: false, reason: "out_of_order", descriptorKey };
        }
        // A verified root deletion is irreversible source intent. Preserve it
        // even before Queue dispatch records the durable tombstone so a later
        // reply/edit callback cannot replace the delete outbox row in the
        // scheduling-to-consumption race window.
        if (current.reason === "delete" && job.reason !== "delete") {
          return { accepted: false, reason: "out_of_order", descriptorKey };
        }
        if (
          job.configVersion === current.configVersion &&
          job.requestedAt <= current.requestedAt
        ) {
          return { accepted: false, reason: "duplicate", descriptorKey };
        }
      }

      this.sql.exec(
        `INSERT OR IGNORE INTO knowledge_events
         (descriptor_key, source_key, config_version, requested_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        descriptorKey,
        job.sourceKey,
        job.configVersion,
        job.requestedAt,
        job.reason,
        now,
      );
      this.sql.exec(
        `INSERT INTO knowledge_ledger (
           source_key, team_id, project_id, channel_id, thread_ts,
           config_version, requested_at, reason, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           team_id = excluded.team_id,
           project_id = excluded.project_id,
           channel_id = excluded.channel_id,
           thread_ts = excluded.thread_ts,
           config_version = excluded.config_version,
           requested_at = excluded.requested_at,
           reason = excluded.reason,
           desired_revision = NULL,
           status = 'pending',
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error_class = NULL,
           last_error_code = NULL,
           incomplete_reason = NULL,
           updated_at = excluded.updated_at`,
        job.sourceKey,
        job.teamId,
        job.projectId,
        job.channelId,
        job.threadTs,
        job.configVersion,
        job.requestedAt,
        job.reason,
        now,
        now,
      );
      this.sql.exec(
        `INSERT INTO knowledge_outbox (
           source_key, descriptor_key, job_json, status, attempt_count,
           next_attempt_at, last_error, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           descriptor_key = excluded.descriptor_key,
           job_json = excluded.job_json,
           status = 'pending',
           attempt_count = 0,
           next_attempt_at = excluded.next_attempt_at,
           last_error = NULL,
           updated_at = excluded.updated_at`,
        job.sourceKey,
        descriptorKey,
        JSON.stringify(job),
        nowMs,
        now,
      );
      return {
        accepted: true,
        reason: current ? "superseded" : "new",
        descriptorKey,
      };
    });
  }

  claimDueOutbox(nowMs: number): KnowledgeOutboxItem | undefined {
    return this.tx(() => {
      const row = this.sql.exec<OutboxDbRow>(
        `SELECT * FROM knowledge_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, source_key ASC LIMIT 1`,
        nowMs,
      ).toArray()[0];
      if (!row) return undefined;
      this.sql.exec(
        `UPDATE knowledge_outbox
         SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
         WHERE source_key = ? AND descriptor_key = ? AND status = 'pending'`,
        new Date(nowMs).toISOString(),
        row.source_key,
        row.descriptor_key,
      );
      return {
        sourceKey: row.source_key,
        descriptorKey: row.descriptor_key,
        job: JSON.parse(row.job_json) as KnowledgeJob,
        attemptCount: row.attempt_count + 1,
      };
    });
  }

  markOutboxSent(item: KnowledgeOutboxItem, nowMs: number): void {
    this.tx(() => {
      this.sql.exec(
        `DELETE FROM knowledge_outbox WHERE source_key = ? AND descriptor_key = ?`,
        item.sourceKey,
        item.descriptorKey,
      );
      this.sql.exec(
        `UPDATE knowledge_ledger
         SET status = 'queued', queue_attempts = queue_attempts + 1, updated_at = ?
         WHERE source_key = ? AND config_version = ? AND requested_at = ?`,
        new Date(nowMs).toISOString(),
        item.sourceKey,
        item.job.configVersion,
        item.job.requestedAt,
      );
    });
  }

  markOutboxFailed(
    item: KnowledgeOutboxItem,
    error: string,
    nowMs: number,
    delayMs: number,
  ): void {
    this.tx(() => {
      this.sql.exec(
        `UPDATE knowledge_outbox
         SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE source_key = ? AND descriptor_key = ?`,
        nowMs + delayMs,
        error.slice(0, 256),
        new Date(nowMs).toISOString(),
        item.sourceKey,
        item.descriptorKey,
      );
    });
  }

  recoverSending(nowMs: number): void {
    this.sql.exec(
      `UPDATE knowledge_outbox
       SET status = 'pending', next_attempt_at = ?, updated_at = ?
       WHERE status = 'sending'`,
      nowMs,
      new Date(nowMs).toISOString(),
    );
  }

  earliestPendingAt(): number | undefined {
    const row = this.sql.exec<{ next_attempt_at: number }>(
      `SELECT next_attempt_at FROM knowledge_outbox
       WHERE status = 'pending' ORDER BY next_attempt_at ASC LIMIT 1`,
    ).toArray()[0];
    return row?.next_attempt_at;
  }

  acquireLease(
    job: KnowledgeJob,
    authoritativeConfigVersion: number,
    leaseToken: string,
    nowMs: number,
    leaseMs: number,
  ): LeaseKnowledgeResult {
    return this.tx(() => {
      const current = this.get(job.sourceKey);
      if (!current) return { decision: "noop", reason: "missing" };
      const workspaceConfigAhead =
        job.reason === "delete" &&
        authoritativeConfigVersion > job.configVersion &&
        current.configVersion === job.configVersion;
      if (
        !workspaceConfigAhead &&
        (job.configVersion !== authoritativeConfigVersion ||
          current.configVersion !== authoritativeConfigVersion)
      ) {
        return { decision: "noop", reason: "config_drift" };
      }
      if (job.requestedAt !== current.requestedAt || job.configVersion !== current.configVersion) {
        return { decision: "noop", reason: "stale_descriptor" };
      }
      if ((current.status === "normalized" && current.desiredRevision) ||
        (current.status === "indexed" && current.desiredRevision === current.indexedRevision)) {
        return { decision: "noop", reason: "already_complete" };
      }
      if (current.status === "permanent_failure") {
        // Preserve Queue/DLQ delivery without re-running a known permanent
        // external effect on every at-least-once attempt.
        return { decision: "retry", reason: "permanent_failure", retryAfterSeconds: 300 };
      }
      if (current.leaseToken && (current.leaseExpiresAt ?? 0) > nowMs) {
        return {
          decision: "retry",
          reason: "lease_active",
          retryAfterSeconds: Math.max(1, Math.ceil(((current.leaseExpiresAt ?? nowMs) - nowMs) / 1_000)),
        };
      }
      const leaseExpiresAt = nowMs + leaseMs;
      this.sql.exec(
        `UPDATE knowledge_ledger SET
           status = 'leased', lease_token = ?, lease_expires_at = ?,
           queue_attempts = queue_attempts + 1, updated_at = ?
         WHERE source_key = ?`,
        leaseToken,
        leaseExpiresAt,
        new Date(nowMs).toISOString(),
        job.sourceKey,
      );
      return { decision: "lease", leaseToken, leaseExpiresAt };
    });
  }

  recordOutcome(
    sourceKey: string,
    leaseToken: string,
    outcome: KnowledgeOutcome,
    nowMs: number,
  ): boolean {
    return this.tx(() => {
      const current = this.get(sourceKey);
      if (!current || current.leaseToken !== leaseToken) return false;
      const now = new Date(nowMs).toISOString();
      if (outcome.status === "normalized") {
        this.sql.exec(
          `UPDATE knowledge_ledger SET
             status = 'normalized', desired_revision = ?, lease_token = NULL,
             lease_expires_at = NULL, last_error_class = NULL,
             last_error_code = NULL, incomplete_reason = NULL, updated_at = ?
           WHERE source_key = ? AND lease_token = ?`,
          outcome.desiredRevision,
          now,
          sourceKey,
          leaseToken,
        );
      } else if (outcome.status === "indexed") {
        if (
          current.localDocumentId !== outcome.localDocumentId ||
          current.localDocumentRevision !== outcome.desiredRevision ||
          outcome.indexedRevision !== outcome.desiredRevision
        ) return false;
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'indexed', desired_revision = ?, indexed_revision = ?,
           local_document_id = ?, local_workflow_status = ?, poll_count = poll_count + ?,
           poll_deadline_at = NULL, next_poll_at = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_class = NULL, last_error_code = NULL, incomplete_reason = NULL,
           last_local_operation = 'add_done', last_local_error = NULL, updated_at = ?
           WHERE source_key = ? AND lease_token = ?`,
          outcome.desiredRevision, outcome.indexedRevision, outcome.localDocumentId,
          outcome.workflowStatus, outcome.pollCount, now, sourceKey, leaseToken,
        );
      } else if (outcome.status === "processing_unconfirmed") {
        if (
          current.localDocumentId !== outcome.localDocumentId ||
          current.localDocumentRevision !== outcome.desiredRevision
        ) return false;
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'processing_unconfirmed', desired_revision = ?,
           local_document_id = ?, local_workflow_status = ?, poll_deadline_at = ?, next_poll_at = ?,
           poll_count = poll_count + ?, lease_token = NULL, lease_expires_at = NULL,
           last_error_class = 'local_processing', last_error_code = 'processing_unconfirmed',
           last_local_operation = 'poll', updated_at = ? WHERE source_key = ? AND lease_token = ?`,
          outcome.desiredRevision, outcome.localDocumentId, outcome.workflowStatus,
          outcome.pollDeadlineAt, outcome.nextPollAt, outcome.pollCount, now, sourceKey, leaseToken,
        );
      } else if (outcome.status === "tombstoned") {
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'tombstoned', tombstoned_at = ?,
           lease_token = NULL, lease_expires_at = NULL, last_error_class = 'unsupported_capability',
           last_error_code = ?, last_local_operation = 'tombstone', updated_at = ?
           WHERE source_key = ? AND lease_token = ?`,
          outcome.tombstonedAt, outcome.errorCode, now, sourceKey, leaseToken,
        );
      } else {
        this.sql.exec(
          `UPDATE knowledge_ledger SET
             status = ?, lease_token = NULL, lease_expires_at = NULL,
             last_error_class = ?, last_error_code = ?, incomplete_reason = ?,
             last_local_error = ?, updated_at = ?
           WHERE source_key = ? AND lease_token = ?`,
          outcome.status,
          outcome.errorClass,
          outcome.errorCode ?? null,
          outcome.status === "retryable_failure" ? outcome.incompleteReason ?? null : null,
          outcome.errorCode ?? outcome.errorClass,
          now,
          sourceKey,
          leaseToken,
        );
      }
      return true;
    });
  }

  prepareRevision(sourceKey: string, leaseToken: string, desiredRevision: string, nowMs: number): PrepareRevisionResult {
    return this.tx(() => {
      const current = this.get(sourceKey);
      if (!current || current.leaseToken !== leaseToken) throw new Error("knowledge lease is not current");
      if (current.tombstonedAt || current.status === "tombstoned") return { decision: "blocked", reason: "tombstoned" };
      if (current.indexedRevision === desiredRevision && current.status === "indexed") {
        return { decision: "noop", reason: "already_indexed" };
      }
      if (current.indexedRevision === desiredRevision) {
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'indexed', desired_revision = ?,
           lease_token = NULL, lease_expires_at = NULL, last_error_class = NULL,
           last_error_code = NULL, incomplete_reason = NULL,
           last_local_operation = 'same_revision_noop', last_local_error = NULL, updated_at = ?
           WHERE source_key = ? AND lease_token = ?`,
          desiredRevision, new Date(nowMs).toISOString(), sourceKey, leaseToken,
        );
        return { decision: "noop", reason: "already_indexed" };
      }
      if (current.indexedRevision && current.indexedRevision !== desiredRevision) {
        return { decision: "blocked", reason: "unsupported_update_contract" };
      }
      if (current.localDocumentId) {
        if (!current.localDocumentRevision || current.localDocumentRevision !== desiredRevision) {
          return { decision: "blocked", reason: "unsupported_update_contract" };
        }
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'polling', desired_revision = ?,
           last_local_operation = 'resume_poll', updated_at = ? WHERE source_key = ? AND lease_token = ?`,
          desiredRevision, new Date(nowMs).toISOString(), sourceKey, leaseToken,
        );
        return { decision: "poll", localDocumentId: current.localDocumentId, pollDeadlineAt: current.pollDeadlineAt };
      }
      // The add request may have reached Local even if this isolate died before
      // persisting its returned ID. Without a proven get-by-customId/idempotency
      // contract, never issue a second add for that source.
      if (current.lastLocalOperation === "add_started") {
        return { decision: "blocked", reason: "ambiguous_add_contract" };
      }
      this.sql.exec(
        `UPDATE knowledge_ledger SET status = 'writing', desired_revision = ?,
         add_attempt_token = ?, add_attempt_revision = ?,
         last_local_operation = 'add_started', updated_at = ? WHERE source_key = ? AND lease_token = ?`,
        desiredRevision, leaseToken, desiredRevision,
        new Date(nowMs).toISOString(), sourceKey, leaseToken,
      );
      return { decision: "add" };
    });
  }

  recordLocalAccepted(input: {
    sourceKey: string;
    leaseToken: string;
    localDocumentId: string;
    desiredRevision: string;
    workflowStatus: string;
    pollDeadlineAt: number;
    nextPollAt: number;
  }, nowMs: number): boolean {
    return this.tx(() => {
      const current = this.get(input.sourceKey);
      if (!current || current.tombstonedAt) return false;
      const ownsCurrentLease = current.leaseToken === input.leaseToken;
      if (!ownsCurrentLease && current.addAttemptToken !== input.leaseToken) return false;
      if (current.localDocumentId && current.localDocumentId !== input.localDocumentId) {
        throw new Error("local document identity conflict");
      }
      if (current.addAttemptRevision !== input.desiredRevision) {
        return false;
      }
      if (current.localDocumentRevision && current.localDocumentRevision !== input.desiredRevision) {
        throw new Error("local document revision conflict");
      }
      this.sql.exec(
        `UPDATE knowledge_ledger SET
         status = CASE WHEN lease_token = ? THEN 'polling' ELSE status END,
         local_document_id = ?,
         local_document_revision = ?,
         local_workflow_status = ?, poll_deadline_at = ?, next_poll_at = ?,
         last_local_operation = 'add_accepted', last_local_error = NULL, updated_at = ?
         WHERE source_key = ? AND add_attempt_token = ?`,
        input.leaseToken, input.localDocumentId, input.desiredRevision, input.workflowStatus,
        input.pollDeadlineAt, input.nextPollAt,
        new Date(nowMs).toISOString(), input.sourceKey, input.leaseToken,
      );
      return true;
    });
  }

  markStale(job: KnowledgeJob, nowMs: number): void {
    this.sql.exec(
      `UPDATE knowledge_ledger SET status = 'stale', lease_token = NULL,
       lease_expires_at = NULL, updated_at = ?
       WHERE source_key = ? AND config_version = ? AND requested_at = ?`,
      new Date(nowMs).toISOString(),
      job.sourceKey,
      job.configVersion,
      job.requestedAt,
    );
  }

  startReconcileRun(runId: string, nowMs: number): KnowledgeReconcileRun {
    if (!runId || runId.length > 128) throw new Error("reconcile runId is invalid");
    const now = new Date(nowMs).toISOString();
    this.sql.exec(
      `INSERT OR IGNORE INTO knowledge_reconcile_runs (
         run_id, status, created_at, updated_at
       ) VALUES (?, 'running', ?, ?)`,
      runId,
      now,
      now,
    );
    const row = this.sql.exec<ReconcileRunDbRow>(
      "SELECT * FROM knowledge_reconcile_runs WHERE run_id = ?",
      runId,
    ).toArray()[0];
    if (!row) throw new Error("reconcile run was not persisted");
    return reconcileRun(row);
  }

  /**
   * Claim is restart-safe: an uncommitted page is returned verbatim until the
   * caller commits its token. Repeated descriptor writes are therefore
   * idempotent instead of advancing past work after an isolate crash.
   */
  claimReconcilePage(runId: string, limit: number, nowMs: number): KnowledgeReconcilePage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("reconcile page limit must be between 1 and 100");
    }
    return this.tx(() => {
      const current = this.sql.exec<ReconcileRunDbRow>(
        "SELECT * FROM knowledge_reconcile_runs WHERE run_id = ?",
        runId,
      ).toArray()[0];
      if (!current) throw new Error("reconcile run does not exist");
      if (current.pending_page_token && current.pending_page_json) {
        return {
          run: reconcileRun(current),
          pageToken: current.pending_page_token,
          rows: JSON.parse(current.pending_page_json) as KnowledgeLedgerRow[],
        };
      }
      if (current.status === "complete") return { run: reconcileRun(current), rows: [] };
      const rows = this.sql.exec<LedgerDbRow>(
        `SELECT * FROM knowledge_ledger
         WHERE source_key > ?
         ORDER BY source_key ASC
         LIMIT ?`,
        current.cursor_source_key ?? "",
        limit,
      ).toArray().map(ledgerRow);
      if (rows.length === 0) {
        const now = new Date(nowMs).toISOString();
        this.sql.exec(
          `UPDATE knowledge_reconcile_runs
           SET status = 'complete', updated_at = ?
           WHERE run_id = ? AND pending_page_token IS NULL`,
          now,
          runId,
        );
        const completed = this.sql.exec<ReconcileRunDbRow>(
          "SELECT * FROM knowledge_reconcile_runs WHERE run_id = ?",
          runId,
        ).toArray()[0]!;
        return { run: reconcileRun(completed), rows: [] };
      }
      const pageToken = crypto.randomUUID();
      const endCursor = rows.at(-1)!.sourceKey;
      this.sql.exec(
        `UPDATE knowledge_reconcile_runs SET
           pending_page_token = ?, pending_page_json = ?,
           pending_end_cursor = ?, updated_at = ?
         WHERE run_id = ? AND pending_page_token IS NULL`,
        pageToken,
        JSON.stringify(rows),
        endCursor,
        new Date(nowMs).toISOString(),
        runId,
      );
      const claimed = this.sql.exec<ReconcileRunDbRow>(
        "SELECT * FROM knowledge_reconcile_runs WHERE run_id = ?",
        runId,
      ).toArray()[0]!;
      return {
        run: reconcileRun(claimed),
        pageToken: claimed.pending_page_token!,
        rows: JSON.parse(claimed.pending_page_json!) as KnowledgeLedgerRow[],
      };
    });
  }

  commitReconcilePage(
    runId: string,
    pageToken: string,
    counts: { enqueued: number; skipped: number },
    nowMs: number,
  ): KnowledgeReconcileRun {
    if (!pageToken) throw new Error("reconcile pageToken is required");
    if (
      !Number.isSafeInteger(counts.enqueued) || counts.enqueued < 0 ||
      !Number.isSafeInteger(counts.skipped) || counts.skipped < 0
    ) {
      throw new Error("reconcile page counts are invalid");
    }
    return this.tx(() => {
      const current = this.sql.exec<ReconcileRunDbRow>(
        "SELECT * FROM knowledge_reconcile_runs WHERE run_id = ?",
        runId,
      ).toArray()[0];
      if (!current || current.pending_page_token !== pageToken ||
        !current.pending_page_json || !current.pending_end_cursor) {
        throw new Error("reconcile page token is not current");
      }
      const scanned = (JSON.parse(current.pending_page_json) as unknown[]).length;
      if (counts.enqueued + counts.skipped !== scanned) {
        throw new Error("reconcile page counts do not cover the claimed page");
      }
      this.sql.exec(
        `UPDATE knowledge_reconcile_runs SET
           cursor_source_key = pending_end_cursor,
           pending_page_token = NULL, pending_page_json = NULL,
           pending_end_cursor = NULL,
           scanned_count = scanned_count + ?,
           enqueued_count = enqueued_count + ?,
           skipped_count = skipped_count + ?,
           updated_at = ?
         WHERE run_id = ? AND pending_page_token = ?`,
        scanned,
        counts.enqueued,
        counts.skipped,
        new Date(nowMs).toISOString(),
        runId,
        pageToken,
      );
      const updated = this.sql.exec<ReconcileRunDbRow>(
        "SELECT * FROM knowledge_reconcile_runs WHERE run_id = ?",
        runId,
      ).toArray()[0]!;
      return reconcileRun(updated);
    });
  }

  claimReconcileCoordinator(input: {
    coordinatorKey: string;
    triggerId: string;
    scopeDigest: string;
    teamIds: string[];
    cycleId: string;
    leaseToken: string;
    leaseMs: number;
  }, nowMs: number): KnowledgeReconcileCoordinatorClaim {
    if (!input.coordinatorKey || input.coordinatorKey.length > 128) {
      throw new Error("reconcile coordinator key is invalid");
    }
    if (!input.triggerId || input.triggerId.length > 128) {
      throw new Error("reconcile trigger id is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.scopeDigest)) {
      throw new Error("reconcile scope digest is invalid");
    }
    if (
      input.teamIds.length < 1 ||
      input.teamIds.length > 100 ||
      new Set(input.teamIds).size !== input.teamIds.length ||
      input.teamIds.some((teamId) =>
        !teamId || teamId.length > 128 || /[:*?\u0000-\u001f\u007f]/.test(teamId))
    ) {
      throw new Error("reconcile team scope must contain unique exact team ids");
    }
    if (!input.cycleId || input.cycleId.length > 96) {
      throw new Error("reconcile cycle id is invalid");
    }
    if (!input.leaseToken || input.leaseToken.length > 128) {
      throw new Error("reconcile coordinator lease token is invalid");
    }
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 10_000 || input.leaseMs > 15 * 60_000) {
      throw new Error("reconcile coordinator lease is invalid");
    }
    return this.tx(() => {
      const currentRow = this.sql.exec<ReconcileCoordinatorDbRow>(
        "SELECT * FROM knowledge_reconcile_coordinator WHERE coordinator_key = ?",
        input.coordinatorKey,
      ).toArray()[0];
      const current = currentRow ? reconcileCoordinator(currentRow) : undefined;
      const configDrifted = Boolean(current && current.scopeDigest !== input.scopeDigest);
      if (current && (current.leaseExpiresAt ?? 0) > nowMs) {
        return { decision: "busy", coordinator: current };
      }
      const shouldStart = !current || configDrifted ||
        (current.status === "complete" && current.triggerId !== input.triggerId);
      if (!shouldStart && current) {
        if (current.status === "backoff" && current.nextAttemptAt > nowMs) {
          return { decision: "backoff", coordinator: current };
        }
        if (current.status === "complete") {
          return { decision: "complete", coordinator: current };
        }
        this.sql.exec(
          `UPDATE knowledge_reconcile_coordinator
           SET status = 'running', lease_token = ?, lease_expires_at = ?,
               next_attempt_at = ?, updated_at = ?
           WHERE coordinator_key = ?`,
          input.leaseToken,
          nowMs + input.leaseMs,
          nowMs,
          new Date(nowMs).toISOString(),
          input.coordinatorKey,
        );
      } else {
        const now = new Date(nowMs).toISOString();
        this.sql.exec(
          `INSERT INTO knowledge_reconcile_coordinator (
             coordinator_key, trigger_id, scope_digest, team_ids_json,
             cycle_id, team_index, active_run_id, status,
             lease_token, lease_expires_at, next_attempt_at,
             error_count, page_count, completed_team_count, config_drift_count,
             last_error_code, started_at, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, ?, 'running', ?, ?, ?, 0, 0, 0, ?,
                     NULL, ?, NULL, ?)
           ON CONFLICT(coordinator_key) DO UPDATE SET
             trigger_id = excluded.trigger_id,
             scope_digest = excluded.scope_digest,
             team_ids_json = excluded.team_ids_json,
             cycle_id = excluded.cycle_id,
             team_index = 0,
             active_run_id = excluded.active_run_id,
             status = 'running',
             lease_token = excluded.lease_token,
             lease_expires_at = excluded.lease_expires_at,
             next_attempt_at = excluded.next_attempt_at,
             error_count = 0,
             page_count = 0,
             completed_team_count = 0,
             config_drift_count = excluded.config_drift_count,
             last_error_code = NULL,
             started_at = excluded.started_at,
             completed_at = NULL,
             updated_at = excluded.updated_at`,
          input.coordinatorKey,
          input.triggerId,
          input.scopeDigest,
          JSON.stringify(input.teamIds),
          input.cycleId,
          `${input.cycleId}:0`,
          input.leaseToken,
          nowMs + input.leaseMs,
          nowMs,
          (current?.configDriftCount ?? 0) + (configDrifted ? 1 : 0),
          now,
          now,
        );
      }
      const claimed = this.sql.exec<ReconcileCoordinatorDbRow>(
        "SELECT * FROM knowledge_reconcile_coordinator WHERE coordinator_key = ?",
        input.coordinatorKey,
      ).toArray()[0];
      if (!claimed) throw new Error("reconcile coordinator was not persisted");
      return {
        decision: "acquired",
        coordinator: reconcileCoordinator(claimed),
        configDrifted,
      };
    });
  }

  checkpointReconcileCoordinatorPage(
    coordinatorKey: string,
    leaseToken: string,
    leaseMs: number,
    nowMs: number,
  ): KnowledgeReconcileCoordinator {
    if (!leaseToken) throw new Error("reconcile coordinator lease token is required");
    this.sql.exec(
      `UPDATE knowledge_reconcile_coordinator
       SET page_count = page_count + 1, lease_expires_at = ?, updated_at = ?
       WHERE coordinator_key = ? AND status = 'running' AND lease_token = ?
         AND lease_expires_at > ?`,
      nowMs + leaseMs,
      new Date(nowMs).toISOString(),
      coordinatorKey,
      leaseToken,
      nowMs,
    );
    return this.requireReconcileCoordinatorLease(coordinatorKey, leaseToken, nowMs);
  }

  advanceReconcileCoordinatorTeam(
    coordinatorKey: string,
    leaseToken: string,
    nowMs: number,
  ): KnowledgeReconcileCoordinator {
    return this.tx(() => {
      const current = this.requireReconcileCoordinatorLease(coordinatorKey, leaseToken, nowMs);
      const nextIndex = current.teamIndex + 1;
      const complete = nextIndex >= current.teamIds.length;
      const now = new Date(nowMs).toISOString();
      this.sql.exec(
        `UPDATE knowledge_reconcile_coordinator
         SET team_index = ?, active_run_id = ?, status = ?,
             completed_team_count = completed_team_count + 1,
             lease_token = ?, lease_expires_at = ?, completed_at = ?,
             updated_at = ?
         WHERE coordinator_key = ? AND lease_token = ?`,
        nextIndex,
        complete ? current.activeRunId : `${current.cycleId}:${nextIndex}`,
        complete ? "complete" : "running",
        complete ? null : leaseToken,
        complete ? null : current.leaseExpiresAt ?? nowMs,
        complete ? now : null,
        now,
        coordinatorKey,
        leaseToken,
      );
      return this.getReconcileCoordinator(coordinatorKey)!;
    });
  }

  releaseReconcileCoordinator(
    coordinatorKey: string,
    leaseToken: string,
    nowMs: number,
  ): KnowledgeReconcileCoordinator {
    this.requireReconcileCoordinatorLease(coordinatorKey, leaseToken, nowMs);
    this.sql.exec(
      `UPDATE knowledge_reconcile_coordinator
       SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE coordinator_key = ? AND lease_token = ?`,
      new Date(nowMs).toISOString(),
      coordinatorKey,
      leaseToken,
    );
    return this.getReconcileCoordinator(coordinatorKey)!;
  }

  failReconcileCoordinator(
    coordinatorKey: string,
    leaseToken: string,
    errorCode: string,
    retryAt: number,
    nowMs: number,
  ): KnowledgeReconcileCoordinator {
    this.requireReconcileCoordinatorLease(coordinatorKey, leaseToken, nowMs);
    if (!errorCode || errorCode.length > 256 || !Number.isSafeInteger(retryAt) || retryAt <= nowMs) {
      throw new Error("reconcile coordinator failure disposition is invalid");
    }
    this.sql.exec(
      `UPDATE knowledge_reconcile_coordinator
       SET status = 'backoff', lease_token = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, error_count = error_count + 1,
           last_error_code = ?, updated_at = ?
       WHERE coordinator_key = ? AND lease_token = ?`,
      retryAt,
      errorCode,
      new Date(nowMs).toISOString(),
      coordinatorKey,
      leaseToken,
    );
    return this.getReconcileCoordinator(coordinatorKey)!;
  }

  getReconcileCoordinator(coordinatorKey: string): KnowledgeReconcileCoordinator | undefined {
    const row = this.sql.exec<ReconcileCoordinatorDbRow>(
      "SELECT * FROM knowledge_reconcile_coordinator WHERE coordinator_key = ?",
      coordinatorKey,
    ).toArray()[0];
    return row ? reconcileCoordinator(row) : undefined;
  }

  private requireReconcileCoordinatorLease(
    coordinatorKey: string,
    leaseToken: string,
    nowMs: number,
  ): KnowledgeReconcileCoordinator {
    const coordinator = this.getReconcileCoordinator(coordinatorKey);
    if (
      !coordinator ||
      coordinator.leaseToken !== leaseToken ||
      coordinator.status !== "running" ||
      (coordinator.leaseExpiresAt ?? 0) <= nowMs
    ) {
      throw new Error("reconcile coordinator lease is not current");
    }
    return coordinator;
  }

  captureDlqRecord(input: {
    messageId: string;
    queueName: string;
    body: unknown;
    sourceKey?: string;
    teamId?: string;
    attempts: number;
    lastErrorCode?: string;
    capturedAt: string;
  }): DurableKnowledgeDlqRecord {
    const bodyJson = JSON.stringify(input.body);
    if (!input.messageId || input.messageId.length > 256) throw new Error("DLQ messageId is invalid");
    if (!input.queueName || input.queueName.length > 256) throw new Error("DLQ queueName is invalid");
    if (!bodyJson || bodyJson.length > 64 * 1024) throw new Error("DLQ body is invalid or too large");
    if (!Number.isSafeInteger(input.attempts) || input.attempts < 1 || input.attempts > 10_000) {
      throw new Error("DLQ attempts is invalid");
    }
    if (!Number.isFinite(Date.parse(input.capturedAt))) throw new Error("DLQ capturedAt is invalid");
    this.sql.exec(
      `INSERT OR IGNORE INTO knowledge_dlq_records (
         message_id, queue_name, body_json, source_key, team_id, attempts,
         last_error_code, status, captured_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.messageId,
      input.queueName,
      bodyJson,
      input.sourceKey ?? null,
      input.teamId ?? null,
      input.attempts,
      input.lastErrorCode?.slice(0, 256) ?? null,
      input.capturedAt,
      input.capturedAt,
    );
    const row = this.sql.exec<DlqDbRow>(
      "SELECT * FROM knowledge_dlq_records WHERE message_id = ?",
      input.messageId,
    ).toArray()[0];
    if (!row) throw new Error("DLQ record was not persisted");
    return dlqRecord(row);
  }

  listDlqRecords(cursor: number, limit: number): {
    records: DurableKnowledgeDlqRecord[];
    nextCursor?: number;
  } {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("DLQ cursor is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("DLQ inspection limit must be between 1 and 100");
    }
    const rows = this.sql.exec<DlqDbRow>(
      `SELECT * FROM knowledge_dlq_records
       WHERE id > ? ORDER BY id ASC LIMIT ?`,
      cursor,
      limit + 1,
    ).toArray();
    const visible = rows.slice(0, limit);
    return {
      records: visible.map(dlqRecord),
      ...(rows.length > limit ? { nextCursor: visible.at(-1)!.id } : {}),
    };
  }

  getDlqRecord(recordId: string): DurableKnowledgeDlqRecord | undefined {
    const row = this.sql.exec<DlqDbRow>(
      "SELECT * FROM knowledge_dlq_records WHERE id = ?",
      parseDlqRecordId(recordId),
    ).toArray()[0];
    return row ? dlqRecord(row) : undefined;
  }

  claimDlqReplay(
    recordId: string,
    replayReference: string,
    nowMs: number,
  ): DurableKnowledgeDlqRecord {
    const id = parseDlqRecordId(recordId);
    if (!replayReference || replayReference.length > 512) {
      throw new Error("DLQ replay reference is invalid");
    }
    return this.tx(() => {
      const current = this.sql.exec<DlqDbRow>(
        "SELECT * FROM knowledge_dlq_records WHERE id = ?",
        id,
      ).toArray()[0];
      if (!current) throw new Error("DLQ record does not exist");
      if (current.status === "replayed" || current.status === "disposed") {
        throw new Error("DLQ record already has a terminal replay disposition");
      }
      if (current.status === "pending") {
        const now = new Date(nowMs).toISOString();
        this.sql.exec(
          `UPDATE knowledge_dlq_records SET
             status = 'replaying', replay_requested_at = ?,
             replay_reference = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          now,
          replayReference,
          now,
          id,
        );
      }
      return dlqRecord(this.sql.exec<DlqDbRow>(
        "SELECT * FROM knowledge_dlq_records WHERE id = ?",
        id,
      ).toArray()[0]!);
    });
  }

  releaseDlqReplay(recordId: string, nowMs: number): void {
    this.sql.exec(
      `UPDATE knowledge_dlq_records SET
         status = 'pending', replay_requested_at = NULL,
         replay_reference = NULL, updated_at = ?
       WHERE id = ? AND status = 'replaying'`,
      new Date(nowMs).toISOString(),
      parseDlqRecordId(recordId),
    );
  }

  completeDlqReplay(
    recordId: string,
    disposition: KnowledgeDlqReplayDisposition,
    nowMs: number,
  ): DurableKnowledgeDlqRecord {
    const id = parseDlqRecordId(recordId);
    if (![
      "accepted",
      "accepted_response_lost",
      "duplicate",
      "converged",
      "superseded",
    ].includes(disposition)) {
      throw new Error("DLQ replay disposition is invalid");
    }
    const now = new Date(nowMs).toISOString();
    const replayed = disposition === "accepted";
    this.sql.exec(
      `UPDATE knowledge_dlq_records SET
         status = ?, replay_disposition = ?, replayed_at = ?,
         disposed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'replaying'`,
      replayed ? "replayed" : "disposed",
      disposition,
      replayed ? now : null,
      replayed ? null : now,
      now,
      id,
    );
    const row = this.sql.exec<DlqDbRow>(
      "SELECT * FROM knowledge_dlq_records WHERE id = ?",
      id,
    ).toArray()[0];
    if (!row || (row.status !== "replayed" && row.status !== "disposed")) {
      throw new Error("DLQ replay completion failed");
    }
    return dlqRecord(row);
  }

  private backfillDiscoveryRecord(
    row: BackfillDiscoveryDbRow,
    includeCandidates = false,
  ): DurableKnowledgeBackfillDiscovery {
    const channels = this.sql.exec<BackfillDiscoveryChannelDbRow>(
      `SELECT * FROM knowledge_backfill_discovery_channels
       WHERE manifest_id = ? ORDER BY channel_id ASC`,
      row.manifest_id,
    ).toArray().map((channel) => ({
      channelId: channel.channel_id,
      configVersion: channel.config_version,
      status: channel.status,
      cursor: channel.cursor ?? undefined,
      pageCount: channel.page_count,
    }));
    const count = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM knowledge_backfill_candidates WHERE manifest_id = ?",
      row.manifest_id,
    ).toArray()[0]?.count ?? 0;
    const candidates = includeCandidates
      ? this.sql.exec<BackfillCandidateDbRow>(
        `SELECT channel_id, thread_ts, observed_at
         FROM knowledge_backfill_candidates
         WHERE manifest_id = ?
         ORDER BY observed_at ASC, channel_id ASC, thread_ts ASC`,
        row.manifest_id,
      ).toArray().map(backfillCandidate)
      : undefined;
    return {
      manifestId: row.manifest_id,
      scopeDigest: row.scope_digest,
      scope: JSON.parse(row.scope_json) as KnowledgeBackfillScope,
      status: row.status,
      pages: channels.reduce((total, channel) => total + channel.pageCount, 0),
      candidateCount: count,
      channels,
      ...(candidates ? { candidates } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      blockedReason: row.blocked_reason ?? undefined,
    };
  }

  startBackfillDiscovery(input: {
    manifestId: string;
    scopeDigest: string;
    scope: KnowledgeBackfillScope;
    createdAt: string;
  }): DurableKnowledgeBackfillDiscovery {
    if (!input.manifestId || input.manifestId.length > 128) {
      throw new Error("backfill manifestId is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.scopeDigest)) {
      throw new Error("backfill scope digest is invalid");
    }
    if (
      input.scope.schemaVersion !== 2 ||
      input.scope.manifestId !== input.manifestId ||
      input.scope.channelIds.length === 0 ||
      input.scope.channelIds.length !== input.scope.sources.length ||
      input.scope.channelIds.some((channelId, index) =>
        channelId !== input.scope.sources[index]?.channelId) ||
      !Number.isFinite(Date.parse(input.createdAt))
    ) {
      throw new Error("backfill discovery scope is invalid");
    }
    const scopeJson = JSON.stringify(input.scope);
    return this.tx(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO knowledge_backfill_discoveries (
           manifest_id, scope_digest, scope_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'discovering', ?, ?)`,
        input.manifestId,
        input.scopeDigest,
        scopeJson,
        input.createdAt,
        input.createdAt,
      );
      const row = this.sql.exec<BackfillDiscoveryDbRow>(
        "SELECT * FROM knowledge_backfill_discoveries WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0];
      if (
        !row ||
        row.scope_digest !== input.scopeDigest ||
        row.scope_json !== scopeJson
      ) {
        throw new Error("backfill discovery identity conflict");
      }
      for (const source of input.scope.sources) {
        this.sql.exec(
          `INSERT OR IGNORE INTO knowledge_backfill_discovery_channels (
             manifest_id, channel_id, config_version, status, page_count,
             updated_at
           ) VALUES (?, ?, ?, 'unvisited', 0, ?)`,
          input.manifestId,
          source.channelId,
          source.configVersion,
          input.createdAt,
        );
      }
      const channels = this.sql.exec<BackfillDiscoveryChannelDbRow>(
        `SELECT * FROM knowledge_backfill_discovery_channels
         WHERE manifest_id = ? ORDER BY channel_id ASC`,
        input.manifestId,
      ).toArray();
      if (
        channels.length !== input.scope.sources.length ||
        channels.some((channel, index) =>
          channel.channel_id !== input.scope.sources[index]?.channelId ||
          channel.config_version !==
            input.scope.sources[index]?.configVersion)
      ) {
        throw new Error("backfill discovery channel identity conflict");
      }
      return this.backfillDiscoveryRecord(row);
    });
  }

  getBackfillDiscovery(
    manifestId: string,
    includeCandidates = false,
  ): DurableKnowledgeBackfillDiscovery | undefined {
    const row = this.sql.exec<BackfillDiscoveryDbRow>(
      "SELECT * FROM knowledge_backfill_discoveries WHERE manifest_id = ?",
      manifestId,
    ).toArray()[0];
    return row
      ? this.backfillDiscoveryRecord(row, includeCandidates)
      : undefined;
  }

  blockBackfillDiscovery(
    manifestId: string,
    scopeDigest: string,
    reason: string,
    nowMs: number,
  ): DurableKnowledgeBackfillDiscovery {
    if (reason !== "source_config_drift") {
      throw new Error("backfill discovery block reason is invalid");
    }
    return this.tx(() => {
      const row = this.sql.exec<BackfillDiscoveryDbRow>(
        "SELECT * FROM knowledge_backfill_discoveries WHERE manifest_id = ?",
        manifestId,
      ).toArray()[0];
      if (!row || row.scope_digest !== scopeDigest) {
        throw new Error("backfill discovery identity mismatch");
      }
      if (row.status === "complete") {
        throw new Error("completed backfill discovery cannot be blocked");
      }
      this.sql.exec(
        `UPDATE knowledge_backfill_discoveries
         SET status = 'blocked_config_drift', blocked_reason = ?,
             updated_at = ?
         WHERE manifest_id = ?`,
        reason,
        new Date(nowMs).toISOString(),
        manifestId,
      );
      return this.backfillDiscoveryRecord(
        this.sql.exec<BackfillDiscoveryDbRow>(
          "SELECT * FROM knowledge_backfill_discoveries WHERE manifest_id = ?",
          manifestId,
        ).toArray()[0]!,
      );
    });
  }

  mergeBackfillDiscoveryPage(input: {
    manifestId: string;
    scopeDigest: string;
    channelId: string;
    expectedStatus: "unvisited" | "pending";
    expectedCursor: string | null;
    nextStatus: "pending" | "exhausted";
    nextCursor: string | null;
    candidates: KnowledgeBackfillCandidate[];
    mergedAt: string;
  }): DurableKnowledgeBackfillDiscovery {
    if (
      !["unvisited", "pending"].includes(input.expectedStatus) ||
      !["pending", "exhausted"].includes(input.nextStatus) ||
      (input.nextStatus === "pending" && !input.nextCursor) ||
      (input.nextStatus === "exhausted" && input.nextCursor !== null) ||
      !Number.isFinite(Date.parse(input.mergedAt))
    ) {
      throw new Error("backfill discovery page state is invalid");
    }
    return this.tx(() => {
      const discovery = this.sql.exec<BackfillDiscoveryDbRow>(
        "SELECT * FROM knowledge_backfill_discoveries WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0];
      if (
        !discovery ||
        discovery.scope_digest !== input.scopeDigest ||
        discovery.status !== "discovering"
      ) {
        throw new Error("backfill discovery is not mergeable");
      }
      const scope = JSON.parse(discovery.scope_json) as KnowledgeBackfillScope;
      const channel = this.sql.exec<BackfillDiscoveryChannelDbRow>(
        `SELECT * FROM knowledge_backfill_discovery_channels
         WHERE manifest_id = ? AND channel_id = ?`,
        input.manifestId,
        input.channelId,
      ).toArray()[0];
      if (
        !channel ||
        channel.status !== input.expectedStatus ||
        channel.cursor !== input.expectedCursor
      ) {
        throw new Error("backfill discovery page was already advanced");
      }
      const from = Date.parse(scope.from);
      const to = Date.parse(scope.to);
      for (const candidate of input.candidates) {
        const observedAt = Date.parse(candidate.observedAt);
        if (
          candidate.channelId !== input.channelId ||
          !/^[0-9]+(?:\.[0-9]+)?$/.test(candidate.threadTs) ||
          !Number.isFinite(observedAt) ||
          observedAt < from ||
          observedAt > to
        ) {
          throw new Error("backfill discovery candidate is invalid");
        }
        this.sql.exec(
          `INSERT OR IGNORE INTO knowledge_backfill_candidates (
             manifest_id, channel_id, thread_ts, observed_at
           ) VALUES (?, ?, ?, ?)`,
          input.manifestId,
          candidate.channelId,
          candidate.threadTs,
          candidate.observedAt,
        );
      }
      this.sql.exec(
        `UPDATE knowledge_backfill_discovery_channels
         SET status = ?, cursor = ?, page_count = page_count + 1,
             updated_at = ?
         WHERE manifest_id = ? AND channel_id = ?`,
        input.nextStatus,
        input.nextCursor,
        input.mergedAt,
        input.manifestId,
        input.channelId,
      );
      const incomplete = this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM knowledge_backfill_discovery_channels
         WHERE manifest_id = ? AND status <> 'exhausted'`,
        input.manifestId,
      ).toArray()[0]?.count ?? 0;
      const count = this.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM knowledge_backfill_candidates WHERE manifest_id = ?`,
        input.manifestId,
      ).toArray()[0]?.count ?? 0;
      const status: KnowledgeBackfillDiscoveryStatus = incomplete > 0
        ? "discovering"
        : count > scope.executionBudget.maximumCount
          ? "complete_over_budget"
          : "complete";
      this.sql.exec(
        `UPDATE knowledge_backfill_discoveries
         SET status = ?, updated_at = ? WHERE manifest_id = ?`,
        status,
        input.mergedAt,
        input.manifestId,
      );
      return this.backfillDiscoveryRecord(
        this.sql.exec<BackfillDiscoveryDbRow>(
          "SELECT * FROM knowledge_backfill_discoveries WHERE manifest_id = ?",
          input.manifestId,
        ).toArray()[0]!,
      );
    });
  }

  putBackfillManifest(input: {
    manifestId: string;
    manifestDigest: string;
    manifest: KnowledgeBackfillManifest;
    createdAt: string;
  }): DurableBackfillManifestRecord {
    const manifestJson = JSON.stringify(input.manifest);
    if (!input.manifestId || input.manifestId.length > 128) {
      throw new Error("backfill manifestId is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.manifestDigest)) {
      throw new Error("backfill manifest digest is invalid");
    }
    if (!manifestJson || manifestJson.length > 1024 * 1024) {
      throw new Error("backfill manifest is too large");
    }
    return this.tx(() => {
      const discovery = this.getBackfillDiscovery(
        input.manifestId,
        true,
      );
      if (
        !discovery ||
        discovery.status !== "complete" ||
        !discovery.candidates ||
        input.manifest.schemaVersion !== 2 ||
        input.manifest.manifestId !== input.manifestId ||
        input.manifest.discovery.status !== "complete" ||
        input.manifest.discovery.channels.some((channel) =>
          channel.status !== "exhausted") ||
        input.manifest.count !== discovery.candidateCount ||
        input.manifest.count !== input.manifest.jobs.length ||
        input.manifest.count >
          input.manifest.executionBudget.maximumCount ||
        input.manifest.sourceKeys.length !== input.manifest.jobs.length
      ) {
        throw new Error("backfill manifest discovery is incomplete or invalid");
      }
      const scope = discovery.scope;
      const manifestScope = {
        schemaVersion: input.manifest.schemaVersion,
        manifestId: input.manifest.manifestId,
        teamId: input.manifest.teamId,
        projectId: input.manifest.projectId,
        channelIds: input.manifest.channelIds,
        sources: input.manifest.sources,
        from: input.manifest.from,
        to: input.manifest.to,
        executionBudget: input.manifest.executionBudget,
        releaseIds: input.manifest.releaseIds,
        rollbackOwner: input.manifest.rollbackOwner,
      };
      if (JSON.stringify(manifestScope) !== JSON.stringify(scope)) {
        throw new Error("backfill manifest scope differs from discovery");
      }
      for (let index = 0; index < discovery.candidates.length; index += 1) {
        const candidate = discovery.candidates[index]!;
        const job = input.manifest.jobs[index];
        const source = scope.sources.find((entry) =>
          entry.channelId === candidate.channelId);
        if (
          !job ||
          !source ||
          job.teamId !== scope.teamId ||
          job.projectId !== scope.projectId ||
          job.channelId !== candidate.channelId ||
          job.threadTs !== candidate.threadTs ||
          job.requestedAt !== candidate.observedAt ||
          job.configVersion !== source.configVersion ||
          job.reason !== "backfill" ||
          input.manifest.sourceKeys[index] !== job.sourceKey
        ) {
          throw new Error("backfill manifest jobs differ from discovery");
        }
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO knowledge_backfill_manifests (
           manifest_id, manifest_digest, manifest_json, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'dry_run', ?, ?)`,
        input.manifestId,
        input.manifestDigest,
        manifestJson,
        input.createdAt,
        input.createdAt,
      );
      const row = this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0];
      if (
        !row ||
        row.manifest_digest !== input.manifestDigest ||
        row.manifest_json !== manifestJson
      ) {
        throw new Error("backfill manifest identity conflict");
      }
      return backfillManifestRecord(row);
    });
  }

  getBackfillManifest(
    manifestId: string,
  ): DurableBackfillManifestRecord | undefined {
    const row = this.sql.exec<BackfillManifestDbRow>(
      "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
      manifestId,
    ).toArray()[0];
    return row ? backfillManifestRecord(row) : undefined;
  }

  assertBackfillApprovalActive(
    manifestId: string,
    manifestDigest: string,
    nowMs: number,
  ): void {
    const row = this.sql.exec<BackfillManifestDbRow>(
      "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
      manifestId,
    ).toArray()[0];
    if (
      !row ||
      row.manifest_digest !== manifestDigest ||
      row.approval_gate !== "P1" ||
      !row.approval_reference
    ) {
      throw new Error("backfill execution has no verified P1 approval");
    }
    const approval = this.sql.exec<BackfillApprovalDbRow>(
      "SELECT * FROM knowledge_backfill_approvals WHERE approval_id = ?",
      row.approval_reference,
    ).toArray()[0];
    if (
      !approval ||
      approval.manifest_id !== manifestId ||
      approval.manifest_digest !== manifestDigest ||
      Date.parse(approval.expires_at) <= nowMs
    ) {
      throw new Error("backfill P1 approval is missing or expired");
    }
  }

  listBackfillApprovalAudit(
    manifestId: string,
  ): DurableBackfillApprovalAudit[] {
    return this.sql.exec<BackfillApprovalDbRow>(
      `SELECT * FROM knowledge_backfill_approvals
       WHERE manifest_id = ? ORDER BY consumed_at ASC, approval_id ASC`,
      manifestId,
    ).toArray().map((approval) => ({
      approvalId: approval.approval_id,
      artifactDigest: approval.artifact_digest,
      approverId: approval.approver_id,
      manifestId: approval.manifest_id,
      manifestDigest: approval.manifest_digest,
      issuedAt: approval.issued_at,
      expiresAt: approval.expires_at,
      supersedesApprovalId:
        approval.supersedes_approval_id ?? undefined,
      consumedAt: approval.consumed_at,
    }));
  }

  approveBackfillManifest(
    approval: VerifiedKnowledgeBackfillApproval,
    nowMs: number,
  ): DurableBackfillManifestRecord {
    return this.tx(() => {
      const replay = this.sql.exec<BackfillApprovalDbRow>(
        "SELECT * FROM knowledge_backfill_approvals WHERE approval_id = ?",
        approval.approvalId,
      ).toArray()[0];
      if (replay) throw new Error("knowledge_backfill_approval_replayed");
      const row = this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        approval.manifestId,
      ).toArray()[0];
      if (!row) throw new Error("backfill manifest does not exist");
      if (row.manifest_digest !== approval.manifestDigest) {
        throw new Error("backfill manifest is not awaiting this approval");
      }
      let supersedesApprovalId: string | null = null;
      if (row.status === "dry_run") {
        if (row.approval_reference) {
          throw new Error("backfill dry-run manifest has approval state");
        }
      } else if (row.status === "approved" || row.status === "running") {
        if (!row.approval_reference) {
          throw new Error("backfill execution has no prior P1 approval");
        }
        const currentApproval = this.sql.exec<BackfillApprovalDbRow>(
          "SELECT * FROM knowledge_backfill_approvals WHERE approval_id = ?",
          row.approval_reference,
        ).toArray()[0];
        if (
          !currentApproval ||
          currentApproval.manifest_id !== approval.manifestId ||
          currentApproval.manifest_digest !== approval.manifestDigest
        ) {
          throw new Error("backfill prior P1 approval audit is invalid");
        }
        if (
          Date.parse(currentApproval.expires_at) > nowMs ||
          Date.parse(approval.issuedAt) <
            Date.parse(currentApproval.expires_at)
        ) {
          throw new Error("knowledge_backfill_approval_overlap");
        }
        if (
          approval.maximumCount > currentApproval.maximum_count ||
          approval.maximumRatePerMinute >
            currentApproval.maximum_rate_per_minute ||
          approval.maximumErrors > currentApproval.maximum_errors
        ) {
          throw new Error("knowledge_backfill_approval_budget_loosened");
        }
        supersedesApprovalId = currentApproval.approval_id;
      } else {
        throw new Error("backfill manifest is not awaiting this approval");
      }
      const manifest = JSON.parse(row.manifest_json) as KnowledgeBackfillManifest;
      const discovery = this.getBackfillDiscovery(approval.manifestId);
      if (
        !discovery ||
        discovery.status !== "complete" ||
        manifest.discovery.status !== "complete" ||
        manifest.count > approval.maximumCount ||
        manifest.teamId !== approval.teamId ||
        manifest.projectId !== approval.projectId ||
        JSON.stringify(manifest.channelIds) !==
          JSON.stringify(approval.channelIds) ||
        manifest.from !== approval.from ||
        manifest.to !== approval.to ||
        !Number.isSafeInteger(approval.maximumCount) ||
        approval.maximumCount < manifest.count ||
        approval.maximumCount > manifest.executionBudget.maximumCount ||
        !Number.isSafeInteger(approval.maximumRatePerMinute) ||
        approval.maximumRatePerMinute < 1 ||
        approval.maximumRatePerMinute >
          manifest.executionBudget.maximumRatePerMinute ||
        !Number.isSafeInteger(approval.maximumErrors) ||
        approval.maximumErrors < 0 ||
        approval.maximumErrors > manifest.executionBudget.maximumErrors ||
        JSON.stringify(manifest.releaseIds) !==
          JSON.stringify(approval.releaseIds) ||
        manifest.rollbackOwner !== approval.rollbackOwner
      ) {
        throw new Error("backfill approval scope or budget mismatch");
      }
      if (Date.parse(approval.expiresAt) <= nowMs) {
        throw new Error("knowledge_backfill_approval_expired");
      }
      let rateWindowStartedAt = row.rate_window_started_at;
      let rateWindowReserved = row.rate_window_reserved;
      let pendingUnclassified = 0;
      if (supersedesApprovalId && row.pending_page_json) {
        const pendingJobs = JSON.parse(
          row.pending_page_json,
        ) as KnowledgeJob[];
        const pendingResults = row.pending_results_json
          ? JSON.parse(row.pending_results_json) as Record<
            string,
            KnowledgeBackfillPageDisposition
          >
          : {};
        pendingUnclassified = pendingJobs.filter((job) =>
          pendingResults[knowledgeDescriptorKey(job)] === undefined
        ).length;
        if (pendingUnclassified > approval.maximumRatePerMinute) {
          throw new Error(
            "knowledge_backfill_approval_budget_incompatible_with_pending_page",
          );
        }
      }
      if (
        supersedesApprovalId &&
        row.pending_page_json &&
        (
          rateWindowStartedAt === null ||
          nowMs - rateWindowStartedAt >= 60_000
        )
      ) {
        rateWindowStartedAt = nowMs;
        rateWindowReserved = pendingUnclassified;
      }
      const consumedAt = new Date(nowMs).toISOString();
      this.sql.exec(
        `INSERT INTO knowledge_backfill_approvals (
           approval_id, artifact_digest, issuer, key_id, approver_kind,
           approver_id, manifest_id, manifest_digest, team_id, project_id,
           channel_ids_json, from_time, to_time, maximum_count,
           maximum_rate_per_minute, maximum_errors, release_ids_json,
           rollback_owner, issued_at, expires_at, supersedes_approval_id,
           consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        approval.approvalId,
        approval.artifactDigest,
        approval.issuer,
        approval.keyId,
        approval.approverKind,
        approval.approverId,
        approval.manifestId,
        approval.manifestDigest,
        approval.teamId,
        approval.projectId,
        JSON.stringify(approval.channelIds),
        approval.from,
        approval.to,
        approval.maximumCount,
        approval.maximumRatePerMinute,
        approval.maximumErrors,
        JSON.stringify(approval.releaseIds),
        approval.rollbackOwner,
        approval.issuedAt,
        approval.expiresAt,
        supersedesApprovalId,
        consumedAt,
      );
      this.sql.exec(
        `UPDATE knowledge_backfill_manifests SET
           status = CASE WHEN status = 'dry_run' THEN 'approved' ELSE status END,
           approval_gate = 'P1',
           approval_reference = ?, approved_by = ?, approved_at = ?,
           rate_window_started_at = ?, rate_window_reserved = ?,
           updated_at = ?
         WHERE manifest_id = ?`,
        approval.approvalId,
        approval.approverId,
        approval.issuedAt,
        rateWindowStartedAt,
        rateWindowReserved,
        consumedAt,
        approval.manifestId,
      );
      return backfillManifestRecord(this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        approval.manifestId,
      ).toArray()[0]!);
    });
  }

  claimBackfillPage(
    manifestId: string,
    manifestDigest: string,
    limit: number,
    nowMs: number,
  ): DurableBackfillManifestRecord {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error(
        "backfill execution batch limit must be between 1 and 25",
      );
    }
    return this.tx(() => {
      const row = this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        manifestId,
      ).toArray()[0];
      if (!row) throw new Error("backfill manifest does not exist");
      if (row.manifest_digest !== manifestDigest) {
        throw new Error("backfill manifest digest mismatch");
      }
      if (row.status === "complete") return backfillManifestRecord(row);
      if (row.approval_gate !== "P1" || !row.approval_reference) {
        throw new Error(
          "backfill execution requires independently verified P1 approval",
        );
      }
      const approval = this.sql.exec<BackfillApprovalDbRow>(
        "SELECT * FROM knowledge_backfill_approvals WHERE approval_id = ?",
        row.approval_reference,
      ).toArray()[0];
      if (
        !approval ||
        approval.manifest_id !== manifestId ||
        approval.manifest_digest !== manifestDigest ||
        Date.parse(approval.expires_at) <= nowMs
      ) {
        throw new Error("backfill P1 approval is missing or expired");
      }
      const manifest = JSON.parse(row.manifest_json) as KnowledgeBackfillManifest;
      if (
        manifest.schemaVersion !== 2 ||
        manifest.discovery.status !== "complete" ||
        manifest.count !== manifest.jobs.length ||
        manifest.count > approval.maximum_count
      ) {
        throw new Error("backfill manifest is incomplete or over budget");
      }
      if (row.execution_error_count > approval.maximum_errors) {
        throw new Error("backfill execution error budget exhausted");
      }
      if (row.pending_page_token && row.pending_page_json) {
        return backfillManifestRecord(row);
      }
      if (row.status !== "approved" && row.status !== "running") {
        throw new Error("backfill manifest is not executable");
      }
      let windowStartedAt = row.rate_window_started_at;
      let reserved = row.rate_window_reserved;
      if (
        windowStartedAt === null ||
        nowMs - windowStartedAt >= 60_000
      ) {
        windowStartedAt = nowMs;
        reserved = 0;
      }
      const available = approval.maximum_rate_per_minute - reserved;
      if (available < 1) {
        throw new Error("backfill execution rate budget exhausted");
      }
      const jobs = manifest.jobs.slice(
        row.next_job_index,
        row.next_job_index + Math.min(limit, available),
      );
      if (jobs.length === 0) {
        this.sql.exec(
          `UPDATE knowledge_backfill_manifests
           SET status = 'complete', updated_at = ? WHERE manifest_id = ?`,
          new Date(nowMs).toISOString(),
          manifestId,
        );
      } else {
        this.sql.exec(
          `UPDATE knowledge_backfill_manifests SET
             status = 'running', pending_page_token = ?,
             pending_page_json = ?, pending_end_index = ?,
             pending_results_json = '{}', pending_error_json = NULL,
             rate_window_started_at = ?, rate_window_reserved = ?,
             updated_at = ?
           WHERE manifest_id = ? AND pending_page_token IS NULL`,
          crypto.randomUUID(),
          JSON.stringify(jobs),
          row.next_job_index + jobs.length,
          windowStartedAt,
          reserved + jobs.length,
          new Date(nowMs).toISOString(),
          manifestId,
        );
      }
      return backfillManifestRecord(this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        manifestId,
      ).toArray()[0]!);
    });
  }

  recordBackfillJobDisposition(input: {
    manifestId: string;
    manifestDigest: string;
    pageToken: string;
    descriptorKey: string;
    disposition: KnowledgeBackfillPageDisposition;
  }, nowMs: number): DurableBackfillManifestRecord {
    const safe = [
      "accepted",
      "accepted_response_lost",
      "duplicate",
      "converged",
      "superseded",
    ] as const;
    if (!(safe as readonly string[]).includes(input.disposition)) {
      throw new Error("backfill job disposition is not safe");
    }
    return this.tx(() => {
      const row = this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0];
      if (
        !row ||
        row.manifest_digest !== input.manifestDigest ||
        row.pending_page_token !== input.pageToken ||
        !row.pending_page_json
      ) {
        throw new Error("backfill page identity mismatch");
      }
      this.assertBackfillApprovalActive(
        input.manifestId,
        input.manifestDigest,
        nowMs,
      );
      const jobs = JSON.parse(row.pending_page_json) as KnowledgeJob[];
      if (!jobs.some((job) =>
        knowledgeDescriptorKey(job) === input.descriptorKey)) {
        throw new Error("backfill result is not in the pending page");
      }
      const results = row.pending_results_json
        ? JSON.parse(row.pending_results_json) as Record<
          string,
          KnowledgeBackfillPageDisposition
        >
        : {};
      const prior = results[input.descriptorKey];
      if (prior && prior !== input.disposition) {
        throw new Error("backfill job disposition conflict");
      }
      results[input.descriptorKey] = input.disposition;
      this.sql.exec(
        `UPDATE knowledge_backfill_manifests
         SET pending_results_json = ?, pending_error_json = NULL,
             updated_at = ?
         WHERE manifest_id = ? AND pending_page_token = ?`,
        JSON.stringify(results),
        new Date(nowMs).toISOString(),
        input.manifestId,
        input.pageToken,
      );
      return backfillManifestRecord(this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0]!);
    });
  }

  recordBackfillPageFailure(input: {
    manifestId: string;
    manifestDigest: string;
    pageToken: string;
    descriptorKey: string;
    errorCode: string;
  }, nowMs: number): DurableBackfillManifestRecord {
    if (!input.errorCode || input.errorCode.length > 256) {
      throw new Error("backfill page error code is invalid");
    }
    return this.tx(() => {
      const row = this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0];
      if (
        !row ||
        row.manifest_digest !== input.manifestDigest ||
        row.pending_page_token !== input.pageToken ||
        !row.pending_page_json
      ) {
        throw new Error("backfill page identity mismatch");
      }
      this.assertBackfillApprovalActive(
        input.manifestId,
        input.manifestDigest,
        nowMs,
      );
      const jobs = JSON.parse(row.pending_page_json) as KnowledgeJob[];
      if (!jobs.some((job) =>
        knowledgeDescriptorKey(job) === input.descriptorKey)) {
        throw new Error("backfill page failure is not in the pending page");
      }
      const recordedAt = new Date(nowMs).toISOString();
      const nextError = {
        descriptorKey: input.descriptorKey,
        errorCode: input.errorCode,
        recordedAt,
      };
      this.sql.exec(
        `UPDATE knowledge_backfill_manifests
         SET pending_error_json = ?,
             execution_error_count = execution_error_count + 1,
             updated_at = ?
         WHERE manifest_id = ? AND pending_page_token = ?`,
        JSON.stringify(nextError),
        recordedAt,
        input.manifestId,
        input.pageToken,
      );
      return backfillManifestRecord(this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        input.manifestId,
      ).toArray()[0]!);
    });
  }

  commitBackfillPage(
    manifestId: string,
    manifestDigest: string,
    pageToken: string,
    nowMs: number,
  ): DurableBackfillManifestRecord {
    return this.tx(() => {
      const row = this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        manifestId,
      ).toArray()[0];
      if (
        !row ||
        row.manifest_digest !== manifestDigest ||
        !pageToken ||
        row.pending_page_token !== pageToken ||
        row.pending_end_index === null ||
        !row.pending_page_json
      ) {
        throw new Error("backfill page token is not current");
      }
      this.assertBackfillApprovalActive(
        manifestId,
        manifestDigest,
        nowMs,
      );
      const jobs = JSON.parse(row.pending_page_json) as KnowledgeJob[];
      const results = row.pending_results_json
        ? JSON.parse(row.pending_results_json) as Record<
          string,
          KnowledgeBackfillPageDisposition
        >
        : {};
      if (jobs.some((job) => !results[knowledgeDescriptorKey(job)])) {
        throw new Error("backfill page has unclassified jobs");
      }
      const manifest = JSON.parse(row.manifest_json) as KnowledgeBackfillManifest;
      const complete = row.pending_end_index >= manifest.jobs.length;
      this.sql.exec(
        `UPDATE knowledge_backfill_manifests SET
           status = ?, next_job_index = pending_end_index,
           pending_page_token = NULL, pending_page_json = NULL,
           pending_end_index = NULL, pending_results_json = NULL,
           pending_error_json = NULL, updated_at = ?
         WHERE manifest_id = ? AND pending_page_token = ?`,
        complete ? "complete" : "running",
        new Date(nowMs).toISOString(),
        manifestId,
        pageToken,
      );
      return backfillManifestRecord(this.sql.exec<BackfillManifestDbRow>(
        "SELECT * FROM knowledge_backfill_manifests WHERE manifest_id = ?",
        manifestId,
      ).toArray()[0]!);
    });
  }

  get(sourceKey: string): KnowledgeLedgerRow | undefined {
    const row = this.sql.exec<LedgerDbRow>(
      `SELECT * FROM knowledge_ledger WHERE source_key = ?`,
      sourceKey,
    ).toArray()[0];
    return row ? ledgerRow(row) : undefined;
  }

  getOutbox(sourceKey: string): {
    descriptorKey: string;
    job: KnowledgeJob;
    status: string;
    attemptCount: number;
    lastError?: string;
  } | undefined {
    const row = this.sql.exec<OutboxDbRow>(
      `SELECT * FROM knowledge_outbox WHERE source_key = ?`,
      sourceKey,
    ).toArray()[0];
    return row ? {
      descriptorKey: row.descriptor_key,
      job: JSON.parse(row.job_json) as KnowledgeJob,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error ?? undefined,
    } : undefined;
  }
}
