import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_EXECUTION_BUDGETS,
  knowledgeQueryDigest,
  parseLocalDocumentStatus,
  slackKnowledgeMetadataAsFlat,
  slackSourceKey,
  workspaceTag,
  type KnowledgeCitation,
  type LocalDocumentStatus,
  type SlackKnowledgeMetadata,
} from "./knowledge-contract.js";
import type { SupermemoryClient } from "./supermemory-client.js";
import { createSupermemoryClientFromEnv } from "./supermemory-client.js";
import {
  createSlackKnowledgePageReader,
  fetchKnowledgeThread,
  type KnowledgeThreadFetchCheckpoint,
  type KnowledgeThreadFetchOutcome,
} from "../slack/knowledge-thread-fetcher.js";
import { sharedSlackRateScheduler } from "../slack/web-api.js";
import { normalizeSlackThread } from "./normalize-slack-thread.js";
import { enrichSlackThreadForIndex } from "./connectors/slack-enrichment.js";
import type { KnowledgeDispatch, KnowledgeQueueEnv } from "./knowledge-jobs.js";
import { isLocalMutationContractVerified } from "./local-mutation-contract.js";
import { normalizeDerivedIndexGeneration } from "./derived-index-generation.js";
import { tenantStub } from "../tenancy.js";

export const SUPERMEMORY_POLL = Object.freeze({
  deadlineMs: KNOWLEDGE_EXECUTION_BUDGETS.localPollWindowMs,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  maxPolls: 20,
});

const SLACK_TERMINAL_SKIP_ERROR_CLASS = "slack_terminal_skip";

export type LocalOperationErrorCode =
  | "knowledge_unavailable"
  | "local_rejected"
  | "local_malformed_response"
  | "local_document_failed"
  | "local_ambiguous_identity";

export class SupermemoryAdapterError extends Error {
  readonly persistedCode: string;

  constructor(
    readonly code: LocalOperationErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(code);
    this.name = "SupermemoryAdapterError";
    this.persistedCode = status === undefined
      ? code
      : `${retryable ? "knowledge" : "local"}_http_${status}`;
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

export type AmbiguousDocumentResolution =
  | { status: "found"; localDocumentId: string; workflowStatus: LocalDocumentStatus }
  | { status: "not_found" };

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

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const candidate of [value.status, value.statusCode, value.response?.status]) {
    const status = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

function retryableError(error: unknown): SupermemoryAdapterError {
  if (error instanceof SupermemoryAdapterError) return error;
  const status = errorStatus(error);
  const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  return new SupermemoryAdapterError(retryable ? "knowledge_unavailable" : "local_rejected", retryable, status);
}

function isAcceptedMutationStatus(status: LocalDocumentStatus): status is "queued" | "done" {
  return status === "queued" || status === "done";
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
      if (!isAcceptedMutationStatus(status)) throw new SupermemoryAdapterError("local_malformed_response", false);
      return { localDocumentId: response.id, status };
    } catch (error) {
      throw retryableError(error);
    }
  }

