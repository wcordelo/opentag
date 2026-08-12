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
import { parseConnectorAccessGrant } from "../connectors/authorization.js";
import { KNOWLEDGE_LIMITS, type KnowledgeCitation } from "../memory/knowledge-contract.js";
import { SupermemoryAdapter, SupermemoryAdapterError } from "../memory/supermemory-adapter.js";
import { createSupermemoryClientFromEnv } from "../memory/supermemory-client.js";
import { requirePermissionSnapshot } from "../permissions/context.js";
import {
  assertPermissionSnapshotV1SlackOnly,
  type PermissionSnapshotV1,
} from "../permissions/contract.js";
import { requireRequestContext } from "../request-context.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";
import { tenantStub } from "../tenancy.js";

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
  actorId: string;
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
  const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
  let connectorGrants: AccessBundle["connectorGrants"] = [];
  try {
    connectorGrants = Array.isArray(rawBundle.connectorGrants)
      ? rawBundle.connectorGrants.map(parseConnectorAccessGrant)
      : [];
  } catch {
    return undefined;
  }
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
    connectorGrants,
    schemaVersion: rawBundle.schemaVersion === 1 ? 1 : undefined,
    revision: typeof rawBundle.revision === "number" ? rawBundle.revision : 1,
    status: rawBundle.status === "revoked" ? "revoked" : "active",
    ...(typeof rawBundle.revokedAt === "string" ? { revokedAt: rawBundle.revokedAt } : {}),
  };
  if (bundle.status === "revoked") return undefined;
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
    revision: access.bundle.revision ?? 1,
    status: access.bundle.status ?? "active",
    connectorGrants: access.bundle.connectorGrants ?? [],
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
  const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
      (source.sourceType === undefined || source.sourceType === "slack") &&
      typeof source.projectId === "string" && typeof source.readerPolicyRef === "string" &&
      isTrackedKnowledgeSourceEnabled({ enabled: source.enabled === true, configVersion: source.configVersion ?? 0 });
  });
  if (sources.length > 1) throw new Error("tracked_source_project_conflict");
  return sources[0];
}

type SlackAclLease = {
  leaseId: string;
  revision: number;
};

async function acquireSlackAclLease(
  env: Env,
  teamId: string,
  channelId: string,
  actorId: string,
): Promise<SlackAclLease | undefined> {
  const stub = tenantStub(env.KNOWLEDGE, teamId);
  const response = await stub.fetch("https://do/acl/authorize", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId, actorId }),
  });
  if (response.status === 403 || response.status === 404) return undefined;
  if (!response.ok) throw new Error("slack_acl_state_lookup_unavailable");
  const value = await response.json() as Partial<SlackAclLease> | null;
  if (value === null) return undefined;
  const revision = value.revision;
  const leaseId = value.leaseId;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof leaseId !== "string" ||
    !leaseId
  ) throw new Error("slack_acl_state_lookup_invalid");
  return { leaseId, revision };
}

async function checkSlackAclLease(
  env: Env,
  teamId: string,
  channelId: string,
  actorId: string,
  leaseId: string,
): Promise<boolean> {
  const response = await tenantStub(env.KNOWLEDGE, teamId).fetch("https://do/acl/check", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId, actorId, leaseId }),
  });
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) throw new Error("slack_acl_lease_check_unavailable");
  const value = await response.json() as { authorized?: unknown };
  if (typeof value.authorized !== "boolean") throw new Error("slack_acl_lease_check_invalid");
  return value.authorized;
}

async function releaseSlackAclLease(
  env: Env,
  teamId: string,
  channelId: string,
  leaseId: string,
): Promise<void> {
  await tenantStub(env.KNOWLEDGE, teamId).fetch("https://do/acl/release", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId, leaseId }),
  });
}

export async function isSlackKnowledgeMember(
  env: Env,
  teamId: string,
  channelId: string,
  actorId: string,
): Promise<boolean> {
  let lease: SlackAclLease | undefined;
  try {
    lease = await acquireSlackAclLease(env, teamId, channelId, actorId);
    if (!lease) return false;
    return await checkSlackAclLease(env, teamId, channelId, actorId, lease.leaseId);
  } catch {
    return false;
  } finally {
    if (lease) {
      await releaseSlackAclLease(env, teamId, channelId, lease.leaseId).catch(() => undefined);
    }
  }
}

