/**
 * Fail-closed configuration for automatic Slack knowledge ingestion.
 *
 * This is intentionally separate from WorkspaceChannelConfig. That older
 * configuration has a useful empty-channel fallback for turn settings; an
 * ingestion source must never inherit it.
 *
 * K2: optional `sourceType` defaults to `slack`. For non-Slack sources,
 * `channelId` is a synthetic stable scope id within the project (not a
 * Slack channel).
 */

import {
  parseKnowledgeSourceType,
  type KnowledgeSourceType,
} from "../memory/knowledge-source-types.js";

export type { KnowledgeSourceType };

export const KNOWLEDGE_CONFIG_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_ADMISSION_POLICY_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_RUNTIME = Object.freeze({
  dataDir: "/var/lib/supermemory",
  openAiModel: "gpt-5.1",
  openAiFastModel: "gpt-5.1",
  openAiTextModel: "gpt-5.1",
  embeddingProvider: "local",
  embeddingModel: "Xenova/bge-base-en-v1.5",
  embeddingDimensions: 768,
});

export type KnowledgeSourceScope = {
  teamId: string;
  projectId: string;
  /**
   * Slack: channel id. Other sourceTypes: stable scope id within the project
   * (synthetic; not a Slack channel).
   */
  channelId: string;
  /** Defaults to `slack` when absent for back-compat. */
  sourceType?: KnowledgeSourceType;
};

export type TrackedKnowledgeSource = KnowledgeSourceScope & {
  schemaVersion: typeof KNOWLEDGE_CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  /** Durable lifecycle bit. Re-enable remains blocked after the first disable. */
  everEnabled: boolean;
  readerPolicyRef: string;
  retentionDays: number | null;
  /** Database-owned; callers may not choose a version. */
  configVersion: number;
  updatedAt: string;
};

export type PutTrackedKnowledgeSource = KnowledgeSourceScope & {
  enabled: boolean;
  readerPolicyRef: string;
  retentionDays?: number | null;
};

export type WorkspaceKnowledgeAdmissionPolicy = {
  schemaVersion: typeof KNOWLEDGE_ADMISSION_POLICY_SCHEMA_VERSION;
  mode: "explicit" | "all_delivered";
  defaultProjectId: string;
  readerPolicyRef: string;
  retentionDays: number | null;
  configVersion: number;
  updatedAt: string;
};

export type PutWorkspaceKnowledgeAdmissionPolicy = {
  mode: WorkspaceKnowledgeAdmissionPolicy["mode"];
  defaultProjectId: string;
  readerPolicyRef: string;
  retentionDays?: number | null;
};

const ID_MAX_LENGTH = 128;
const POLICY_REF_MAX_LENGTH = 256;
const MAX_RETENTION_DAYS = 36_500;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const BUNDLE_POLICY_PREFIX = "bundle:";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ID_MAX_LENGTH) {
    throw new Error(`${field} must be a non-empty string up to ${ID_MAX_LENGTH} characters`);
  }
  if (/[:*?\[\]{}\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} contains a reserved, wildcard, or control character`);
  }
  return value;
}

export function readerPolicyRefForBundle(bundleId: unknown): string {
  if (typeof bundleId !== "string" || !BUNDLE_ID_RE.test(bundleId)) {
    throw new Error(
      "bundleId must be a canonical identifier using letters, numbers, dot, underscore, slash, or hyphen",
    );
  }
  return `${BUNDLE_POLICY_PREFIX}${bundleId}`;
}

export function bundleIdFromReaderPolicyRef(value: unknown): string {
  if (typeof value !== "string" || value.length > POLICY_REF_MAX_LENGTH) {
    throw new Error(`readerPolicyRef must be a string up to ${POLICY_REF_MAX_LENGTH} characters`);
  }
  if (!value.startsWith(BUNDLE_POLICY_PREFIX)) {
    throw new Error("readerPolicyRef must use the canonical bundle:{bundleId} policy");
  }
  const bundleId = value.slice(BUNDLE_POLICY_PREFIX.length);
  try {
    if (readerPolicyRefForBundle(bundleId) === value) return bundleId;
  } catch {
    // Normalize every malformed canonical reference to the same safe error.
  }
  throw new Error("readerPolicyRef must use the canonical bundle:{bundleId} policy");
}

function policyRef(value: unknown): string {
  if (value === "") return "";
  const bundleId = bundleIdFromReaderPolicyRef(value);
  return readerPolicyRefForBundle(bundleId);
}

function enabled(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("enabled must be a boolean");
  return value;
}

function retentionDays(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RETENTION_DAYS) {
    throw new Error(`retentionDays must be an integer from 1 to ${MAX_RETENTION_DAYS}, or null`);
  }
  return value as number;
}

export function parseKnowledgeSourceScope(value: unknown): KnowledgeSourceScope {
  const input = record(value, "knowledge source scope");
  const scope: KnowledgeSourceScope = {
    teamId: identifier(input.teamId, "teamId"),
    projectId: identifier(input.projectId, "projectId"),
    channelId: identifier(input.channelId, "channelId"),
  };
  scope.sourceType = parseKnowledgeSourceType(input.sourceType ?? "slack");
  return scope;
}

export function parsePutTrackedKnowledgeSource(value: unknown): PutTrackedKnowledgeSource {
  const input = record(value, "tracked knowledge source");
  const scope = parseKnowledgeSourceScope(input);
  const source = {
    ...scope,
    enabled: enabled(input.enabled),
    readerPolicyRef: policyRef(input.readerPolicyRef),
    retentionDays: retentionDays(input.retentionDays),
  };
  // This parser establishes only the canonical bundle reference. Retrieval
  // still authorizes the exact turn against the current WorkspaceConfigDO
  // channel bundle before and after Local; metadata is never authorization.
  if (source.enabled && source.readerPolicyRef.length === 0) {
    throw new Error("enabled knowledge sources require readerPolicyRef");
  }
  return { ...source, retentionDays: source.retentionDays ?? null };
}

export function parsePutWorkspaceKnowledgeAdmissionPolicy(
  value: unknown,
): PutWorkspaceKnowledgeAdmissionPolicy {
  const input = record(value, "workspace knowledge admission policy");
  if (input.mode !== "explicit" && input.mode !== "all_delivered") {
    throw new Error("workspace knowledge admission mode must be explicit or all_delivered");
  }
  const mode = input.mode;
  const defaultProjectId = identifier(input.defaultProjectId, "defaultProjectId");
  const readerPolicyRef = policyRef(input.readerPolicyRef);
  if (mode === "all_delivered" && readerPolicyRef.length === 0) {
    throw new Error("all_delivered knowledge admission requires readerPolicyRef");
  }
  return {
    mode,
    defaultProjectId,
    readerPolicyRef,
    retentionDays: retentionDays(input.retentionDays),
  };
}

export function disabledTrackedKnowledgeSource(
  scope: KnowledgeSourceScope,
): TrackedKnowledgeSource {
  const parsed = parseKnowledgeSourceScope(scope);
  return {
    ...parsed,
    schemaVersion: KNOWLEDGE_CONFIG_SCHEMA_VERSION,
    enabled: false,
    everEnabled: false,
    readerPolicyRef: "",
    retentionDays: null,
    configVersion: 0,
    updatedAt: "",
  };
}

export function isTrackedKnowledgeSourceEnabled(
  source: Pick<TrackedKnowledgeSource, "enabled" | "configVersion">,
): boolean {
  return source.enabled === true && Number.isSafeInteger(source.configVersion) && source.configVersion > 0;
}
