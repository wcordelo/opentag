import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_EXECUTION_BUDGETS,
  createKnowledgeJob,
  type KnowledgeJob,
} from "./knowledge-contract.js";
import {
  isTrackedKnowledgeSourceEnabled,
  type TrackedKnowledgeSource,
} from "../config/knowledge-config.js";
import type { EnqueueKnowledgeResult } from "./knowledge-ledger.js";
import type { KnowledgeDO } from "./knowledge-do.js";
import type { WorkspaceConfigDO } from "../config/workspace-config-do.js";
import type { Env } from "../env.js";
import { tenantStub } from "../tenancy.js";
import { refreshSlackKnowledgeAcl } from "./knowledge-acl-reconciler.js";
import { parseKnowledgeSourceType } from "./knowledge-source-types.js";
import {
  slackLifecycleEventFromCallback,
  slackLifecycleEventDisablesInstallation,
  type SlackLifecycleEventType,
} from "../slack/installation-lifecycle.js";
import { createSlackWebClient, sharedSlackRateScheduler } from "../slack/web-api.js";

const ENQUEUE_REASONS = new Set<EnqueueKnowledgeResult["reason"]>([
  "new",
  "superseded",
  "duplicate",
  "out_of_order",
]);

function isEnqueueKnowledgeResult(value: unknown): value is EnqueueKnowledgeResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<EnqueueKnowledgeResult>;
  return typeof result.accepted === "boolean" &&
    typeof result.descriptorKey === "string" &&
    typeof result.reason === "string" &&
    ENQUEUE_REASONS.has(result.reason);
}

export const KNOWLEDGE_LEASE_MS = KNOWLEDGE_EXECUTION_BUDGETS.ledgerLeaseMs;
export const KNOWLEDGE_CONFIG_EFFECT_LEASE_MS =
  KNOWLEDGE_EXECUTION_BUDGETS.configEffectLeaseMs;
const RETRY_DELAY_SECONDS = 30;

