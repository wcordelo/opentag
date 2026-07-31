import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";
import {
  resolveAllowedTools,
  type AccessBundle,
  type WorkspaceChannelConfig,
} from "../config/access-bundle.js";
import type { TrackedKnowledgeSource } from "../config/knowledge-config.js";
import {
  bundleIdFromReaderPolicyRef,
  isTrackedKnowledgeSourceEnabled,
  readerPolicyRefForBundle,
} from "../config/knowledge-config.js";
import type { Env } from "../env.js";
import { KNOWLEDGE_LIMITS, type KnowledgeCitation } from "../memory/knowledge-contract.js";
import { SupermemoryAdapter, SupermemoryAdapterError } from "../memory/supermemory-adapter.js";
import { createSupermemoryClient } from "../memory/supermemory-client.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import {
  assertPermissionSnapshotV1SlackOnly,
  type PermissionSnapshotV1,
} from "../permissions/contract.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";

export const SEARCH_SLACK_LIMITS = Object.freeze({
  maxQueryLength: 1_000,
  defaultLimit: 5,
  maxLimit: Math.min(10, KNOWLEDGE_LIMITS.maxSearchLimit),
});

export type SearchSlackResult =
  | { status: "ok"; citations: KnowledgeCitation[] }
  | {
      status: "unauthorized";
      citations: [];
      reason: "source_not_enabled" | "source_conflict" | "policy_denied";
    }
  | { status: "knowledge_unavailable"; citations: []; retryable: boolean };

export type SearchSlackAdapter = Pick<SupermemoryAdapter, "searchSlack">;

export type SearchSlackAuthorization = Readonly<{
  permissionSnapshot: PermissionSnapshotV1;
  conversationKey: string;
  executionId: string;
}>;

type CurrentTurnAccess = Readonly<{
  config: WorkspaceChannelConfig;
  bundle: AccessBundle;
  readerPolicyRef: string;
  searchAllowed: boolean;
}>;

function exactPermissionSnapshot(
  authorization: SearchSlackAuthorization,
  teamId: string,
  channelId: string,
): boolean {
  const snapshot = authorization.permissionSnapshot;
  try {
    assertPermissionSnapshotV1SlackOnly(snapshot);
  } catch {
    return false;
  }
  return Object.isFrozen(snapshot) &&
    Object.isFrozen(snapshot.scope) &&
    Object.isFrozen(snapshot.channelAccess) &&
    Object.isFrozen(snapshot.channelAccess.allowedTools) &&
    snapshot.version === 1 &&
    snapshot.scope.teamId === teamId &&
    snapshot.scope.channelId === channelId &&
    snapshot.scope.conversationKey === authorization.conversationKey &&
    snapshot.scope.executionId === authorization.executionId &&
    snapshot.scope.actorKind === "slack_user" &&
    snapshot.channelAccess.allowedTools.includes("search_slack");
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

async function currentTurnAccess(
  env: Env,
  teamId: string,
  channelId: string,
): Promise<CurrentTurnAccess | undefined> {
  const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
  const configResponse = await stub.fetch("https://do/getConfig", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId }),
  });
  if (!configResponse.ok) throw new Error("turn_access_lookup_unavailable");
  const rawConfig = await configResponse.json() as Partial<WorkspaceChannelConfig>;
  if (
    rawConfig.teamId !== teamId ||
    (rawConfig.channelId !== null && rawConfig.channelId !== channelId) ||
    typeof rawConfig.accessBundleId !== "string" ||
    !rawConfig.accessBundleId
  ) {
    return undefined;
  }

  const bundleResponse = await stub.fetch("https://do/getBundle", {
    method: "POST",
    body: JSON.stringify({ id: rawConfig.accessBundleId }),
  });
  if (!bundleResponse.ok) throw new Error("turn_bundle_lookup_unavailable");
  const rawBundle = await bundleResponse.json() as Partial<AccessBundle>;
  const tools = stringArray(rawBundle.tools);
  const mcpEndpoints = stringArray(rawBundle.mcpEndpoints);
  const secretRefs = stringArray(rawBundle.secretRefs);
  if (
    rawBundle.id !== rawConfig.accessBundleId ||
    !tools ||
    !mcpEndpoints ||
    !secretRefs
  ) {
    return undefined;
  }

  let readerPolicyRef: string;
  try {
    readerPolicyRef = readerPolicyRefForBundle(rawBundle.id);
  } catch {
    return undefined;
  }
  const bundle: AccessBundle = {
    id: rawBundle.id,
    tools,
    mcpEndpoints,
    secretRefs,
  };
  return {
    config: rawConfig as WorkspaceChannelConfig,
    bundle,
    readerPolicyRef,
    searchAllowed: resolveAllowedTools(["search_slack"], bundle).includes("search_slack"),
  };
}

