/** Pure, server-derived contracts shared by future knowledge ingestion/search. */

import type { KnowledgeSourceScope } from "../config/knowledge-config.js";
import type { KnowledgeSourceType } from "./knowledge-source-types.js";

export type { KnowledgeSourceType } from "./knowledge-source-types.js";

export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_LIMITS = Object.freeze({
  maxIdentifierLength: 128,
  maxMetadataEntries: 24,
  maxMetadataKeyLength: 64,
  maxMetadataStringLength: 2_048,
  maxCitationExcerptLength: 1_000,
  maxSearchLimit: 10,
});

/**
 * One Queue attempt is bounded below the durable ledger/config-effect leases.
 * The Local poll allowance includes one final request timeout past its clock
 * deadline; the control-plane margin covers DO fencing/outcome RPCs.
 */
export const KNOWLEDGE_EXECUTION_BUDGETS = Object.freeze({
  slackThreadFetchMs: 25_000,
  slackAttemptMs: 5_000,
  localRequestMs: 5_000,
  localPollWindowMs: 20_000,
  localPollOverrunMs: 5_000,
  controlPlaneMarginMs: 10_000,
  ledgerLeaseMs: 70_000,
  configEffectLeaseMs: 80_000,
});

export type FlatMetadataValue = string | number | boolean;
export type FlatMetadata = Record<string, FlatMetadataValue>;
export type LocalDocumentStatus =
  | "unknown"
  | "queued"
  | "extracting"
  | "chunking"
  | "embedding"
  | "indexing"
  | "done"
  | "failed";

export const LOCAL_DOCUMENT_STATUSES: readonly LocalDocumentStatus[] = [
  "unknown", "queued", "extracting", "chunking", "embedding", "indexing", "done", "failed",
];

export type MetadataFilter = { AND: Array<{ key: string; value: string }> } | {
  OR: Array<{ key: string; value: string }>;
};

/**
 * Shared Local document metadata fields for every sourceType.
 * Source-specific ids (channel/thread, space/page, repo/path, connector/row)
 * are optional on the union base and required on typed variants.
 */
export type KnowledgeDocumentMetadataBase = {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  sourceType: KnowledgeSourceType;
  workspaceId: string;
  projectId: string;
  sourceKey: string;
  contentRevision: string;
  aclPolicyRef: string;
  status: "active" | "deleted";
  observedAt: string;
  indexedAt: string;
};

export type KnowledgeDocumentMetadata = KnowledgeDocumentMetadataBase & {
  channelId?: string;
  threadTs?: string;
  spaceId?: string;
  pageId?: string;
  repoId?: string;
  path?: string;
  connectorId?: string;
  rowId?: string;
  slackPermalink?: string;
  rootAuthorId?: string;
  rootTs?: string;
};

/** Slack corpus metadata. `sourceType` defaults to slack when omitted (legacy). */
export type SlackKnowledgeMetadata = {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  sourceType?: "slack";
  workspaceId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  sourceKey: string;
  contentRevision: string;
  slackPermalink?: string;
  rootAuthorId?: string;
  rootTs: string;
  observedAt: string;
  indexedAt: string;
  aclPolicyRef: string;
  status: "active" | "deleted";
};

/**
 * Citation shape shared across sourceTypes.
 * Slack search_slack keeps channelId/threadTs required via KnowledgeCitation.
 */
export type KnowledgeCitationBase = {
  sourceKey: string;
  /** Defaults to slack for legacy search_slack consumers; always set by citationFromResult. */
  sourceType?: KnowledgeSourceType;
  projectId: string;
  contentRevision: string;
  excerpt: string;
  score?: number;
  aclPolicyRef: string;
  retrievedAt: string;
  permalink?: string;
  channelId?: string;
  threadTs?: string;
  spaceId?: string;
  pageId?: string;
  repoId?: string;
  path?: string;
  connectorId?: string;
  rowId?: string;
};

/** Slack citation — channelId and threadTs remain required for search_slack. */
export type KnowledgeCitation = KnowledgeCitationBase & {
  channelId: string;
  threadTs: string;
};

export type KnowledgeJob = {
  version: typeof KNOWLEDGE_SCHEMA_VERSION;
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  sourceKey: string;
  configVersion: number;
  requestedAt: string;
  reason:
    | "event"
    | "debounce"
    | "reconcile"
    | "backfill"
    | "delete"
    | "reply_delete";
  /** Exact Slack message ts for deletion events; never rounded or rewritten. */
  messageTs?: string;
};

