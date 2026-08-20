import {
  KNOWLEDGE_LIMITS,
  type KnowledgeCitationBase,
} from "./knowledge-contract.js";
import {
  GraphifyClient,
  GraphifyClientError,
  type GraphifyEdge,
  type GraphifyNode,
} from "./graphify-client.js";

export { GraphifyClientError } from "./graphify-client.js";

type GraphScope = {
  teamId: string;
  repoId: string;
  projectId: string;
  aclPolicyRef: string;
};

function sourceLocation(value: string | undefined): { startLine?: number; endLine?: number } {
  if (!value) return {};
  const match = /^(?:L)?(\d+)(?:[-:]L?(\d+))?$/i.exec(value.trim());
  if (!match) return {};
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < 1) return {};
  return { startLine, endLine: Math.max(startLine, endLine) };
}

function sourcePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const path = value.replace(/^\.\//, "").trim();
  if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]+/).some((part) => part === ".." || part === ".") ||
    /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  return path.slice(0, 512);
}

function safePart(value: string, max: number): string {
  return encodeURIComponent(value).slice(0, max);
}

function citationFromNode(
  node: GraphifyNode,
  scope: GraphScope,
  revision: { commitSha: string; artifactKey: string },
  operation: string,
  relation?: string,
  confidenceOverride?: number,
  confidenceLabelOverride?: string,
): KnowledgeCitationBase {
  const excerpt = (node.excerpt ?? node.label ?? node.id).replace(/\s+/g, " ").trim().slice(0, KNOWLEDGE_LIMITS.maxCitationExcerptLength);
  const path = sourcePath(node.viaFile ?? node.sourceFile);
  const location = sourceLocation(node.viaLocation ?? node.sourceLocation);
  const score = typeof node.score === "number" && Number.isFinite(node.score)
    ? node.score
    : typeof node.depth === "number" && node.depth >= 0
      ? 1 / (1 + node.depth)
      : undefined;
  const confidence = typeof (confidenceOverride ?? node.confidence) === "number" && Number.isFinite(confidenceOverride ?? node.confidence)
    ? Math.max(0, Math.min(1, confidenceOverride ?? node.confidence!))
    : undefined;
  return {
    sourceKey: `code_graph:${safePart(scope.teamId, 96)}:${safePart(scope.repoId, 96)}:${safePart(revision.commitSha, 96)}:${operation}:${safePart(node.id, 160)}`,
    sourceType: "code_graph",
    projectId: scope.projectId,
    contentRevision: `graph:${revision.commitSha}`,
    excerpt,
    ...(score !== undefined ? { score } : {}),
    aclPolicyRef: scope.aclPolicyRef,
    retrievedAt: new Date().toISOString(),
    repoId: scope.repoId,
    commitSha: revision.commitSha,
    ...(path ? { path } : {}),
    ...location,
    ...(relation || node.relation ? { relation: relation ?? node.relation } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...((confidenceLabelOverride ?? node.confidenceLabel)
      ? { confidenceLabel: confidenceLabelOverride ?? node.confidenceLabel }
      : {}),
    artifactKey: revision.artifactKey,
  };
}

function evidenceForEdge(edge: GraphifyEdge | undefined): {
  relation?: string;
  confidence?: number;
  confidenceLabel?: string;
} {
  return {
    ...(edge?.relation ? { relation: edge.relation } : {}),
    ...(edge?.confidence !== undefined ? { confidence: edge.confidence } : {}),
    ...(edge?.confidenceLabel ? { confidenceLabel: edge.confidenceLabel } : {}),
  };
}

export class GraphifyAdapter {
  constructor(private readonly client: GraphifyClient) {}

  async search(input: GraphScope & { query: string; limit: number }): Promise<KnowledgeCitationBase[]> {
    const response = await this.client.search(input);
    return response.results
      .map((node) => citationFromNode(node, input, response, "search"))
      .slice(0, input.limit);
  }

  async path(input: GraphScope & { source: string; target: string; maxHops: number }): Promise<KnowledgeCitationBase[]> {
    const response = await this.client.path(input);
    return response.nodes
      .map((node, index) => {
        const prior = response.nodes[index - 1];
        const edge = prior && response.edges.find((candidate) =>
          (candidate.source === prior.id && candidate.target === node.id) ||
          (candidate.target === prior.id && candidate.source === node.id),
        );
        const evidence = evidenceForEdge(edge);
        return citationFromNode(
          node,
          input,
          response,
          "path",
          evidence.relation,
          evidence.confidence,
          evidence.confidenceLabel,
        );
      })
      .slice(0, 128);
  }

  async impact(input: GraphScope & { symbol: string; depth: number; relations?: string[] }): Promise<KnowledgeCitationBase[]> {
    const response = await this.client.impact(input);
    return response.results
      .map((node) => citationFromNode(node, input, response, "impact"))
      .slice(0, 64);
  }
}
