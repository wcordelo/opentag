/**
 * MCP retrieval primitives for the knowledge base (K2 Phase 5).
 * LLM-light: raw evidence rows only. Clients orchestrate planner/synthesis.
 * No ingestion path — search only, bearer-gated by ADMIN_SECRET.
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
import { createSupermemoryClient } from "../memory/supermemory-client.js";
import { WikiSearchAdapter } from "../memory/connectors/wiki-connector.js";
import { CodeSearchAdapter } from "../memory/connectors/code-connector.js";
import { CustomDbSearchAdapter } from "../memory/connectors/custom-db-connector.js";
import { SupermemoryAdapter } from "../memory/supermemory-adapter.js";
import { unifiedKnowledgeSearch } from "../memory/retrieval/unified-search.js";

export type KnowledgeMcpToolName =
  | "search"
  | "search_slack"
  | "search_wiki"
  | "search_code"
  | "search_custom";

export const KNOWLEDGE_MCP_TOOLS: readonly KnowledgeMcpToolName[] = [
  "search",
  "search_slack",
  "search_wiki",
  "search_code",
  "search_custom",
] as const;

export type KnowledgeMcpRequest = {
  tool: KnowledgeMcpToolName;
  teamId: string;
  projectId: string;
  query: string;
  limit?: number;
  channelId?: string;
  spaceId?: string;
  repoId?: string;
  connectorId?: string;
  aclPolicyRef: string;
};

export type KnowledgeMcpResponse =
  | { status: "ok"; citations: KnowledgeCitationBase[] }
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
    return source.teamId === claims.teamId &&
      source.projectId === claims.projectId &&
      source.channelId === input.channelId &&
      source.enabled === true &&
      source.readerPolicyRef === claims.aclPolicyRef;
  } catch {
    return false;
  }
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
  if (!(await currentActorAclMatches(env, claims, input))) return null;
  if (!(await consumeActorToken(env, claims))) return null;
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
  const resource = resourceForRequest(input);
  const auditBase = {
    jti: authorization.jti,
    authKind: authorization.kind,
    actorId: authorization.actorId,
    teamId: input.teamId,
    projectId: input.projectId,
    tool: input.tool,
    ...(resource ? { resourceType: resource.type, resourceId: resource.id } : {}),
  } satisfies Omit<KnowledgeMcpAuditEvent, "id" | "outcome" | "createdAt">;
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

  if (!env.SUPERMEMORY_URL || !env.SUPERMEMORY_API_KEY) {
    return finish(Response.json({
      status: "error",
      code: "knowledge_unavailable",
      message: "Supermemory is not configured",
    }, { status: 503 }), "error", "knowledge_unavailable");
  }
  const limit = Math.min(
    KNOWLEDGE_LIMITS.maxSearchLimit,
    Math.max(1, input.limit ?? 5),
  );

  try {
    const client = createSupermemoryClient({
      baseURL: env.SUPERMEMORY_URL,
      apiKey: env.SUPERMEMORY_API_KEY,
    });
    let citations: KnowledgeCitationBase[] = [];

    switch (input.tool) {
      case "search_slack": {
        if (!input.channelId) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "channelId required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await new SupermemoryAdapter(client).searchSlack({
          teamId: input.teamId,
          projectId: input.projectId,
          channelId: input.channelId,
          aclPolicyRef: input.aclPolicyRef,
          query: input.query,
          limit,
        });
        break;
      }
      case "search_wiki": {
        if (!input.spaceId) {
          return finish(Response.json({ status: "error", code: "invalid_request", message: "spaceId required" }, { status: 400 }), "error", "invalid_request");
        }
        citations = await new WikiSearchAdapter(client).search({
          teamId: input.teamId,
          projectId: input.projectId,
          spaceId: input.spaceId,
          aclPolicyRef: input.aclPolicyRef,
          query: input.query,
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
          projectId: input.projectId,
          repoId: input.repoId,
          aclPolicyRef: input.aclPolicyRef,
          query: input.query,
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
          projectId: input.projectId,
          connectorId: input.connectorId,
          aclPolicyRef: input.aclPolicyRef,
          query: input.query,
          limit,
        });
        break;
      }
      case "search": {
        const lists = [];
        if (input.channelId) {
          const slack = new SupermemoryAdapter(client);
          lists.push(async (q: string, lim: number) => {
            const rows = await slack.searchSlack({
              teamId: input.teamId,
              projectId: input.projectId,
              channelId: input.channelId!,
              aclPolicyRef: input.aclPolicyRef,
              query: q,
              limit: lim,
            });
            return rows.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
          });
        }
        if (input.spaceId) {
          const wiki = new WikiSearchAdapter(client);
          lists.push(async (q: string, lim: number) => {
            const rows = await wiki.search({
              teamId: input.teamId,
              projectId: input.projectId,
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
              projectId: input.projectId,
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
              projectId: input.projectId,
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
          query: input.query,
          lists,
          rrfK: 60,
          finalLimit: limit,
        });
        break;
      }
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
  for (const field of ["teamId", "projectId", "query", "aclPolicyRef"] as const) {
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
  return {
    ok: true,
    value: {
      tool: raw.tool as KnowledgeMcpToolName,
      teamId: raw.teamId as string,
      projectId: raw.projectId as string,
      query: raw.query as string,
      aclPolicyRef: raw.aclPolicyRef as string,
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
      ...(typeof raw.channelId === "string" ? { channelId: raw.channelId } : {}),
      ...(typeof raw.spaceId === "string" ? { spaceId: raw.spaceId } : {}),
      ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
      ...(typeof raw.connectorId === "string" ? { connectorId: raw.connectorId } : {}),
    },
  };
}