function logKnowledgeQueueEvent(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * Controlled migration gate for the derived Supermemory consumer. The
 * authoritative Slack observations, KnowledgeDO ledger, and Queue remain in
 * place while deliveries are retried instead of being acknowledged.
 */
export function isSupermemoryConsumerPaused(
  env: Pick<KnowledgeQueueEnv, "SUPERMEMORY_CONSUMER_MODE">,
): boolean {
  return env.SUPERMEMORY_CONSUMER_MODE?.trim() === "paused";
}

export type SlackKnowledgeEvent = {
  type?: string;
  subtype?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  deleted_ts?: string;
  event_ts?: string;
  reaction?: string;
  bot_id?: string;
  user?: string;
  message?: { ts?: string; thread_ts?: string; bot_id?: string };
  previous_message?: { ts?: string; thread_ts?: string; bot_id?: string };
  item?: { type?: string; channel?: string; ts?: string; thread_ts?: string };
};

export type SlackKnowledgeCallback = {
  type?: string;
  event_id?: string;
  team_id?: string;
  event_time?: number;
  event?: SlackKnowledgeEvent;
};

export type SlackKnowledgeMessageObservation = {
  teamId: string;
  channelId: string;
  ts: string;
  threadTs?: string;
  operation: "posted" | "updated";
};

export type SlackKnowledgeAclInvalidation = {
  teamId: string;
  channelId: string;
  eventId: string;
  eventType:
    | "member_joined_channel"
    | "member_left_channel"
    | "channel_archive"
    | "channel_unarchive"
    | "channel_left"
    | "installation_revoked";
  userId?: string;
  observedAt?: string;
};

export type KnowledgeScheduleEnv = {
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_USER_ID?: string;
  SLACK_RATE_LIMIT?: Env["SLACK_RATE_LIMIT"];
  ENVIRONMENT?: string;
  slackFetchImpl?: typeof fetch;
};

export type KnowledgeQueueEnv = KnowledgeScheduleEnv & Pick<Env,
  | "SLACK_BOT_TOKEN"
  | "SUPERMEMORY"
  | "SUPERMEMORY_SERVICE_AUTH_TOKEN"
  | "SUPERMEMORY_URL"
  | "SUPERMEMORY_API_KEY"
  | "SUPERMEMORY_MIGRATION_MODE"
  | "SUPERMEMORY_MUTATION_CONTRACT"
  | "SUPERMEMORY_CONSUMER_MODE"
  | "SUPERMEMORY_INDEX_GENERATION"
  | "SLACK_RATE_LIMIT"
  | "ENVIRONMENT"
>;

export type KnowledgeDispatchResult =
  | { status: "normalized"; desiredRevision: string }
  | { status: "recorded_success" }
  | { status: "recorded_retry" }
  | { status: "recorded_permanent" }
  | { status: "retryable_failure"; errorClass: string; errorCode?: string; incompleteReason?: string }
  | { status: "permanent_failure"; errorClass: string; errorCode?: string };

export type KnowledgeDispatch = (
  job: KnowledgeJob,
  env: KnowledgeQueueEnv,
  context: {
    leaseToken: string;
    source: TrackedKnowledgeSource;
    effectToken: string;
    validateSource: () => Promise<TrackedKnowledgeSource>;
  },
) => Promise<KnowledgeDispatchResult>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

export function parseKnowledgeJob(value: unknown): KnowledgeJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("knowledge job must be an object");
  }
  const input = value as Record<string, unknown>;
  const reason = input.reason;
  if (!(["event", "debounce", "reconcile", "backfill", "delete", "reply_delete"] as unknown[]).includes(reason)) {
    throw new Error("knowledge job reason is invalid");
  }
  if (input.version !== KNOWLEDGE_SCHEMA_VERSION) throw new Error("knowledge job version is invalid");
  const requestedAt = requiredString(input.requestedAt, "requestedAt");
  if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("requestedAt must be an ISO timestamp");
  const sourceType = parseKnowledgeSourceType(input.sourceType ?? "slack");
  const job = createKnowledgeJob({
    sourceType,
    teamId: requiredString(input.teamId, "teamId"),
    projectId: requiredString(input.projectId, "projectId"),
    channelId: requiredString(input.channelId, "channelId"),
    threadTs: requiredString(input.threadTs, "threadTs"),
    configVersion: input.configVersion as number,
    requestedAt,
    reason: reason as KnowledgeJob["reason"],
    messageTs: typeof input.messageTs === "string"
      ? input.messageTs
      : undefined,
    observedMessageTs: input.observedMessageTs === undefined
      ? undefined
      : requiredString(input.observedMessageTs, "observedMessageTs"),
  });
  if (input.sourceKey !== job.sourceKey || input.sourceType !== undefined && input.sourceType !== job.sourceType) {
    throw new Error("knowledge job source identity is invalid");
  }
  return job;
}

