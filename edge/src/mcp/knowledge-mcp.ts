/**
 * MCP retrieval primitives for the knowledge base (K2 Phase 5).
 * LLM-light: raw evidence rows only. Clients orchestrate planner/synthesis.
 * No ingestion path — search only, operator bearer or actor-token gated.
 */

import type { Env } from "../env.js";
import {
  KNOWLEDGE_ACTOR_TOKEN_HEADER,
  verifyKnowledgeActorToken,
  type KnowledgeActorTokenClaims,
} from "./knowledge-actor-token.js";
import type { KnowledgeMcpAuditEvent } from "../memory/knowledge-do.js";
import { tenantStub } from "../tenancy.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { KNOWLEDGE_LIMITS, rejectCallerControlledAddressing } from "../memory/knowledge-contract.js";
import { createSupermemoryClientFromEnv } from "../memory/supermemory-client.js";
import { createGraphifyClient } from "../memory/graphify-client.js";
import { GraphifyAdapter } from "../memory/graphify-adapter.js";
import { connectorGrantsOf } from "../connectors/authorization.js";
import type { AccessBundle, WorkspaceChannelConfig } from "../config/access-bundle.js";
import { readerPolicyRefForBundle } from "../config/knowledge-config.js";
import {
  currentKnowledgeReadGrantAllows,
  currentKnowledgeToolAllows,
  loadCurrentKnowledgeReadAccess,
} from "../memory/knowledge-read-authorization.js";
import { WikiSearchAdapter } from "../memory/connectors/wiki-connector.js";
import { CodeSearchAdapter } from "../memory/connectors/code-connector.js";
import { CustomDbSearchAdapter } from "../memory/connectors/custom-db-connector.js";
import { SupermemoryAdapter } from "../memory/supermemory-adapter.js";
import {
  isSlackKnowledgeMember,
  searchSlackKnowledgeForActor,
} from "../tools/search-slack.js";
import { unifiedKnowledgeSearch } from "../memory/retrieval/unified-search.js";
import {
  parseRawKnowledgeQuery,
  type RawKnowledgeQuery,
  type RawKnowledgeQueryResponse,
} from "../memory/raw-query-templates.js";

export type KnowledgeMcpToolName =
  | "search"
  | "search_slack"
  | "search_wiki"
  | "search_code"
  | "search_custom"
  | "code_graph_search"
  | "code_path"
  | "code_impact"
  | "query_template";

export const KNOWLEDGE_MCP_TOOLS: readonly KnowledgeMcpToolName[] = [
  "search",
  "search_slack",
  "search_wiki",
  "search_code",
  "search_custom",
  "code_graph_search",
  "code_path",
  "code_impact",
  "query_template",
] as const;

export type KnowledgeMcpRequest = {
  tool: KnowledgeMcpToolName;
  teamId: string;
  projectId?: string;
  query?: string;
  limit?: number;
  channelId?: string;
  spaceId?: string;
  repoId?: string;
  connectorId?: string;
  source?: string;
  target?: string;
  symbol?: string;
  depth?: number;
  maxHops?: number;
  relations?: string[];
  aclPolicyRef: string;
  rawQuery?: RawKnowledgeQuery;
};

export type KnowledgeMcpResponse =
  | { status: "ok"; citations: KnowledgeCitationBase[] }
  | ({ status: "ok" } & RawKnowledgeQueryResponse)
  | { status: "error"; code: string; message: string };

type McpAuthorization =
  | { kind: "operator"; actorId: "operator"; jti: string }
  | { kind: "actor"; actorId: string; jti: string; claims: KnowledgeActorTokenClaims };

function hasAdminAuthorization(request: Request, env: Env): boolean {
  const expected = env.ADMIN_SECRET;
  if (!expected) return false;
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return Boolean(match && match[1] === expected);
}

function resourceForRequest(input: KnowledgeMcpRequest): { type: string; id: string } | undefined {
  const resources: Array<[string, string]> = [];
  if (input.channelId) resources.push(["channel", input.channelId]);
  if (input.spaceId) resources.push(["space", input.spaceId]);
  if (input.repoId) resources.push(["repo", input.repoId]);
  if (input.connectorId) resources.push(["connector", input.connectorId]);
  if (resources.length === 0) return undefined;
  if (resources.length === 1) {
    return { type: resources[0]![0], id: resources[0]![1] };
  }
  return {
    type: "multi",
    id: resources.map(([type, id]) => `${type}:${id}`).join(",").slice(0, 256),
  };
}