function accessAuthorizesSource(
  authorization: SearchSlackAuthorization,
  access: CurrentTurnAccess | undefined,
  source: TrackedKnowledgeSource,
): boolean {
  if (
    !access ||
    !access.searchAllowed ||
    access.bundle.id !== authorization.permissionSnapshot.channelAccess.bundleId
  ) {
    return false;
  }
  try {
    return bundleIdFromReaderPolicyRef(source.readerPolicyRef) === access.bundle.id &&
      source.readerPolicyRef === access.readerPolicyRef;
  } catch {
    return false;
  }
}

function accessMatches(
  expected: CurrentTurnAccess,
  current: CurrentTurnAccess | undefined,
): current is CurrentTurnAccess {
  if (!current) return false;
  const bundleShape = (access: CurrentTurnAccess) => JSON.stringify({
    id: access.bundle.id,
    tools: [...new Set(access.bundle.tools)].sort(),
  });
  return current.config.updatedAt === expected.config.updatedAt &&
    current.config.accessBundleId === expected.config.accessBundleId &&
    current.readerPolicyRef === expected.readerPolicyRef &&
    bundleShape(current) === bundleShape(expected);
}

function sourceMatches(
  expected: TrackedKnowledgeSource,
  current: TrackedKnowledgeSource | undefined,
): current is TrackedKnowledgeSource {
  return Boolean(
    current &&
    current.projectId === expected.projectId &&
    current.configVersion === expected.configVersion &&
    current.readerPolicyRef === expected.readerPolicyRef,
  );
}

async function enabledSource(env: Env, teamId: string, channelId: string): Promise<TrackedKnowledgeSource | undefined> {
  const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
  const response = await stub.fetch("https://do/listTrackedKnowledgeSources", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId }),
  });
  if (!response.ok) throw new Error("tracked_source_lookup_unavailable");
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("tracked_source_lookup_invalid");
  const sources = value.filter((candidate): candidate is TrackedKnowledgeSource => {
    if (!candidate || typeof candidate !== "object") return false;
    const source = candidate as Partial<TrackedKnowledgeSource>;
    return source.teamId === teamId && source.channelId === channelId &&
      typeof source.projectId === "string" && typeof source.readerPolicyRef === "string" &&
      isTrackedKnowledgeSourceEnabled({ enabled: source.enabled === true, configVersion: source.configVersion ?? 0 });
  });
  if (sources.length > 1) throw new Error("tracked_source_project_conflict");
  return sources[0];
}

async function citationIsCurrent(
  env: Env,
  teamId: string,
  citation: KnowledgeCitation,
  configVersion: number,
): Promise<boolean> {
  const stub = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(teamId));
  const response = await stub.fetch("https://do/state", {
    method: "POST",
    body: JSON.stringify({ sourceKey: citation.sourceKey }),
  });
  if (!response.ok) return false;
  const state = await response.json() as {
    ledger?: {
      indexedRevision?: string;
      tombstonedAt?: string;
      status?: string;
      lastErrorCode?: string;
      projectId?: string;
      channelId?: string;
      configVersion?: number;
    } | null;
  };
  const ledger = state.ledger;
  // Cite the last successfully indexed revision even when a later unsupported
  // update marked the row permanent_failure (mutation contract still off).
  return Boolean(
    ledger &&
    !ledger.tombstonedAt &&
    ledger.indexedRevision &&
    ledger.projectId === citation.projectId &&
    ledger.channelId === citation.channelId &&
    ledger.configVersion === configVersion &&
    ledger.indexedRevision === citation.contentRevision,
  );
}