export function knowledgeCandidateFromSlackCallback(
  callback: SlackKnowledgeCallback,
  botUserId?: string,
): {
  teamId: string;
  channelId: string;
  threadTs: string;
  reason: "event" | "delete" | "reply_delete";
  requestedAt?: string;
  messageTs?: string;
  observedMessageTs?: string;
  resolveReactionThread?: boolean;
  resolveDeletedMessageThread?: boolean;
} | undefined {
  if (callback.type !== "event_callback") return undefined;
  const teamId = callback.team_id;
  const event = callback.event;
  const channelId = event?.channel ?? event?.item?.channel;
  if (!teamId || !event || !channelId) return undefined;

  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    if (event.item?.type && event.item.type !== "message") return undefined;
    if (event.reaction === "eyes" && botUserId && event.user === botUserId) {
      return undefined;
    }
    const threadTs = event.item?.thread_ts ?? event.item?.ts;
    return threadTs
      ? {
          teamId,
          channelId,
          threadTs,
          ...(event.item?.ts ? { observedMessageTs: event.item.ts } : {}),
          reason: "event",
          ...(event.item?.thread_ts ? {} : { resolveReactionThread: true }),
          requestedAt: event.event_ts && Number.isFinite(Number(event.event_ts))
            ? new Date(Number(event.event_ts) * 1_000).toISOString()
            : undefined,
        }
      : undefined;
  }

  if (event.type !== "message" && event.type !== "app_mention") return undefined;

  // A stable Slack event timestamp makes redelivery produce the same
  // descriptor key. `now()` is only a fallback for malformed test/admin input.
  const observedSlackTs = event.event_ts ?? event.ts ??
    (typeof callback.event_time === "number" ? String(callback.event_time) : undefined);
  const observedSeconds = observedSlackTs ? Number(observedSlackTs) : Number.NaN;
  const requestedAt = Number.isFinite(observedSeconds) && observedSeconds > 0
    ? new Date(observedSeconds * 1_000).toISOString()
    : undefined;

  if (event.subtype === "message_deleted") {
    const previous = event.previous_message;
    const previousTs = typeof previous?.ts === "string" && previous.ts.length > 0
      ? previous.ts
      : undefined;
    const deletedTs = typeof event.deleted_ts === "string" &&
        event.deleted_ts.length > 0
      ? event.deleted_ts
      : undefined;
    const parentTs = typeof previous?.thread_ts === "string" &&
        previous.thread_ts.length > 0
      ? previous.thread_ts
      : undefined;

    const identityMismatch = Boolean(
      previousTs && deletedTs && previousTs !== deletedTs,
    );
    // deleted_ts is the event envelope's exact deleted-message identity. Even
    // if previous_message.ts is malformed, an exact distinct parent thread_ts
    // can safely request a refetch; it can never authorize a root tombstone.
    const messageTs = deletedTs ?? previousTs;
    if (parentTs && messageTs && parentTs !== messageTs) {
      return {
        teamId,
        channelId,
        threadTs: parentTs,
        messageTs,
        reason: "reply_delete",
        requestedAt,
      };
    }
    // Slack's Events API normally supplies only deleted_ts. That value cannot
    // prove root-vs-reply by itself, so the scheduler resolves it against the
    // durable body-free message-to-thread map before creating a delete job.
    if (
      previousTs &&
      !identityMismatch &&
      (!parentTs || parentTs === previousTs) &&
      (!deletedTs || deletedTs === previousTs)
    ) {
      return {
        teamId,
        channelId,
        threadTs: previousTs,
        messageTs: previousTs,
        reason: "delete",
        requestedAt,
      };
    }
    if (deletedTs) {
      return {
        teamId,
        channelId,
        threadTs: deletedTs,
        messageTs: deletedTs,
        reason: "delete",
        resolveDeletedMessageThread: true,
        requestedAt,
      };
    }
    return undefined;
  }
  if (event.subtype === "message_changed") {
    const threadTs = event.message?.thread_ts ?? event.message?.ts;
    return threadTs ? {
      teamId,
      channelId,
      threadTs,
      ...(event.message?.ts ? { observedMessageTs: event.message.ts } : {}),
      reason: "event",
      requestedAt,
    } : undefined;
  }
  const threadTs = event.message?.thread_ts ?? event.thread_ts ?? event.ts;
  return threadTs ? {
    teamId,
    channelId,
    threadTs,
    ...(event.message?.ts ?? event.ts
      ? { observedMessageTs: event.message?.ts ?? event.ts }
      : {}),
    reason: "event",
    requestedAt,
  } : undefined;
}

export async function scheduleKnowledgeFromSlackMessage(
  env: KnowledgeScheduleEnv,
  observation: SlackKnowledgeMessageObservation,
  now: () => Date = () => new Date(),
): Promise<{ scheduled: number; aclInvalidated?: number }> {
  const observedAt = now();
  const observedSeconds = (observedAt.getTime() + (observation.operation === "updated" ? 1 : 0)) / 1_000;
  const eventType = observation.operation === "updated" ? "message_changed" : "message";
  return scheduleKnowledgeFromSlackEventInternal(env, {
    type: "event_callback",
    event_id: [
      "outbound",
      observation.operation,
      observation.teamId,
      observation.channelId,
      observation.ts,
    ].join(":"),
    team_id: observation.teamId,
    event_time: observedSeconds,
    event: {
      type: "message",
      subtype: eventType === "message_changed" ? "message_changed" : undefined,
      channel: observation.channelId,
      ts: observation.ts,
      thread_ts: observation.threadTs,
      event_ts: String(observedSeconds),
      ...(eventType === "message_changed"
        ? {
            message: {
              ts: observation.ts,
              ...(observation.threadTs ? { thread_ts: observation.threadTs } : {}),
            },
          }
        : {}),
    },
  }, now, { requireSource: true });
}

