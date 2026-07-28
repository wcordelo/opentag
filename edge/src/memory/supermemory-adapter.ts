import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_EXECUTION_BUDGETS,
  parseLocalDocumentStatus,
  slackKnowledgeMetadataAsFlat,
  slackSourceKey,
  workspaceTag,
  type KnowledgeCitation,
  type LocalDocumentStatus,
  type SlackKnowledgeMetadata,
} from "./knowledge-contract.js";
import type { SupermemoryClient } from "./supermemory-client.js";
import { createSupermemoryClient } from "./supermemory-client.js";
import {
  createSlackKnowledgePageReader,
  fetchKnowledgeThread,
  type KnowledgeThreadFetchOutcome,
} from "../slack/knowledge-thread-fetcher.js";
import { sharedSlackRateScheduler } from "../slack/web-api.js";
import { normalizeSlackThread } from "./normalize-slack-thread.js";
import type { KnowledgeDispatch, KnowledgeQueueEnv } from "./knowledge-jobs.js";
import { isLocalMutationContractVerified } from "./local-mutation-contract.js";

export const SUPERMEMORY_POLL = Object.freeze({
  deadlineMs: KNOWLEDGE_EXECUTION_BUDGETS.localPollWindowMs,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  maxPolls: 20,
});

export type LocalOperationErrorCode =
  | "knowledge_unavailable"
  | "local_rejected"
  | "local_malformed_response"
  | "local_document_failed";

export class SupermemoryAdapterError extends Error {
  constructor(
    readonly code: LocalOperationErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "SupermemoryAdapterError";
  }
}

export type PollResult =
  | { status: "done"; localDocumentId: string; polls: number }
  | { status: "failed"; localDocumentId: string; polls: number }
  | {
      status: "processing_unconfirmed";
      localDocumentId: string;
      workflowStatus: Exclude<LocalDocumentStatus, "done" | "failed">;
      polls: number;
      nextPollAt: number;
      pollDeadlineAt: number;
    };

export type SlackSearchScope = {
  teamId: string;
  projectId: string;
  channelId: string;
  aclPolicyRef: string;
};

type Clock = { now(): number; sleep(ms: number): Promise<void> };

function defaultClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function retryableError(error: unknown): SupermemoryAdapterError {
  if (error instanceof SupermemoryAdapterError) return error;
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
  return new SupermemoryAdapterError(retryable ? "knowledge_unavailable" : "local_rejected", retryable);
}

function requiredMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function citationFromResult(
  result: unknown,
  scope: SlackSearchScope,
  retrievedAt: string,
): KnowledgeCitation | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const raw = result as Record<string, unknown>;
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) return undefined;
  const metadata = raw.metadata as Record<string, unknown>;
  const workspaceId = requiredMetadataString(metadata, "workspaceId");
  const projectId = requiredMetadataString(metadata, "projectId");
  const channelId = requiredMetadataString(metadata, "channelId");
  const threadTs = requiredMetadataString(metadata, "threadTs");
  const sourceKey = requiredMetadataString(metadata, "sourceKey");
  const contentRevision = requiredMetadataString(metadata, "contentRevision");
  const aclPolicyRef = requiredMetadataString(metadata, "aclPolicyRef");
  if (
    workspaceId !== scope.teamId ||
    projectId !== scope.projectId ||
    channelId !== scope.channelId ||
    aclPolicyRef !== scope.aclPolicyRef ||
    metadata.status !== "active" ||
    !threadTs || !sourceKey || !contentRevision ||
    sourceKey !== slackSourceKey(scope.teamId, scope.channelId, threadTs)
  ) return undefined;
  const rawExcerpt = typeof raw.chunk === "string"
    ? raw.chunk
    : typeof raw.memory === "string"
      ? raw.memory
      : undefined;
  if (!rawExcerpt) return undefined;
  const excerpt = rawExcerpt.replace(/\s+/g, " ").trim().slice(0, KNOWLEDGE_LIMITS.maxCitationExcerptLength);
  if (!excerpt) return undefined;
  const score = typeof raw.similarity === "number" && Number.isFinite(raw.similarity)
    ? raw.similarity
    : undefined;
  let permalink: string | undefined;
  if (typeof metadata.slackPermalink === "string") {
    try {
      const url = new URL(metadata.slackPermalink);
      if (url.protocol === "https:" && /(^|\.)slack\.com$/i.test(url.hostname) && /^\/archives\//.test(url.pathname)) {
        permalink = url.toString();
      }
    } catch {
      // Omit malformed or non-Slack links.
    }
  }
  return {
    sourceKey,
    sourceType: "slack",
    projectId,
    channelId,
    threadTs,
    ...(permalink ? { permalink } : {}),
    contentRevision,
    excerpt,
    ...(score !== undefined ? { score } : {}),
    aclPolicyRef,
    retrievedAt,
  };
}

