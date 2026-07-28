/**
 * Wiki / Confluence-style page normalization and Local hybrid search (K2 Phase 2).
 * Fetch I/O stays outside the Worker turn path; Queue consumers call normalize.
 */

import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_SCHEMA_VERSION,
  type FlatMetadata,
  type KnowledgeCitationBase,
  type MetadataFilter,
} from "../knowledge-contract.js";
import type { KnowledgeNormalizedDocument } from "../knowledge-connector.js";
import { wikiSourceKey } from "../knowledge-source-types.js";
import type { SupermemoryClient } from "../supermemory-client.js";
import { workspaceTag } from "../knowledge-contract.js";
import { SupermemoryAdapterError } from "../supermemory-adapter.js";

export type WikiPageInput = {
  teamId: string;
  projectId: string;
  spaceId: string;
  pageId: string;
  title: string;
  body: string;
  updatedAt: string;
  aclPolicyRef: string;
  permalink?: string;
};

function sectionSlug(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "section";
}

function contentRevision(content: string): string {
  // Deterministic short hash without crypto dependency in pure tests.
  let h = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `wiki_${(h >>> 0).toString(16)}`;
}

/** Split markdown-ish body on ## headings; always include a page-level document. */
export function normalizeWikiPage(input: WikiPageInput): KnowledgeNormalizedDocument[] {
  const title = input.title.trim();
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!title && !body) throw new Error("wiki page requires title or body");

  const pageContent = [`# ${title}`, body].filter(Boolean).join("\n\n").trim();
  const pageKey = wikiSourceKey(input.teamId, input.spaceId, input.pageId);
  const baseMeta = (sourceKey: string, extra: FlatMetadata = {}): FlatMetadata => ({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    sourceType: "wiki",
    workspaceId: input.teamId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    pageId: input.pageId,
    sourceKey,
    contentRevision: contentRevision(pageContent),
    observedAt: input.updatedAt,
    indexedAt: input.updatedAt,
    aclPolicyRef: input.aclPolicyRef,
    status: "active",
    ...(input.permalink ? { permalink: input.permalink } : {}),
    ...extra,
  });

  const docs: KnowledgeNormalizedDocument[] = [
    {
      sourceKey: pageKey,
      sourceType: "wiki",
      content: pageContent,
      revision: contentRevision(pageContent),
      metadata: baseMeta(pageKey),
    },
  ];

  const parts = body.split(/\n(?=##\s+)/);
  if (parts.length > 1) {
    for (const part of parts) {
      const match = part.match(/^##\s+(.+)\n?([\s\S]*)$/);
      if (!match) continue;
      const heading = match[1]!.trim();
      const sectionBody = (match[2] ?? "").trim();
      const slug = sectionSlug(heading);
      const chunkId = `${input.pageId}#${slug}`;
      const sourceKey = wikiSourceKey(input.teamId, input.spaceId, chunkId);
      const content = [`# ${title}`, `## ${heading}`, sectionBody].filter(Boolean).join("\n\n");
      docs.push({
        sourceKey,
        sourceType: "wiki",
        content,
        revision: contentRevision(content),
        metadata: baseMeta(sourceKey, { sectionHeading: heading.slice(0, KNOWLEDGE_LIMITS.maxMetadataStringLength) }),
      });
    }
  }
  return docs;
}

export class WikiSearchAdapter {
  constructor(private readonly client: SupermemoryClient) {}

  async search(input: {
    teamId: string;
    projectId: string;
    spaceId: string;
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
        { key: "spaceId", value: input.spaceId },
        { key: "sourceType", value: "wiki" },
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
        .map((result) => citationFromWikiResult(result, input, retrievedAt))
        .filter((c): c is KnowledgeCitationBase => c !== undefined)
        .slice(0, input.limit);
    } catch (error) {
      if (error instanceof SupermemoryAdapterError) throw error;
      throw new SupermemoryAdapterError("knowledge_unavailable", true);
    }
  }
}

function citationFromWikiResult(
  result: unknown,
  scope: { teamId: string; projectId: string; spaceId: string; aclPolicyRef: string },
  retrievedAt: string,
): KnowledgeCitationBase | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const raw = result as Record<string, unknown>;
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) return undefined;
  const metadata = raw.metadata as Record<string, unknown>;
  if (
    metadata.workspaceId !== scope.teamId ||
    metadata.projectId !== scope.projectId ||
    metadata.spaceId !== scope.spaceId ||
    metadata.sourceType !== "wiki" ||
    metadata.status !== "active" ||
    metadata.aclPolicyRef !== scope.aclPolicyRef
  ) {
    return undefined;
  }
  const sourceKey = typeof metadata.sourceKey === "string" ? metadata.sourceKey : undefined;
  const contentRevision = typeof metadata.contentRevision === "string" ? metadata.contentRevision : undefined;
  const pageId = typeof metadata.pageId === "string" ? metadata.pageId : undefined;
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
    sourceType: "wiki",
    projectId: scope.projectId,
    spaceId: scope.spaceId,
    ...(pageId ? { pageId } : {}),
    contentRevision,
    excerpt,
    ...(typeof raw.similarity === "number" && Number.isFinite(raw.similarity) ? { score: raw.similarity } : {}),
    aclPolicyRef: scope.aclPolicyRef,
    retrievedAt,
    ...(typeof metadata.permalink === "string" ? { permalink: metadata.permalink } : {}),
  };
}
