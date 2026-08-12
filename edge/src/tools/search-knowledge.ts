/**
 * Unified multi-list knowledge search tool (K2 Phase 4).
 * Fans out allowed source search functions, RRF-fuses, optional LLM rerank.
 */

import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import type { Env } from "../env.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { KNOWLEDGE_LIMITS } from "../memory/knowledge-contract.js";
import { createSupermemoryClientFromEnv } from "../memory/supermemory-client.js";
import { WikiSearchAdapter } from "../memory/connectors/wiki-connector.js";
import { CodeSearchAdapter } from "../memory/connectors/code-connector.js";
import { CustomDbSearchAdapter } from "../memory/connectors/custom-db-connector.js";
import { SupermemoryAdapter } from "../memory/supermemory-adapter.js";
import { searchSlackKnowledge } from "./search-slack.js";
import {
  currentKnowledgeReadGrantAllows,
  currentKnowledgeToolAllows,
  loadCurrentKnowledgeReadAccess,
} from "../memory/knowledge-read-authorization.js";
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
      let client;
      try {
        client = createSupermemoryClientFromEnv(env);
      } catch {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies UnifiedSearchResult;
      }
      if (!client) {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies UnifiedSearchResult;
      }

      const currentAccess = await loadCurrentKnowledgeReadAccess(env, context.teamId, channelId);
      if (!currentKnowledgeToolAllows(currentAccess, {
        teamId: context.teamId,
        channelId,
        action: "search",
        permissionSnapshot: snapshot,
      })) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies UnifiedSearchResult;
      }
      const aclPolicyRef = `bundle:${snapshot.channelAccess.bundleId}`;
      const lists: SearchListFn[] = [];

      if (args.channelId === undefined && snapshot.channelAccess.allowedTools.includes("search_slack")) {
        const slackAdapter = new SupermemoryAdapter(client);
        lists.push(async (query, limit) => {
          const result = await searchSlackKnowledge({
            env,
            teamId: context.teamId,
            channelId,
            authorization: {
              permissionSnapshot: snapshot,
              conversationKey: (thread as { conversationKey?: string }).conversationKey ?? "",
              executionId: exact.executionId,
              actorId: context.requesterId,
            },
            query,
            limit,
            adapter: slackAdapter,
          });
          if (result.status !== "ok") return [];
          const citations = result.citations;
          return citations.map((c) => ({
            id: c.sourceKey,
            citation: c,
            score: c.score,
          }));
        });
      }
      if (args.spaceId && snapshot.channelAccess.allowedTools.includes("search_wiki") &&
        currentKnowledgeReadGrantAllows(currentAccess, {
          teamId: context.teamId,
          channelId,
          projectId: args.projectId,
          connectorId: "wiki",
          action: "search_wiki",
          spaceId: args.spaceId,
          aclPolicyRef,
          permissionSnapshot: snapshot,
        })) {
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
      if (args.repoId && snapshot.channelAccess.allowedTools.includes("search_code") &&
        currentKnowledgeReadGrantAllows(currentAccess, {
          teamId: context.teamId,
          channelId,
          projectId: args.projectId,
          connectorId: "code",
          action: "search_code",
          repoId: args.repoId,
          aclPolicyRef,
          permissionSnapshot: snapshot,
        })) {
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
      if (args.connectorId && snapshot.channelAccess.allowedTools.includes("search_custom") &&
        currentKnowledgeReadGrantAllows(currentAccess, {
          teamId: context.teamId,
          channelId,
          projectId: args.projectId,
          connectorId: args.connectorId,
          action: "search_custom",
          aclPolicyRef,
          permissionSnapshot: snapshot,
        })) {
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