export class SupermemoryAdapter {
  private readonly clock: Clock;

  constructor(
    private readonly client: SupermemoryClient,
    clock: Partial<Clock> = {},
  ) {
    const defaults = defaultClock();
    this.clock = { now: clock.now ?? defaults.now, sleep: clock.sleep ?? defaults.sleep };
  }

  async addSlackDocument(input: {
    teamId: string;
    content: string;
    metadata: SlackKnowledgeMetadata;
  }): Promise<{ localDocumentId: string; status: LocalDocumentStatus }> {
    const metadata = slackKnowledgeMetadataAsFlat(input.metadata);
    if (input.metadata.workspaceId !== input.teamId) throw new Error("metadata workspace does not match team");
    try {
      const response = await this.client.add({
        content: input.content,
        containerTag: workspaceTag(input.teamId),
        customId: slackSourceKey(input.teamId, input.metadata.channelId, input.metadata.threadTs),
        metadata,
      });
      if (!response || typeof response.id !== "string" || !response.id) {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      let status: LocalDocumentStatus;
      try {
        status = parseLocalDocumentStatus(response.status);
      } catch {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      if (status !== "queued") throw new SupermemoryAdapterError("local_malformed_response", false);
      return { localDocumentId: response.id, status };
    } catch (error) {
      throw retryableError(error);
    }
  }

  async updateSlackDocument(input: {
    teamId: string;
    localDocumentId: string;
    content: string;
    metadata: SlackKnowledgeMetadata;
  }): Promise<{ localDocumentId: string; status: LocalDocumentStatus }> {
    const metadata = slackKnowledgeMetadataAsFlat(input.metadata);
    if (input.metadata.workspaceId !== input.teamId) throw new Error("metadata workspace does not match team");
    if (!input.localDocumentId) throw new SupermemoryAdapterError("local_rejected", false);
    const sourceKey = slackSourceKey(input.teamId, input.metadata.channelId, input.metadata.threadTs);
    try {
      const response = await this.client.documents.update(input.localDocumentId, {
        content: input.content,
        customId: sourceKey,
        containerTag: workspaceTag(input.teamId),
        metadata,
      });
      if (!response || typeof response.id !== "string" || !response.id) {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      let status: LocalDocumentStatus;
      try {
        status = parseLocalDocumentStatus(response.status);
      } catch {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      if (status !== "queued") throw new SupermemoryAdapterError("local_malformed_response", false);
      return { localDocumentId: response.id, status };
    } catch (error) {
      throw retryableError(error);
    }
  }

  async deleteSlackDocument(input: {
    localDocumentId: string;
    sourceKey: string;
  }): Promise<{ deleted: true }> {
    if (!input.localDocumentId || !input.sourceKey) {
      throw new SupermemoryAdapterError("local_rejected", false);
    }
    try {
      await this.client.documents.delete(input.localDocumentId);
      return { deleted: true };
    } catch (error) {
      throw retryableError(error);
    }
  }

  async pollDocument(input: {
    localDocumentId: string;
    sourceKey: string;
    pollDeadlineAt?: number;
  }): Promise<PollResult> {
    const pollDeadlineAt = input.pollDeadlineAt ?? this.clock.now() + SUPERMEMORY_POLL.deadlineMs;
    let delay: number = SUPERMEMORY_POLL.initialDelayMs;
    let polls = 0;
    let lastStatus: Exclude<LocalDocumentStatus, "done" | "failed"> = "unknown";
    while (polls < SUPERMEMORY_POLL.maxPolls && this.clock.now() <= pollDeadlineAt) {
      let response: Awaited<ReturnType<SupermemoryClient["documents"]["get"]>>;
      try {
        response = await this.client.documents.get(input.localDocumentId);
      } catch (error) {
        throw retryableError(error);
      }
      polls += 1;
      if (response.id !== input.localDocumentId || (response.customId && response.customId !== input.sourceKey)) {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      let status: LocalDocumentStatus;
      try {
        status = parseLocalDocumentStatus(response.status);
      } catch {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      if (status === "done") return { status, localDocumentId: input.localDocumentId, polls };
      if (status === "failed") return { status, localDocumentId: input.localDocumentId, polls };
      lastStatus = status;
      if (this.clock.now() + delay > pollDeadlineAt) break;
      await this.clock.sleep(delay);
      delay = Math.min(SUPERMEMORY_POLL.maxDelayMs, delay * 2);
    }
    return {
      status: "processing_unconfirmed",
      localDocumentId: input.localDocumentId,
      workflowStatus: lastStatus,
      polls,
      nextPollAt: this.clock.now() + SUPERMEMORY_POLL.maxDelayMs,
      pollDeadlineAt,
    };
  }

  async searchSlack(input: SlackSearchScope & { query: string; limit: number }): Promise<KnowledgeCitation[]> {
    const query = input.query.trim();
    if (!query || query.length > 1_000 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > KNOWLEDGE_LIMITS.maxSearchLimit) {
      throw new SupermemoryAdapterError("local_rejected", false);
    }
    const retrievedAt = new Date(this.clock.now()).toISOString();
    try {
      const response = await this.client.search.memories({
        q: query,
        containerTag: workspaceTag(input.teamId),
        searchMode: "hybrid",
        filters: { AND: [
          { key: "projectId", value: input.projectId },
          { key: "channelId", value: input.channelId },
          { key: "status", value: "active" },
        ] },
        limit: input.limit,
      });
      if (!response || !Array.isArray(response.results)) {
        throw new SupermemoryAdapterError("local_malformed_response", true);
      }
      return response.results
        .map((result) => citationFromResult(result, input, retrievedAt))
        .filter((citation): citation is KnowledgeCitation => citation !== undefined)
        .slice(0, input.limit);
    } catch (error) {
      throw retryableError(error);
    }
  }
}

async function knowledgeDoCall<T>(
  env: KnowledgeQueueEnv,
  teamId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(teamId));
  const response = await stub.fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`knowledge_do_${path.replace("/", "")}_${response.status}`);
  return response.json() as Promise<T>;
}

async function recordOutcome(
  env: KnowledgeQueueEnv,
  teamId: string,
  sourceKey: string,
  leaseToken: string,
  outcome: unknown,
): Promise<void> {
  const result = await knowledgeDoCall<{ recorded: boolean }>(env, teamId, "/outcome", {
    sourceKey, leaseToken, outcome,
  });
  if (!result.recorded) throw new Error("knowledge_outcome_not_recorded");
}

type IngestionAdapter = Pick<
  SupermemoryAdapter,
  "addSlackDocument" | "updateSlackDocument" | "deleteSlackDocument" | "pollDocument"
>;

export type KnowledgeDispatchDependencies = {
  createAdapter?: (env: KnowledgeQueueEnv) => IngestionAdapter;
  fetchThread?: (
    job: Parameters<KnowledgeDispatch>[0],
    env: KnowledgeQueueEnv,
  ) => Promise<KnowledgeThreadFetchOutcome>;
};

function slackDocumentMetadata(input: {
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  sourceKey: string;
  revision: string;
  rootAuthorId?: string;
  observedAt: string;
  indexedAt: string;
  aclPolicyRef: string;
}): SlackKnowledgeMetadata {
  return {
    schemaVersion: 1,
    workspaceId: input.teamId,
    projectId: input.projectId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    sourceKey: input.sourceKey,
    contentRevision: input.revision,
    ...(input.rootAuthorId ? { rootAuthorId: input.rootAuthorId } : {}),
    rootTs: input.threadTs,
    observedAt: input.observedAt,
    indexedAt: input.indexedAt,
    aclPolicyRef: input.aclPolicyRef,
    status: "active",
  };
}

/** Production Queue dispatch. This is never imported by an ordinary turn path. */
export function createKnowledgeSupermemoryDispatch(
  dependencies: KnowledgeDispatchDependencies = {},
): KnowledgeDispatch {
  return async (job, env, context) => {
  const now = () => Date.now();
  const mutationsVerified = isLocalMutationContractVerified(env);
  const recordFencedOutcome = async (outcome: unknown): Promise<void> => {
    await context.validateSource();
    await recordOutcome(env, job.teamId, job.sourceKey, context.leaseToken, outcome);
  };
  if (job.reason === "delete" || !context.source.enabled) {
    if (!mutationsVerified) {
      await recordFencedOutcome({
        status: "tombstoned",
        tombstonedAt: new Date(now()).toISOString(),
        errorCode: "unsupported_delete_contract",
      });
      return { status: "recorded_permanent" };
    }
    const state = await knowledgeDoCall<{
      ledger: { localDocumentId?: string } | null;
    }>(env, job.teamId, "/state", { sourceKey: job.sourceKey });
    const localDocumentId = state.ledger?.localDocumentId;
    if (localDocumentId) {
      if (!env.SUPERMEMORY_URL || !env.SUPERMEMORY_API_KEY) {
        await recordFencedOutcome({
          status: "retryable_failure",
          errorClass: "dependency_unavailable",
          errorCode: "knowledge_dependency_unconfigured",
        });
        return { status: "recorded_retry" };
      }
      let adapter: IngestionAdapter;
      try {
        adapter = dependencies.createAdapter
          ? dependencies.createAdapter(env)
          : new SupermemoryAdapter(createSupermemoryClient({
              baseURL: env.SUPERMEMORY_URL,
              apiKey: env.SUPERMEMORY_API_KEY,
            }));
      } catch {
        await recordFencedOutcome({
          status: "retryable_failure",
          errorClass: "dependency_unavailable",
          errorCode: "knowledge_local_unavailable",
        });
        return { status: "recorded_retry" };
      }
      try {
        await adapter.deleteSlackDocument({
          localDocumentId,
          sourceKey: job.sourceKey,
        });
      } catch (error) {
        const classified = error instanceof SupermemoryAdapterError
          ? error
          : new SupermemoryAdapterError("knowledge_unavailable", true);
        await recordFencedOutcome({
          status: classified.retryable ? "retryable_failure" : "permanent_failure",
          errorClass: "local_delete",
          errorCode: classified.code,
        });
        return { status: classified.retryable ? "recorded_retry" : "recorded_permanent" };
      }
    }
    await recordFencedOutcome({
      status: "tombstoned",
      tombstonedAt: new Date(now()).toISOString(),
      errorCode: "deleted",
    });
    return { status: "recorded_permanent" };
  }
  if (!env.SLACK_BOT_TOKEN || !env.SUPERMEMORY_URL || !env.SUPERMEMORY_API_KEY) {
    await recordFencedOutcome({
      status: "retryable_failure",
      errorClass: "dependency_unavailable",
      errorCode: "knowledge_dependency_unconfigured",
    });
    return { status: "recorded_retry" };
  }
  let adapter: IngestionAdapter;
  try {
    adapter = dependencies.createAdapter
      ? dependencies.createAdapter(env)
      : new SupermemoryAdapter(createSupermemoryClient({
          baseURL: env.SUPERMEMORY_URL,
          apiKey: env.SUPERMEMORY_API_KEY,
        }));
  } catch {
    await recordFencedOutcome({
      status: "retryable_failure", errorClass: "dependency_unavailable", errorCode: "knowledge_local_unavailable",
    });
    return { status: "recorded_retry" };
  }
  const fetched = dependencies.fetchThread
    ? await dependencies.fetchThread(job, env)
    : await fetchKnowledgeThread({
        channel: job.channelId,
        threadTs: job.threadTs,
        readPage: createSlackKnowledgePageReader({
          botToken: env.SLACK_BOT_TOKEN,
          scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
        }),
      });
  if (fetched.status === "incomplete") {
    await recordFencedOutcome({
      status: "retryable_failure",
      errorClass: "slack_thread_incomplete",
      errorCode: fetched.reason,
      incompleteReason: fetched.reason,
    });
    return { status: "recorded_retry" };
  }
  const normalized = await normalizeSlackThread(fetched, {
    teamId: job.teamId,
    projectId: job.projectId,
    channelId: job.channelId,
    threadTs: job.threadTs,
    aclPolicyRef: context.source.readerPolicyRef,
  });
  if (normalized.status !== "complete") throw new Error("complete thread normalized as incomplete");
  await context.validateSource();
  const prepared = await knowledgeDoCall<
    | { decision: "add" }
    | { decision: "update"; localDocumentId: string }
    | { decision: "poll"; localDocumentId: string }
    | { decision: "noop" }
    | { decision: "blocked"; reason: string }
  >(env, job.teamId, "/prepareRevision", {
    sourceKey: job.sourceKey,
    leaseToken: context.leaseToken,
    desiredRevision: normalized.revision,
    mutationsVerified,
  });
  if (prepared.decision === "blocked") {
    await recordFencedOutcome({
      status: "permanent_failure",
      errorClass: "unsupported_capability",
      errorCode: prepared.reason === "tombstoned"
        ? "unsupported_delete_contract"
        : prepared.reason === "ambiguous_add_contract"
          ? "ambiguous_add_contract"
          : "unsupported_update_contract",
    });
    return { status: "recorded_permanent" };
  }
  if (prepared.decision === "noop") return { status: "recorded_success" };

  let localDocumentId: string;
  if (prepared.decision === "poll") {
    localDocumentId = prepared.localDocumentId;
  } else {
    // The durable configuration effect prevents a disable/policy update from
    // committing between this check and the Local effect.
    await context.validateSource();
    const metadata = slackDocumentMetadata({
      teamId: job.teamId,
      projectId: job.projectId,
      channelId: job.channelId,
      threadTs: job.threadTs,
      sourceKey: job.sourceKey,
      revision: normalized.revision,
      rootAuthorId: normalized.canonical.messages[0]?.authorId,
      observedAt: job.requestedAt,
      indexedAt: new Date(now()).toISOString(),
      aclPolicyRef: context.source.readerPolicyRef,
    });
    let accepted: { localDocumentId: string; status: LocalDocumentStatus };
    try {
      if (prepared.decision === "update") {
        accepted = await adapter.updateSlackDocument({
          teamId: job.teamId,
          localDocumentId: prepared.localDocumentId,
          content: normalized.content,
          metadata,
        });
      } else {
        accepted = await adapter.addSlackDocument({
          teamId: job.teamId,
          content: normalized.content,
          metadata,
        });
      }
    } catch (error) {
      const classified = error instanceof SupermemoryAdapterError ? error : new SupermemoryAdapterError("knowledge_unavailable", true);
      await recordFencedOutcome({
        status: classified.retryable ? "retryable_failure" : "permanent_failure",
        errorClass: prepared.decision === "update" ? "local_update" : "local_add",
        errorCode: classified.code,
      });
      return { status: classified.retryable ? "recorded_retry" : "recorded_permanent" };
    }
    localDocumentId = accepted.localDocumentId;
    // Fail closed if the bounded config fence expired while Local accepted.
    // The durable add_started / update_started marker then prevents a duplicate external write.
    await context.validateSource();
    const pollDeadlineAt = now() + SUPERMEMORY_POLL.deadlineMs;
    const persisted = await knowledgeDoCall<{ recorded: boolean }>(env, job.teamId, "/localAccepted", {
      sourceKey: job.sourceKey,
      leaseToken: context.leaseToken,
      localDocumentId,
      desiredRevision: normalized.revision,
      workflowStatus: accepted.status,
      pollDeadlineAt,
      nextPollAt: now(),
    });
    if (!persisted.recorded) throw new Error("durable_local_document_id_not_recorded");
  }

  await context.validateSource();
  let polled: PollResult;
  try {
    polled = await adapter.pollDocument({ localDocumentId, sourceKey: job.sourceKey });
  } catch (error) {
    const classified = error instanceof SupermemoryAdapterError ? error : new SupermemoryAdapterError("knowledge_unavailable", true);
    await recordFencedOutcome({
      status: classified.retryable ? "retryable_failure" : "permanent_failure",
      errorClass: "local_poll",
      errorCode: classified.code,
    });
    return { status: classified.retryable ? "recorded_retry" : "recorded_permanent" };
  }
  if (polled.status === "done") {
    await recordFencedOutcome({
      status: "indexed",
      desiredRevision: normalized.revision,
      indexedRevision: normalized.revision,
      localDocumentId,
      workflowStatus: "done",
      pollCount: polled.polls,
    });
    return { status: "recorded_success" };
  }
  if (polled.status === "processing_unconfirmed") {
    await recordFencedOutcome({
      status: "processing_unconfirmed",
      desiredRevision: normalized.revision,
      localDocumentId,
      workflowStatus: polled.workflowStatus,
      pollDeadlineAt: polled.pollDeadlineAt,
      nextPollAt: polled.nextPollAt,
      pollCount: polled.polls,
    });
    return { status: "recorded_retry" };
  }
  await recordFencedOutcome({
    status: "permanent_failure", errorClass: "local_poll", errorCode: "local_document_failed",
  });
  return { status: "recorded_permanent" };
  };
}

export const dispatchKnowledgeToSupermemory =
  createKnowledgeSupermemoryDispatch();