function actorScopeContains(claims: KnowledgeActorTokenClaims, input: KnowledgeMcpRequest): boolean {
  const scopes: Array<[string | undefined, string[]]> = [
    [input.channelId, claims.scopes.channelIds],
    [input.spaceId, claims.scopes.spaceIds],
    [input.repoId, claims.scopes.repoIds],
    [input.connectorId, claims.scopes.connectorIds],
  ];
  return scopes.every(([resourceId, allowed]) => resourceId === undefined || allowed.includes(resourceId));
}

async function currentActorAclMatches(
  env: Env,
  claims: KnowledgeActorTokenClaims,
  input: KnowledgeMcpRequest,
): Promise<boolean> {
  if (!input.channelId) return true;
  if (!env.WORKSPACE_CONFIG) return false;
  try {
    const response = await tenantStub(env.WORKSPACE_CONFIG, claims.teamId).fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        teamId: claims.teamId,
        projectId: claims.projectId,
        channelId: input.channelId,
      }),
    });
    if (!response.ok) return false;
    const source = await response.json() as {
      teamId?: unknown;
      projectId?: unknown;
      channelId?: unknown;
      enabled?: unknown;
      readerPolicyRef?: unknown;
    };
    const sourceMatches = source.teamId === claims.teamId &&
      source.projectId === claims.projectId &&
      source.channelId === input.channelId &&
      source.enabled === true &&
      source.readerPolicyRef === claims.aclPolicyRef;
    return sourceMatches && await isSlackKnowledgeMember(
      env,
      claims.teamId,
      input.channelId,
      claims.actor.id,
    );
  } catch {
    return false;
  }
}

async function currentGraphRepositoryGrantMatches(
  env: Env,
  input: KnowledgeMcpRequest,
  authorization: Extract<McpAuthorization, { kind: "actor" }>,
): Promise<boolean> {
  // Graph tools require both a signed actor repo scope and the current access
  // bundle grant. Requiring a channel makes the bundle lookup exact; a repo
  // token without a live channel policy must not reach Graphify.
  if (!input.channelId || !input.repoId) return false;
  try {
    const configResponse = await tenantStub(env.WORKSPACE_CONFIG, input.teamId).fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId: input.teamId, channelId: input.channelId }),
    });
    if (!configResponse.ok) return false;
    const config = await configResponse.json() as WorkspaceChannelConfig;
    const bundleResponse = await tenantStub(env.WORKSPACE_CONFIG, input.teamId).fetch("https://do/getBundle", {
      method: "POST",
      body: JSON.stringify({ id: config.accessBundleId }),
    });
    if (!bundleResponse.ok) return false;
    const bundle = await bundleResponse.json() as AccessBundle;
    if (config.teamId !== input.teamId || config.channelId !== input.channelId ||
      bundle.status === "revoked" || !bundle.tools.includes(input.tool) ||
      !authorization.claims.scopes.repoIds.includes(input.repoId)) {
      return false;
    }
    return connectorGrantsOf(bundle).some((grant) =>
      grant.connectorId === "code_graph" &&
      grant.actions.includes(input.tool) &&
      grant.repoId === input.repoId &&
      (!grant.projectId || grant.projectId === input.projectId) &&
      (!grant.channelId || grant.channelId === input.channelId) &&
      (grant.scope === "workspace" ||
        (grant.scope === "project" && Boolean(input.projectId)) ||
        (grant.scope === "channel" && Boolean(input.channelId))),
    );
  } catch {
    return false;
  }
}