export function slackKnowledgeAclInvalidationFromSlackCallback(
  callback: SlackKnowledgeCallback,
): SlackKnowledgeAclInvalidation | undefined {
  if (callback.type !== "event_callback") return undefined;
  const event = callback.event;
  if (
    !event ||
    (event.type !== "member_joined_channel" && event.type !== "member_left_channel") ||
    !callback.team_id ||
    !event.channel
  ) return undefined;
  const observedAt = event.event_ts && Number.isFinite(Number(event.event_ts))
    ? new Date(Number(event.event_ts) * 1_000).toISOString()
    : typeof callback.event_time === "number" && Number.isFinite(callback.event_time)
      ? new Date(callback.event_time * 1_000).toISOString()
      : undefined;
  const eventId = callback.event_id?.trim() || [
    event.type,
    callback.team_id,
    event.channel,
    event.user ?? "",
    event.event_ts ?? "",
  ].join(":");
  return {
    teamId: callback.team_id,
    channelId: event.channel,
    eventId,
    eventType: event.type,
    ...(event.user ? { userId: event.user } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

async function exactSourcesForChannel(
  env: KnowledgeScheduleEnv,
  teamId: string,
  channelId: string,
): Promise<TrackedKnowledgeSource[]> {
  const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
  const response = await stub.fetch("https://do/resolveSlackKnowledgeSource", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId }),
  });
  if (response.status === 409) throw new Error("tracked_source_project_conflict");
  if (!response.ok) throw new Error(`tracked_source_lookup_http_${response.status}`);
  const value = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tracked_source_lookup_invalid");
  }
  const candidate = (value as { source?: unknown }).source;
  const sources = candidate && typeof candidate === "object"
    ? [candidate].filter((item): item is TrackedKnowledgeSource => {
      const source = item as Partial<TrackedKnowledgeSource>;
      return source.teamId === teamId && source.channelId === channelId &&
        typeof source.projectId === "string" && isTrackedKnowledgeSourceEnabled({
          enabled: source.enabled === true,
          configVersion: source.configVersion ?? 0,
        });
    })
    : [];
  if (sources.length > 1) throw new Error("tracked_source_project_conflict");
  return sources;
}

/**
 * Called only from the verified Events route's durable ingress owner. Slack
 * never supplies a projectId: this schedules the sole exact, explicitly enabled
 * WorkspaceConfigDO row for the event's team/channel. Configuration rejects
 * a second enabled project because B1 source/custom IDs are not project-scoped.
 */
type SlackKnowledgeScheduleOptions = {
  requireSource?: boolean;
};

function lifecycleAclEventType(
  eventType: SlackLifecycleEventType,
): SlackKnowledgeAclInvalidation["eventType"] {
  if (slackLifecycleEventDisablesInstallation(eventType)) return "installation_revoked";
  if (eventType === "channel_unarchive" || eventType === "group_unarchive" || eventType === "group_open") {
    return "channel_unarchive";
  }
  if (eventType === "channel_left" || eventType === "group_left" || eventType === "member_left_channel") {
    return "channel_left";
  }
  if (
    eventType === "channel_archive" ||
    eventType === "channel_deleted" ||
    eventType === "channel_unshared" ||
    eventType === "group_archive" ||
    eventType === "group_deleted" ||
    eventType === "group_close"
  ) return "channel_archive";
  throw new Error("slack_lifecycle_acl_event_type_invalid");
}

async function invalidateSlackAcl(
  env: KnowledgeScheduleEnv,
  invalidation: SlackKnowledgeAclInvalidation,
): Promise<boolean> {
  const response = await tenantStub(env.KNOWLEDGE, invalidation.teamId).fetch(
    "https://do/acl/invalidate",
    {
      method: "POST",
      body: JSON.stringify(invalidation),
    },
  );
  if (!response.ok) throw new Error(`knowledge_acl_invalidation_http_${response.status}`);
  const result = await response.json() as { invalidated?: unknown; duplicate?: unknown };
  if (result.invalidated !== true && result.duplicate !== true) {
    throw new Error("knowledge_acl_invalidation_result_malformed");
  }
  return result.invalidated === true;
}

