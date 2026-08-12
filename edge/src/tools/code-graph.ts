import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import type { Env } from "../env.js";
import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { GraphifyAdapter, GraphifyClientError } from "../memory/graphify-adapter.js";
import { createGraphifyClient } from "../memory/graphify-client.js";
import {
  currentKnowledgeReadGrantAllows,
  loadCurrentKnowledgeReadAccess,
} from "../memory/knowledge-read-authorization.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";

const MAX_QUERY_LENGTH = 512;
const MAX_LIMIT = 10;

export type CodeGraphToolResult =
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

function repositoryGrantAllowed(
  thread: unknown,
  toolName: string,
  projectId: string,
  repoId: string,
  channelId: string,
): boolean {
  try {
    const snapshot = requirePermissionSnapshot(thread as object);
    const grants = snapshot.channelAccess.connectorGrants ?? [];
    return grants.some((grant) =>
      grant.connectorId === "code_graph" &&
      grant.actions.includes(toolName) &&
      grant.repoId === repoId &&
      (!grant.projectId || grant.projectId === projectId) &&
      (!grant.channelId || grant.channelId === channelId) &&
      (grant.scope === "workspace" ||
        (grant.scope === "project" && Boolean(projectId)) ||
        (grant.scope === "channel" && Boolean(channelId))),
    );
  } catch {
    return false;
  }
}

function errorResult(error: unknown): CodeGraphToolResult {
  return {
    status: "knowledge_unavailable",
    citations: [],
    retryable: error instanceof GraphifyClientError ? error.retryable : true,
  };
}

function graphifyNotConfiguredResult(): CodeGraphToolResult {
  return {
    status: "knowledge_unavailable",
    citations: [],
    retryable: false,
  };
}

export function createCodeGraphSearchTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "code_graph_search",
    description: "Search the explicit, commit-pinned Graphify code graph for a tracked repository.",
    parameters: z.object({
      query: z.string().min(1).max(MAX_QUERY_LENGTH),
      repoId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    }).strict(),
    async handler({ query, repoId, projectId, limit }, { thread }) {
      const context = requireRequestContext(thread);
      if (!getTurnExecutionContext(thread)) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const snapshot = requirePermissionSnapshot(thread);
      const access = await loadCurrentKnowledgeReadAccess(dependencies.env(), context.teamId, channelId);
      if (!toolAllowed(thread, "code_graph_search", context.teamId, channelId) ||
        !repositoryGrantAllowed(thread, "code_graph_search", projectId, repoId, channelId) ||
        !currentKnowledgeReadGrantAllows(access, {
          teamId: context.teamId,
          channelId,
          projectId,
          connectorId: "code_graph",
          action: "code_graph_search",
          repoId,
          aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
          permissionSnapshot: snapshot,
        })) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies CodeGraphToolResult;
      }
      const client = createGraphifyClient(dependencies.env());
      if (!client) return graphifyNotConfiguredResult();
      try {
        const citations = await new GraphifyAdapter(client).search({
          teamId: context.teamId,
          repoId,
          projectId,
          aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
          query,
          limit: limit ?? 5,
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies CodeGraphToolResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

export function createCodePathTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "code_path",
    description: "Find a bounded dependency path between two symbols in a tracked commit-pinned code graph.",
    parameters: z.object({
      source: z.string().min(1).max(MAX_QUERY_LENGTH),
      target: z.string().min(1).max(MAX_QUERY_LENGTH),
      repoId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      maxHops: z.number().int().min(1).max(12).optional(),
    }).strict(),
    async handler({ source, target, repoId, projectId, maxHops }, { thread }) {
      const context = requireRequestContext(thread);
      if (!getTurnExecutionContext(thread)) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const snapshot = requirePermissionSnapshot(thread);
      const access = await loadCurrentKnowledgeReadAccess(dependencies.env(), context.teamId, channelId);
      if (!toolAllowed(thread, "code_path", context.teamId, channelId) ||
        !repositoryGrantAllowed(thread, "code_path", projectId, repoId, channelId) ||
        !currentKnowledgeReadGrantAllows(access, {
          teamId: context.teamId,
          channelId,
          projectId,
          connectorId: "code_graph",
          action: "code_path",
          repoId,
          aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
          permissionSnapshot: snapshot,
        })) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies CodeGraphToolResult;
      }
      const client = createGraphifyClient(dependencies.env());
      if (!client) return graphifyNotConfiguredResult();
      try {
        const citations = await new GraphifyAdapter(client).path({
          teamId: context.teamId,
          repoId,
          projectId,
          aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
          source,
          target,
          maxHops: maxHops ?? 6,
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies CodeGraphToolResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

export function createCodeImpactTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
}) {
  return defineBotTool({
    name: "code_impact",
    description: "Find bounded reverse dependencies affected by a symbol in a tracked commit-pinned code graph.",
    parameters: z.object({
      symbol: z.string().min(1).max(MAX_QUERY_LENGTH),
      repoId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      depth: z.number().int().min(1).max(8).optional(),
      relations: z.array(z.string().min(1).max(64)).max(8).optional(),
    }).strict(),
    async handler({ symbol, repoId, projectId, depth, relations }, { thread }) {
      const context = requireRequestContext(thread);
      if (!getTurnExecutionContext(thread)) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const snapshot = requirePermissionSnapshot(thread);
      const access = await loadCurrentKnowledgeReadAccess(dependencies.env(), context.teamId, channelId);
      if (!toolAllowed(thread, "code_impact", context.teamId, channelId) ||
        !repositoryGrantAllowed(thread, "code_impact", projectId, repoId, channelId) ||
        !currentKnowledgeReadGrantAllows(access, {
          teamId: context.teamId,
          channelId,
          projectId,
          connectorId: "code_graph",
          action: "code_impact",
          repoId,
          aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
          permissionSnapshot: snapshot,
        })) {
        return { status: "unauthorized", citations: [], reason: "policy_denied" } satisfies CodeGraphToolResult;
      }
      const client = createGraphifyClient(dependencies.env());
      if (!client) return graphifyNotConfiguredResult();
      try {
        const citations = await new GraphifyAdapter(client).impact({
          teamId: context.teamId,
          repoId,
          projectId,
          aclPolicyRef: `bundle:${snapshot.channelAccess.bundleId}`,
          symbol,
          depth: depth ?? 3,
          ...(relations ? { relations } : {}),
        });
        await dependencies.assertActive(thread);
        return { status: "ok", citations } satisfies CodeGraphToolResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