async function currentActorKnowledgeReadAllows(
  env: Env,
  claims: KnowledgeActorTokenClaims,
  input: KnowledgeMcpRequest,
): Promise<boolean> {
  if (!input.channelId || !input.projectId) return false;
  const access = await loadCurrentKnowledgeReadAccess(env, input.teamId, input.channelId);
  if (!access) return false;
  try {
    if (readerPolicyRefForBundle(access.bundle.id) !== input.aclPolicyRef) return false;
  } catch {
    return false;
  }
  if (input.tool === "query_template") return false;
  if (input.tool === "search_slack" && !(await currentActorAclMatches(env, claims, input))) return false;
  if (!currentKnowledgeToolAllows(access, {
    teamId: input.teamId,
    channelId: input.channelId,
    action: input.tool,
  })) return false;

  const grant = (request: Parameters<typeof currentKnowledgeReadGrantAllows>[1]): boolean =>
    currentKnowledgeReadGrantAllows(access, request);

  if (input.tool === "search_slack") {
    return true;
  }
  if (input.tool === "search_wiki") {
    return Boolean(input.spaceId) && grant({
      teamId: input.teamId,
      channelId: input.channelId,
      projectId: input.projectId,
      connectorId: "wiki",
      action: "search_wiki",
      spaceId: input.spaceId,
      aclPolicyRef: input.aclPolicyRef,
    });
  }
  if (input.tool === "search_code") {
    return Boolean(input.repoId) && grant({
      teamId: input.teamId,
      channelId: input.channelId,
      projectId: input.projectId,
      connectorId: "code",
      action: "search_code",
      repoId: input.repoId,
      aclPolicyRef: input.aclPolicyRef,
    });
  }
  if (input.tool === "search_custom") {
    const connectorId = input.connectorId;
    if (!connectorId) return false;
    return grant({
      teamId: input.teamId,
      channelId: input.channelId,
      projectId: input.projectId,
      connectorId,
      action: "search_custom",
      aclPolicyRef: input.aclPolicyRef,
    });
  }
  if (input.tool === "code_graph_search" || input.tool === "code_path" || input.tool === "code_impact") {
    return Boolean(input.repoId) && currentGraphRepositoryGrantMatches(env, input, {
      kind: "actor",
      actorId: claims.actor.id,
      jti: claims.jti,
      claims,
    });
  }
  if (input.tool === "search") {
    let sourceCount = 0;
    if (input.channelId) {
      if (!(await currentActorAclMatches(env, claims, input))) return false;
      if (!currentKnowledgeToolAllows(access, {
        teamId: input.teamId,
        channelId: input.channelId,
        action: "search_slack",
      })) return false;
      sourceCount += 1;
    }
    if (input.spaceId) {
      if (!(await grant({
        teamId: input.teamId,
        channelId: input.channelId,
        projectId: input.projectId,
        connectorId: "wiki",
        action: "search_wiki",
        spaceId: input.spaceId,
        aclPolicyRef: input.aclPolicyRef,
      }))) return false;
      sourceCount += 1;
    }
    if (input.repoId) {
      if (!(await grant({
        teamId: input.teamId,
        channelId: input.channelId,
        projectId: input.projectId,
        connectorId: "code",
        action: "search_code",
        repoId: input.repoId,
        aclPolicyRef: input.aclPolicyRef,
      }))) return false;
      sourceCount += 1;
    }
    if (input.connectorId) {
      if (!(await grant({
        teamId: input.teamId,
        channelId: input.channelId,
        projectId: input.projectId,
        connectorId: input.connectorId,
        action: "search_custom",
        aclPolicyRef: input.aclPolicyRef,
      }))) return false;
      sourceCount += 1;
    }
    return sourceCount > 0;
  }
  return false;
}

async function consumeActorToken(
  env: Env,
  claims: KnowledgeActorTokenClaims,
): Promise<boolean> {
  const namespace = env.KNOWLEDGE;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return false;
  const response = await tenantStub(namespace, claims.teamId).fetch("https://do/actor-token/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jti: claims.jti,
      teamId: claims.teamId,
      actorId: claims.actor.id,
      rev: claims.rev,
      expiresAt: claims.exp * 1000,
    }),
  });
  if (!response.ok) return false;
  const result = await response.json() as { accepted?: boolean };
  return result.accepted === true;
}

async function authorizeMcp(
  request: Request,
  env: Env,
  input: KnowledgeMcpRequest,
): Promise<McpAuthorization | null> {
  if (hasAdminAuthorization(request, env)) {
    return { kind: "operator", actorId: "operator", jti: `operator:${crypto.randomUUID()}` };
  }
  const token = request.headers.get(KNOWLEDGE_ACTOR_TOKEN_HEADER);
  if (!token || !env.KNOWLEDGE_ACTOR_TOKEN_SECRET) return null;
  const verification = await verifyKnowledgeActorToken(token, env.KNOWLEDGE_ACTOR_TOKEN_SECRET);
  if (!verification.ok) return null;
  const claims = verification.claims;
  if (
    claims.teamId !== input.teamId ||
    claims.projectId !== input.projectId ||
    claims.aclPolicyRef !== input.aclPolicyRef ||
    !actorScopeContains(claims, input)
  ) {
    return null;
  }
  if (!(await currentActorKnowledgeReadAllows(env, claims, input))) return null;
  return { kind: "actor", actorId: claims.actor.id, jti: claims.jti, claims };
}

