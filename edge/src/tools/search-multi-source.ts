/**
 * Thin search_wiki / search_code / search_custom bot tools (K2 Phase 2).
 * Fail-closed: not in DEFAULT_BUNDLE; require explicit grant + Supermemory.
 */

import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import type { Env } from "../env.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { KNOWLEDGE_LIMITS } from "../memory/knowledge-contract.js";
import { createSupermemoryClientFromEnv } from "../memory/supermemory-client.js";
import { SupermemoryAdapterError } from "../memory/supermemory-adapter.js";
import { WikiSearchAdapter } from "../memory/connectors/wiki-connector.js";
import { CodeSearchAdapter } from "../memory/connectors/code-connector.js";
import { CustomDbSearchAdapter } from "../memory/connectors/custom-db-connector.js";
import {
  currentKnowledgeReadGrantAllows,
  loadCurrentKnowledgeReadAccess,
} from "../memory/knowledge-read-authorization.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";

const LIMITS = Object.freeze({
  maxQueryLength: 1_000,
  defaultLimit: 5,
  maxLimit: Math.min(10, KNOWLEDGE_LIMITS.maxSearchLimit),
});

export type MultiSourceSearchResult =
  | { status: "ok"; citations: KnowledgeCitationBase[] }
  | { status: "unauthorized"; citations: []; reason: "policy_denied" }
  | { status: "knowledge_unavailable"; citations: []; retryable: boolean };

function toolAllowed(thread: unknown, toolName: string, teamId: string, channelId: string): boolean {
  if (!thread || typeof thread !== "object") return false;
  try {
    const snapshot = requirePermissionSnapshot(thread);
    return Object.isFrozen(snapshot) &&
      snapshot.version === 1 &&
      snapshot.scope.teamId === teamId &&
      snapshot.scope.channelId === channelId &&
      snapshot.scope.actorKind === "slack_user" &&
      snapshot.channelAccess.allowedTools.includes(toolName);
  } catch {
    return false;
  }
}

function clientFromEnv(env: Env) {
  try {
    return createSupermemoryClientFromEnv(env);
  } catch {
    return undefined;
  }
}

async function connectorReadAllowed(input: {
  env: Env;
  thread: object;
  teamId: string;
  channelId: string;
  action: string;
  connectorId: string;
  projectId: string;
  repoId?: string;
  spaceId?: string;
}): Promise<boolean> {
  let snapshot;
  try {
    snapshot = requirePermissionSnapshot(input.thread);
  } catch {
    return false;
  }
  if (!toolAllowed(input.thread, input.action, input.teamId, input.channelId)) return false;
  const access = await loadCurrentKnowledgeReadAccess(input.env, input.teamId, input.channelId);
  return currentKnowledgeReadGrantAllows(access, {
    teamId: input.teamId,
    channelId: input.channelId,
    projectId: input.projectId,
    connectorId: input.connectorId,
    action: input.action,
    repoId: input.repoId,
    spaceId: input.spaceId,
    aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
    permissionSnapshot: snapshot,
  });
}

export function createSearchWikiTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "search_wiki",
    description: "Search indexed wiki/Confluence pages for the current project scope. Returns citations or knowledge_unavailable.",
    parameters: z.object({
      query: z.string().min(1).max(LIMITS.maxQueryLength),
      spaceId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(LIMITS.maxLimit).optional(),
    }).strict(),
    async handler({ query, spaceId, projectId, limit }, { thread }) {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      if (!(await connectorReadAllowed({
        env: dependencies.env(),
        thread,
        teamId: context.teamId,
        channelId,
        action: "search_wiki",
        connectorId: "wiki",
        projectId,
        spaceId,
      }))) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies MultiSourceSearchResult;
      }
      const client = clientFromEnv(dependencies.env());
      if (!client) {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies MultiSourceSearchResult;
      }
      try {
        const adapter = new WikiSearchAdapter(client);
        const citations = await adapter.search({
          teamId: context.teamId,
          projectId,
          spaceId,
          aclPolicyRef: `bundle:${requirePermissionSnapshot(thread).channelAccess.bundleId}`,
          query,
          limit: limit ?? LIMITS.defaultLimit,
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies MultiSourceSearchResult;
      } catch (error) {
        return {
          status: "knowledge_unavailable",
          citations: [],
          retryable: error instanceof SupermemoryAdapterError ? error.retryable : true,
        } satisfies MultiSourceSearchResult;
      }
    },
  });
}

export function createSearchCodeTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "search_code",
    description: "Search indexed code repository chunks for the current project. Embedding hybrid search only (ripgrep is harness-side).",
    parameters: z.object({
      query: z.string().min(1).max(LIMITS.maxQueryLength),
      repoId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(LIMITS.maxLimit).optional(),
    }).strict(),
    async handler({ query, repoId, projectId, limit }, { thread }) {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      if (!(await connectorReadAllowed({
        env: dependencies.env(),
        thread,
        teamId: context.teamId,
        channelId,
        action: "search_code",
        connectorId: "code",
        projectId,
        repoId,
      }))) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies MultiSourceSearchResult;
      }
      const client = clientFromEnv(dependencies.env());
      if (!client) {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies MultiSourceSearchResult;
      }
      try {
        const adapter = new CodeSearchAdapter(client);
        const citations = await adapter.search({
          teamId: context.teamId,
          projectId,
          repoId,
          aclPolicyRef: `bundle:${requirePermissionSnapshot(thread).channelAccess.bundleId}`,
          query,
          limit: limit ?? LIMITS.defaultLimit,
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies MultiSourceSearchResult;
      } catch (error) {
        return {
          status: "knowledge_unavailable",
          citations: [],
          retryable: error instanceof SupermemoryAdapterError ? error.retryable : true,
        } satisfies MultiSourceSearchResult;
      }
    },
  });
}

export function createSearchCustomTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "search_custom",
    description: "Search custom database rows indexed into the knowledge base for a connector id.",
    parameters: z.object({
      query: z.string().min(1).max(LIMITS.maxQueryLength),
      connectorId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(LIMITS.maxLimit).optional(),
    }).strict(),
    async handler({ query, connectorId, projectId, limit }, { thread }) {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      if (!(await connectorReadAllowed({
        env: dependencies.env(),
        thread,
        teamId: context.teamId,
        channelId,
        action: "search_custom",
        connectorId,
        projectId,
      }))) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies MultiSourceSearchResult;
      }
      const client = clientFromEnv(dependencies.env());
      if (!client) {
        return { status: "knowledge_unavailable", citations: [], retryable: true } satisfies MultiSourceSearchResult;
      }
      try {
        const adapter = new CustomDbSearchAdapter(client);
        const citations = await adapter.search({
          teamId: context.teamId,
          projectId,
          connectorId,
          aclPolicyRef: `bundle:${requirePermissionSnapshot(thread).channelAccess.bundleId}`,
          query,
          limit: limit ?? LIMITS.defaultLimit,
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies MultiSourceSearchResult;
      } catch (error) {
        return {
          status: "knowledge_unavailable",
          citations: [],
          retryable: error instanceof SupermemoryAdapterError ? error.retryable : true,
        } satisfies MultiSourceSearchResult;
      }
    },
  });
}
