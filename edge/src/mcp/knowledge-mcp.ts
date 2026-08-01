/**
 * MCP retrieval primitives for the knowledge base (K2 Phase 5).
 * LLM-light: raw evidence rows only. Clients orchestrate planner/synthesis.
 * No ingestion path — search only, bearer-gated by ADMIN_SECRET.
 */

import type { Env } from "../env.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { KNOWLEDGE_LIMITS, rejectCallerControlledAddressing } from "../memory/knowledge-contract.js";
import { createSupermemoryClient } from "../memory/supermemory-client.js";
import { WikiSearchAdapter } from "../memory/connectors/wiki-connector.js";
import { CodeSearchAdapter } from "../memory/connectors/code-connector.js";
import { CustomDbSearchAdapter } from "../memory/connectors/custom-db-connector.js";
import { SupermemoryAdapter } from "../memory/supermemory-adapter.js";
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
  | "query_template";

export const KNOWLEDGE_MCP_TOOLS: readonly KnowledgeMcpToolName[] = [
  "search",
  "search_slack",
  "search_wiki",
  "search_code",
  "search_custom",
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
  aclPolicyRef: string;
  rawQuery?: RawKnowledgeQuery;
};

export type KnowledgeMcpResponse =
  | { status: "ok"; citations: KnowledgeCitationBase[] }
  | ({ status: "ok" } & RawKnowledgeQueryResponse)
  | { status: "error"; code: string; message: string };

function authorizeMcp(request: Request, env: Env): boolean {
  const expected = env.ADMIN_SECRET;
  if (!expected) return false;
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return Boolean(match && match[1] === expected);
}

export async function handleKnowledgeMcp(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ status: "error", code: "method_not_allowed", message: "POST only" }, { status: 405 });
  }
  if (!authorizeMcp(request, env)) {
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
  if (input.tool === "query_template") {
    if (!env.KNOWLEDGE || !input.rawQuery) {
      return Response.json({
        status: "error",
        code: "knowledge_unavailable",
        message: "KnowledgeDO is not configured",
      }, { status: 503 });
    }
    try {
      const stub = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(input.rawQuery.teamId));
      const rawResponse = await stub.fetch("https://do/raw-query", {
        method: "POST",
        body: JSON.stringify(input.rawQuery),
      });
      if (!rawResponse.ok) {
        return Response.json({
          status: "error",
          code: "invalid_request",
          message: "raw query template was rejected",
        }, { status: rawResponse.status === 400 ? 400 : 503 });
      }
      const payload = await rawResponse.json() as RawKnowledgeQueryResponse;
      return Response.json({ status: "ok", ...payload } satisfies KnowledgeMcpResponse);
    } catch (error) {
      return Response.json({
        status: "error",
        code: "knowledge_unavailable",
        message: error instanceof Error ? error.message : "raw query failed",
      }, { status: 503 });
    }
  }
  if (!env.SUPERMEMORY_URL || !env.SUPERMEMORY_API_KEY) {
    return Response.json({
      status: "error",
      code: "knowledge_unavailable",
      message: "Supermemory is not configured",
    }, { status: 503 });
  }
  if (!input.query || !input.projectId) {
    return Response.json({ status: "error", code: "invalid_request", message: "projectId and query are required" }, { status: 400 });
  }
  const projectId = input.projectId;
  const queryText = input.query;
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
          return Response.json({ status: "error", code: "invalid_request", message: "channelId required" }, { status: 400 });
        }
        citations = await new SupermemoryAdapter(client).searchSlack({
          teamId: input.teamId,
          projectId,
          channelId: input.channelId,
          aclPolicyRef: input.aclPolicyRef,
          query: queryText,
          limit,
        });
        break;
      }
      case "search_wiki": {
        if (!input.spaceId) {
          return Response.json({ status: "error", code: "invalid_request", message: "spaceId required" }, { status: 400 });
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
          return Response.json({ status: "error", code: "invalid_request", message: "repoId required" }, { status: 400 });
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
          return Response.json({ status: "error", code: "invalid_request", message: "connectorId required" }, { status: 400 });
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
          return Response.json({
            status: "error",
            code: "invalid_request",
            message: "unified search requires at least one source scope",
          }, { status: 400 });
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

    const response: KnowledgeMcpResponse = { status: "ok", citations };
    return Response.json(response);
  } catch (error) {
    return Response.json({
      status: "error",
      code: "knowledge_unavailable",
      message: error instanceof Error ? error.message : "search failed",
    }, { status: 503 });
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
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) {
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
        ...(typeof raw.schemaVersion === "number" ? { schemaVersion: raw.schemaVersion } : {}),
        template: raw.template,
        teamId: raw.teamId,
        ...(typeof raw.channelId === "string" ? { channelId: raw.channelId } : {}),
        ...(typeof raw.recordId === "string" ? { recordId: raw.recordId } : {}),
        ...(typeof raw.sourceKey === "string" ? { sourceKey: raw.sourceKey } : {}),
        ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
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
  for (const field of ["projectId", "query"] as const) {
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) {
      return { ok: false, message: `${field} is required` };
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
