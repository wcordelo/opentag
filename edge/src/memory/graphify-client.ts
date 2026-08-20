import type { ServiceBinding } from "./supermemory-client.js";

const GRAPHIFY_ORIGIN = "https://graphify.internal";
const GRAPHIFY_TIMEOUT_MS = 5_000;
const MAX_ERROR_BODY = 512;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ARTIFACT_KEY = /^code-graphs\/[A-Za-z0-9._-]{1,128}\/[0-9a-f]{40}$/;

export type GraphifyNode = {
  id: string;
  label?: string;
  sourceFile?: string;
  sourceLocation?: string;
  excerpt?: string;
  score?: number;
  depth?: number;
  relation?: string;
  confidenceLabel?: string;
  viaFile?: string;
  viaLocation?: string;
  confidence?: number;
};

export type GraphifyEdge = {
  source: string;
  target: string;
  relation?: string;
  confidenceLabel?: string;
  confidence?: number;
  sourceFile?: string;
  sourceLocation?: string;
};

export type GraphifyRevision = {
  teamId: string;
  repoId: string;
  commitSha: string;
  artifactKey: string;
};

export type GraphifySearchResponse = GraphifyRevision & {
  results: GraphifyNode[];
};

export type GraphifyPathResponse = GraphifyRevision & {
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
};

export type GraphifyImpactResponse = GraphifyRevision & {
  results: GraphifyNode[];
};

export class GraphifyClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "GraphifyClientError";
  }
}

type GraphifyResponse = GraphifySearchResponse | GraphifyPathResponse | GraphifyImpactResponse;

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function safeJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function normalizeRevision(value: unknown): GraphifyRevision {
  const input = safeJson(value) as Record<string, unknown> | undefined;
  const teamId = boundedString(input?.teamId, 128);
  const repoId = boundedString(input?.repoId, 128);
  const commitSha = boundedString(input?.commitSha, 128);
  const artifactKey = boundedString(input?.artifactKey, 256);
  if (!teamId || !repoId || !commitSha || !COMMIT_SHA.test(commitSha) ||
    !artifactKey || !ARTIFACT_KEY.test(artifactKey)) {
    throw new GraphifyClientError("Graphify response is missing an immutable revision", 502, false);
  }
  if (artifactKey !== `code-graphs/${repoId}/${commitSha}`) {
    throw new GraphifyClientError("Graphify response artifact scope does not match its revision", 502, false);
  }
  return { teamId, repoId, commitSha, artifactKey };
}

function normalizeNode(value: unknown): GraphifyNode | undefined {
  const input = safeJson(value) as Record<string, unknown> | undefined;
  const id = boundedString(input?.id, 256);
  if (!id) return undefined;
  const node: GraphifyNode = { id };
  const fields: Array<[keyof GraphifyNode, number]> = [
    ["label", 512], ["sourceFile", 512], ["sourceLocation", 64],
    ["excerpt", 1_000], ["relation", 128], ["confidenceLabel", 64], ["viaFile", 512], ["viaLocation", 64],
  ];
  for (const [field, max] of fields) {
    const stringValue = boundedString(input?.[field], max);
    if (stringValue) (node[field] as string | undefined) = stringValue;
  }
  for (const field of ["score", "confidence"] as const) {
    const numberValue = input?.[field];
    if (typeof numberValue === "number" && Number.isFinite(numberValue)) node[field] = numberValue;
  }
  if (typeof input?.depth === "number" && Number.isSafeInteger(input.depth) && input.depth >= 0) {
    node.depth = input.depth;
  }
  return node;
}

function normalizeEdge(value: unknown): GraphifyEdge | undefined {
  const input = safeJson(value) as Record<string, unknown> | undefined;
  const source = boundedString(input?.source, 256);
  const target = boundedString(input?.target, 256);
  if (!source || !target) return undefined;
  const edge: GraphifyEdge = { source, target };
  for (const [field, max] of [["relation", 128], ["confidenceLabel", 64], ["sourceFile", 512], ["sourceLocation", 64]] as const) {
    const stringValue = boundedString(input?.[field], max);
    if (stringValue) edge[field] = stringValue;
  }
  if (typeof input?.confidence === "number" && Number.isFinite(input.confidence)) {
    edge.confidence = input.confidence;
  }
  return edge;
}

function normalizePayload(value: unknown, operation: "search" | "path" | "impact"): GraphifyResponse {
  const input = safeJson(value) as Record<string, unknown> | undefined;
  const revision = normalizeRevision(value);
  if (operation === "path") {
    const nodes = Array.isArray(input?.nodes)
      ? input.nodes.map(normalizeNode).filter((node): node is GraphifyNode => Boolean(node)).slice(0, 128)
      : [];
    const edges = Array.isArray(input?.edges)
      ? input.edges.map(normalizeEdge).filter((edge): edge is GraphifyEdge => Boolean(edge)).slice(0, 256)
      : [];
    return { ...revision, nodes, edges };
  }
  const results = Array.isArray(input?.results)
    ? input.results.map(normalizeNode).filter((node): node is GraphifyNode => Boolean(node)).slice(0, 64)
    : [];
  return { ...revision, results };
}

export class GraphifyClient {
  constructor(
    private readonly binding: ServiceBinding,
    private readonly serviceAuthToken: string,
    private readonly timeoutMs = GRAPHIFY_TIMEOUT_MS,
  ) {}

  private async request<T extends GraphifyResponse>(
    path: string,
    body: Record<string, unknown>,
    operation: "search" | "path" | "impact",
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.binding.fetch(`${GRAPHIFY_ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opentag-graphify-token": this.serviceAuthToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, MAX_ERROR_BODY);
        throw new GraphifyClientError(
          detail || `Graphify request failed with ${response.status}`,
          response.status,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new GraphifyClientError("Graphify returned invalid JSON", 502, true);
      }
      const normalized = normalizePayload(payload, operation);
      const requestedTeamId = body.teamId;
      const requestedRepoId = body.repoId;
      if (normalized.teamId !== requestedTeamId || normalized.repoId !== requestedRepoId) {
        throw new GraphifyClientError("Graphify response scope does not match the request", 502, false);
      }
      return normalized as T;
    } catch (error) {
      if (error instanceof GraphifyClientError) throw error;
      throw new GraphifyClientError(
        error instanceof Error && error.name === "AbortError" ? "Graphify request timed out" : "Graphify is unavailable",
        undefined,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  search(input: { teamId: string; repoId: string; projectId: string; query: string; limit: number }): Promise<GraphifySearchResponse> {
    return this.request<GraphifySearchResponse>("/v1/code/graph-search", input, "search");
  }

  path(input: { teamId: string; repoId: string; projectId: string; source: string; target: string; maxHops: number }): Promise<GraphifyPathResponse> {
    return this.request<GraphifyPathResponse>("/v1/code/path", input, "path");
  }

  impact(input: { teamId: string; repoId: string; projectId: string; symbol: string; depth: number; relations?: string[] }): Promise<GraphifyImpactResponse> {
    return this.request<GraphifyImpactResponse>("/v1/code/impact", input, "impact");
  }
}

export function createGraphifyClient(env: {
  GRAPHIFY?: ServiceBinding;
  GRAPHIFY_SERVICE_AUTH_TOKEN?: string;
}): GraphifyClient | undefined {
  const token = env.GRAPHIFY_SERVICE_AUTH_TOKEN?.trim();
  if (!env.GRAPHIFY || !token) return undefined;
  return new GraphifyClient(env.GRAPHIFY, token);
}