async function scheduleKnowledgeFromSlackEventInternal(
  env: KnowledgeScheduleEnv,
  callback: SlackKnowledgeCallback,
  now: () => Date = () => new Date(),
  options: SlackKnowledgeScheduleOptions = {},
): Promise<{ scheduled: number; aclInvalidated?: number }> {
  const lifecycle = slackLifecycleEventFromCallback(callback, env.SLACK_BOT_USER_ID);
  if (lifecycle) {
    const lifecycleResponse = await tenantStub(env.WORKSPACE_CONFIG, lifecycle.teamId).fetch(
      "https://do/applySlackLifecycle",
      {
        method: "POST",
        body: JSON.stringify(lifecycle),
      },
    );
    if (!lifecycleResponse.ok) {
      throw new Error(`slack_lifecycle_http_${lifecycleResponse.status}`);
    }
    const lifecycleResult = await lifecycleResponse.json() as {
      affectedChannels?: unknown;
    };
    if (!Array.isArray(lifecycleResult.affectedChannels) ||
      !lifecycleResult.affectedChannels.every((channelId) => typeof channelId === "string" && channelId.length > 0)) {
      throw new Error("slack_lifecycle_result_malformed");
    }
    let aclInvalidated = 0;
    for (const channelId of lifecycleResult.affectedChannels) {
      const invalidated = await invalidateSlackAcl(env, {
        teamId: lifecycle.teamId,
        channelId,
        eventId: `lifecycle:${lifecycle.eventId}:${channelId}`,
        eventType: lifecycleAclEventType(lifecycle.eventType),
        ...(lifecycle.observedAt ? { observedAt: lifecycle.observedAt } : {}),
      });
      if (invalidated) aclInvalidated += 1;
      if (lifecycle.eventType === "channel_unarchive" && env.SLACK_BOT_TOKEN) {
        await refreshSlackKnowledgeAcl(env, { teamId: lifecycle.teamId, channelId });
      }
    }
    return { scheduled: 0, aclInvalidated };
  }
  const aclInvalidation = slackKnowledgeAclInvalidationFromSlackCallback(callback);
  if (aclInvalidation) {
    const invalidated = await invalidateSlackAcl(env, aclInvalidation);
    if (env.SLACK_BOT_TOKEN) {
      await refreshSlackKnowledgeAcl(env, {
        teamId: aclInvalidation.teamId,
        channelId: aclInvalidation.channelId,
      });
    }
    return { scheduled: 0, aclInvalidated: invalidated ? 1 : 0 };
  }
  const candidate = knowledgeCandidateFromSlackCallback(callback, env.SLACK_BOT_USER_ID);
  if (!candidate) return { scheduled: 0 };
  let threadTs = candidate.threadTs;
  let reason = candidate.reason;
  let messageTs = candidate.messageTs;
  if (candidate.resolveDeletedMessageThread) {
    const resolved = await knowledgeDoRequest<{
      found?: unknown;
      threadTs?: unknown;
    }>(env, candidate.teamId, "/message-thread/resolve", {
      teamId: candidate.teamId,
      channelId: candidate.channelId,
      messageTs: candidate.messageTs,
    });
    if (resolved.found !== true || typeof resolved.threadTs !== "string" || !resolved.threadTs) {
      throw new Error("knowledge_deleted_message_thread_unresolved");
    }
    threadTs = resolved.threadTs;
    reason = threadTs === candidate.messageTs ? "delete" : "reply_delete";
    messageTs = candidate.messageTs;
  }
  if (candidate.resolveReactionThread) {
    const mapped = await knowledgeDoRequest<{
      found?: unknown;
      threadTs?: unknown;
    }>(env, candidate.teamId, "/message-thread/resolve", {
      teamId: candidate.teamId,
      channelId: candidate.channelId,
      messageTs: candidate.threadTs,
    });
    if (mapped.found === true && typeof mapped.threadTs === "string" && mapped.threadTs) {
      threadTs = mapped.threadTs;
    } else {
      if (!env.SLACK_BOT_TOKEN) {
        throw new Error("knowledge_reaction_thread_lookup_token_missing");
      }
      const lookup = await createSlackWebClient(env.SLACK_BOT_TOKEN, {
        scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
        ...(env.slackFetchImpl ? { fetchImpl: env.slackFetchImpl } : {}),
      }).getMessageByTimestamp({
        channel: candidate.channelId,
        timestamp: candidate.threadTs,
      });
      if (!lookup.found || !lookup.message?.ts) {
        throw new Error("knowledge_reaction_message_thread_unresolved");
      }
      threadTs = lookup.message.thread_ts ?? lookup.message.ts;
    }
  }
  const sources = await exactSourcesForChannel(env, candidate.teamId, candidate.channelId);
  if (options.requireSource && sources.length === 0) {
    throw new Error("knowledge_observation_source_not_enabled");
  }
  let scheduled = 0;
  for (const source of sources) {
    const job = createKnowledgeJob({
      teamId: source.teamId,
      projectId: source.projectId,
      channelId: source.channelId,
      threadTs,
      configVersion: source.configVersion,
      requestedAt: candidate.requestedAt ?? now().toISOString(),
      reason,
      ...(messageTs ? { messageTs } : {}),
      ...(candidate.observedMessageTs
        ? { observedMessageTs: candidate.observedMessageTs }
        : {}),
    });
    const stub = tenantStub(env.KNOWLEDGE, source.teamId);
    const response = await stub.fetch("https://do/descriptor", {
      method: "POST",
      body: JSON.stringify(job),
    });
    if (!response.ok) throw new Error(`knowledge_descriptor_http_${response.status}`);
    const result: unknown = await response.json();
    if (!isEnqueueKnowledgeResult(result)) {
      throw new Error("knowledge_descriptor_result_malformed");
    }
    // Duplicate / out-of-order descriptors return HTTP 200 with accepted:false;
    // only count rows that actually entered the outbox.
    if (result.accepted) scheduled += 1;
  }
  return { scheduled };
}