  async findSlackDocument(input: {
    teamId: string;
    sourceKey: string;
  }): Promise<AmbiguousDocumentResolution> {
    try {
      const response = await this.client.documents.list({
        containerTags: [workspaceTag(input.teamId)],
        filters: { AND: [
          { key: "workspaceId", value: input.teamId },
          { key: "sourceKey", value: input.sourceKey },
        ] },
        includeContent: false,
        limit: 10,
        page: 1,
        order: "desc",
        sort: "updatedAt",
      });
      if (!response || !Array.isArray(response.memories)) {
        throw new SupermemoryAdapterError("local_malformed_response", true);
      }
      const candidates = response.memories.filter((memory) => {
        if (!memory || typeof memory !== "object") return false;
        const item = memory as {
          id?: unknown;
          customId?: unknown;
        };
        return typeof item.id === "string" && Boolean(item.id) && item.customId === input.sourceKey;
      });
      for (const candidate of candidates) {
        const item = candidate as { metadata?: unknown };
        if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata) ||
          (item.metadata as Record<string, unknown>).sourceKey !== input.sourceKey) {
          throw new SupermemoryAdapterError("local_ambiguous_identity", false);
        }
      }
      const matches = candidates;
      if (matches.length > 1) {
        throw new SupermemoryAdapterError("local_ambiguous_identity", false);
      }
      const match = matches[0] as {
        id: string;
        status?: unknown;
      } | undefined;
      if (!match) return { status: "not_found" };
      let workflowStatus: LocalDocumentStatus;
      try {
        workflowStatus = parseLocalDocumentStatus(match.status);
      } catch {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      return { status: "found", localDocumentId: match.id, workflowStatus };
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
      const responseRecord = response && typeof response === "object"
        ? response as Record<string, unknown>
        : undefined;
      console.log(JSON.stringify({
        event: "knowledge_local_update_response",
        idPresent: typeof responseRecord?.id === "string" && responseRecord.id.length > 0,
        status: typeof responseRecord?.status === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(responseRecord.status)
          ? responseRecord.status
          : undefined,
        keys: responseRecord ? Object.keys(responseRecord).sort().slice(0, 16) : [],
      }));
      if (!response || typeof response.id !== "string" || !response.id) {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      let status: LocalDocumentStatus;
      try {
        status = parseLocalDocumentStatus(response.status);
      } catch {
        throw new SupermemoryAdapterError("local_malformed_response", false);
      }
      if (!isAcceptedMutationStatus(status)) throw new SupermemoryAdapterError("local_malformed_response", false);
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
    const now = this.clock.now();
    const pollDeadlineAt = input.pollDeadlineAt !== undefined && input.pollDeadlineAt > now
      ? input.pollDeadlineAt
      : now + SUPERMEMORY_POLL.deadlineMs;
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

  async searchSlackForConvergence(
    input: SlackSearchScope & { query: string; limit: number },
  ): Promise<{ citations: KnowledgeCitation[]; providerResultCount: number; queryDigest: string }> {
    const query = input.query.trim();
    if (!query || query.length > 1_000 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > KNOWLEDGE_LIMITS.maxSearchLimit) {
      throw new SupermemoryAdapterError("local_rejected", false);
    }
    let queryDigest: string;
    try {
      queryDigest = await knowledgeQueryDigest(query);
    } catch {
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
      const citations = response.results
        .map((result) => citationFromResult(result, input, retrievedAt))
        .filter((citation): citation is KnowledgeCitation => citation !== undefined)
        .slice(0, input.limit);
      return { citations, providerResultCount: response.results.length, queryDigest };
    } catch (error) {
      throw retryableError(error);
    }
  }

  async searchSlack(input: SlackSearchScope & { query: string; limit: number }): Promise<KnowledgeCitation[]> {
    return (await this.searchSlackForConvergence(input)).citations;
  }
}

async function knowledgeDoCall<T>(
  env: KnowledgeQueueEnv,
  teamId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = tenantStub(env.KNOWLEDGE, teamId);
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
> & Partial<Pick<SupermemoryAdapter, "findSlackDocument">>;

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
  reactionCount?: number;
  distillStatus?: "ok" | "skipped";
  burstCount?: number;
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
    ...(input.reactionCount ? { reactionCount: input.reactionCount } : {}),
    ...(input.distillStatus ? { distillStatus: input.distillStatus } : {}),
    ...(input.burstCount !== undefined ? { burstCount: input.burstCount } : {}),
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
  let phase = "start";
  try {
  const mutationsVerified = isLocalMutationContractVerified(env);
  let indexGeneration: string | undefined;
  try {
    indexGeneration = normalizeDerivedIndexGeneration(env.SUPERMEMORY_INDEX_GENERATION);
  } catch {
    indexGeneration = undefined;
  }
  const recordFencedOutcome = async (outcome: unknown): Promise<void> => {
    if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
      const value = outcome as Record<string, unknown>;
      console.log(JSON.stringify({
        event: "knowledge_dispatch_outcome",
        teamId: job.teamId,
        sourceType: job.sourceType,
        reason: job.reason,
        ...(typeof value.status === "string" ? { status: value.status } : {}),
        ...(typeof value.errorClass === "string" ? { errorClass: value.errorClass } : {}),
        ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
        ...(typeof value.incompleteReason === "string" ? { incompleteReason: value.incompleteReason } : {}),
      }));
    }
    await context.validateSource();
    await recordOutcome(env, job.teamId, job.sourceKey, context.leaseToken, outcome);
  };
  if (env.SUPERMEMORY && !indexGeneration) {
    await recordFencedOutcome({
      status: "retryable_failure",
      errorClass: "dependency_unavailable",
      errorCode: "knowledge_index_generation_unconfigured",
    });
    return { status: "recorded_retry" };
  }
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
      ledger: { localDocumentId?: string; derivedIndexGeneration?: string } | null;
    }>(env, job.teamId, "/state", { sourceKey: job.sourceKey });
    const localDocumentId = state.ledger?.localDocumentId;
    const localDocumentIsInTargetIndex = !indexGeneration ||
      state.ledger?.derivedIndexGeneration === indexGeneration;
    if (localDocumentId && localDocumentIsInTargetIndex) {
      const client = dependencies.createAdapter
        ? undefined
        : createSupermemoryClientFromEnv(env);
      if (!dependencies.createAdapter && !client) {
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
          : new SupermemoryAdapter(client!);
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
          errorCode: classified.persistedCode,
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
  const client = dependencies.createAdapter
    ? undefined
    : createSupermemoryClientFromEnv(env);
  if (!env.SLACK_BOT_TOKEN || (!dependencies.createAdapter && !client)) {
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
      : new SupermemoryAdapter(client!);
  } catch {
    await recordFencedOutcome({
      status: "retryable_failure", errorClass: "dependency_unavailable", errorCode: "knowledge_local_unavailable",
    });
    return { status: "recorded_retry" };
  }
  phase = "slack_thread_fetch";
  let fetched: KnowledgeThreadFetchOutcome;
  if (dependencies.fetchThread) {
    fetched = await dependencies.fetchThread(job, env);
  } else {
    const storedCheckpoint = await knowledgeDoCall<{
      checkpoint: KnowledgeThreadFetchCheckpoint | null;
    }>(env, job.teamId, "/thread-fetch/progress/get", { job });
    fetched = await fetchKnowledgeThread({
      channel: job.channelId,
      threadTs: job.threadTs,
      readPage: createSlackKnowledgePageReader({
        botToken: env.SLACK_BOT_TOKEN,
        scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
      }),
      ...(storedCheckpoint.checkpoint ? { initial: storedCheckpoint.checkpoint } : {}),
      onCheckpoint: async (checkpoint) => {
        await knowledgeDoCall(env, job.teamId, "/thread-fetch/progress/save", {
          job,
          checkpoint,
        });
      },
    });
    if (fetched.status === "complete") {
      await knowledgeDoCall(env, job.teamId, "/thread-fetch/progress/clear", { job });
    }
  }
  if (fetched.status === "skipped") {
    await recordFencedOutcome({
      status: "permanent_failure",
      errorClass: SLACK_TERMINAL_SKIP_ERROR_CLASS,
      errorCode: fetched.reason,
    });
    return { status: "recorded_permanent" };
  }
  if (fetched.status === "incomplete") {
    const sizeBound = fetched.reason === "message_cap" || fetched.reason === "byte_cap";
    await recordFencedOutcome({
      status: sizeBound ? "permanent_failure" : "retryable_failure",
      errorClass: sizeBound ? "slack_thread_size_bound" : "slack_thread_incomplete",
      errorCode: fetched.reason,
      incompleteReason: fetched.reason,
    });
    return { status: sizeBound ? "recorded_permanent" : "recorded_retry" };
  }
  const normalized = await normalizeSlackThread(fetched, {
    teamId: job.teamId,
    projectId: job.projectId,
    channelId: job.channelId,
    threadTs: job.threadTs,
    aclPolicyRef: context.source.readerPolicyRef,
  });
  if (normalized.status !== "complete") throw new Error("complete thread normalized as incomplete");
  if (job.observedMessageTs && !normalized.canonical.messages.some(
    (message) => message.ts === job.observedMessageTs,
  )) {
    await recordFencedOutcome({
      status: "retryable_failure",
      errorClass: "slack_thread_incomplete",
      errorCode: "observed_message_missing",
      incompleteReason: "observed_message_missing",
    });
    return { status: "recorded_retry" };
  }
  await knowledgeDoCall(env, job.teamId, "/message-thread/put", {
    teamId: job.teamId,
    projectId: job.projectId,
    channelId: job.channelId,
    threadTs: job.threadTs,
    sourceKey: job.sourceKey,
    messageTs: normalized.canonical.messages
      .map((message) => message.ts)
      .filter((messageTs) => /^\d+\.\d+$/.test(messageTs)),
  });
  const enrichment = await enrichSlackThreadForIndex({
    transcript: normalized.content,
    messages: normalized.canonical.messages
      .filter((message) => message.kind === "message" && message.text.length > 0)
      .map((message) => ({
        authorId: message.authorId,
        text: message.text,
        ...(message.reactions !== undefined ? { reactions: message.reactions } : {}),
      })),
    threadTopic: normalized.canonical.messages[0]?.text ?? "",
  });
  const indexedContent = enrichment.threadEmbedText;
  await context.validateSource();
  phase = "prepare_revision";
  let prepared = await knowledgeDoCall<
    | { decision: "add" }
    | { decision: "update"; localDocumentId: string }
    | { decision: "poll"; localDocumentId: string; pollDeadlineAt?: number }
    | { decision: "noop" }
    | { decision: "blocked"; reason: string }
  >(env, job.teamId, "/prepareRevision", {
    sourceKey: job.sourceKey,
    leaseToken: context.leaseToken,
    desiredRevision: normalized.revision,
    mutationsVerified,
    ...(indexGeneration ? { indexGeneration } : {}),
  });
  if (prepared.decision === "blocked") {
    if (prepared.reason === "index_generation_mismatch") {
      await recordFencedOutcome({
        status: "retryable_failure",
        errorClass: "dependency_configuration",
        errorCode: "knowledge_index_generation_mismatch",
      });
      return { status: "recorded_retry" };
    }
    if (prepared.reason === "unsupported_update_contract") {
      await recordFencedOutcome({
        status: "preserve_indexed",
        errorClass: "unsupported_capability",
        errorCode: "unsupported_update_contract",
      });
      return { status: "recorded_permanent" };
    }
    if (prepared.reason === "ambiguous_add_contract") {
      if (!adapter.findSlackDocument) {
        await recordFencedOutcome({
          status: "permanent_failure",
          errorClass: "local_add",
          errorCode: "ambiguous_add_contract",
        });
        return { status: "recorded_permanent" };
      }
      phase = "ambiguous_identity_probe";
      let resolution: AmbiguousDocumentResolution;
      try {
        resolution = await adapter.findSlackDocument({
          teamId: job.teamId,
          sourceKey: job.sourceKey,
        });
      } catch (error) {
        const classified = error instanceof SupermemoryAdapterError
          ? error
          : new SupermemoryAdapterError("knowledge_unavailable", true);
        await recordFencedOutcome({
          status: classified.retryable ? "retryable_failure" : "permanent_failure",
          errorClass: "local_add",
          errorCode: classified.persistedCode,
          ...(classified.retryable ? { incompleteReason: "ambiguous_add_contract" } : {}),
        });
        return { status: classified.retryable ? "recorded_retry" : "recorded_permanent" };
      }
      if (resolution.status === "found") {
        phase = "resolve_ambiguous_add";
        const resolved = await knowledgeDoCall<{
          decision: "poll";
          localDocumentId: string;
          pollDeadlineAt: number;
        }>(env, job.teamId, "/resolveAmbiguousAdd", {
          sourceKey: job.sourceKey,
          leaseToken: context.leaseToken,
          desiredRevision: normalized.revision,
          resolution: "found",
          localDocumentId: resolution.localDocumentId,
          workflowStatus: resolution.workflowStatus,
          pollDeadlineAt: now() + SUPERMEMORY_POLL.deadlineMs,
          nextPollAt: now(),
        });
        prepared = resolved;
      } else {
        phase = "resolve_ambiguous_add";
        const resolved = await knowledgeDoCall<{ decision: "add" }>(env, job.teamId, "/resolveAmbiguousAdd", {
          sourceKey: job.sourceKey,
          leaseToken: context.leaseToken,
          desiredRevision: normalized.revision,
          resolution: "not_found",
        });
        prepared = resolved;
      }
    } else {
      await recordFencedOutcome({
        status: "permanent_failure",
        errorClass: "unsupported_capability",
        errorCode: "unsupported_delete_contract",
      });
      return { status: "recorded_permanent" };
    }
  }
  if (prepared.decision === "noop") return { status: "recorded_success" };

  let localDocumentId: string;
  let resumePollDeadlineAt: number | undefined;
  if (prepared.decision === "poll") {
    localDocumentId = prepared.localDocumentId;
    resumePollDeadlineAt = typeof prepared.pollDeadlineAt === "number" &&
      Number.isFinite(prepared.pollDeadlineAt)
      ? prepared.pollDeadlineAt
      : undefined;
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
      reactionCount: enrichment.reactionCount,
      distillStatus: enrichment.distillStatus,
      burstCount: enrichment.burstDocuments.length,
    });
    phase = prepared.decision === "update" ? "provider_update" : "provider_add";
    let accepted: { localDocumentId: string; status: LocalDocumentStatus };
    try {
      if (prepared.decision === "update") {
        accepted = await adapter.updateSlackDocument({
          teamId: job.teamId,
          localDocumentId: prepared.localDocumentId,
          content: indexedContent,
          metadata,
        });
      } else {
        accepted = await adapter.addSlackDocument({
          teamId: job.teamId,
          content: indexedContent,
          metadata,
        });
      }
    } catch (error) {
      const classified = error instanceof SupermemoryAdapterError ? error : new SupermemoryAdapterError("knowledge_unavailable", true);
      await recordFencedOutcome({
        status: classified.retryable ? "retryable_failure" : "permanent_failure",
        errorClass: prepared.decision === "update" ? "local_update" : "local_add",
          errorCode: classified.persistedCode,
      });
      return { status: classified.retryable ? "recorded_retry" : "recorded_permanent" };
    }
    localDocumentId = accepted.localDocumentId;
    // Fail closed if the bounded config fence expired while Local accepted.
    // The durable add_started / update_started marker then prevents a duplicate external write.
    await context.validateSource();
    const pollDeadlineAt = now() + SUPERMEMORY_POLL.deadlineMs;
    phase = "record_local_acceptance";
    const persisted = await knowledgeDoCall<{ recorded: boolean }>(env, job.teamId, "/localAccepted", {
      sourceKey: job.sourceKey,
      leaseToken: context.leaseToken,
      localDocumentId,
      desiredRevision: normalized.revision,
      workflowStatus: accepted.status,
      pollDeadlineAt,
      nextPollAt: now(),
      ...(indexGeneration ? { indexGeneration } : {}),
    });
    if (!persisted.recorded) throw new Error("durable_local_document_id_not_recorded");
  }

  await context.validateSource();
  phase = "provider_poll";
  let polled: PollResult;
  try {
    polled = await adapter.pollDocument({
      localDocumentId,
      sourceKey: job.sourceKey,
      ...(resumePollDeadlineAt !== undefined ? { pollDeadlineAt: resumePollDeadlineAt } : {}),
    });
  } catch (error) {
    const classified = error instanceof SupermemoryAdapterError ? error : new SupermemoryAdapterError("knowledge_unavailable", true);
    await recordFencedOutcome({
      status: classified.retryable ? "retryable_failure" : "permanent_failure",
      errorClass: "local_poll",
      errorCode: classified.persistedCode,
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
      ...(indexGeneration ? { indexGeneration } : {}),
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
      ...(indexGeneration ? { indexGeneration } : {}),
    });
    return { status: "recorded_retry" };
  }
  await recordFencedOutcome({
    status: "permanent_failure", errorClass: "local_poll", errorCode: "local_document_failed",
  });
  return { status: "recorded_permanent" };
  } catch (error) {
    console.log(JSON.stringify({
      event: "knowledge_dispatch_failure",
      teamId: job.teamId,
      sourceType: job.sourceType,
      reason: job.reason,
      phase,
      ...(error instanceof SupermemoryAdapterError ? { errorCode: error.persistedCode } : {}),
    }));
    throw error;
  }
  };
}

export const dispatchKnowledgeToSupermemory =
  createKnowledgeSupermemoryDispatch();
