/**
 * Custom database row emitters → shared document contract (K2 Phase 2).
 */

import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_SCHEMA_VERSION,
  type FlatMetadata,
  type KnowledgeCitationBase,
  type MetadataFilter,
  workspaceTag,
} from "../knowledge-contract.js";
import type { KnowledgeNormalizedDocument } from "../knowledge-connector.js";
import { customDbSourceKey } from "../knowledge-source-types.js";
import type { SupermemoryClient } from "../supermemory-client.js";
import { SupermemoryAdapterError } from "../supermemory-adapter.js";

export type CustomDbRow = {
  rowId: string;
  title?: string;
  content: string;
  metadata?: FlatMetadata;
};

export type CustomDbRowEmitter = {
  teamId: string;
  projectId: string;
  connectorId: string;
  aclPolicyRef: string;
  observedAt?: string;
  rows: CustomDbRow[];
};

function contentRevision(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `cdb_${(h >>> 0).toString(16)}`;
}

export function normalizeCustomDbRows(input: CustomDbRowEmitter): KnowledgeNormalizedDocument[] {
  const observedAt = input.observedAt ?? new Date(0).toISOString();
  const docs: KnowledgeNormalizedDocument[] = [];
  for (const row of input.rows) {
    const body = row.content.trim();
    if (!body) continue;
    const sourceKey = customDbSourceKey(input.teamId, input.connectorId, row.rowId);
    const content = row.title ? `${row.title.trim()}\n\n${body}` : body;
    const revision = contentRevision(content);
    const metadata: FlatMetadata = {
      ...(row.metadata ?? {}),
      // Canonical server-derived fields always win over caller row metadata.
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      sourceType: "custom_db",
      workspaceId: input.teamId,
      projectId: input.projectId,
      connectorId: input.connectorId,
      rowId: row.rowId,
      sourceKey,
      contentRevision: revision,
      observedAt,
      indexedAt: observedAt,
      aclPolicyRef: input.aclPolicyRef,
      status: "active",
    };
    docs.push({
      sourceKey,
      sourceType: "custom_db",
      content,
      revision,
      metadata,
    });
  }
  return docs;
}

export class CustomDbSearchAdapter {
  constructor(private readonly client: SupermemoryClient) {}

  async search(input: {
    teamId: string;
    projectId: string;
    connectorId: string;
    aclPolicyRef: string;
    query: string;
    limit: number;
  }): Promise<KnowledgeCitationBase[]> {
    const query = input.query.trim();
    if (!query || query.length > 1_000 || input.limit < 1 || input.limit > KNOWLEDGE_LIMITS.maxSearchLimit) {
      throw new SupermemoryAdapterError("local_rejected", false);
    }
    const retrievedAt = new Date().toISOString();
    const filters: MetadataFilter = {
      AND: [
        { key: "projectId", value: input.projectId },
        { key: "connectorId", value: input.connectorId },
        { key: "sourceType", value: "custom_db" },
        { key: "status", value: "active" },
      ],
    };
    try {
      const response = await this.client.search.memories({
        q: query,
        containerTag: workspaceTag(input.teamId),
        searchMode: "hybrid",
        filters,
        limit: input.limit,
      });
      if (!response || !Array.isArray(response.results)) {
        throw new SupermemoryAdapterError("local_malformed_response", true);
      }
      return response.results
        .map((result) => citationFromCustomResult(result, input, retrievedAt))
        .filter((c): c is KnowledgeCitationBase => c !== undefined)
        .slice(0, input.limit);
    } catch (error) {
      if (error instanceof SupermemoryAdapterError) throw error;
      throw new SupermemoryAdapterError("knowledge_unavailable", true);
    }
  }
}

function citationFromCustomResult(
  result: unknown,
  scope: { teamId: string; projectId: string; connectorId: string; aclPolicyRef: string },
  retrievedAt: string,
): KnowledgeCitationBase | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const raw = result as Record<string, unknown>;
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) return undefined;
  const metadata = raw.metadata as Record<string, unknown>;
  if (
    metadata.workspaceId !== scope.teamId ||
    metadata.projectId !== scope.projectId ||
    metadata.connectorId !== scope.connectorId ||
    metadata.sourceType !== "custom_db" ||
    metadata.status !== "active" ||
    metadata.aclPolicyRef !== scope.aclPolicyRef
  ) {
    return undefined;
  }
  const sourceKey = typeof metadata.sourceKey === "string" ? metadata.sourceKey : undefined;
  const contentRevision = typeof metadata.contentRevision === "string" ? metadata.contentRevision : undefined;
  const rowId = typeof metadata.rowId === "string" ? metadata.rowId : undefined;
  const rawExcerpt = typeof raw.chunk === "string"
    ? raw.chunk
    : typeof raw.memory === "string"
      ? raw.memory
      : undefined;
  if (!sourceKey || !contentRevision || !rawExcerpt) return undefined;
  const excerpt = rawExcerpt.replace(/\s+/g, " ").trim().slice(0, KNOWLEDGE_LIMITS.maxCitationExcerptLength);
  if (!excerpt) return undefined;
  return {
    sourceKey,
    sourceType: "custom_db",
    projectId: scope.projectId,
    connectorId: scope.connectorId,
    ...(rowId ? { rowId } : {}),
    contentRevision,
    excerpt,
    ...(typeof raw.similarity === "number" && Number.isFinite(raw.similarity) ? { score: raw.similarity } : {}),
    aclPolicyRef: scope.aclPolicyRef,
    retrievedAt,
  };
}