export function scheduleKnowledgeFromSlackEvent(
  env: KnowledgeScheduleEnv,
  callback: SlackKnowledgeCallback,
  now: () => Date = () => new Date(),
): Promise<{ scheduled: number; aclInvalidated?: number }> {
  return scheduleKnowledgeFromSlackEventInternal(env, callback, now);
}

async function loadExactSource(
  env: KnowledgeQueueEnv,
  job: KnowledgeJob,
): Promise<TrackedKnowledgeSource | undefined> {
  const stub = tenantStub(env.WORKSPACE_CONFIG, job.teamId);
  const response = await stub.fetch("https://do/getTrackedKnowledgeSource", {
    method: "POST",
    body: JSON.stringify({
      teamId: job.teamId,
      projectId: job.projectId,
      channelId: job.channelId,
      sourceType: job.sourceType,
    }),
  });
  if (!response.ok) throw new Error(`tracked_source_lookup_http_${response.status}`);
  return response.json() as Promise<TrackedKnowledgeSource>;
}

async function workspaceDoRequest<T>(
  env: KnowledgeQueueEnv,
  teamId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
  const response = await stub.fetch(`https://do${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`workspace_config_do_http_${response.status}`);
  return response.json() as Promise<T>;
}

async function knowledgeDoRequest<T>(
  env: KnowledgeQueueEnv,
  teamId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = tenantStub(env.KNOWLEDGE, teamId);
  const response = await stub.fetch(`https://do${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`knowledge_do_http_${response.status}`);
  return response.json() as Promise<T>;
}

const unavailableDispatch: KnowledgeDispatch = async () => ({
  status: "retryable_failure",
  errorClass: "consumer_unavailable",
  errorCode: "b3_dispatch_not_registered",
});

/** Queue-only consumer seam. It is never called by Slack acknowledgement or turns. */
export async function handleKnowledgeQueue(
  batch: MessageBatch<unknown>,
  env: KnowledgeQueueEnv,
  dispatch: KnowledgeDispatch = unavailableDispatch,
): Promise<void> {
  if (isSupermemoryConsumerPaused(env)) {
    batch.retryAll({ delaySeconds: RETRY_DELAY_SECONDS });
    return;
  }
  for (const message of batch.messages) {
    let job: KnowledgeJob;
    try {
      job = parseKnowledgeJob(message.body);
    } catch {
      logKnowledgeQueueEvent("knowledge_queue_retry", { stage: "parse" });
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      continue;
    }
    let stage = "start";
    logKnowledgeQueueEvent("knowledge_queue_start", {
      teamId: job.teamId,
      sourceType: job.sourceType,
      reason: job.reason,
    });
    try {
      stage = "load_source";
      const source = await loadExactSource(env, job);
      const deleteConfigAdvanced =
        job.reason === "delete" && source !== undefined &&
        source.configVersion > job.configVersion;
      if (
        !source ||
        (job.reason !== "delete" && !isTrackedKnowledgeSourceEnabled(source)) ||
        source.teamId !== job.teamId ||
        (source.sourceType ?? "slack") !== job.sourceType ||
        source.projectId !== job.projectId ||
        source.channelId !== job.channelId ||
        (source.configVersion !== job.configVersion && !deleteConfigAdvanced)
      ) {
        await knowledgeDoRequest(env, job.teamId, "/stale", { job });
        message.ack();
        continue;
      }

      const effectConfigVersion = deleteConfigAdvanced
        ? source.configVersion
        : job.configVersion;
      const effectToken = crypto.randomUUID();
      stage = "effect_lease";
      const effect = await workspaceDoRequest<
        | { decision: "lease"; effectToken: string; expiresAt: number; source: TrackedKnowledgeSource }
        | { decision: "stale" }
      >(env, job.teamId, "/beginKnowledgeIngestionEffect", {
        teamId: job.teamId,
        sourceType: job.sourceType,
        projectId: job.projectId,
        channelId: job.channelId,
        configVersion: effectConfigVersion,
        effectToken,
        leaseMs: KNOWLEDGE_CONFIG_EFFECT_LEASE_MS,
        allowDisabled: job.reason === "delete",
      });
      if (effect.decision === "stale") {
        await knowledgeDoRequest(env, job.teamId, "/stale", { job });
        message.ack();
        continue;
      }
      const validateSource = async (): Promise<TrackedKnowledgeSource> => {
        const validation = await workspaceDoRequest<{
          valid: boolean;
          source?: TrackedKnowledgeSource;
        }>(env, job.teamId, "/validateKnowledgeIngestionEffect", {
          teamId: job.teamId,
          sourceType: job.sourceType,
          projectId: job.projectId,
          channelId: job.channelId,
          configVersion: effectConfigVersion,
          effectToken,
          allowDisabled: job.reason === "delete",
        });
        if (!validation.valid || !validation.source) {
          throw new Error("knowledge_config_effect_invalid");
        }
        return validation.source;
      };
      try {
        stage = "ledger_lease";
        const lease = await knowledgeDoRequest<
          | { decision: "lease"; leaseToken: string; leaseExpiresAt: number }
          | { decision: "noop"; reason: string }
          | { decision: "retry"; retryAfterSeconds: number }
        >(env, job.teamId, "/lease", {
          job,
          authoritativeConfigVersion: source.configVersion,
          leaseToken: crypto.randomUUID(),
          leaseMs: KNOWLEDGE_LEASE_MS,
        });
        if (lease.decision === "noop") {
          message.ack();
          continue;
        }
        if (lease.decision === "retry") {
          message.retry({ delaySeconds: lease.retryAfterSeconds });
          continue;
        }

        if (job.sourceType !== "slack") {
          await validateSource();
          await knowledgeDoRequest(env, job.teamId, "/outcome", {
            sourceKey: job.sourceKey,
            leaseToken: lease.leaseToken,
            outcome: {
              status: "permanent_failure",
              errorClass: "unsupported_source_type",
              errorCode: job.sourceType,
            },
          });
          message.ack();
          continue;
        }

        stage = "dispatch";
        const outcome = await dispatch(job, env, {
          leaseToken: lease.leaseToken,
          source: effect.source,
          effectToken,
          validateSource,
        });
        logKnowledgeQueueEvent("knowledge_queue_dispatch", {
          teamId: job.teamId,
          sourceType: job.sourceType,
          reason: job.reason,
          status: outcome.status,
        });
        if (outcome.status === "recorded_success") {
          message.ack();
          continue;
        }
        if (outcome.status === "recorded_retry") {
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
          continue;
        }
        if (outcome.status === "recorded_permanent") {
          // Adapter already persisted a terminal tombstone / permanent_failure.
          message.ack();
          continue;
        }
        stage = "outcome";
        await validateSource();
        await knowledgeDoRequest(env, job.teamId, "/outcome", {
          sourceKey: job.sourceKey,
          leaseToken: lease.leaseToken,
          outcome,
        });
        if (outcome.status === "normalized") message.ack();
        else message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      } finally {
        try {
          await workspaceDoRequest(env, job.teamId, "/releaseKnowledgeIngestionEffect", {
            effectToken,
          });
        } catch {
          // The bounded durable effect expires after a crash/control-plane
          // failure. Do not mask an already-recorded Queue decision.
        }
      }
    } catch {
      logKnowledgeQueueEvent("knowledge_queue_retry", {
        teamId: job.teamId,
        sourceType: job.sourceType,
        reason: job.reason,
        stage,
      });
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}
