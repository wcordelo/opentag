import { createKnowledgeJob, slackSourceKey, type KnowledgeJob } from "./knowledge-contract.js";
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
import type { SlackConversationInventoryReceipt } from "../slack/conversation-inventory.js";
import type {
  VerifiedKnowledgeBackfillApproval,
} from "./knowledge-backfill-authorization.js";
import { normalizeDerivedIndexGeneration } from "./derived-index-generation.js";
import {
  knowledgeLedgerTableSql,
  knowledgeQueryabilityTableSql,
  migrateKnowledgeQueryability,
  migrateKnowledgeLedgerSourceTypes,
} from "./knowledge-ledger-migration.js";
import {
  parseKnowledgeSourceType,
  parseSourceTypeFromKey,
} from "./knowledge-source-types.js";

export const KNOWLEDGE_LEDGER_DDL = [
  knowledgeLedgerTableSql("knowledge_ledger"),
  `CREATE TABLE IF NOT EXISTS knowledge_events (
    descriptor_key TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'slack',
    config_version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_outbox (
    source_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'slack',
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
  `CREATE TABLE IF NOT EXISTS knowledge_ledger_derived_history (
    source_key TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'slack',
    index_generation TEXT NOT NULL,
    local_document_id TEXT,
    local_document_revision TEXT,
    indexed_revision TEXT,
    status TEXT NOT NULL,
    archive_reason TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    PRIMARY KEY (source_key, index_generation)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_query_convergence (
    source_key TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'slack',
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    content_revision TEXT NOT NULL,
    index_generation TEXT NOT NULL,
    local_document_id TEXT NOT NULL,
    query_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_result_count INTEGER NOT NULL,
    matching_citation_count INTEGER NOT NULL,
    error_code TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (source_key, content_revision, index_generation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_query_convergence_current
   ON knowledge_query_convergence(source_key, checked_at)`,
  knowledgeQueryabilityTableSql(),
  `CREATE TABLE IF NOT EXISTS knowledge_recovery_audits (
    audit_id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'slack',
    team_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    correction_ref TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_status TEXT NOT NULL,
    previous_error_class TEXT,
    previous_error_code TEXT,
    previous_local_operation TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_recovery_audits_created
   ON knowledge_recovery_audits(created_at, audit_id)`,
  `CREATE TABLE IF NOT EXISTS knowledge_thread_fetch_checkpoints (
    source_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'slack',
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    cursor TEXT,
    pages INTEGER NOT NULL,
    messages_json TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_thread_fetch_checkpoints_updated
   ON knowledge_thread_fetch_checkpoints(updated_at)`,
  `CREATE TABLE IF NOT EXISTS knowledge_slack_message_threads (
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    source_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, channel_id, message_ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_slack_message_threads_source
   ON knowledge_slack_message_threads(source_key, updated_at)`,
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
    source_type TEXT NOT NULL DEFAULT 'slack',
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
  `CREATE TABLE IF NOT EXISTS knowledge_backfill_conversation_inventories (
    manifest_id TEXT PRIMARY KEY,
    inventory_digest TEXT NOT NULL,
    inventory_json TEXT NOT NULL,
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
  sourceType: KnowledgeJob["sourceType"];
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
  derivedIndexGeneration?: string;
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

export type KnowledgeQueryConvergenceStatus = "queryable" | "not_found" | "failed";

export type KnowledgeQueryConvergenceReceipt = {
  sourceKey: string;
  sourceType: KnowledgeJob["sourceType"];
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  contentRevision: string;
  indexGeneration: string;
  localDocumentId: string;
  queryDigest: string;
  status: KnowledgeQueryConvergenceStatus;
  providerResultCount: number;
  matchingCitationCount: number;
  errorCode?: string;
  checkedAt: string;
};

export type KnowledgeQueryabilityReceiptStatus =
  | "unverified"
  | "searchable"
  | "no_match"
  | "provider_unavailable";

export type KnowledgeQueryabilityReceiptIdentity = {
  sourceKey: string;
  sourceType: KnowledgeJob["sourceType"];
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  contentRevision: string;
  indexRevision: string;
  localDocumentId: string;
  derivedIndexGeneration: string;
};

export type KnowledgeQueryabilityReceipt = KnowledgeQueryabilityReceiptIdentity & {
  status: KnowledgeQueryabilityReceiptStatus;
  providerResultCount: number;
  acceptedCitationCount: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeQueryabilityReceiptInput = KnowledgeQueryabilityReceiptIdentity & {
  status: KnowledgeQueryabilityReceiptStatus;
  providerResultCount: number;
  acceptedCitationCount: number;
};

export type KnowledgeFailureRow = Pick<KnowledgeLedgerRow,
  | "sourceKey"
  | "sourceType"
  | "teamId"
  | "projectId"
  | "channelId"
  | "threadTs"
  | "configVersion"
  | "requestedAt"
  | "reason"
  | "lastLocalOperation"
  | "lastLocalError"
  | "status"
  | "queueAttempts"
  | "lastErrorClass"
  | "lastErrorCode"
  | "incompleteReason"
  | "tombstonedAt"
  | "createdAt"
  | "updatedAt"
>;

export type KnowledgeFailureList = {
  rows: KnowledgeFailureRow[];
  nextCursor?: string;
};

type LedgerDbRow = {
  source_key: string;
  source_type: KnowledgeJob["sourceType"];
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
  derived_index_generation: string | null;
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

type KnowledgeQueryConvergenceDbRow = {
  source_key: string;
  source_type: KnowledgeJob["sourceType"];
  team_id: string;
  project_id: string;
  channel_id: string;
  thread_ts: string;
  content_revision: string;
  index_generation: string;
  local_document_id: string;
  query_digest: string;
  status: KnowledgeQueryConvergenceStatus;
  provider_result_count: number;
  matching_citation_count: number;
  error_code: string | null;
  checked_at: string;
};

type KnowledgeQueryabilityReceiptDbRow = {
  source_key: string;
  source_type: KnowledgeJob["sourceType"];
  team_id: string;
  project_id: string;
  channel_id: string;
  thread_ts: string;
  content_revision: string;
  index_revision: string;
  local_document_id: string;
  derived_index_generation: string;
  status: KnowledgeQueryabilityReceiptStatus;
  provider_result_count: number;
  accepted_citation_count: number;
  created_at: string;
  updated_at: string;
};

type OutboxDbRow = {
  source_key: string;
  source_type: KnowledgeJob["sourceType"];
  descriptor_key: string;
  job_json: string;
  status: "pending" | "sending";
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  updated_at: string;
};

export type KnowledgeThreadFetchCheckpoint = {
  cursor?: string;
  pages: number;
  messages: unknown[];
  bytes: number;
};

export type SlackMessageThreadMapping = {
  teamId: string;
  projectId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  sourceKey: string;
  updatedAt: string;
};

type ThreadFetchCheckpointDbRow = {
  source_key: string;
  source_type: KnowledgeJob["sourceType"];
  team_id: string;
  project_id: string;
  channel_id: string;
  thread_ts: string;
  config_version: number;
  requested_at: string;
  cursor: string | null;
  pages: number;
  messages_json: string;
  message_count: number;
  bytes: number;
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
  source_type: KnowledgeJob["sourceType"];
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

type BackfillConversationInventoryDbRow = {
  manifest_id: string;
  inventory_digest: string;
  inventory_json: string;
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
  | { decision: "noop"; reason: "missing" | "stale_descriptor" | "already_complete" | "config_drift" | "permanent_failure" }
  | { decision: "retry"; reason: "lease_active"; retryAfterSeconds: number };

export type KnowledgeOutcome =
  | { status: "normalized"; desiredRevision: string }
  | { status: "indexed"; desiredRevision: string; indexedRevision: string; localDocumentId: string; workflowStatus: "done"; pollCount: number; indexGeneration?: string }
  | { status: "processing_unconfirmed"; desiredRevision: string; localDocumentId: string; workflowStatus: string; pollDeadlineAt: number; nextPollAt: number; pollCount: number; indexGeneration?: string }
  | { status: "tombstoned"; tombstonedAt: string; errorCode?: "unsupported_delete_contract" | "deleted" }
  | {
    status: "preserve_indexed";
    errorClass: "unsupported_capability";
    errorCode: "unsupported_update_contract";
  }
  | { status: "retryable_failure"; errorClass: string; errorCode?: string; incompleteReason?: string }
  | { status: "permanent_failure"; errorClass: string; errorCode?: string };

export type KnowledgeRecoveryResult =
  | {
    action: "reopened";
    sourceKey: string;
    auditId: string;
    descriptorKey: string;
    requestedAt: string;
  }
  | {
    action: "blocked";
    sourceKey: string;
    auditId?: string;
    reason:
      | "not_found"
      | "identity_mismatch"
      | "not_permanent_failure"
      | "tombstoned"
      | "unsupported_failure"
      | "ambiguous_add_contract"
      | "missing_local_document_identity"
      | "delete_intent";
  };

export type PrepareRevisionResult =
  | { decision: "add" }
  | { decision: "update"; localDocumentId: string }
  | { decision: "poll"; localDocumentId: string; pollDeadlineAt?: number }
  | { decision: "noop"; reason: "already_indexed" }
  | { decision: "blocked"; reason: "tombstoned" | "unsupported_update_contract" | "ambiguous_add_contract" | "index_generation_mismatch" };

export type ResolveAmbiguousAddResult =
  | { decision: "add" }
  | { decision: "poll"; localDocumentId: string; pollDeadlineAt: number };

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

export type KnowledgeLedgerStatusSnapshot = {
  capturedAt: string;
  ledger: {
    total: number;
    byStatus: Partial<Record<KnowledgeLedgerStatus, number>>;
  };
  outbox: {
    pending: number;
    sending: number;
    due: number;
    earliestPendingAt?: number;
  };
  dlq: {
    total: number;
    pending: number;
    replaying: number;
    replayed: number;
    disposed: number;
  };
  reconciliation: {
    running: number;
    complete: number;
    latest?: KnowledgeReconcileRun;
  };
  backfill: {
    active: number;
    complete: number;
    latest?: {
      manifestId: string;
      status: DurableBackfillManifestRecord["status"];
      nextJobIndex: number;
      executionErrorCount: number;
      updatedAt: string;
    };
  };
  threadFetch: {
    active: number;
    messages: number;
    bytes: number;
    oldestUpdatedAt?: string;
  };
  inventory: {
    total: number;
    complete: number;
    incomplete: number;
    invalid: number;
    latest?: {
      manifestId: string;
      status: "complete" | "incomplete" | "invalid";
      visibleCount: number;
      eligibleCount: number;
      excludedCount: number;
      inventoryDigest: string;
      updatedAt: string;
    };
  };
  messageThreadMap: {
    total: number;
    oldestUpdatedAt?: string;
    newestUpdatedAt?: string;
  };
  queryConvergence: {
    total: number;
    queryable: number;
    notFound: number;
    failed: number;
    unverified: number;
  };
  queryability: {
    total: number;
    byStatus: Record<KnowledgeQueryabilityReceiptStatus, number>;
  };
  recovery: {
    total: number;
    reopened: number;
    blocked: number;
    latest?: {
      auditId: string;
      sourceKey: string;
      action: "reopened" | "blocked";
      reason: string;
      createdAt: string;
    };
  };
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
  sourceType: KnowledgeJob["sourceType"];
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
  return `${job.sourceType}|${job.sourceKey}|${job.configVersion}|${job.requestedAt}|${job.reason}${
    job.messageTs ? `|${job.messageTs}` : ""
  }${job.observedMessageTs ? `|observed:${job.observedMessageTs}` : ""}`;
}

function ledgerRow(row: LedgerDbRow): KnowledgeLedgerRow {
  return {
    sourceKey: row.source_key,
    sourceType: row.source_type,
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
    derivedIndexGeneration: row.derived_index_generation ?? undefined,
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

function queryConvergenceReceipt(row: KnowledgeQueryConvergenceDbRow): KnowledgeQueryConvergenceReceipt {
  return {
    sourceKey: row.source_key,
    sourceType: row.source_type,
    teamId: row.team_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    contentRevision: row.content_revision,
    indexGeneration: row.index_generation,
    localDocumentId: row.local_document_id,
    queryDigest: row.query_digest,
    status: row.status,
    providerResultCount: row.provider_result_count,
    matchingCitationCount: row.matching_citation_count,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    checkedAt: row.checked_at,
  };
}

const QUERYABILITY_RECEIPT_STATUSES: readonly KnowledgeQueryabilityReceiptStatus[] = [
  "unverified",
  "searchable",
  "no_match",
  "provider_unavailable",
];
const MAX_QUERYABILITY_COUNT = 100_000;

function boundedReceiptText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`knowledge queryability ${field} is invalid`);
  }
  return value;
}

function boundedReceiptRevision(value: unknown, field: string): string {
  const revision = boundedReceiptText(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(revision)) {
    throw new Error(`knowledge queryability ${field} is invalid`);
  }
  return revision;
}

function boundedReceiptIdentifier(value: unknown, field: string, maxLength: number): string {
  const identifier = boundedReceiptText(value, field, maxLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(identifier)) {
    throw new Error(`knowledge queryability ${field} is invalid`);
  }
  return identifier;
}

function boundedReceiptGeneration(value: unknown): string {
  const generation = boundedReceiptText(value, "derivedIndexGeneration", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generation) || generation === "legacy") {
    throw new Error("knowledge queryability derivedIndexGeneration is invalid");
  }
  return generation;
}

function queryabilityIdentity(
  input: KnowledgeQueryabilityReceiptIdentity,
): KnowledgeQueryabilityReceiptIdentity {
  const sourceKey = boundedReceiptText(input.sourceKey, "sourceKey", 512);
  const sourceType = parseKnowledgeSourceType(input.sourceType);
  if (parseSourceTypeFromKey(sourceKey) !== sourceType) {
    throw new Error("knowledge queryability source identity is invalid");
  }
  return {
    sourceKey,
    sourceType,
    teamId: boundedReceiptIdentifier(input.teamId, "teamId", 128),
    projectId: boundedReceiptIdentifier(input.projectId, "projectId", 128),
    channelId: boundedReceiptIdentifier(input.channelId, "channelId", 256),
    threadTs: boundedReceiptIdentifier(input.threadTs, "threadTs", 256),
    contentRevision: boundedReceiptRevision(input.contentRevision, "contentRevision"),
    indexRevision: boundedReceiptRevision(input.indexRevision, "indexRevision"),
    localDocumentId: boundedReceiptIdentifier(input.localDocumentId, "localDocumentId", 256),
    derivedIndexGeneration: boundedReceiptGeneration(input.derivedIndexGeneration),
  };
}

function queryabilityReceipt(row: KnowledgeQueryabilityReceiptDbRow): KnowledgeQueryabilityReceipt {
  return {
    sourceKey: row.source_key,
    sourceType: row.source_type,
    teamId: row.team_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    contentRevision: row.content_revision,
    indexRevision: row.index_revision,
    localDocumentId: row.local_document_id,
    derivedIndexGeneration: row.derived_index_generation,
    status: row.status,
    providerResultCount: row.provider_result_count,
    acceptedCitationCount: row.accepted_citation_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function knowledgeFailureRow(row: KnowledgeLedgerRow): KnowledgeFailureRow {
  return {
    sourceKey: row.sourceKey,
    sourceType: row.sourceType,
    teamId: row.teamId,
    projectId: row.projectId,
    channelId: row.channelId,
    threadTs: row.threadTs,
    configVersion: row.configVersion,
    requestedAt: row.requestedAt,
    reason: row.reason,
    lastLocalOperation: row.lastLocalOperation,
    lastLocalError: row.lastLocalError,
    status: row.status,
    queueAttempts: row.queueAttempts,
    lastErrorClass: row.lastErrorClass,
    lastErrorCode: row.lastErrorCode,
    incompleteReason: row.incompleteReason,
    tombstonedAt: row.tombstonedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
    sourceType: row.source_type,
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

const MAX_THREAD_FETCH_CHECKPOINT_JSON_BYTES = 4_000_000;
const RECOVERABLE_KNOWLEDGE_FAILURE_CLASSES = new Set([
  "local_add",
  "local_update",
  "local_poll",
]);

function recoveryField(value: string, field: string, maximum: number): string {
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
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
      ["derived_index_generation", "TEXT"],
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
    migrateKnowledgeLedgerSourceTypes(this.sql);
    migrateKnowledgeQueryability(this.sql);
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
    const threadCheckpointColumns = new Set(this.sql.exec<{ name: string }>(
      "PRAGMA table_info(knowledge_thread_fetch_checkpoints)",
    ).toArray().map((row) => row.name));
    if (!threadCheckpointColumns.has("message_count")) {
      this.sql.exec(
        "ALTER TABLE knowledge_thread_fetch_checkpoints ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
      );
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
         (descriptor_key, source_key, source_type, config_version, requested_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        descriptorKey,
        job.sourceKey,
        job.sourceType,
        job.configVersion,
        job.requestedAt,
        job.reason,
        now,
      );
      this.sql.exec(
        `INSERT INTO knowledge_ledger (
           source_key, source_type, team_id, project_id, channel_id, thread_ts,
           config_version, requested_at, reason, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           source_type = excluded.source_type,
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
        job.sourceType,
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
           source_key, source_type, descriptor_key, job_json, status, attempt_count,
           next_attempt_at, last_error, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           source_type = excluded.source_type,
           descriptor_key = excluded.descriptor_key,
           job_json = excluded.job_json,
           status = 'pending',
           attempt_count = 0,
           next_attempt_at = excluded.next_attempt_at,
           last_error = NULL,
           updated_at = excluded.updated_at`,
        job.sourceKey,
        job.sourceType,
        descriptorKey,
        JSON.stringify(job),
        nowMs,
        now,
      );
      this.sql.exec(
        `DELETE FROM knowledge_thread_fetch_checkpoints WHERE source_key = ?`,
        job.sourceKey,
      );
      return {
        accepted: true,
        reason: current ? "superseded" : "new",
        descriptorKey,
      };
    });
  }

  recoverPermanentFailure(input: {
    sourceKey: string;
    teamId: string;
    expectedConfigVersion: number;
    expectedRequestedAt: string;
    operatorId: string;
    rootCauseCorrectionRef: string;
  }, nowMs: number): KnowledgeRecoveryResult {
    const sourceKey = recoveryField(input.sourceKey, "sourceKey", 512);
    const teamId = recoveryField(input.teamId, "teamId", 256);
    const operatorId = recoveryField(input.operatorId, "operatorId", 256);
    const correctionRef = recoveryField(input.rootCauseCorrectionRef, "rootCauseCorrectionRef", 512);
    if (!Number.isSafeInteger(input.expectedConfigVersion) || input.expectedConfigVersion < 1) {
      throw new Error("expectedConfigVersion is invalid");
    }
    if (!Number.isFinite(Date.parse(input.expectedRequestedAt))) {
      throw new Error("expectedRequestedAt is invalid");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("recovery timestamp is invalid");
    return this.tx(() => {
      const current = this.get(sourceKey);
      if (!current) return { action: "blocked", sourceKey, reason: "not_found" };
      const auditId = crypto.randomUUID();
      const audit = (
        action: "reopened" | "blocked",
        reason: string,
      ): void => {
        this.sql.exec(
          `INSERT INTO knowledge_recovery_audits (
             audit_id, source_key, source_type, team_id, operator_id,
             correction_ref, action, reason, previous_status,
             previous_error_class, previous_error_code, previous_local_operation,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          auditId,
          current.sourceKey,
          current.sourceType,
          current.teamId,
          operatorId,
          correctionRef,
          action,
          reason,
          current.status,
          current.lastErrorClass ?? null,
          current.lastErrorCode ?? null,
          current.lastLocalOperation ?? null,
          new Date(nowMs).toISOString(),
        );
      };
      const blocked = (
        reason:
          | "identity_mismatch"
          | "not_permanent_failure"
          | "tombstoned"
          | "unsupported_failure"
          | "ambiguous_add_contract"
          | "missing_local_document_identity"
          | "delete_intent",
      ): KnowledgeRecoveryResult => {
        audit("blocked", reason);
        return { action: "blocked", sourceKey, auditId, reason };
      };
      if (
        current.teamId !== teamId ||
        current.configVersion !== input.expectedConfigVersion ||
        current.requestedAt !== input.expectedRequestedAt
      ) return blocked("identity_mismatch");
      if (current.tombstonedAt || current.status === "tombstoned") return blocked("tombstoned");
      if (current.reason === "delete" || current.reason === "reply_delete") return blocked("delete_intent");
      if (current.status !== "permanent_failure") return blocked("not_permanent_failure");
      const historicalAmbiguousAdd =
        current.lastErrorClass === "unsupported_capability" &&
        current.lastErrorCode === "ambiguous_add_contract" &&
        current.lastLocalOperation === "add_started" &&
        !current.localDocumentId;
      const historicalMutationContractFailure =
        current.lastErrorClass === "unsupported_capability" &&
        current.lastErrorCode === "unsupported_update_contract" &&
        (!current.lastLocalOperation || current.lastLocalOperation === "add_accepted") &&
        Boolean(current.localDocumentId);
      if (
        !current.lastErrorClass ||
        (!RECOVERABLE_KNOWLEDGE_FAILURE_CLASSES.has(current.lastErrorClass) &&
          !historicalAmbiguousAdd &&
          !historicalMutationContractFailure)
      ) {
        return blocked("unsupported_failure");
      }
      if (
        (current.lastLocalOperation === "update_started" ||
          current.lastLocalOperation === "poll" ||
          current.lastLocalOperation === "resume_poll") &&
        !current.localDocumentId
      ) return blocked("missing_local_document_identity");

      const preserveAmbiguousAdd = current.lastLocalOperation === "add_started" && !current.localDocumentId;
      const preservedDesiredRevision = preserveAmbiguousAdd ? current.desiredRevision : undefined;
      const currentRequestedAtMs = Date.parse(current.requestedAt);
      const requestedAt = new Date(Math.max(
        nowMs,
        Number.isFinite(currentRequestedAtMs) ? currentRequestedAtMs + 1 : nowMs,
      )).toISOString();
      const job = createKnowledgeJob({
        sourceType: current.sourceType,
        teamId: current.teamId,
        projectId: current.projectId,
        channelId: current.channelId,
        threadTs: current.threadTs,
        configVersion: current.configVersion,
        requestedAt,
        reason: "reconcile",
      });
      const descriptorKey = knowledgeDescriptorKey(job);
      const now = new Date(nowMs).toISOString();
      this.sql.exec(
        `INSERT INTO knowledge_events (
           descriptor_key, source_key, source_type, config_version,
           requested_at, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        descriptorKey,
        job.sourceKey,
        job.sourceType,
        job.configVersion,
        job.requestedAt,
        job.reason,
        now,
      );
      this.sql.exec(
        `UPDATE knowledge_ledger SET
           source_type = ?, team_id = ?, project_id = ?, channel_id = ?,
           thread_ts = ?, config_version = ?, requested_at = ?, reason = ?,
           desired_revision = ?, status = 'pending', lease_token = NULL,
           lease_expires_at = NULL, last_error_class = NULL,
           last_error_code = NULL, incomplete_reason = NULL,
           add_attempt_token = NULL, add_attempt_revision = NULL,
           local_workflow_status = NULL, poll_deadline_at = NULL,
           next_poll_at = NULL, last_local_operation = ?,
           last_local_error = NULL, updated_at = ?
         WHERE source_key = ?`,
        job.sourceType,
        job.teamId,
        job.projectId,
        job.channelId,
        job.threadTs,
        job.configVersion,
        job.requestedAt,
        job.reason,
        preservedDesiredRevision ?? null,
        preserveAmbiguousAdd ? "add_started" : null,
        now,
        sourceKey,
      );
      this.sql.exec(
        `INSERT INTO knowledge_outbox (
           source_key, source_type, descriptor_key, job_json, status,
           attempt_count, next_attempt_at, last_error, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           source_type = excluded.source_type,
           descriptor_key = excluded.descriptor_key,
           job_json = excluded.job_json,
           status = 'pending', attempt_count = 0,
           next_attempt_at = excluded.next_attempt_at,
           last_error = NULL, updated_at = excluded.updated_at`,
        job.sourceKey,
        job.sourceType,
        descriptorKey,
        JSON.stringify(job),
        nowMs,
        now,
      );
      this.sql.exec(
        "DELETE FROM knowledge_thread_fetch_checkpoints WHERE source_key = ?",
        sourceKey,
      );
      audit(
        "reopened",
        preserveAmbiguousAdd ? "operator_recovery_ambiguous_add_probe" : "operator_recovery",
      );
      return { action: "reopened", sourceKey, auditId, descriptorKey, requestedAt };
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
        // Terminal ledger state: acknowledge the Queue message so at-least-once
        // redeliveries converge. Operators replay via DLQ after root-cause fix.
        return { decision: "noop", reason: "permanent_failure" };
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
        const outcomeGeneration = normalizeDerivedIndexGeneration(outcome.indexGeneration);
        if (
          current.localDocumentId !== outcome.localDocumentId ||
          current.localDocumentRevision !== outcome.desiredRevision ||
          outcome.indexedRevision !== outcome.desiredRevision ||
          current.derivedIndexGeneration !== outcomeGeneration
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
        const outcomeGeneration = normalizeDerivedIndexGeneration(outcome.indexGeneration);
        if (
          current.localDocumentId !== outcome.localDocumentId ||
          current.localDocumentRevision !== outcome.desiredRevision ||
          current.derivedIndexGeneration !== outcomeGeneration
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
        const tombstoneCode = outcome.errorCode ?? "unsupported_delete_contract";
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'tombstoned', tombstoned_at = ?,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_class = ?,
           last_error_code = ?, last_local_operation = 'tombstone', updated_at = ?
           WHERE source_key = ? AND lease_token = ?`,
          outcome.tombstonedAt,
          tombstoneCode === "deleted" ? "local_delete" : "unsupported_capability",
          tombstoneCode,
          now,
          sourceKey,
          leaseToken,
        );
      } else if (outcome.status === "preserve_indexed") {
        // Mutation contract is off: keep the last successful index searchable
        // instead of poisoning the row to permanent_failure on reply/edit.
        // preserve_indexed always carries required errorClass/errorCode literals;
        // do not use `??` on them (TS narrows the RHS to never).
        if (!current.indexedRevision) {
          this.sql.exec(
            `UPDATE knowledge_ledger SET
               status = ?, lease_token = NULL, lease_expires_at = NULL,
               last_error_class = ?, last_error_code = ?, incomplete_reason = ?,
               last_local_error = ?, updated_at = ?
             WHERE source_key = ? AND lease_token = ?`,
            "permanent_failure",
            outcome.errorClass,
            outcome.errorCode,
            null,
            outcome.errorCode,
            now,
            sourceKey,
            leaseToken,
          );
        } else if (!current.localDocumentId) {
          return false;
        } else {
          this.sql.exec(
            `UPDATE knowledge_ledger SET status = 'indexed', desired_revision = indexed_revision,
             lease_token = NULL, lease_expires_at = NULL,
             last_error_class = ?, last_error_code = ?, incomplete_reason = NULL,
             last_local_error = ?, last_local_operation = 'update_skipped', updated_at = ?
             WHERE source_key = ? AND lease_token = ?`,
            outcome.errorClass,
            outcome.errorCode,
            outcome.errorCode,
            now,
            sourceKey,
            leaseToken,
          );
        }
      } else {
        const retryableAddNeverAccepted =
          outcome.status === "retryable_failure" &&
          current.lastLocalOperation === "add_started" &&
          !current.localDocumentId;
        if (retryableAddNeverAccepted) {
          this.sql.exec(
            `UPDATE knowledge_ledger SET
               status = ?, lease_token = NULL, lease_expires_at = NULL,
               last_error_class = ?, last_error_code = ?, incomplete_reason = ?,
               last_local_error = ?, last_local_operation = 'add_started', updated_at = ?
             WHERE source_key = ? AND lease_token = ?`,
            outcome.status,
            outcome.errorClass,
            outcome.errorCode ?? null,
            outcome.incompleteReason ?? "ambiguous_add_contract",
            outcome.errorCode ?? outcome.errorClass,
            now,
            sourceKey,
            leaseToken,
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
      }
      if (outcome.status !== "retryable_failure") {
        this.sql.exec(
          `DELETE FROM knowledge_thread_fetch_checkpoints WHERE source_key = ?`,
          sourceKey,
        );
      }
      return true;
    });
  }

  prepareRevision(
    sourceKey: string,
    leaseToken: string,
    desiredRevision: string,
    nowMs: number,
    options?: { mutationsVerified?: boolean; indexGeneration?: string },
  ): PrepareRevisionResult {
    return this.tx(() => {
      const current = this.get(sourceKey);
      if (!current || current.leaseToken !== leaseToken) throw new Error("knowledge lease is not current");
      if (current.tombstonedAt || current.status === "tombstoned") return { decision: "blocked", reason: "tombstoned" };
      const requestedGeneration = normalizeDerivedIndexGeneration(options?.indexGeneration);
      if (current.derivedIndexGeneration !== requestedGeneration) {
        // A generation is an isolated provider state store. Never use a
        // document ID from one store against another. The old binding is kept
        // in history for rollback/audit; only the derived live pointer is
        // replaced and the authoritative desired revision remains intact.
        if (requestedGeneration === undefined) {
          return { decision: "blocked", reason: "index_generation_mismatch" };
        }
        const now = new Date(nowMs).toISOString();
        if (current.localDocumentId || current.indexedRevision || current.localDocumentRevision) {
          this.sql.exec(
            `INSERT OR IGNORE INTO knowledge_ledger_derived_history (
               source_key, source_type, index_generation, local_document_id,
               local_document_revision, indexed_revision, status,
               archive_reason, archived_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sourceKey,
            current.sourceType,
            current.derivedIndexGeneration ?? "legacy",
            current.localDocumentId ?? null,
            current.localDocumentRevision ?? null,
            current.indexedRevision ?? null,
            current.status,
            "index_generation_changed",
            now,
          );
        }
        this.sql.exec(
          `UPDATE knowledge_ledger SET status = 'writing', desired_revision = ?,
           indexed_revision = NULL, local_document_id = NULL,
           local_document_revision = NULL, derived_index_generation = ?,
           local_workflow_status = NULL, poll_deadline_at = NULL,
           next_poll_at = NULL, add_attempt_token = ?, add_attempt_revision = ?,
           last_local_operation = 'add_started', last_local_error = NULL,
           updated_at = ? WHERE source_key = ? AND lease_token = ?`,
          desiredRevision,
          requestedGeneration,
          leaseToken,
          desiredRevision,
          now,
          sourceKey,
          leaseToken,
        );
        return { decision: "add" };
      }
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
      const mutationsVerified = options?.mutationsVerified === true;
      if (current.indexedRevision && current.indexedRevision !== desiredRevision) {
        if (mutationsVerified && current.localDocumentId) {
          this.sql.exec(
            `UPDATE knowledge_ledger SET status = 'writing', desired_revision = ?,
             last_local_operation = 'update_started', updated_at = ? WHERE source_key = ? AND lease_token = ?`,
            desiredRevision, new Date(nowMs).toISOString(), sourceKey, leaseToken,
          );
          return { decision: "update", localDocumentId: current.localDocumentId };
        }
        return { decision: "blocked", reason: "unsupported_update_contract" };
      }
      if (current.localDocumentId) {
        if (!current.localDocumentRevision || current.localDocumentRevision !== desiredRevision) {
          if (mutationsVerified) {
            this.sql.exec(
              `UPDATE knowledge_ledger SET status = 'writing', desired_revision = ?,
               last_local_operation = 'update_started', updated_at = ? WHERE source_key = ? AND lease_token = ?`,
              desiredRevision, new Date(nowMs).toISOString(), sourceKey, leaseToken,
            );
            return { decision: "update", localDocumentId: current.localDocumentId };
          }
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

  resolveAmbiguousAdd(input: {
    sourceKey: string;
    leaseToken: string;
    desiredRevision: string;
    resolution: "not_found" | "found";
    localDocumentId?: string;
    workflowStatus?: string;
    pollDeadlineAt?: number;
    nextPollAt?: number;
  }, nowMs: number): ResolveAmbiguousAddResult {
    if (!input.sourceKey || !input.leaseToken || !input.desiredRevision) {
      throw new Error("ambiguous add resolution identity is required");
    }
    return this.tx(() => {
      const current = this.get(input.sourceKey);
      if (
        !current ||
        current.leaseToken !== input.leaseToken ||
        current.status !== "leased" ||
        current.lastLocalOperation !== "add_started" ||
        current.localDocumentId ||
        (current.desiredRevision !== undefined && current.desiredRevision !== input.desiredRevision)
      ) throw new Error("ambiguous add resolution is not current");
      const now = new Date(nowMs).toISOString();
      if (input.resolution === "not_found") {
        this.sql.exec(
          `UPDATE knowledge_ledger SET
             status = 'writing', desired_revision = ?, add_attempt_token = ?,
             add_attempt_revision = ?, last_local_error = NULL,
             updated_at = ? WHERE source_key = ? AND lease_token = ?`,
          input.desiredRevision,
          input.leaseToken,
          input.desiredRevision,
          now,
          input.sourceKey,
          input.leaseToken,
        );
        return { decision: "add" };
      }
      if (
        !input.localDocumentId ||
        !input.workflowStatus ||
        !Number.isFinite(input.pollDeadlineAt) ||
        !Number.isFinite(input.nextPollAt)
      ) throw new Error("found ambiguous add resolution is incomplete");
      const pollDeadlineAt = input.pollDeadlineAt as number;
      const nextPollAt = input.nextPollAt as number;
      this.sql.exec(
          `UPDATE knowledge_ledger SET
           status = 'polling', desired_revision = ?, local_document_id = ?,
           local_document_revision = ?, local_workflow_status = ?,
           poll_deadline_at = ?, next_poll_at = ?,
           last_local_operation = 'add_accepted', last_local_error = NULL,
           add_attempt_token = NULL, add_attempt_revision = NULL,
           updated_at = ? WHERE source_key = ? AND lease_token = ?`,
        input.desiredRevision,
        input.localDocumentId,
        input.desiredRevision,
        input.workflowStatus,
        pollDeadlineAt,
        nextPollAt,
        now,
        input.sourceKey,
        input.leaseToken,
      );
      return {
        decision: "poll",
        localDocumentId: input.localDocumentId,
        pollDeadlineAt,
      };
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
    indexGeneration?: string;
  }, nowMs: number): boolean {
    return this.tx(() => {
      const current = this.get(input.sourceKey);
      if (!current || current.tombstonedAt) return false;
      const inputGeneration = normalizeDerivedIndexGeneration(input.indexGeneration);
      if (current.derivedIndexGeneration !== inputGeneration) return false;
      const ownsCurrentLease = current.leaseToken === input.leaseToken;
      const acceptedAdd = current.addAttemptToken === input.leaseToken &&
        current.addAttemptRevision === input.desiredRevision;
      const acceptedUpdate = ownsCurrentLease &&
        current.lastLocalOperation === "update_started" &&
        current.desiredRevision === input.desiredRevision;
      if (!acceptedAdd && !acceptedUpdate) return false;
      if (current.localDocumentId && current.localDocumentId !== input.localDocumentId) {
        throw new Error("local document identity conflict");
      }
      if (!acceptedUpdate && current.localDocumentRevision && current.localDocumentRevision !== input.desiredRevision) {
        throw new Error("local document revision conflict");
      }
      const acceptanceOperation = acceptedUpdate ? "update_accepted" : "add_accepted";
      this.sql.exec(
        `UPDATE knowledge_ledger SET
         status = CASE WHEN lease_token = ? THEN 'polling' ELSE status END,
         local_document_id = ?,
         local_document_revision = ?,
         derived_index_generation = ?,
         local_workflow_status = ?, poll_deadline_at = ?, next_poll_at = ?,
         last_local_operation = ?, last_local_error = NULL, updated_at = ?
         WHERE source_key = ? AND (add_attempt_token = ? OR lease_token = ?)`,
        input.leaseToken, input.localDocumentId, input.desiredRevision, inputGeneration ?? null, input.workflowStatus,
        input.pollDeadlineAt, input.nextPollAt, acceptanceOperation,
        new Date(nowMs).toISOString(), input.sourceKey, input.leaseToken, input.leaseToken,
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
    sourceType?: KnowledgeJob["sourceType"];
    teamId?: string;
    attempts: number;
    lastErrorCode?: string;
    capturedAt: string;
  }): DurableKnowledgeDlqRecord {
    const bodyJson = JSON.stringify(input.body);
    const sourceType = parseKnowledgeSourceType(
      input.sourceType ?? (input.sourceKey ? parseSourceTypeFromKey(input.sourceKey) : "slack"),
    );
    if (input.sourceKey) {
      const keySourceType = parseSourceTypeFromKey(input.sourceKey);
      if (keySourceType !== sourceType) throw new Error("DLQ source identity is invalid");
    }
    if (!input.messageId || input.messageId.length > 256) throw new Error("DLQ messageId is invalid");
    if (!input.queueName || input.queueName.length > 256) throw new Error("DLQ queueName is invalid");
    if (!bodyJson || bodyJson.length > 64 * 1024) throw new Error("DLQ body is invalid or too large");
    if (!Number.isSafeInteger(input.attempts) || input.attempts < 1 || input.attempts > 10_000) {
      throw new Error("DLQ attempts is invalid");
    }
    if (!Number.isFinite(Date.parse(input.capturedAt))) throw new Error("DLQ capturedAt is invalid");
    this.sql.exec(
      `INSERT OR IGNORE INTO knowledge_dlq_records (
         message_id, queue_name, body_json, source_key, source_type, team_id, attempts,
         last_error_code, status, captured_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.messageId,
      input.queueName,
      bodyJson,
      input.sourceKey ?? null,
      sourceType,
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

  putBackfillConversationInventory(input: {
    manifestId: string;
    inventoryDigest: string;
    inventory: SlackConversationInventoryReceipt;
    createdAt: string;
  }): SlackConversationInventoryReceipt {
    if (!input.manifestId || input.manifestId.length > 128) {
      throw new Error("backfill manifestId is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.inventoryDigest)) {
      throw new Error("backfill conversation inventory digest is invalid");
    }
    if (
      input.inventory.schemaVersion !== 1 ||
      input.inventory.visibility !== "installed_bot" ||
      !["complete", "incomplete"].includes(input.inventory.status) ||
      input.inventory.inventoryDigest !== input.inventoryDigest ||
      !Number.isSafeInteger(input.inventory.pages) ||
      input.inventory.pages < 0 ||
      !Number.isSafeInteger(input.inventory.visibleCount) ||
      input.inventory.visibleCount < 0 ||
      !Number.isSafeInteger(input.inventory.eligibleCount) ||
      input.inventory.eligibleCount < 0 ||
      !Number.isSafeInteger(input.inventory.excludedCount) ||
      input.inventory.excludedCount < 0 ||
      input.inventory.eligibleCount + input.inventory.excludedCount !== input.inventory.visibleCount ||
      !Array.isArray(input.inventory.eligibleConversationIds) ||
      input.inventory.eligibleConversationIds.length !== input.inventory.eligibleCount ||
      new Set(input.inventory.eligibleConversationIds).size !== input.inventory.eligibleConversationIds.length ||
      !Array.isArray(input.inventory.excluded) ||
      input.inventory.excluded.length > input.inventory.excludedCount
    ) {
      throw new Error("backfill conversation inventory is invalid");
    }
    const inventoryJson = JSON.stringify(input.inventory);
    if (!inventoryJson || inventoryJson.length > 1024 * 1024) {
      throw new Error("backfill conversation inventory is too large");
    }
    if (!Number.isFinite(Date.parse(input.createdAt))) {
      throw new Error("backfill conversation inventory timestamp is invalid");
    }
    return this.tx(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO knowledge_backfill_conversation_inventories (
           manifest_id, inventory_digest, inventory_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        input.manifestId,
        input.inventoryDigest,
        inventoryJson,
        input.createdAt,
        input.createdAt,
      );
      const row = this.sql.exec<BackfillConversationInventoryDbRow>(
        `SELECT * FROM knowledge_backfill_conversation_inventories
         WHERE manifest_id = ?`,
        input.manifestId,
      ).toArray()[0];
      if (
        !row ||
        row.inventory_digest !== input.inventoryDigest ||
        row.inventory_json !== inventoryJson
      ) {
        throw new Error("backfill conversation inventory identity conflict");
      }
      return JSON.parse(row.inventory_json) as SlackConversationInventoryReceipt;
    });
  }

  getBackfillConversationInventory(
    manifestId: string,
  ): SlackConversationInventoryReceipt | undefined {
    const row = this.sql.exec<BackfillConversationInventoryDbRow>(
      `SELECT * FROM knowledge_backfill_conversation_inventories
       WHERE manifest_id = ?`,
      manifestId,
    ).toArray()[0];
    return row
      ? JSON.parse(row.inventory_json) as SlackConversationInventoryReceipt
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
        ...(input.manifest.conversationInventoryDigest
          ? { conversationInventoryDigest: input.manifest.conversationInventoryDigest }
          : {}),
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

  getQueryConvergence(sourceKey: string): KnowledgeQueryConvergenceReceipt | undefined {
    const row = this.sql.exec<KnowledgeQueryConvergenceDbRow>(
      `SELECT query.*
       FROM knowledge_query_convergence AS query
       JOIN knowledge_ledger AS ledger ON ledger.source_key = query.source_key
       WHERE query.source_key = ?
         AND ledger.indexed_revision = query.content_revision
         AND ledger.derived_index_generation = query.index_generation
       ORDER BY query.checked_at DESC
       LIMIT 1`,
      sourceKey,
    ).toArray()[0];
    return row ? queryConvergenceReceipt(row) : undefined;
  }

  recordQueryConvergence(input: {
    sourceKey: string;
    contentRevision: string;
    indexGeneration: string;
    localDocumentId: string;
    queryDigest: string;
    status: KnowledgeQueryConvergenceStatus;
    providerResultCount: number;
    matchingCitationCount: number;
    errorCode?: string;
  }, nowMs: number): boolean {
    if (!input.sourceKey || input.sourceKey.length > 512 || /[\u0000-\u001f\u007f]/.test(input.sourceKey)) {
      throw new Error("query convergence sourceKey is invalid");
    }
    if (!input.contentRevision || input.contentRevision.length > 512 || /[\u0000-\u001f\u007f]/.test(input.contentRevision)) {
      throw new Error("query convergence contentRevision is invalid");
    }
    const indexGeneration = normalizeDerivedIndexGeneration(input.indexGeneration);
    if (!indexGeneration) throw new Error("query convergence indexGeneration is invalid");
    if (!input.localDocumentId || input.localDocumentId.length > 512 || /[\u0000-\u001f\u007f]/.test(input.localDocumentId)) {
      throw new Error("query convergence localDocumentId is invalid");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(input.queryDigest)) {
      throw new Error("query convergence queryDigest is invalid");
    }
    if (!Number.isSafeInteger(input.providerResultCount) || input.providerResultCount < 0 || input.providerResultCount > 100_000) {
      throw new Error("query convergence providerResultCount is invalid");
    }
    if (!Number.isSafeInteger(input.matchingCitationCount) || input.matchingCitationCount < 0 ||
      input.matchingCitationCount > input.providerResultCount) {
      throw new Error("query convergence matchingCitationCount is invalid");
    }
    if (input.status === "queryable" && input.matchingCitationCount < 1) {
      throw new Error("queryable convergence requires a matching citation");
    }
    if (input.status === "not_found" && input.matchingCitationCount !== 0) {
      throw new Error("not_found convergence cannot contain a matching citation");
    }
    if (input.status === "failed" && (!input.errorCode || !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.errorCode))) {
      throw new Error("failed query convergence requires an errorCode");
    }
    if (input.errorCode !== undefined && !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.errorCode)) {
      throw new Error("query convergence errorCode is invalid");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("query convergence timestamp is invalid");
    return this.tx(() => {
      const current = this.get(input.sourceKey);
      if (
        !current ||
        current.status === "tombstoned" ||
        current.indexedRevision !== input.contentRevision ||
        current.derivedIndexGeneration !== indexGeneration ||
        current.localDocumentId !== input.localDocumentId
      ) return false;
      const checkedAt = new Date(nowMs).toISOString();
      this.sql.exec(
        `INSERT INTO knowledge_query_convergence (
           source_key, source_type, team_id, project_id, channel_id, thread_ts,
           content_revision, index_generation, local_document_id, query_digest,
           status, provider_result_count, matching_citation_count, error_code, checked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key, content_revision, index_generation) DO UPDATE SET
           source_type = excluded.source_type,
           team_id = excluded.team_id,
           project_id = excluded.project_id,
           channel_id = excluded.channel_id,
           thread_ts = excluded.thread_ts,
           local_document_id = excluded.local_document_id,
           query_digest = excluded.query_digest,
           status = excluded.status,
           provider_result_count = excluded.provider_result_count,
           matching_citation_count = excluded.matching_citation_count,
           error_code = excluded.error_code,
           checked_at = excluded.checked_at`,
        current.sourceKey,
        current.sourceType,
        current.teamId,
        current.projectId,
        current.channelId,
        current.threadTs,
        input.contentRevision,
        indexGeneration,
        input.localDocumentId,
        input.queryDigest,
        input.status,
        input.providerResultCount,
        input.matchingCitationCount,
        input.errorCode ?? null,
        checkedAt,
      );
      return true;
    });
  }

  recordQueryabilityReceipt(
    input: KnowledgeQueryabilityReceiptInput,
    nowMs: number,
  ): KnowledgeQueryabilityReceipt {
    const identity = queryabilityIdentity(input);
    if (!QUERYABILITY_RECEIPT_STATUSES.includes(input.status)) {
      throw new Error("knowledge queryability receipt status is invalid");
    }
    if (
      !Number.isSafeInteger(input.providerResultCount) ||
      input.providerResultCount < 0 ||
      input.providerResultCount > MAX_QUERYABILITY_COUNT ||
      !Number.isSafeInteger(input.acceptedCitationCount) ||
      input.acceptedCitationCount < 0 ||
      input.acceptedCitationCount > MAX_QUERYABILITY_COUNT ||
      input.acceptedCitationCount > input.providerResultCount
    ) {
      throw new Error("knowledge queryability receipt counts are invalid");
    }
    if (!Number.isSafeInteger(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
      throw new Error("knowledge queryability receipt timestamp is invalid");
    }
    const now = new Date(nowMs).toISOString();
    return this.tx(() => {
      const current = this.get(identity.sourceKey);
      if (
        !current ||
        current.sourceType !== identity.sourceType ||
        current.teamId !== identity.teamId ||
        current.projectId !== identity.projectId ||
        current.channelId !== identity.channelId ||
        current.threadTs !== identity.threadTs
      ) {
        throw new Error("knowledge queryability source identity mismatch");
      }
      if (current.status !== "indexed") {
        throw new Error("knowledge queryability receipt requires indexed status");
      }
      if (
        current.indexedRevision !== identity.contentRevision ||
        current.localDocumentRevision !== identity.indexRevision ||
        current.localDocumentId !== identity.localDocumentId
      ) {
        throw new Error("knowledge queryability receipt fence mismatch");
      }
      if (current.derivedIndexGeneration && current.derivedIndexGeneration !== identity.derivedIndexGeneration) {
        throw new Error("knowledge queryability derived index generation mismatch");
      }
      if (!current.derivedIndexGeneration) {
        this.sql.exec(
          `UPDATE knowledge_ledger
           SET derived_index_generation = ?, updated_at = ?
           WHERE source_key = ? AND derived_index_generation IS NULL`,
          identity.derivedIndexGeneration,
          now,
          identity.sourceKey,
        );
      }
      this.sql.exec(
        `INSERT INTO knowledge_queryability_receipts (
           source_key, source_type, team_id, project_id, channel_id, thread_ts,
           content_revision, index_revision, local_document_id,
           derived_index_generation, status, provider_result_count,
           accepted_citation_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key, content_revision, index_revision, derived_index_generation)
         DO UPDATE SET
           source_type = excluded.source_type,
           team_id = excluded.team_id,
           project_id = excluded.project_id,
           channel_id = excluded.channel_id,
           thread_ts = excluded.thread_ts,
           local_document_id = excluded.local_document_id,
           status = excluded.status,
           provider_result_count = excluded.provider_result_count,
           accepted_citation_count = excluded.accepted_citation_count,
           updated_at = excluded.updated_at`,
        identity.sourceKey,
        identity.sourceType,
        identity.teamId,
        identity.projectId,
        identity.channelId,
        identity.threadTs,
        identity.contentRevision,
        identity.indexRevision,
        identity.localDocumentId,
        identity.derivedIndexGeneration,
        input.status,
        input.providerResultCount,
        input.acceptedCitationCount,
        now,
        now,
      );
      const row = this.sql.exec<KnowledgeQueryabilityReceiptDbRow>(
        `SELECT * FROM knowledge_queryability_receipts
         WHERE source_key = ? AND content_revision = ? AND index_revision = ?
           AND derived_index_generation = ?`,
        identity.sourceKey,
        identity.contentRevision,
        identity.indexRevision,
        identity.derivedIndexGeneration,
      ).toArray()[0];
      if (!row) throw new Error("knowledge queryability receipt was not persisted");
      return queryabilityReceipt(row);
    });
  }

  getQueryabilityReceipt(
    input: KnowledgeQueryabilityReceiptIdentity,
  ): KnowledgeQueryabilityReceipt | undefined {
    const identity = queryabilityIdentity(input);
    const current = this.get(identity.sourceKey);
    if (!current) return undefined;
    if (
      current.sourceType !== identity.sourceType ||
      current.teamId !== identity.teamId ||
      current.projectId !== identity.projectId ||
      current.channelId !== identity.channelId ||
      current.threadTs !== identity.threadTs
    ) {
      throw new Error("knowledge queryability source identity mismatch");
    }
    if (
      current.status !== "indexed" ||
      current.indexedRevision !== identity.contentRevision ||
      current.localDocumentRevision !== identity.indexRevision ||
      current.localDocumentId !== identity.localDocumentId ||
      current.derivedIndexGeneration !== identity.derivedIndexGeneration
    ) {
      return undefined;
    }
    const row = this.sql.exec<KnowledgeQueryabilityReceiptDbRow>(
      `SELECT * FROM knowledge_queryability_receipts
       WHERE source_key = ? AND content_revision = ? AND index_revision = ?
         AND derived_index_generation = ?`,
      identity.sourceKey,
      identity.contentRevision,
      identity.indexRevision,
      identity.derivedIndexGeneration,
    ).toArray()[0];
    return row ? queryabilityReceipt(row) : undefined;
  }

  readQueryabilityReceipt(
    input: KnowledgeQueryabilityReceiptIdentity,
  ): KnowledgeQueryabilityReceipt | undefined {
    return this.getQueryabilityReceipt(input);
  }

  listFailures(input: {
    cursor?: string;
    limit?: number;
    status?: "permanent_failure" | "retryable_failure";
  }): KnowledgeFailureList {
    const cursor = input.cursor ?? "";
    if (cursor.length > 512) throw new Error("failure cursor is invalid");
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("failure page limit must be between 1 and 100");
    }
    const rows = input.status
      ? this.sql.exec<LedgerDbRow>(
        `SELECT * FROM knowledge_ledger
         WHERE source_key > ? AND status = ?
         ORDER BY source_key ASC
         LIMIT ?`,
        cursor,
        input.status,
        limit + 1,
      ).toArray()
      : this.sql.exec<LedgerDbRow>(
        `SELECT * FROM knowledge_ledger
         WHERE source_key > ? AND status IN ('permanent_failure', 'retryable_failure')
         ORDER BY source_key ASC
         LIMIT ?`,
        cursor,
        limit + 1,
      ).toArray();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => knowledgeFailureRow(ledgerRow(row)));
    return {
      rows: page,
      ...(hasMore && page.length > 0 ? { nextCursor: page.at(-1)!.sourceKey } : {}),
    };
  }

  getThreadFetchCheckpoint(job: KnowledgeJob): KnowledgeThreadFetchCheckpoint | undefined {
    const row = this.sql.exec<ThreadFetchCheckpointDbRow>(
      `SELECT * FROM knowledge_thread_fetch_checkpoints
       WHERE source_key = ? AND source_type = ? AND team_id = ?
         AND project_id = ? AND channel_id = ? AND thread_ts = ?
         AND config_version = ? AND requested_at = ?`,
      job.sourceKey,
      job.sourceType,
      job.teamId,
      job.projectId,
      job.channelId,
      job.threadTs,
      job.configVersion,
      job.requestedAt,
    ).toArray()[0];
    if (!row) return undefined;
    try {
      const messages = JSON.parse(row.messages_json);
      if (!Array.isArray(messages)) return undefined;
      return {
        ...(row.cursor ? { cursor: row.cursor } : {}),
        pages: row.pages,
        messages,
        bytes: row.bytes,
      };
    } catch {
      return undefined;
    }
  }

  saveThreadFetchCheckpoint(
    job: KnowledgeJob,
    checkpoint: KnowledgeThreadFetchCheckpoint,
    nowMs: number,
  ): void {
    if (
      !Number.isSafeInteger(checkpoint.pages) ||
      checkpoint.pages < 0 ||
      !Number.isSafeInteger(checkpoint.bytes) ||
      checkpoint.bytes < 0 ||
      !Array.isArray(checkpoint.messages) ||
      (checkpoint.cursor !== undefined && !checkpoint.cursor)
    ) {
      throw new Error("knowledge thread checkpoint is invalid");
    }
    const messagesJson = JSON.stringify(checkpoint.messages);
    if (new TextEncoder().encode(messagesJson).byteLength > MAX_THREAD_FETCH_CHECKPOINT_JSON_BYTES) {
      throw new Error("knowledge thread checkpoint exceeds storage bound");
    }
    this.tx(() => {
      const current = this.get(job.sourceKey);
      if (
        !current ||
        current.sourceType !== job.sourceType ||
        current.teamId !== job.teamId ||
        current.projectId !== job.projectId ||
        current.channelId !== job.channelId ||
        current.threadTs !== job.threadTs ||
        current.configVersion !== job.configVersion ||
        current.requestedAt !== job.requestedAt
      ) {
        throw new Error("knowledge thread checkpoint identity is stale");
      }
      this.sql.exec(
        `INSERT INTO knowledge_thread_fetch_checkpoints (
           source_key, source_type, team_id, project_id, channel_id, thread_ts,
           config_version, requested_at, cursor, pages, messages_json,
           message_count, bytes, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           source_type = excluded.source_type,
           team_id = excluded.team_id,
           project_id = excluded.project_id,
           channel_id = excluded.channel_id,
           thread_ts = excluded.thread_ts,
           config_version = excluded.config_version,
           requested_at = excluded.requested_at,
           cursor = excluded.cursor,
           pages = excluded.pages,
           messages_json = excluded.messages_json,
           message_count = excluded.message_count,
           bytes = excluded.bytes,
           updated_at = excluded.updated_at`,
        job.sourceKey,
        job.sourceType,
        job.teamId,
        job.projectId,
        job.channelId,
        job.threadTs,
        job.configVersion,
        job.requestedAt,
        checkpoint.cursor ?? null,
        checkpoint.pages,
        messagesJson,
        checkpoint.messages.length,
        checkpoint.bytes,
        new Date(nowMs).toISOString(),
      );
    });
  }

  clearThreadFetchCheckpoint(job: KnowledgeJob): void {
    this.sql.exec(
      `DELETE FROM knowledge_thread_fetch_checkpoints
       WHERE source_key = ? AND config_version = ? AND requested_at = ?`,
      job.sourceKey,
      job.configVersion,
      job.requestedAt,
    );
  }

  putSlackMessageThreads(input: {
    teamId: string;
    projectId: string;
    channelId: string;
    threadTs: string;
    sourceKey: string;
    messageTs: string[];
  }, nowMs: number): { stored: number } {
    const expectedSourceKey = slackSourceKey(input.teamId, input.channelId, input.threadTs);
    if (input.sourceKey !== expectedSourceKey) {
      throw new Error("Slack message thread source key is invalid");
    }
    const messageTs = [...new Set(input.messageTs)].filter((value) => /^\d+\.\d+$/.test(value));
    if (messageTs.length === 0) return { stored: 0 };
    const updatedAt = new Date(nowMs).toISOString();
    this.tx(() => {
      for (const message of messageTs) {
        this.sql.exec(
          `INSERT INTO knowledge_slack_message_threads (
             team_id, project_id, channel_id, message_ts, thread_ts, source_key, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(team_id, channel_id, message_ts) DO UPDATE SET
             project_id = excluded.project_id,
             thread_ts = excluded.thread_ts,
             source_key = excluded.source_key,
             updated_at = excluded.updated_at`,
          input.teamId,
          input.projectId,
          input.channelId,
          message,
          input.threadTs,
          input.sourceKey,
          updatedAt,
        );
      }
    });
    return { stored: messageTs.length };
  }

  getSlackMessageThread(input: {
    teamId: string;
    channelId: string;
    messageTs: string;
  }): SlackMessageThreadMapping | undefined {
    const row = this.sql.exec<{
      team_id: string;
      project_id: string;
      channel_id: string;
      message_ts: string;
      thread_ts: string;
      source_key: string;
      updated_at: string;
    }>(
      `SELECT team_id, project_id, channel_id, message_ts, thread_ts, source_key, updated_at
         FROM knowledge_slack_message_threads
        WHERE team_id = ? AND channel_id = ? AND message_ts = ?`,
      input.teamId,
      input.channelId,
      input.messageTs,
    ).toArray()[0];
    if (!row) return undefined;
    return {
      teamId: row.team_id,
      projectId: row.project_id,
      channelId: row.channel_id,
      messageTs: row.message_ts,
      threadTs: row.thread_ts,
      sourceKey: row.source_key,
      updatedAt: row.updated_at,
    };
  }

  pruneThreadFetchCheckpoints(nowMs: number, maxAgeMs: number): void {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
      throw new Error("thread fetch checkpoint retention is invalid");
    }
    this.sql.exec(
      `DELETE FROM knowledge_thread_fetch_checkpoints
       WHERE updated_at < ?
          OR NOT EXISTS (
               SELECT 1 FROM knowledge_ledger
               WHERE knowledge_ledger.source_key = knowledge_thread_fetch_checkpoints.source_key
                 AND knowledge_ledger.config_version = knowledge_thread_fetch_checkpoints.config_version
                 AND knowledge_ledger.requested_at = knowledge_thread_fetch_checkpoints.requested_at
                 AND knowledge_ledger.status IN ('pending', 'queued', 'leased', 'fetching', 'retryable_failure')
             )`,
      new Date(nowMs - maxAgeMs).toISOString(),
    );
  }

  statusSnapshot(nowMs: number): KnowledgeLedgerStatusSnapshot {
    const ledgerRows = this.sql.exec<{
      status: KnowledgeLedgerStatus;
      count: number;
    }>(
      `SELECT status, COUNT(*) AS count
       FROM knowledge_ledger
       GROUP BY status
       ORDER BY status ASC`,
    ).toArray();
    const byStatus: Partial<Record<KnowledgeLedgerStatus, number>> = {};
    for (const row of ledgerRows) byStatus[row.status] = Number(row.count);

    const outboxRows = this.sql.exec<{
      status: "pending" | "sending";
      count: number;
    }>(
      `SELECT status, COUNT(*) AS count
       FROM knowledge_outbox
       GROUP BY status`,
    ).toArray();
    const outboxPending = Number(outboxRows.find((row) => row.status === "pending")?.count ?? 0);
    const outboxSending = Number(outboxRows.find((row) => row.status === "sending")?.count ?? 0);
    const outboxDue = Number(this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM knowledge_outbox
       WHERE status = 'pending' AND next_attempt_at <= ?`,
      nowMs,
    ).toArray()[0]?.count ?? 0);
    const earliestPendingAt = this.sql.exec<{ next_attempt_at: number }>(
      `SELECT next_attempt_at
       FROM knowledge_outbox
       WHERE status = 'pending'
       ORDER BY next_attempt_at ASC
       LIMIT 1`,
    ).toArray()[0]?.next_attempt_at;

    const dlqRows = this.sql.exec<{
      status: "pending" | "replaying" | "replayed" | "disposed";
      count: number;
    }>(
      `SELECT status, COUNT(*) AS count
       FROM knowledge_dlq_records
       GROUP BY status`,
    ).toArray();
    const dlqPending = Number(dlqRows.find((row) => row.status === "pending")?.count ?? 0);
    const dlqReplaying = Number(dlqRows.find((row) => row.status === "replaying")?.count ?? 0);
    const dlqReplayed = Number(dlqRows.find((row) => row.status === "replayed")?.count ?? 0);
    const dlqDisposed = Number(dlqRows.find((row) => row.status === "disposed")?.count ?? 0);

    const reconcileRows = this.sql.exec<{
      status: "running" | "complete";
      count: number;
    }>(
      `SELECT status, COUNT(*) AS count
       FROM knowledge_reconcile_runs
       GROUP BY status`,
    ).toArray();
    const latestReconcileRow = this.sql.exec<ReconcileRunDbRow>(
      `SELECT * FROM knowledge_reconcile_runs
       ORDER BY updated_at DESC, run_id DESC
       LIMIT 1`,
    ).toArray()[0];

    const backfillRows = this.sql.exec<{
      status: DurableBackfillManifestRecord["status"];
      count: number;
    }>(
      `SELECT status, COUNT(*) AS count
       FROM knowledge_backfill_manifests
       GROUP BY status`,
    ).toArray();
    const latestBackfillRow = this.sql.exec<BackfillManifestDbRow>(
      `SELECT * FROM knowledge_backfill_manifests
       ORDER BY updated_at DESC, manifest_id DESC
       LIMIT 1`,
    ).toArray()[0];
    const threadFetchSummary = this.sql.exec<{
      active: number;
      messages: number | null;
      bytes: number | null;
      oldest_updated_at: string | null;
    }>(
      `SELECT COUNT(*) AS active,
              SUM(message_count) AS messages,
              SUM(bytes) AS bytes,
              MIN(updated_at) AS oldest_updated_at
       FROM knowledge_thread_fetch_checkpoints`,
    ).toArray()[0];
    const inventoryRows = this.sql.exec<BackfillConversationInventoryDbRow>(
      `SELECT * FROM knowledge_backfill_conversation_inventories
       ORDER BY updated_at DESC, manifest_id DESC`,
    ).toArray();
    let inventoryComplete = 0;
    let inventoryIncomplete = 0;
    let inventoryInvalid = 0;
    let latestInventory: KnowledgeLedgerStatusSnapshot["inventory"]["latest"];
    for (const row of inventoryRows) {
      let inventory: SlackConversationInventoryReceipt | undefined;
      try {
        inventory = JSON.parse(row.inventory_json) as SlackConversationInventoryReceipt;
      } catch {
        inventory = undefined;
      }
      const valid = inventory &&
        inventory.schemaVersion === 1 &&
        inventory.visibility === "installed_bot" &&
        (inventory.status === "complete" || inventory.status === "incomplete") &&
        Number.isSafeInteger(inventory.visibleCount) &&
        Number.isSafeInteger(inventory.eligibleCount) &&
        Number.isSafeInteger(inventory.excludedCount) &&
        typeof inventory.inventoryDigest === "string" &&
        inventory.inventoryDigest === row.inventory_digest;
      const status = valid ? inventory!.status : "invalid";
      if (status === "complete") inventoryComplete += 1;
      if (status === "incomplete") inventoryIncomplete += 1;
      if (status === "invalid") inventoryInvalid += 1;
      if (!latestInventory) {
        latestInventory = {
          manifestId: row.manifest_id,
          status,
          visibleCount: valid ? inventory!.visibleCount : 0,
          eligibleCount: valid ? inventory!.eligibleCount : 0,
          excludedCount: valid ? inventory!.excludedCount : 0,
          inventoryDigest: row.inventory_digest,
          updatedAt: row.updated_at,
        };
      }
    }
    const messageThreadMapSummary = this.sql.exec<{
      total: number;
      oldest_updated_at: string | null;
      newest_updated_at: string | null;
    }>(
      `SELECT COUNT(*) AS total,
              MIN(updated_at) AS oldest_updated_at,
              MAX(updated_at) AS newest_updated_at
       FROM knowledge_slack_message_threads`,
    ).toArray()[0];
    const queryConvergenceRows = this.sql.exec<{
      status: KnowledgeQueryConvergenceStatus;
      count: number;
    }>(
      `SELECT query.status, COUNT(*) AS count
       FROM knowledge_query_convergence AS query
       JOIN knowledge_ledger AS ledger ON ledger.source_key = query.source_key
       WHERE ledger.indexed_revision = query.content_revision
         AND ledger.derived_index_generation = query.index_generation
         AND ledger.status != 'tombstoned'
       GROUP BY query.status`,
    ).toArray();
    const queryable = Number(queryConvergenceRows.find((row) => row.status === "queryable")?.count ?? 0);
    const notFound = Number(queryConvergenceRows.find((row) => row.status === "not_found")?.count ?? 0);
    const failed = Number(queryConvergenceRows.find((row) => row.status === "failed")?.count ?? 0);
    const queryableSources = queryable + notFound + failed;
    const indexedSources = Number(this.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM knowledge_ledger
       WHERE indexed_revision IS NOT NULL
         AND local_document_id IS NOT NULL
         AND status != 'tombstoned'`,
    ).toArray()[0]?.count ?? 0);
    const queryability: Record<KnowledgeQueryabilityReceiptStatus, number> = {
      unverified: 0,
      searchable: 0,
      no_match: 0,
      provider_unavailable: 0,
    };
    const queryabilityRows = this.sql.exec<{
      status: KnowledgeQueryabilityReceiptStatus;
      count: number;
    }>(
      `SELECT COALESCE(receipt.status, 'unverified') AS status, COUNT(*) AS count
       FROM knowledge_ledger AS ledger
       LEFT JOIN knowledge_queryability_receipts AS receipt
         ON receipt.source_key = ledger.source_key
        AND receipt.content_revision = ledger.indexed_revision
        AND receipt.index_revision = ledger.local_document_revision
        AND receipt.local_document_id = ledger.local_document_id
        AND receipt.derived_index_generation = ledger.derived_index_generation
       WHERE ledger.status = 'indexed'
       GROUP BY COALESCE(receipt.status, 'unverified')`,
    ).toArray();
    for (const row of queryabilityRows) {
      if (QUERYABILITY_RECEIPT_STATUSES.includes(row.status)) {
        queryability[row.status] = Number(row.count);
      }
    }
    const recoveryRows = this.sql.exec<{
      action: "reopened" | "blocked";
      count: number;
    }>(
      `SELECT action, COUNT(*) AS count
       FROM knowledge_recovery_audits
       GROUP BY action`,
    ).toArray();
    const latestRecovery = this.sql.exec<{
      audit_id: string;
      source_key: string;
      action: "reopened" | "blocked";
      reason: string;
      created_at: string;
    }>(
      `SELECT audit_id, source_key, action, reason, created_at
       FROM knowledge_recovery_audits
       ORDER BY created_at DESC, audit_id DESC
       LIMIT 1`,
    ).toArray()[0];

    return {
      capturedAt: new Date(nowMs).toISOString(),
      ledger: {
        total: Object.values(byStatus).reduce((total, count) => total + (count ?? 0), 0),
        byStatus,
      },
      outbox: {
        pending: outboxPending,
        sending: outboxSending,
        due: outboxDue,
        ...(earliestPendingAt === undefined ? {} : { earliestPendingAt }),
      },
      dlq: {
        total: dlqPending + dlqReplaying + dlqReplayed + dlqDisposed,
        pending: dlqPending,
        replaying: dlqReplaying,
        replayed: dlqReplayed,
        disposed: dlqDisposed,
      },
      reconciliation: {
        running: Number(reconcileRows.find((row) => row.status === "running")?.count ?? 0),
        complete: Number(reconcileRows.find((row) => row.status === "complete")?.count ?? 0),
        ...(latestReconcileRow ? { latest: reconcileRun(latestReconcileRow) } : {}),
      },
      backfill: {
        active: backfillRows
          .filter((row) => row.status === "dry_run" || row.status === "approved" || row.status === "running")
          .reduce((total, row) => total + Number(row.count), 0),
        complete: Number(backfillRows.find((row) => row.status === "complete")?.count ?? 0),
        ...(latestBackfillRow ? {
          latest: {
            manifestId: latestBackfillRow.manifest_id,
            status: latestBackfillRow.status,
            nextJobIndex: latestBackfillRow.next_job_index,
            executionErrorCount: latestBackfillRow.execution_error_count,
            updatedAt: latestBackfillRow.updated_at,
          },
        } : {}),
      },
      threadFetch: {
        active: Number(threadFetchSummary?.active ?? 0),
        messages: Number(threadFetchSummary?.messages ?? 0),
        bytes: Number(threadFetchSummary?.bytes ?? 0),
        ...(threadFetchSummary?.oldest_updated_at
          ? { oldestUpdatedAt: threadFetchSummary.oldest_updated_at }
          : {}),
      },
      inventory: {
        total: inventoryRows.length,
        complete: inventoryComplete,
        incomplete: inventoryIncomplete,
        invalid: inventoryInvalid,
        ...(latestInventory ? { latest: latestInventory } : {}),
      },
      messageThreadMap: {
        total: Number(messageThreadMapSummary?.total ?? 0),
        ...(messageThreadMapSummary?.oldest_updated_at
          ? { oldestUpdatedAt: messageThreadMapSummary.oldest_updated_at }
          : {}),
        ...(messageThreadMapSummary?.newest_updated_at
          ? { newestUpdatedAt: messageThreadMapSummary.newest_updated_at }
          : {}),
      },
      queryConvergence: {
        total: indexedSources,
        queryable,
        notFound,
        failed,
        unverified: Math.max(0, indexedSources - queryableSources),
      },
      queryability: {
        total: Object.values(queryability).reduce((total, count) => total + count, 0),
        byStatus: queryability,
      },
      recovery: {
        total: recoveryRows.reduce((total, row) => total + Number(row.count), 0),
        reopened: Number(recoveryRows.find((row) => row.action === "reopened")?.count ?? 0),
        blocked: Number(recoveryRows.find((row) => row.action === "blocked")?.count ?? 0),
        ...(latestRecovery ? {
          latest: {
            auditId: latestRecovery.audit_id,
            sourceKey: latestRecovery.source_key,
            action: latestRecovery.action,
            reason: latestRecovery.reason,
            createdAt: latestRecovery.created_at,
          },
        } : {}),
      },
    };
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