function identifier(value: string, field: string): string {
  if (!value || value.length > KNOWLEDGE_LIMITS.maxIdentifierLength || /[:\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function sourcePart(value: string, field: string): string {
  if (!value || value.length > KNOWLEDGE_LIMITS.maxIdentifierLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a non-empty safe source component`);
  }
  return value;
}

/**
 * Local `customId` allows only `[A-Za-z0-9_:-]`. Slack message timestamps use
 * `.` (e.g. `171234.000100`), so the ts component of `sourceKey`/`customId`
 * must be encoded. Metadata `threadTs` / `rootTs` keep the real Slack ts.
 */
export function encodeSlackTsForSourceKey(threadTs: string): string {
  return sourcePart(threadTs, "threadTs").replaceAll(".", "_");
}

export function workspaceTag(teamId: string): `workspace:${string}` {
  return `workspace:${identifier(teamId, "teamId")}`;
}

export function slackSourceKey(teamId: string, channelId: string, threadTs: string): string {
  return `slack:${identifier(teamId, "teamId")}:${identifier(channelId, "channelId")}:${encodeSlackTsForSourceKey(threadTs)}`;
}

export function isIndexedDocumentStatus(status: LocalDocumentStatus): boolean {
  return status === "done";
}

export function parseLocalDocumentStatus(value: unknown): LocalDocumentStatus {
  if (typeof value !== "string" || !LOCAL_DOCUMENT_STATUSES.includes(value as LocalDocumentStatus)) {
    throw new Error("unsupported Local document status");
  }
  return value as LocalDocumentStatus;
}

export function validateFlatMetadata(value: unknown): FlatMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be a flat object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > KNOWLEDGE_LIMITS.maxMetadataEntries) {
    throw new Error("metadata has too many entries");
  }
  for (const [key, item] of entries) {
    if (!key || key.length > KNOWLEDGE_LIMITS.maxMetadataKeyLength || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error("metadata key is invalid");
    }
    if (typeof item === "string") {
      if (item.length > KNOWLEDGE_LIMITS.maxMetadataStringLength) throw new Error("metadata string is too long");
      continue;
    }
    if (typeof item !== "number" && typeof item !== "boolean") {
      throw new Error("metadata values must be strings, numbers, or booleans");
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("metadata number must be finite");
  }
  return value as FlatMetadata;
}

export function slackKnowledgeMetadataAsFlat(metadata: SlackKnowledgeMetadata): FlatMetadata {
  const sourceKey = slackSourceKey(metadata.workspaceId, metadata.channelId, metadata.threadTs);
  if (metadata.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION || metadata.sourceKey !== sourceKey) {
    throw new Error("Slack metadata has an invalid schema version or sourceKey");
  }
  if (metadata.status !== "active" && metadata.status !== "deleted") {
    throw new Error("Slack metadata status is invalid");
  }
  for (const field of [
    "projectId", "contentRevision", "rootTs", "observedAt", "indexedAt", "aclPolicyRef",
  ] as const) {
    if (!metadata[field]) throw new Error(`Slack metadata ${field} is required`);
  }
  return validateFlatMetadata(metadata);
}

/** Reject addressing that must only ever be derived from the authenticated scope. */
export function rejectCallerControlledAddressing(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  for (const key of ["tag", "containerTag", "containerTags", "customId", "prefix", "glob"]) {
    if (key in input) throw new Error(`${key} is server-derived and may not be caller supplied`);
  }
}

export function createKnowledgeJob(input: KnowledgeSourceScope & {
  threadTs: string;
  configVersion: number;
  requestedAt: string;
  reason: KnowledgeJob["reason"];
  messageTs?: string;
}): KnowledgeJob {
  if (!Number.isSafeInteger(input.configVersion) || input.configVersion < 1) {
    throw new Error("configVersion must be a positive integer");
  }
  const requestedAtMs = Date.parse(input.requestedAt);
  if (!Number.isFinite(requestedAtMs) || new Date(requestedAtMs).toISOString() !== input.requestedAt) {
    throw new Error("requestedAt must be a canonical ISO timestamp");
  }
  const threadTs = sourcePart(input.threadTs, "threadTs");
  const messageTs = input.messageTs === undefined
    ? undefined
    : sourcePart(input.messageTs, "messageTs");
  if (input.reason === "delete" && messageTs !== threadTs) {
    throw new Error("root deletion messageTs must equal threadTs");
  }
  if (
    input.reason === "reply_delete" &&
    (!messageTs || messageTs === threadTs)
  ) {
    throw new Error("reply deletion requires an exact non-root messageTs");
  }
  if (
    input.reason !== "delete" &&
    input.reason !== "reply_delete" &&
    messageTs !== undefined
  ) {
    throw new Error("messageTs is only valid for deletion descriptors");
  }
  return {
    version: KNOWLEDGE_SCHEMA_VERSION,
    teamId: identifier(input.teamId, "teamId"),
    projectId: identifier(input.projectId, "projectId"),
    channelId: identifier(input.channelId, "channelId"),
    threadTs,
    sourceKey: slackSourceKey(input.teamId, input.channelId, input.threadTs),
    configVersion: input.configVersion,
    requestedAt: input.requestedAt,
    reason: input.reason,
    ...(messageTs ? { messageTs } : {}),
  };
}