async function recordMcpAudit(env: Env, event: KnowledgeMcpAuditEvent): Promise<boolean> {
  const namespace = env.KNOWLEDGE;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return false;
  try {
    const response = await tenantStub(namespace, event.teamId).fetch("https://do/mcp-audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type SlackConvergenceSearch = {
  citations: KnowledgeCitationBase[];
  providerResultCount: number;
  queryDigest: string;
};

async function recordSlackQueryConvergence(
  env: Env,
  input: KnowledgeMcpRequest,
  result: SlackConvergenceSearch,
): Promise<void> {
  if (!env.KNOWLEDGE || input.tool !== "search_slack" || !input.channelId) return;
  const citationsBySource = new Map<string, KnowledgeCitationBase[]>();
  for (const citation of result.citations) {
    const existing = citationsBySource.get(citation.sourceKey) ?? [];
    existing.push(citation);
    citationsBySource.set(citation.sourceKey, existing);
  }
  if (citationsBySource.size === 0) return;

  const stub = tenantStub(env.KNOWLEDGE, input.teamId);
  for (const [sourceKey, citations] of citationsBySource) {
    try {
      const stateResponse = await stub.fetch("https://do/state", {
        method: "POST",
        body: JSON.stringify({ sourceKey }),
      });
      if (!stateResponse.ok) throw new Error("state_lookup_failed");
      const state = await stateResponse.json() as {
        ledger?: {
          sourceType?: string;
          teamId?: string;
          projectId?: string;
          channelId?: string;
          threadTs?: string;
          status?: string;
          indexedRevision?: string;
          localDocumentId?: string;
          derivedIndexGeneration?: string;
        } | null;
      };
      const ledger = state.ledger;
      if (
        !ledger ||
        ledger.sourceType !== "slack" ||
        ledger.teamId !== input.teamId ||
        ledger.projectId !== input.projectId ||
        ledger.channelId !== input.channelId ||
        ledger.status !== "indexed" ||
        !ledger.threadTs ||
        !ledger.indexedRevision ||
        !ledger.localDocumentId ||
        !ledger.derivedIndexGeneration
      ) throw new Error("indexed_ledger_fence_missing");
      const citation = citations[0];
      if (!citation) throw new Error("citation_missing");
      if (
        citation.contentRevision !== ledger.indexedRevision ||
        citation.channelId !== ledger.channelId ||
        citation.threadTs !== ledger.threadTs
      ) throw new Error("citation_ledger_fence_mismatch");

      const receiptResponse = await stub.fetch("https://do/query-convergence", {
        method: "POST",
        body: JSON.stringify({
          sourceKey,
          contentRevision: ledger.indexedRevision,
          indexGeneration: ledger.derivedIndexGeneration,
          localDocumentId: ledger.localDocumentId,
          queryDigest: result.queryDigest,
          status: "queryable",
          providerResultCount: result.providerResultCount,
          matchingCitationCount: citations.length,
        }),
      });
      if (!receiptResponse.ok) throw new Error("receipt_write_failed");
      const receipt = await receiptResponse.json() as { recorded?: unknown };
      if (receipt.recorded !== true) throw new Error("receipt_not_recorded");
      console.log(JSON.stringify({
        event: "knowledge_query_convergence_recorded",
        teamId: input.teamId,
        sourceKey,
        status: "queryable",
        providerResultCount: result.providerResultCount,
        matchingCitationCount: citations.length,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "knowledge_query_convergence_record_failed",
        teamId: input.teamId,
        sourceKey,
        errorCode: error instanceof Error ? error.message : "unknown",
      }));
    }
  }
}

export async function handleKnowledgeMcp(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ status: "error", code: "method_not_allowed", message: "POST only" }, { status: 405 });
  }
  if (!hasAdminAuthorization(request, env) && !request.headers.get(KNOWLEDGE_ACTOR_TOKEN_HEADER)) {
    return Response.json({ status: "error", code: "unauthorized", message: "bearer required" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: "error", code: "invalid_json", message: "body must be JSON" }, { status: 400 });
  }
  try {
    rejectCallerControlledAddressing(body);
  } catch (error) {
    return Response.json({
      status: "error",
      code: "forbidden_addressing",
      message: error instanceof Error ? error.message : "forbidden",
    }, { status: 400 });
  }

  const parsed = parseMcpRequest(body);
  if (!parsed.ok) {
    return Response.json({ status: "error", code: "invalid_request", message: parsed.message }, { status: 400 });
  }
  const input = parsed.value;
  const authorization = await authorizeMcp(request, env, input);
  if (!authorization) {
    return Response.json({ status: "error", code: "unauthorized", message: "knowledge actor authorization failed" }, { status: 401 });
  }
  if (input.tool === "query_template" && authorization.kind !== "operator") {
    return Response.json({ status: "error", code: "unauthorized", message: "query_template requires operator authorization" }, { status: 401 });
  }
  const resource = resourceForRequest(input);
  const auditBase = {
    jti: authorization.jti,
    authKind: authorization.kind,
    actorId: authorization.actorId,
    teamId: input.teamId,
    projectId: input.projectId ?? "query_template",
    tool: input.tool,
    ...(resource ? { resourceType: resource.type, resourceId: resource.id } : {}),
  } satisfies Omit<KnowledgeMcpAuditEvent, "id" | "outcome" | "createdAt">;
  if (authorization.kind === "actor") {
    if (!(await consumeActorToken(env, authorization.claims))) {
      return Response.json({
        status: "error",
        code: "unauthorized",
        message: "knowledge actor authorization failed",
      }, { status: 401 });
    }
  }
  const startedAuditRecorded = await recordMcpAudit(env, {
    ...auditBase,
    id: crypto.randomUUID(),
    outcome: "started",
    createdAt: Date.now(),
  });
  if (authorization.kind === "actor" && !startedAuditRecorded) {
    return Response.json({
      status: "error",
      code: "audit_unavailable",
      message: "knowledge audit is unavailable",
    }, { status: 503 });
  }

  const finish = async (response: Response, outcome: "ok" | "error", errorCode?: string): Promise<Response> => {
    const recorded = await recordMcpAudit(env, {
      ...auditBase,
      id: crypto.randomUUID(),
      outcome,
      ...(errorCode ? { errorCode } : {}),
      createdAt: Date.now(),
    });
    if (authorization.kind === "actor" && !recorded) {
      return Response.json({
        status: "error",
        code: "audit_unavailable",
        message: "knowledge audit is unavailable",
      }, { status: 503 });
    }
    return response;
  };

  if (input.tool === "query_template") {
    if (!env.KNOWLEDGE || !input.rawQuery) {
      return finish(Response.json({
        status: "error",
        code: "knowledge_unavailable",
        message: "KnowledgeDO is not configured",
      }, { status: 503 }), "error", "knowledge_unavailable");
    }
    try {
      const stub = tenantStub(env.KNOWLEDGE, input.rawQuery.teamId);
      const rawResponse = await stub.fetch("https://do/raw-query", {
        method: "POST",
        body: JSON.stringify(input.rawQuery),
      });
      if (!rawResponse.ok) {
        return finish(Response.json({
          status: "error",
          code: "invalid_request",
          message: "raw query template was rejected",
        }, { status: rawResponse.status === 400 ? 400 : 503 }), "error", "invalid_request");
      }
      const payload = await rawResponse.json() as RawKnowledgeQueryResponse;
      return finish(Response.json({ status: "ok", ...payload } satisfies KnowledgeMcpResponse), "ok");
    } catch (error) {
      return finish(Response.json({
        status: "error",
        code: "knowledge_unavailable",
        message: error instanceof Error ? error.message : "raw query failed",
      }, { status: 503 }), "error", "knowledge_unavailable");
    }
  }

  if (!input.projectId) {
    return finish(Response.json({ status: "error", code: "invalid_request", message: "projectId is required" }, { status: 400 }), "error", "invalid_request");
  }
  const projectId = input.projectId;
  const limit = Math.min(
    KNOWLEDGE_LIMITS.maxSearchLimit,
    Math.max(1, input.limit ?? 5),
  );

  if (input.tool === "code_graph_search" || input.tool === "code_path" || input.tool === "code_impact") {
    if (!input.repoId) {
      return finish(Response.json({ status: "error", code: "invalid_request", message: "repoId required" }, { status: 400 }), "error", "invalid_request");
    }
    if (authorization.kind === "actor" && !(await currentGraphRepositoryGrantMatches(env, input, authorization))) {
      return finish(Response.json({
        status: "error",
        code: "code_graph_acl_denied",
        message: "the current access bundle does not grant this repository graph action",
      }, { status: 403 }), "error", "code_graph_acl_denied");
    }
    const graphify = createGraphifyClient(env);
    if (!graphify) {
      return finish(Response.json({
        status: "error",
        code: "knowledge_unavailable",
        message: "Graphify is not configured",
      }, { status: 503 }), "error", "knowledge_unavailable");
    }
    try {
      const adapter = new GraphifyAdapter(graphify);
      let citations: KnowledgeCitationBase[];
      if (input.tool === "code_graph_search") {
        if (!input.query) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "query required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await adapter.search({
          teamId: input.teamId,
          repoId: input.repoId,
          projectId,
          aclPolicyRef: input.aclPolicyRef,
          query: input.query,
          limit,
        });
      } else if (input.tool === "code_path") {
        if (!input.source || !input.target) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "source and target required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await adapter.path({
          teamId: input.teamId,
          repoId: input.repoId,
          projectId,
          aclPolicyRef: input.aclPolicyRef,
          source: input.source,
          target: input.target,
          maxHops: input.maxHops ?? 6,
        });
      } else {
        if (!input.symbol) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "symbol required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await adapter.impact({
          teamId: input.teamId,
          repoId: input.repoId,
          projectId,
          aclPolicyRef: input.aclPolicyRef,
          symbol: input.symbol,
          depth: input.depth ?? 3,
          ...(input.relations ? { relations: input.relations } : {}),
        });
      }
      if (authorization.kind === "actor" && !(await currentActorKnowledgeReadAllows(env, authorization.claims, input))) {
        return finish(Response.json({ status: "error", code: "knowledge_acl_changed", message: "knowledge access changed during retrieval" }, { status: 403 }), "error", "knowledge_acl_changed");
      }
      return finish(Response.json({ status: "ok", citations } satisfies KnowledgeMcpResponse), "ok");
    } catch {
      return finish(Response.json({ status: "error", code: "knowledge_unavailable", message: "Graphify search failed" }, { status: 503 }), "error", "knowledge_unavailable");
    }
  }

  if (!input.query) {
    return finish(Response.json({ status: "error", code: "invalid_request", message: "query is required" }, { status: 400 }), "error", "invalid_request");
  }
  const queryText = input.query;
  const client = createSupermemoryClientFromEnv(env);
  if (!client) {
    return finish(Response.json({
      status: "error",
      code: "knowledge_unavailable",
      message: "Supermemory is not configured",
    }, { status: 503 }), "error", "knowledge_unavailable");
  }
  try {
    let citations: KnowledgeCitationBase[] = [];

    switch (input.tool) {
      case "search_slack": {
        if (!input.channelId) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "channelId required" }, { status: 400 }), "error", "invalid_request");
        }
        if (authorization.kind === "actor") {
          const result = await searchSlackKnowledgeForActor({
            env,
            teamId: input.teamId,
            channelId: input.channelId,
            projectId,
            actorId: authorization.claims.actor.id,
            aclPolicyRef: input.aclPolicyRef,
            query: queryText,
            limit,
          });
          if (result.status !== "ok") {
            const code = result.status === "unauthorized" ? "knowledge_acl_denied" : "knowledge_unavailable";
            return finish(Response.json({
              status: "error",
              code,
              message: code === "knowledge_acl_denied" ? "current Slack knowledge access denied" : "Slack knowledge is unavailable",
            }, { status: result.status === "unauthorized" ? 403 : 503 }), "error", code);
          }
          citations = result.citations;
        } else {
          const search = await new SupermemoryAdapter(client).searchSlackForConvergence({
            teamId: input.teamId,
            projectId,
            channelId: input.channelId,
            aclPolicyRef: input.aclPolicyRef,
            query: queryText,
            limit,
          });
          citations = search.citations;
          await recordSlackQueryConvergence(env, input, search);
        }
        break;
      }
      case "search_wiki": {
        if (!input.spaceId) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "spaceId required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await new WikiSearchAdapter(client).search({
          teamId: input.teamId,
          projectId,
          spaceId: input.spaceId,
          aclPolicyRef: input.aclPolicyRef,
          query: queryText,
          limit,
        });
        break;
      }
      case "search_code": {
        if (!input.repoId) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "repoId required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await new CodeSearchAdapter(client).search({
          teamId: input.teamId,
          projectId,
          repoId: input.repoId,
          aclPolicyRef: input.aclPolicyRef,
          query: queryText,
          limit,
        });
        break;
      }
      case "search_custom": {
        if (!input.connectorId) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "connectorId required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await new CustomDbSearchAdapter(client).search({
          teamId: input.teamId,
          projectId,
          connectorId: input.connectorId,
          aclPolicyRef: input.aclPolicyRef,
          query: queryText,
          limit,
        });
        break;
      }
      case "search": {
        const lists = [];
        if (input.channelId) {
          if (authorization.kind === "actor") {
            lists.push(async (q: string, lim: number) => {
              const result = await searchSlackKnowledgeForActor({
                env,
                teamId: input.teamId,
                channelId: input.channelId!,
                projectId,
                actorId: authorization.claims.actor.id,
                aclPolicyRef: input.aclPolicyRef,
                query: q,
                limit: lim,
              });
              if (result.status !== "ok") throw new Error(result.status);
              return result.citations.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
            });
          } else {
            const slack = new SupermemoryAdapter(client);
            lists.push(async (q: string, lim: number) => {
              const rows = await slack.searchSlack({
                teamId: input.teamId,
                projectId,
                channelId: input.channelId!,
                aclPolicyRef: input.aclPolicyRef,
                query: q,
                limit: lim,
              });
              return rows.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
            });
          }
        }
        if (input.spaceId) {
          const wiki = new WikiSearchAdapter(client);
          lists.push(async (q: string, lim: number) => {
            const rows = await wiki.search({
              teamId: input.teamId,
              projectId,
              spaceId: input.spaceId!,
              aclPolicyRef: input.aclPolicyRef,
              query: q,
              limit: lim,
            });
            return rows.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
          });
        }
        if (input.repoId) {
          const code = new CodeSearchAdapter(client);
          lists.push(async (q: string, lim: number) => {
            const rows = await code.search({
              teamId: input.teamId,
              projectId,
              repoId: input.repoId!,
              aclPolicyRef: input.aclPolicyRef,
              query: q,
              limit: lim,
            });
            return rows.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
          });
        }
        if (input.connectorId) {
          const custom = new CustomDbSearchAdapter(client);
          lists.push(async (q: string, lim: number) => {
            const rows = await custom.search({
              teamId: input.teamId,
              projectId,
              connectorId: input.connectorId!,
              aclPolicyRef: input.aclPolicyRef,
              query: q,
              limit: lim,
            });
            return rows.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
          });
        }
        if (lists.length === 0) {
          return finish(Response.json({
            status: "error",
            code: "invalid_request",
            message: "unified search requires at least one source scope",
          }, { status: 400 }), "error", "invalid_request");
        }
        citations = await unifiedKnowledgeSearch({
          query: queryText,
          lists,
          rrfK: 60,
          finalLimit: limit,
        });
        break;
      }
    }

    if (authorization.kind === "actor" && !(await currentActorKnowledgeReadAllows(env, authorization.claims, input))) {
      return finish(Response.json({ status: "error", code: "knowledge_acl_changed", message: "knowledge access changed during retrieval" }, { status: 403 }), "error", "knowledge_acl_changed");
    }
    const response: KnowledgeMcpResponse = { status: "ok", citations };
    return finish(Response.json(response), "ok");
    } catch (error) {
      return finish(Response.json({
        status: "error",
        code: "knowledge_unavailable",
        message: "search failed",
      }, { status: 503 }), "error", "knowledge_unavailable");
  }
}

