/**
 * Unified multi-list knowledge search tool (K2 Phase 4).
 * Fans out allowed source search functions, RRF-fuses, optional LLM rerank.
 */

import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import type { Env } from "../env.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { KNOWLEDGE_LIMITS } from "../memory/knowledge-contract.js";
import { createSupermemoryClient } from "../memory/supermemory-client.js";
import { WikiSearchAdapter } from "../memory/connectors/wiki-connector.js";
import { CodeSearchAdapter } from "../memory/connectors/code-connector.js";
import { CustomDbSearchAdapter } from "../memory/connectors/custom-db-connector.js";
import { SupermemoryAdapter } from "../memory/supermemory-adapter.js";
import {
  unifiedKnowledgeSearch,
  type SearchListFn,
} from "../memory/retrieval/unified-search.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";

const LIMITS = Object.freeze({
  maxQueryLength: 1_000,
  defaultLimit: 8,
  maxLimit: Math.min(10, KNOWLEDGE_LIMITS.maxSearchLimit),
  perListLimit: 8,
});

export type UnifiedSearchResult =
  | { status: "ok"; citations: KnowledgeCitationBase[] }
  | { status: "unauthorized"; citations: []; reason: "policy_denied" }
  | { status: "knowledge_unavailable"; citations: []; retryable: boolean };

export function createSearchKnowledgeTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "search",
    description:
      "Unified knowledge search across enabled Slack/wiki/code/custom sources. Fuses ranked lists with RRF (k=60).",
    parameters: z.object({
      query: z.string().min(1).max(LIMITS.maxQueryLength),
      projectId: z.string().min(1).max(128),
      channelId: z.string().min(1).max(128).optional(),
      spaceId: z.string().min(1).max(128).optional(),
      repoId: z.string().min(1).max(128).optional(),
      connectorId: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(LIMITS.maxLimit).optional(),
    }).strict(),
    async handler(args, { thread }) {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const snapshot = requirePermissionSnapshot(thread);
      if (
        !snapshot.channelAccess.allowedTools.includes("search") ||
        snapshot.scope.teamId !== context.teamId ||
        snapshot.scope.channelId !== channelId
      ) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies UnifiedSearchResult;
      }
      const env = dependencies.env();
      if (!env.SUPERMEMORY_URL || !env.SUPERMEMORY_API_KEY) {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies UnifiedSearchResult;
      }
      let client;
      try {
        client = createSupermemoryClient({
          baseURL: env.SUPERMEMORY_URL,
          apiKey: env.SUPERMEMORY_API_KEY,
        });
      } catch {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies UnifiedSearchResult;
      }

      const aclPolicyRef = `bundle:${snapshot.channelAccess.bundleId}`;
      const lists: SearchListFn[] = [];
      const slackChannel = args.channelId ?? channelId;

      if (snapshot.channelAccess.allowedTools.includes("search_slack")) {
        const slackAdapter = new SupermemoryAdapter(client);
        lists.push(async (query, limit) => {
          const citations = await slackAdapter.searchSlack({
            teamId: context.teamId,
            projectId: args.projectId,
            channelId: slackChannel,
            aclPolicyRef,
            query,
            limit,
          });
          return citations.map((c) => ({
            id: c.sourceKey,
            citation: c,
            score: c.score,
          }));
        });
      }
      if (args.spaceId && snapshot.channelAccess.allowedTools.includes("search_wiki")) {
        const wiki = new WikiSearchAdapter(client);
        lists.push(async (query, limit) => {
          const citations = await wiki.search({
            teamId: context.teamId,
            projectId: args.projectId,
            spaceId: args.spaceId!,
            aclPolicyRef,
            query,
            limit,
          });
          return citations.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
        });
      }
      if (args.repoId && snapshot.channelAccess.allowedTools.includes("search_code")) {
        const code = new CodeSearchAdapter(client);
        lists.push(async (query, limit) => {
          const citations = await code.search({
            teamId: context.teamId,
            projectId: args.projectId,
            repoId: args.repoId!,
            aclPolicyRef,
            query,
            limit,
          });
          return citations.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
        });
      }
      if (args.connectorId && snapshot.channelAccess.allowedTools.includes("search_custom")) {
        const custom = new CustomDbSearchAdapter(client);
        lists.push(async (query, limit) => {
          const citations = await custom.search({
            teamId: context.teamId,
            projectId: args.projectId,
            connectorId: args.connectorId!,
            aclPolicyRef,
            query,
            limit,
          });
          return citations.map((c) => ({ id: c.sourceKey, citation: c, score: c.score }));
        });
      }

      if (lists.length === 0) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies UnifiedSearchResult;
      }

      try {
        const citations = await unifiedKnowledgeSearch({
          query: args.query,
          lists,
          perListLimit: LIMITS.perListLimit,
          rrfK: 60,
          finalLimit: args.limit ?? LIMITS.defaultLimit,
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies UnifiedSearchResult;
      } catch {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies UnifiedSearchResult;
      }
    },
  });
}