export async function searchSlackKnowledge(input: {
  env: Env;
  teamId: string;
  channelId: string;
  authorization: SearchSlackAuthorization;
  query: string;
  limit?: number;
  adapter?: SearchSlackAdapter;
}): Promise<SearchSlackResult> {
  const query = input.query.trim();
  if (!query || query.length > SEARCH_SLACK_LIMITS.maxQueryLength) {
    return { status: "knowledge_unavailable", citations: [], retryable: false };
  }
  const limit = Math.min(SEARCH_SLACK_LIMITS.maxLimit, Math.max(1, input.limit ?? SEARCH_SLACK_LIMITS.defaultLimit));
  if (!exactPermissionSnapshot(input.authorization, input.teamId, input.channelId)) {
    return { status: "unauthorized", citations: [], reason: "policy_denied" };
  }
  let source: TrackedKnowledgeSource | undefined;
  let access: CurrentTurnAccess | undefined;
  try {
    source = await enabledSource(input.env, input.teamId, input.channelId);
    if (source) {
      access = await currentTurnAccess(input.env, input.teamId, input.channelId);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "tracked_source_project_conflict") {
      return { status: "unauthorized", citations: [], reason: "source_conflict" };
    }
    return { status: "knowledge_unavailable", citations: [], retryable: true };
  }
  if (!source) return { status: "unauthorized", citations: [], reason: "source_not_enabled" };
  if (!access || !accessAuthorizesSource(input.authorization, access, source)) {
    return { status: "unauthorized", citations: [], reason: "policy_denied" };
  }

  let adapter = input.adapter;
  if (!adapter) {
    if (!input.env.SUPERMEMORY_URL || !input.env.SUPERMEMORY_API_KEY) {
      return { status: "knowledge_unavailable", citations: [], retryable: true };
    }
    try {
      adapter = new SupermemoryAdapter(createSupermemoryClient({
        baseURL: input.env.SUPERMEMORY_URL,
        apiKey: input.env.SUPERMEMORY_API_KEY,
      }));
    } catch {
      return { status: "knowledge_unavailable", citations: [], retryable: true };
    }
  }

  try {
    const candidates = await adapter.searchSlack({
      teamId: input.teamId,
      projectId: source.projectId,
      channelId: input.channelId,
      aclPolicyRef: source.readerPolicyRef,
      query,
      limit,
    });
    // Close the authorization race: a disable/policy/version change that wins
    // while Local is searching suppresses every result. Turn access is also
    // authoritative and must still resolve to the same exact bundle/policy.
    const currentSource = await enabledSource(input.env, input.teamId, input.channelId);
    const currentAccess = await currentTurnAccess(input.env, input.teamId, input.channelId);
    if (!sourceMatches(source, currentSource) ||
      !accessMatches(access, currentAccess) ||
      !accessAuthorizesSource(input.authorization, currentAccess, currentSource)) {
      return { status: "unauthorized", citations: [], reason: "policy_denied" };
    }
    const current: KnowledgeCitation[] = [];
    for (const citation of candidates.slice(0, limit)) {
      if (await citationIsCurrent(input.env, input.teamId, citation, currentSource.configVersion)) current.push(citation);
    }
    // Ledger checks also await. Revalidate at the final acceptance point so a
    // bundle/source change during those reads cannot release stale excerpts.
    const finalSource = await enabledSource(input.env, input.teamId, input.channelId);
    const finalAccess = await currentTurnAccess(input.env, input.teamId, input.channelId);
    if (!sourceMatches(source, finalSource) ||
      !accessMatches(access, finalAccess) ||
      !accessAuthorizesSource(input.authorization, finalAccess, finalSource)) {
      return { status: "unauthorized", citations: [], reason: "policy_denied" };
    }
    return { status: "ok", citations: current };
  } catch (error) {
    return {
      status: "knowledge_unavailable",
      citations: [],
      retryable: error instanceof SupermemoryAdapterError ? error.retryable : true,
    };
  }
}

export function createSearchSlackTool(dependencies: {
  env(): Env;
  channel(thread: unknown): string;
  assertActive(thread: object): Promise<void>;
  search?: typeof searchSlackKnowledge;
}) {
  return defineBotTool({
    name: "search_slack",
    description: "Search the explicitly enabled knowledge index for the current Slack channel. Returns revisioned Slack citations or a structured unavailable status.",
    parameters: z.object({
      query: z.string().min(1).max(SEARCH_SLACK_LIMITS.maxQueryLength),
      limit: z.number().int().min(1).max(SEARCH_SLACK_LIMITS.maxLimit).optional(),
    }).strict(),
    async handler({ query, limit }, { thread }) {
      const context = requireRequestContext(thread);
      const exact = getTurnExecutionContext(thread);
      if (!exact) throw new Error("active_turn_context_required");
      const channelId = dependencies.channel(thread);
      await dependencies.assertActive(thread);
      const result = await (dependencies.search ?? searchSlackKnowledge)({
        env: dependencies.env(),
        teamId: context.teamId,
        channelId,
        authorization: {
          permissionSnapshot: requirePermissionSnapshot(thread),
          conversationKey: (thread as { conversationKey?: string }).conversationKey ?? "",
          executionId: exact.executionId,
        },
        query,
        limit,
      });
      await dependencies.assertActive(thread);
      return result;
    },
  });
}