async function citationIsCurrent(
  env: Env,
  teamId: string,
  citation: KnowledgeCitation,
  configVersion: number,
): Promise<boolean> {
  const stub = tenantStub(env.KNOWLEDGE, teamId);
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
  let aclLease: SlackAclLease | undefined;
  try {
    aclLease = await acquireSlackAclLease(
      input.env,
      input.teamId,
      input.channelId,
      input.authorization.actorId,
    );
    if (!aclLease) {
      return { status: "knowledge_unavailable", citations: [], retryable: true };
    }
    let adapter = input.adapter;
    if (!adapter) {
      const client = createSupermemoryClientFromEnv(input.env);
      if (!client) {
        return { status: "knowledge_unavailable", citations: [], retryable: true };
      }
      try {
        adapter = new SupermemoryAdapter(client);
      } catch {
        return { status: "knowledge_unavailable", citations: [], retryable: true };
      }
    }
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
    const aclCurrent = await checkSlackAclLease(
      input.env,
      input.teamId,
      input.channelId,
      input.authorization.actorId,
      aclLease.leaseId,
    );
    if (!sourceMatches(source, currentSource) ||
      !accessMatches(access, currentAccess) ||
      !accessAuthorizesSource(input.authorization, currentAccess, currentSource) ||
      !aclCurrent) {
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
    const aclFinal = await checkSlackAclLease(
      input.env,
      input.teamId,
      input.channelId,
      input.authorization.actorId,
      aclLease.leaseId,
    );
    if (!sourceMatches(source, finalSource) ||
      !accessMatches(access, finalAccess) ||
      !accessAuthorizesSource(input.authorization, finalAccess, finalSource) ||
      !aclFinal) {
      return { status: "unauthorized", citations: [], reason: "policy_denied" };
    }
    return { status: "ok", citations: current };
  } catch (error) {
    return {
      status: "knowledge_unavailable",
      citations: [],
      retryable: error instanceof SupermemoryAdapterError ? error.retryable : true,
    };
  } finally {
    if (aclLease) {
      await releaseSlackAclLease(
        input.env,
        input.teamId,
        input.channelId,
        aclLease.leaseId,
      ).catch(() => undefined);
    }
  }
}

export async function searchSlackKnowledgeForActor(input: {
  env: Env;
  teamId: string;
  channelId: string;
  projectId: string;
  actorId: string;
  aclPolicyRef: string;
  query: string;
  limit?: number;
  adapter?: SearchSlackAdapter;
}): Promise<SearchSlackResult> {
  const query = input.query.trim();
  if (!query || query.length > SEARCH_SLACK_LIMITS.maxQueryLength) {
    return { status: "knowledge_unavailable", citations: [], retryable: false };
  }
  const limit = Math.min(SEARCH_SLACK_LIMITS.maxLimit, Math.max(1, input.limit ?? SEARCH_SLACK_LIMITS.defaultLimit));
  let source: TrackedKnowledgeSource | undefined;
  let access: CurrentTurnAccess | undefined;
  try {
    source = await enabledSource(input.env, input.teamId, input.channelId);
    access = await currentTurnAccess(input.env, input.teamId, input.channelId);
  } catch {
    return { status: "knowledge_unavailable", citations: [], retryable: true };
  }
  if (
    !source ||
    source.projectId !== input.projectId ||
    source.readerPolicyRef !== input.aclPolicyRef ||
    !access ||
    !access.searchAllowed ||
    access.readerPolicyRef !== input.aclPolicyRef
  ) {
    return { status: "unauthorized", citations: [], reason: "policy_denied" };
  }

  let aclLease: SlackAclLease | undefined;
  try {
    aclLease = await acquireSlackAclLease(
      input.env,
      input.teamId,
      input.channelId,
      input.actorId,
    );
    if (!aclLease) {
      return { status: "knowledge_unavailable", citations: [], retryable: true };
    }
    let adapter = input.adapter;
    if (!adapter) {
      const client = createSupermemoryClientFromEnv(input.env);
      if (!client) {
        return { status: "knowledge_unavailable", citations: [], retryable: true };
      }
      adapter = new SupermemoryAdapter(client);
    }
    const candidates = await adapter.searchSlack({
      teamId: input.teamId,
      projectId: input.projectId,
      channelId: input.channelId,
      aclPolicyRef: input.aclPolicyRef,
      query,
      limit,
    });
    const currentSource = await enabledSource(input.env, input.teamId, input.channelId);
    const currentAccess = await currentTurnAccess(input.env, input.teamId, input.channelId);
    const aclCurrent = await checkSlackAclLease(
      input.env,
      input.teamId,
      input.channelId,
      input.actorId,
      aclLease.leaseId,
    );
    if (
      !sourceMatches(source, currentSource) ||
      !currentSource ||
      currentSource.projectId !== input.projectId ||
      currentSource.readerPolicyRef !== input.aclPolicyRef ||
      !accessMatches(access, currentAccess) ||
      !currentAccess ||
      !currentAccess.searchAllowed ||
      currentAccess.readerPolicyRef !== input.aclPolicyRef ||
      !aclCurrent
    ) {
      return { status: "unauthorized", citations: [], reason: "policy_denied" };
    }
    const current: KnowledgeCitation[] = [];
    for (const citation of candidates.slice(0, limit)) {
      if (await citationIsCurrent(input.env, input.teamId, citation, currentSource.configVersion)) {
        current.push(citation);
      }
    }
    const finalSource = await enabledSource(input.env, input.teamId, input.channelId);
    const finalAccess = await currentTurnAccess(input.env, input.teamId, input.channelId);
    const aclFinal = await checkSlackAclLease(
      input.env,
      input.teamId,
      input.channelId,
      input.actorId,
      aclLease.leaseId,
    );
    if (
      !sourceMatches(source, finalSource) ||
      !finalSource ||
      finalSource.projectId !== input.projectId ||
      finalSource.readerPolicyRef !== input.aclPolicyRef ||
      !accessMatches(access, finalAccess) ||
      !finalAccess ||
      !finalAccess.searchAllowed ||
      finalAccess.readerPolicyRef !== input.aclPolicyRef ||
      !aclFinal
    ) {
      return { status: "unauthorized", citations: [], reason: "policy_denied" };
    }
    return { status: "ok", citations: current };
  } catch (error) {
    return {
      status: "knowledge_unavailable",
      citations: [],
      retryable: error instanceof SupermemoryAdapterError ? error.retryable : true,
    };
  } finally {
    if (aclLease) {
      await releaseSlackAclLease(
        input.env,
        input.teamId,
        input.channelId,
        aclLease.leaseId,
      ).catch(() => undefined);
    }
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
          actorId: context.requesterId,
        },
        query,
        limit,
      });
      await dependencies.assertActive(thread);
      return result;
    },
  });
}
