import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_EXECUTION_BUDGETS,
  createKnowledgeJob,
  slackSourceKey,
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

export type SlackKnowledgeEvent = {
  type?: string;
  subtype?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  deleted_ts?: string;
  event_ts?: string;
  bot_id?: string;
  message?: { ts?: string; thread_ts?: string; bot_id?: string };
  previous_message?: { ts?: string; thread_ts?: string; bot_id?: string };
};

export type SlackKnowledgeCallback = {
  type?: string;
  team_id?: string;
  event_time?: number;
  event?: SlackKnowledgeEvent;
};

export type KnowledgeScheduleEnv = {
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
};

export type KnowledgeQueueEnv = KnowledgeScheduleEnv & Pick<Env,
  | "SLACK_BOT_TOKEN"
  | "SUPERMEMORY_URL"
  | "SUPERMEMORY_API_KEY"
  | "SUPERMEMORY_MUTATION_CONTRACT"
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
  const job = createKnowledgeJob({
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
  });
  if (input.sourceKey !== job.sourceKey) throw new Error("knowledge job sourceKey is invalid");
  return job;
}

export function knowledgeCandidateFromSlackCallback(
  callback: SlackKnowledgeCallback,
): {
  teamId: string;
  channelId: string;
  threadTs: string;
  reason: "event" | "delete" | "reply_delete";
  requestedAt?: string;
  messageTs?: string;
} | undefined {
  if (callback.type !== "event_callback") return undefined;
  const teamId = callback.team_id;
  const event = callback.event;
  if (!teamId || !event?.channel) return undefined;
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
        channelId: event.channel,
        threadTs: parentTs,
        messageTs,
        reason: "reply_delete",
        requestedAt,
      };
    }
    // Only a complete previous_message can prove that the deleted message is
    // the actual root. deleted_ts alone is intentionally insufficient.
    if (
      previousTs &&
      !identityMismatch &&
      (!parentTs || parentTs === previousTs) &&
      (!deletedTs || deletedTs === previousTs)
    ) {
      return {
        teamId,
        channelId: event.channel,
        threadTs: previousTs,
        messageTs: previousTs,
        reason: "delete",
        requestedAt,
      };
    }
    return undefined;
  }
  if (event.subtype === "message_changed") {
    const threadTs = event.message?.thread_ts ?? event.message?.ts;
    return threadTs ? { teamId, channelId: event.channel, threadTs, reason: "event", requestedAt } : undefined;
  }
  const threadTs = event.thread_ts ?? event.ts;
  return threadTs ? { teamId, channelId: event.channel, threadTs, reason: "event", requestedAt } : undefined;
}

async function exactSourcesForChannel(
  env: KnowledgeScheduleEnv,
  teamId: string,
  channelId: string,
): Promise<TrackedKnowledgeSource[]> {
  const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
  const response = await stub.fetch("https://do/listTrackedKnowledgeSources", {
    method: "POST",
    body: JSON.stringify({ teamId, channelId }),
  });
  if (!response.ok) throw new Error(`tracked_source_lookup_http_${response.status}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("tracked_source_lookup_invalid");
  const sources = value.filter((item): item is TrackedKnowledgeSource => {
    if (!item || typeof item !== "object") return false;
    const source = item as Partial<TrackedKnowledgeSource>;
    return source.teamId === teamId && source.channelId === channelId &&
      typeof source.projectId === "string" && isTrackedKnowledgeSourceEnabled({
        enabled: source.enabled === true,
        configVersion: source.configVersion ?? 0,
      });
  });
  if (sources.length > 1) throw new Error("tracked_source_project_conflict");
  return sources;
}

/**
 * Called only from the verified Events route's waitUntil. Slack never supplies
 * a projectId: this schedules the sole exact, explicitly enabled
 * WorkspaceConfigDO row for the event's team/channel. Configuration rejects
 * a second enabled project because B1 source/custom IDs are not project-scoped.
 */
export async function scheduleKnowledgeFromSlackEvent(
  env: KnowledgeScheduleEnv,
  callback: SlackKnowledgeCallback,
  now: () => Date = () => new Date(),
): Promise<{ scheduled: number }> {
  const candidate = knowledgeCandidateFromSlackCallback(callback);
  if (!candidate) return { scheduled: 0 };
  const sources = await exactSourcesForChannel(env, candidate.teamId, candidate.channelId);
  let scheduled = 0;
  for (const source of sources) {
    const job = createKnowledgeJob({
      teamId: source.teamId,
      projectId: source.projectId,
      channelId: source.channelId,
      threadTs: candidate.threadTs,
      configVersion: source.configVersion,
      requestedAt: candidate.requestedAt ?? now().toISOString(),
      reason: candidate.reason,
      messageTs: candidate.messageTs,
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

async function loadExactSource(
  env: KnowledgeQueueEnv,
  job: KnowledgeJob,
): Promise<TrackedKnowledgeSource | undefined> {
  const stub = tenantStub(env.WORKSPACE_CONFIG, job.teamId);
  const response = await stub.fetch("https://do/getTrackedKnowledgeSource", {
    method: "POST",
    body: JSON.stringify({ teamId: job.teamId, projectId: job.projectId, channelId: job.channelId }),
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
  for (const message of batch.messages) {
    let job: KnowledgeJob;
    try {
      job = parseKnowledgeJob(message.body);
    } catch {
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      continue;
    }
    try {
      const source = await loadExactSource(env, job);
      const deleteConfigAdvanced =
        job.reason === "delete" && source !== undefined &&
        source.configVersion > job.configVersion;
      if (
        !source ||
        (job.reason !== "delete" && !isTrackedKnowledgeSourceEnabled(source)) ||
        source.teamId !== job.teamId ||
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
      const effect = await workspaceDoRequest<
        | { decision: "lease"; effectToken: string; expiresAt: number; source: TrackedKnowledgeSource }
        | { decision: "stale" }
      >(env, job.teamId, "/beginKnowledgeIngestionEffect", {
        teamId: job.teamId,
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

        const outcome = await dispatch(job, env, {
          leaseToken: lease.leaseToken,
          source: effect.source,
          effectToken,
          validateSource,
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
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}
