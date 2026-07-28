/**
 * Cerebras-style project scopes over tracked knowledge sources (K2 Phase 6).
 *
 * Isolation modes (SPEC §2 / K2):
 * - metadata_filter: soft scope via projectId metadata (B1 default; not a tenant boundary)
 * - tag_fanout: search exact project tags and merge (requires Local tag contract)
 * - tag_duplicate: duplicate docs into exact project tags at write time
 */

import type { KnowledgeSourceType } from "../memory/knowledge-source-types.js";

export type ProjectIsolationMode = "metadata_filter" | "tag_fanout" | "tag_duplicate";

export type KnowledgeProjectSourceRef = {
  sourceType: KnowledgeSourceType;
  /** Slack channelId, wiki spaceId, code repoId, or custom connectorId. */
  scopeId: string;
  enabled: boolean;
};

export type KnowledgeProject = {
  schemaVersion: 1;
  teamId: string;
  projectId: string;
  name: string;
  isolationMode: ProjectIsolationMode;
  sources: KnowledgeProjectSourceRef[];
  updatedAt: string;
};

export type UserProjectDefaults = {
  teamId: string;
  userId: string;
  defaultProjectId: string;
  updatedAt: string;
};

export function projectTag(teamId: string, projectId: string): `project:${string}:${string}` {
  if (!teamId || !projectId || /[:\u0000-\u001f\u007f]/.test(teamId) || /[:\u0000-\u001f\u007f]/.test(projectId)) {
    throw new Error("teamId and projectId must be safe identifiers");
  }
  return `project:${teamId}:${projectId}`;
}

export function parseKnowledgeProject(value: unknown): KnowledgeProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("unsupported project schemaVersion");
  if (typeof raw.teamId !== "string" || !raw.teamId) throw new Error("teamId required");
  if (typeof raw.projectId !== "string" || !raw.projectId) throw new Error("projectId required");
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("name required");
  if (
    raw.isolationMode !== "metadata_filter" &&
    raw.isolationMode !== "tag_fanout" &&
    raw.isolationMode !== "tag_duplicate"
  ) {
    throw new Error("isolationMode invalid");
  }
  if (!Array.isArray(raw.sources)) throw new Error("sources must be an array");
  const sources: KnowledgeProjectSourceRef[] = raw.sources.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`sources[${index}] invalid`);
    }
    const source = entry as Record<string, unknown>;
    if (
      source.sourceType !== "slack" &&
      source.sourceType !== "wiki" &&
      source.sourceType !== "code" &&
      source.sourceType !== "custom_db"
    ) {
      throw new Error(`sources[${index}].sourceType invalid`);
    }
    if (typeof source.scopeId !== "string" || !source.scopeId) {
      throw new Error(`sources[${index}].scopeId required`);
    }
    if (typeof source.enabled !== "boolean") {
      throw new Error(`sources[${index}].enabled required`);
    }
    return {
      sourceType: source.sourceType,
      scopeId: source.scopeId,
      enabled: source.enabled,
    };
  });
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new Error("updatedAt must be an ISO timestamp");
  }
  return {
    schemaVersion: 1,
    teamId: raw.teamId,
    projectId: raw.projectId,
    name: raw.name.trim(),
    isolationMode: raw.isolationMode,
    sources,
    updatedAt: raw.updatedAt,
  };
}

/** Enabled source refs for a project, optionally filtered by type. */
export function enabledProjectSources(
  project: KnowledgeProject,
  sourceType?: KnowledgeSourceType,
): KnowledgeProjectSourceRef[] {
  return project.sources.filter(
    (source) => source.enabled && (sourceType === undefined || source.sourceType === sourceType),
  );
}

/**
 * Resolve query tags for a project.
 * metadata_filter returns only workspace tag (project applied as metadata).
 * tag_fanout / tag_duplicate return exact project tag in addition to workspace.
 */
export function queryTagsForProject(input: {
  teamId: string;
  project: KnowledgeProject;
}): string[] {
  const workspace = `workspace:${input.teamId}`;
  if (input.project.isolationMode === "metadata_filter") {
    return [workspace];
  }
  return [workspace, projectTag(input.teamId, input.project.projectId)];
}

export function parseUserProjectDefaults(value: unknown): UserProjectDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("user project defaults must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.teamId !== "string" || !raw.teamId) throw new Error("teamId required");
  if (typeof raw.userId !== "string" || !raw.userId) throw new Error("userId required");
  if (typeof raw.defaultProjectId !== "string" || !raw.defaultProjectId) {
    throw new Error("defaultProjectId required");
  }
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new Error("updatedAt must be an ISO timestamp");
  }
  return {
    teamId: raw.teamId,
    userId: raw.userId,
    defaultProjectId: raw.defaultProjectId,
    updatedAt: raw.updatedAt,
  };
}