function parseMcpRequest(body: unknown): { ok: true; value: KnowledgeMcpRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "body must be an object" };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.tool !== "string" || !(KNOWLEDGE_MCP_TOOLS as readonly string[]).includes(raw.tool)) {
    return { ok: false, message: "tool must be a known knowledge MCP tool" };
  }
  for (const field of ["teamId", "aclPolicyRef"] as const) {
    if (
      typeof raw[field] !== "string" ||
      !(raw[field] as string).trim() ||
      (raw[field] as string).length > 256 ||
      /[\u0000-\u001f\u007f]/.test(raw[field] as string)
    ) {
      return { ok: false, message: `${field} is required` };
    }
  }
  if (raw.tool === "query_template") {
    const allowedTemplateFields = new Set([
      "tool", "teamId", "aclPolicyRef", "schemaVersion", "template",
      "channelId", "recordId", "sourceKey", "limit",
    ]);
    const unknownTemplateField = Object.keys(raw).find((key) => !allowedTemplateFields.has(key));
    if (unknownTemplateField) {
      return { ok: false, message: `field ${unknownTemplateField} is not accepted by query_template` };
    }
    for (const forbidden of ["sql", "table", "where", "filters", "orderBy"]) {
      if (forbidden in raw) return { ok: false, message: `${forbidden} is not accepted; choose a named template` };
    }
    try {
      const rawQuery = parseRawKnowledgeQuery({
        schemaVersion: raw.schemaVersion,
        template: raw.template,
        teamId: raw.teamId,
        channelId: raw.channelId,
        recordId: raw.recordId,
        sourceKey: raw.sourceKey,
        limit: raw.limit,
      });
      return {
        ok: true,
        value: {
          tool: "query_template",
          teamId: raw.teamId as string,
          aclPolicyRef: raw.aclPolicyRef as string,
          rawQuery,
        },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "raw query is invalid" };
    }
  }
  const graphTool = raw.tool === "code_graph_search" || raw.tool === "code_path" || raw.tool === "code_impact";
  const requiredFields = graphTool ? (["projectId"] as const) : (["projectId", "query"] as const);
  for (const field of requiredFields) {
    if (
      typeof raw[field] !== "string" ||
      !(raw[field] as string).trim() ||
      (raw[field] as string).length > (field === "query" ? 4_000 : 256) ||
      /[\u0000-\u001f\u007f]/.test(raw[field] as string)
    ) {
      return { ok: false, message: `${field} is required` };
    }
  }
  if (raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1)) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  for (const field of ["channelId", "spaceId", "repoId", "connectorId"] as const) {
    if (raw[field] !== undefined && (
      typeof raw[field] !== "string" ||
      !(raw[field] as string).trim() ||
      (raw[field] as string).length > 256 ||
      /[\u0000-\u001f\u007f]/.test(raw[field] as string)
    )) {
      return { ok: false, message: `${field} is invalid` };
    }
  }
  for (const field of ["source", "target", "symbol"] as const) {
    if (raw[field] !== undefined && (
      typeof raw[field] !== "string" ||
      !(raw[field] as string).trim() ||
      (raw[field] as string).length > 512 ||
      /[\u0000-\u001f\u007f]/.test(raw[field] as string)
    )) {
      return { ok: false, message: `${field} is invalid` };
    }
  }
  for (const field of ["depth", "maxHops"] as const) {
    if (raw[field] !== undefined && (
      !Number.isSafeInteger(raw[field]) ||
      (raw[field] as number) < 1 ||
      (raw[field] as number) > 16
    )) {
      return { ok: false, message: `${field} is invalid` };
    }
  }
  if (raw.relations !== undefined && (
    !Array.isArray(raw.relations) ||
    raw.relations.length > 8 ||
    raw.relations.some((relation) => typeof relation !== "string" || !relation.trim() || relation.length > 64)
  )) {
    return { ok: false, message: "relations is invalid" };
  }
  return {
    ok: true,
    value: {
      tool: raw.tool as KnowledgeMcpToolName,
      teamId: raw.teamId as string,
      projectId: raw.projectId as string,
      ...(typeof raw.query === "string" ? { query: raw.query } : {}),
      aclPolicyRef: raw.aclPolicyRef as string,
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
      ...(typeof raw.channelId === "string" ? { channelId: raw.channelId } : {}),
      ...(typeof raw.spaceId === "string" ? { spaceId: raw.spaceId } : {}),
      ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
      ...(typeof raw.connectorId === "string" ? { connectorId: raw.connectorId } : {}),
      ...(typeof raw.source === "string" ? { source: raw.source } : {}),
      ...(typeof raw.target === "string" ? { target: raw.target } : {}),
      ...(typeof raw.symbol === "string" ? { symbol: raw.symbol } : {}),
      ...(typeof raw.depth === "number" ? { depth: raw.depth } : {}),
      ...(typeof raw.maxHops === "number" ? { maxHops: raw.maxHops } : {}),
      ...(Array.isArray(raw.relations) ? { relations: raw.relations as string[] } : {}),
    },
  };
}
