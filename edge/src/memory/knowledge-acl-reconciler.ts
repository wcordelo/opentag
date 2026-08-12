import type { Env } from "../env.js";
import {
  createSlackWebClient,
  sharedSlackRateScheduler,
} from "../slack/web-api.js";
import { tenantStub } from "../tenancy.js";
import type { TrackedKnowledgeSource } from "../config/knowledge-config.js";

export type KnowledgeAclRefreshEnv = Pick<
  Env,
  "WORKSPACE_CONFIG" | "KNOWLEDGE" | "SLACK_BOT_TOKEN" | "SLACK_RATE_LIMIT" | "ENVIRONMENT"
>;

type AclState = {
  revision: number;
  status: "stale" | "fresh";
};

export type SlackAclRefreshResult =
  | {
      refreshed: true;
      revision: number;
      membershipDigest?: string;
      memberCount: number;
    }
  | {
      refreshed: false;
      conflict: true;
      revision: number;
      memberCount: number;
    };

function parseAclState(value: unknown): AclState {
  if (value === null) return { revision: 0, status: "stale" };
  if (!value || typeof value !== "object") throw new Error("slack_acl_state_invalid");
  const input = value as Record<string, unknown>;
  if (
    (input.status !== "stale" && input.status !== "fresh") ||
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  ) throw new Error("slack_acl_state_invalid");
  return { status: input.status, revision: input.revision };
}

async function currentAclState(
  env: KnowledgeAclRefreshEnv,
  teamId: string,
  channelId: string,
): Promise<AclState> {
  const response = await tenantStub(env.KNOWLEDGE, teamId).fetch("https://do/acl/state", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId }),
  });
  if (!response.ok) throw new Error(`slack_acl_state_http_${response.status}`);
  return parseAclState(await response.json());
}

export async function refreshSlackKnowledgeAcl(
  env: KnowledgeAclRefreshEnv,
  input: {
    teamId: string;
    channelId: string;
    expectedRevision?: number;
  },
): Promise<SlackAclRefreshResult> {
  if (!env.SLACK_BOT_TOKEN) throw new Error("slack_acl_refresh_token_missing");
  const state = await currentAclState(env, input.teamId, input.channelId);
  const expectedRevision = input.expectedRevision ?? state.revision;
  if (expectedRevision !== state.revision) {
    return {
      refreshed: false,
      conflict: true,
      revision: state.revision,
      memberCount: 0,
    };
  }
  const client = createSlackWebClient(env.SLACK_BOT_TOKEN, {
    scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
  });
  const memberIds = await client.getChannelMembers({ channel: input.channelId });
  const response = await tenantStub(env.KNOWLEDGE, input.teamId).fetch("https://do/acl/refresh", {
    method: "POST",
    body: JSON.stringify({
      teamId: input.teamId,
      channelId: input.channelId,
      memberIds,
      expectedRevision,
    }),
  });
  const result = await response.json() as {
    refreshed?: unknown;
    conflict?: unknown;
    revision?: unknown;
    membershipDigest?: unknown;
  };
  if (response.status === 409) {
    if (
      result.refreshed !== false ||
      result.conflict !== true ||
      typeof result.revision !== "number" ||
      !Number.isSafeInteger(result.revision)
    ) throw new Error("slack_acl_refresh_conflict_invalid");
    return {
      refreshed: false,
      conflict: true,
      revision: result.revision,
      memberCount: memberIds.length,
    };
  }
  if (!response.ok || result.refreshed !== true || typeof result.revision !== "number") {
    throw new Error(`slack_acl_refresh_http_${response.status}`);
  }
  return {
    refreshed: true,
    revision: result.revision,
    ...(typeof result.membershipDigest === "string"
      ? { membershipDigest: result.membershipDigest }
      : {}),
    memberCount: memberIds.length,
  };
}

async function enabledSlackSourcesForTeam(
  env: KnowledgeAclRefreshEnv,
  teamId: string,
): Promise<TrackedKnowledgeSource[]> {
  const response = await tenantStub(env.WORKSPACE_CONFIG, teamId).fetch(
    "https://do/listEnabledTrackedKnowledgeSources",
    {
      method: "POST",
      body: JSON.stringify({ teamId }),
    },
  );
  if (!response.ok) throw new Error(`tracked_source_listing_http_${response.status}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("tracked_source_listing_invalid");
  return value.filter((source): source is TrackedKnowledgeSource =>
    Boolean(
      source &&
      typeof source === "object" &&
      (source as TrackedKnowledgeSource).teamId === teamId &&
      ((source as TrackedKnowledgeSource).sourceType ?? "slack") === "slack" &&
      (source as TrackedKnowledgeSource).enabled === true &&
      typeof (source as TrackedKnowledgeSource).channelId === "string",
    ),
  );
}

export async function reconcileSlackKnowledgeAclForTeam(
  env: KnowledgeAclRefreshEnv,
  teamId: string,
): Promise<{
  channels: number;
  refreshed: number;
  conflicts: number;
  failed: Array<{ channelId: string; error: string }>;
}> {
  const sources = await enabledSlackSourcesForTeam(env, teamId);
  const failed: Array<{ channelId: string; error: string }> = [];
  let refreshed = 0;
  let conflicts = 0;
  for (const source of sources) {
    try {
      const result = await refreshSlackKnowledgeAcl(env, {
        teamId,
        channelId: source.channelId,
      });
      if (result.refreshed) refreshed += 1;
      else conflicts += 1;
    } catch (error) {
      failed.push({
        channelId: source.channelId,
        error: error instanceof Error ? error.message.slice(0, 256) : "unknown",
      });
    }
  }
  return {
    channels: sources.length,
    refreshed,
    conflicts,
    failed,
  };
}
