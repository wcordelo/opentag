/**
 * Code repository chunking + Local hybrid search (K2 Phase 2).
 * Ripgrep over clones lives in the harness Container; this path is embeddings only.
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
import { codeSourceKey } from "../knowledge-source-types.js";
import type { SupermemoryClient } from "../supermemory-client.js";
import { SupermemoryAdapterError } from "../supermemory-adapter.js";

const DEFAULT_WINDOW = 2_000;
const DEFAULT_OVERLAP = 200;

export type CodeFileInput = {
  teamId: string;
  projectId: string;
  repoId: string;
  path: string;
  content: string;
  language?: string;
  aclPolicyRef: string;
  observedAt?: string;
};

function contentRevision(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `code_${(h >>> 0).toString(16)}`;
}

function safeChunkId(path: string, startLine: number, endLine: number): string {
  const safePath = path.replace(/:/g, "_").slice(0, 90);
  return `${safePath}:${startLine}-${endLine}`;
}

/** Coarse language-aware splits, then fixed windows for leftover / unknown languages. */
export function chunkCodeFile(input: CodeFileInput): KnowledgeNormalizedDocument[] {
  const content = input.content.replace(/\r\n/g, "\n");
  if (!content.trim()) return [];
  const lines = content.split("\n");
  const lang = (input.language ?? guessLanguage(input.path)).toLowerCase();
  const boundary = boundaryRegex(lang);
  const ranges: Array<{ start: number; end: number }> = [];

  if (boundary) {
    const starts: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (boundary.test(lines[i]!)) starts.push(i);
    }
    if (starts.length > 0) {
      for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i]!;
        const end = (starts[i + 1] ?? lines.length) - 1;
        ranges.push({ start, end: Math.max(start, end) });
      }
    }
  }

  if (ranges.length === 0) {
    let charStart = 0;
    while (charStart < content.length) {
      const charEnd = Math.min(content.length, charStart + DEFAULT_WINDOW);
      const before = content.slice(0, charStart);
      const slice = content.slice(charStart, charEnd);
      const startLine = before.split("\n").length;
      const endLine = startLine + slice.split("\n").length - 1;
      ranges.push({ start: startLine - 1, end: endLine - 1 });
      if (charEnd >= content.length) break;
      charStart = Math.max(charStart + 1, charEnd - DEFAULT_OVERLAP);
    }
  }

  const observedAt = input.observedAt ?? new Date(0).toISOString();
  const docs: KnowledgeNormalizedDocument[] = [];
  for (const range of ranges) {
    const chunkLines = lines.slice(range.start, range.end + 1);
    const chunkText = chunkLines.join("\n").trim();
    if (!chunkText) continue;
    const chunkId = safeChunkId(input.path, range.start + 1, range.end + 1);
    const sourceKey = codeSourceKey(input.teamId, input.repoId, chunkId);
    const embedContent = [`File: ${input.path}`, `Lines: ${range.start + 1}-${range.end + 1}`, chunkText].join("\n");
    const revision = contentRevision(embedContent);
    const metadata: FlatMetadata = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      sourceType: "code",
      workspaceId: input.teamId,
      projectId: input.projectId,
      repoId: input.repoId,
      path: input.path.slice(0, KNOWLEDGE_LIMITS.maxMetadataStringLength),
      startLine: range.start + 1,
      endLine: range.end + 1,
      sourceKey,
      contentRevision: revision,
      observedAt,
      indexedAt: observedAt,
      aclPolicyRef: input.aclPolicyRef,
      status: "active",
    };
    docs.push({
      sourceKey,
      sourceType: "code",
      content: embedContent,
      revision,
      metadata,
    });
  }
  return docs;
}

function guessLanguage(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "ts";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs")) return "js";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rs";
  return "text";
}

function boundaryRegex(lang: string): RegExp | undefined {
  switch (lang) {
    case "ts":
    case "js":
    case "tsx":
    case "jsx":
      return /^(?:export\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\()/;
    case "py":
      return /^(?:async\s+)?(?:def|class)\s+\w+/;
    case "go":
      return /^func\s+/;
    case "rs":
      return /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|impl)\s+/;
    default:
      return undefined;
  }
}

export class CodeSearchAdapter {
  constructor(private readonly client: SupermemoryClient) {}

  async search(input: {
    teamId: string;
    projectId: string;
    repoId: string;
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
        { key: "repoId", value: input.repoId },
        { key: "sourceType", value: "code" },
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
        .map((result) => citationFromCodeResult(result, input, retrievedAt))
        .filter((c): c is KnowledgeCitationBase => c !== undefined)
        .slice(0, input.limit);
    } catch (error) {
      if (error instanceof SupermemoryAdapterError) throw error;
      throw new SupermemoryAdapterError("knowledge_unavailable", true);
    }
  }
}

function citationFromCodeResult(
  result: unknown,
  scope: { teamId: string; projectId: string; repoId: string; aclPolicyRef: string },
  retrievedAt: string,
): KnowledgeCitationBase | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const raw = result as Record<string, unknown>;
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) return undefined;
  const metadata = raw.metadata as Record<string, unknown>;
  if (
    metadata.workspaceId !== scope.teamId ||
    metadata.projectId !== scope.projectId ||
    metadata.repoId !== scope.repoId ||
    metadata.sourceType !== "code" ||
    metadata.status !== "active" ||
    metadata.aclPolicyRef !== scope.aclPolicyRef
  ) {
    return undefined;
  }
  const sourceKey = typeof metadata.sourceKey === "string" ? metadata.sourceKey : undefined;
  const contentRevision = typeof metadata.contentRevision === "string" ? metadata.contentRevision : undefined;
  const path = typeof metadata.path === "string" ? metadata.path : undefined;
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
    sourceType: "code",
    projectId: scope.projectId,
    repoId: scope.repoId,
    ...(path ? { path } : {}),
    contentRevision,
    excerpt,
    ...(typeof raw.similarity === "number" && Number.isFinite(raw.similarity) ? { score: raw.similarity } : {}),
    aclPolicyRef: scope.aclPolicyRef,
    retrievedAt,
  };
}
