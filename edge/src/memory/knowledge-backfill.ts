import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { WorkspaceConfigDO } from "../config/workspace-config-do.js";
import {
  isTrackedKnowledgeSourceEnabled,
  type TrackedKnowledgeSource,
} from "../config/knowledge-config.js";
import {
  createKnowledgeJob,
  type KnowledgeJob,
} from "./knowledge-contract.js";
import type { KnowledgeDO } from "./knowledge-do.js";
import type { EnqueueKnowledgeResult } from "./knowledge-ledger.js";
import {
  proveKnowledgeDescriptorDisposition,
  type KnowledgeDescriptorDisposition,
} from "./knowledge-reconcile.js";
import {
  verifyKnowledgeBackfillApproval,
  type KnowledgeBackfillApprovalVerifierConfig,
  type VerifiedKnowledgeBackfillApproval,
} from "./knowledge-backfill-authorization.js";
import { tenantStub } from "../tenancy.js";

export const KNOWLEDGE_BACKFILL_LIMITS = Object.freeze({
  maxChannels: 50,
  maxItems: 1_000,
  maxRangeDays: 90,
  maxDiscoveryPagesPerInvocation: 20,
  slackPageSize: 100,
  requestTimeoutMs: 10_000,
  maxRatePerMinute: 1_000,
  maxErrors: 1_000,
  maxReleaseIds: 10,
});

export type KnowledgeBackfillRequest = {
  teamId: string;
  projectId: string;
  channelIds: string[];
  from: string;
  to: string;
  limit: number;
  dryRun: boolean;
  /** Authoritative exact-source versions, reloaded before discovery. */
  sourceConfigVersions: Record<string, number>;
  manifestId?: string;
  maximumRatePerMinute?: number;
  maximumErrors?: number;
  releaseIds?: string[];
  rollbackOwner?: string;
};

export type KnowledgeBackfillCandidate = {
  channelId: string;
  threadTs: string;
  observedAt: string;
};

export type KnowledgeBackfillDiscoveryChannelStatus =
  | "unvisited"
  | "pending"
  | "exhausted";

export type KnowledgeBackfillDiscoveryStatus =
  | "discovering"
  | "complete"
  | "complete_over_budget"
  | "blocked_config_drift";

export type KnowledgeBackfillDiscoveryChannel = {
  channelId: string;
  configVersion: number;
  status: KnowledgeBackfillDiscoveryChannelStatus;
  cursor?: string;
  pageCount: number;
};

export type KnowledgeBackfillScope = {
  schemaVersion: 2;
  manifestId: string;
  teamId: string;
  projectId: string;
  channelIds: string[];
  sources: Array<{ channelId: string; configVersion: number }>;
  from: string;
  to: string;
  executionBudget: {
    maximumCount: number;
    maximumRatePerMinute: number;
    maximumErrors: number;
  };
  releaseIds: string[];
  rollbackOwner: string;
};

export type KnowledgeBackfillManifest = KnowledgeBackfillScope & {
  mode: "dry_run";
  count: number;
  sourceKeys: string[];
  jobs: KnowledgeJob[];
  discovery: {
    status: "complete";
    pages: number;
    channels: Array<{
      channelId: string;
      status: "exhausted";
      pageCount: number;
    }>;
  };
};

export type DurableKnowledgeBackfillDiscovery = {
  manifestId: string;
  scopeDigest: string;
  scope: KnowledgeBackfillScope;
  status: KnowledgeBackfillDiscoveryStatus;
  pages: number;
  candidateCount: number;
  channels: KnowledgeBackfillDiscoveryChannel[];
  candidates?: KnowledgeBackfillCandidate[];
  createdAt: string;
  updatedAt: string;
  blockedReason?: string;
};

export type KnowledgeBackfillPageDisposition =
  KnowledgeDescriptorDisposition;

type SlackHistoryMessage = {
  ts?: unknown;
  thread_ts?: unknown;
  subtype?: unknown;
};

type SlackHistoryPage = {
  ok?: unknown;
  error?: unknown;
  messages?: unknown;
  has_more?: unknown;
  response_metadata?: { next_cursor?: unknown };
};

type KnowledgeBackfillEnv = {
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
  SLACK_BOT_TOKEN?: string;
};

type StoredKnowledgeBackfillManifest = {
  manifestDigest: string;
  manifest: KnowledgeBackfillManifest;
  status: "dry_run" | "approved" | "running" | "complete";
  approvalGate?: string;
  approvalReference?: string;
  approvedBy?: string;
  approvedAt?: string;
  nextJobIndex: number;
  pendingPageToken?: string;
  pendingJobs?: KnowledgeJob[];
  pendingResults?: Record<string, KnowledgeBackfillPageDisposition>;
  pendingError?: {
    descriptorKey: string;
    errorCode: string;
    recordedAt: string;
  };
  executionErrorCount?: number;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function knowledgeBackfillManifestDigest(
  manifest: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function exactText(value: string, label: string, maximum = 256): void {
  if (
    !value ||
    value.length > maximum ||
    /[*?\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be one bounded exact value`);
  }
}

function validate(request: KnowledgeBackfillRequest): void {
  exactText(request.teamId, "teamId");
  exactText(request.projectId, "projectId");
  if (!request.dryRun) {
    throw new Error("backfill requires a dry-run manifest first");
  }
  const channels = [...new Set(request.channelIds)];
  if (
    channels.length === 0 ||
    channels.length > KNOWLEDGE_BACKFILL_LIMITS.maxChannels
  ) {
    throw new Error("a non-empty bounded explicit channel list is required");
  }
  for (const channelId of channels) exactText(channelId, "channel ID");
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > KNOWLEDGE_BACKFILL_LIMITS.maxItems
  ) {
    throw new Error("backfill maximum count is invalid");
  }
  const maximumRatePerMinute = request.maximumRatePerMinute ?? request.limit;
  if (
    !Number.isSafeInteger(maximumRatePerMinute) ||
    maximumRatePerMinute < 1 ||
    maximumRatePerMinute > KNOWLEDGE_BACKFILL_LIMITS.maxRatePerMinute
  ) {
    throw new Error("backfill maximum rate is invalid");
  }
  const maximumErrors = request.maximumErrors ?? 0;
  if (
    !Number.isSafeInteger(maximumErrors) ||
    maximumErrors < 0 ||
    maximumErrors > KNOWLEDGE_BACKFILL_LIMITS.maxErrors
  ) {
    throw new Error("backfill maximum error budget is invalid");
  }
  const configChannels = Object.keys(request.sourceConfigVersions).sort();
  const expectedChannels = [...channels].sort();
  if (
    configChannels.length !== expectedChannels.length ||
    configChannels.some((channel, index) =>
      channel !== expectedChannels[index])
  ) {
    throw new Error(
      "backfill requires one authoritative config version per exact channel",
    );
  }
  for (const channelId of expectedChannels) {
    const version = request.sourceConfigVersions[channelId];
    if (!Number.isSafeInteger(version) || (version ?? 0) < 1) {
      throw new Error(`configVersion is invalid for channel ${channelId}`);
    }
  }
  const from = Date.parse(request.from);
  const to = Date.parse(request.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    new Date(from).toISOString() !== request.from ||
    new Date(to).toISOString() !== request.to ||
    from > to
  ) {
    throw new Error("backfill time range is invalid");
  }
  if (
    to - from >
      KNOWLEDGE_BACKFILL_LIMITS.maxRangeDays * 86_400_000
  ) {
    throw new Error("backfill time range is too large");
  }
  if (request.manifestId !== undefined) {
    exactText(request.manifestId, "manifestId", 128);
  }
  if (request.releaseIds !== undefined) {
    if (
      request.releaseIds.length === 0 ||
      request.releaseIds.length > KNOWLEDGE_BACKFILL_LIMITS.maxReleaseIds ||
      new Set(request.releaseIds).size !== request.releaseIds.length
    ) {
      throw new Error("backfill release IDs are invalid");
    }
    for (const releaseId of request.releaseIds) {
      exactText(releaseId, "release ID");
    }
  }
  if (request.rollbackOwner !== undefined) {
    exactText(request.rollbackOwner, "rollback owner");
  }
}

function slackTimestampToIso(value: string): string | undefined {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1_000).toISOString();
}

function buildScope(request: KnowledgeBackfillRequest): KnowledgeBackfillScope {
  validate(request);
  const channelIds = [...new Set(request.channelIds)].sort();
  return {
    schemaVersion: 2,
    manifestId: request.manifestId ?? "unit-dry-run",
    teamId: request.teamId,
    projectId: request.projectId,
    channelIds,
    sources: channelIds.map((channelId) => ({
      channelId,
      configVersion: request.sourceConfigVersions[channelId]!,
    })),
    from: request.from,
    to: request.to,
    executionBudget: {
      maximumCount: request.limit,
      maximumRatePerMinute: request.maximumRatePerMinute ?? request.limit,
      maximumErrors: request.maximumErrors ?? 0,
    },
    releaseIds: [...(request.releaseIds ?? ["test-release"])],
    rollbackOwner: request.rollbackOwner ?? "test-rollback-owner",
  };
}

export function createKnowledgeBackfillDryRun(
  request: KnowledgeBackfillRequest,
  candidates: readonly KnowledgeBackfillCandidate[],
  discovery?: KnowledgeBackfillManifest["discovery"],
): { manifest: KnowledgeBackfillManifest; jobs: KnowledgeJob[] } {
  const scope = buildScope(request);
  const allowed = new Set(scope.channelIds);
  const from = Date.parse(scope.from);
  const to = Date.parse(scope.to);
  const deduped = new Map<string, KnowledgeBackfillCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.channelId}:${candidate.threadTs}`;
    const prior = deduped.get(key);
    if (!prior || candidate.observedAt < prior.observedAt) {
      deduped.set(key, candidate);
    }
  }
  const eligible = [...deduped.values()]
    .filter((candidate) => allowed.has(candidate.channelId))
    .filter((candidate) => {
      const observed = Date.parse(candidate.observedAt);
      return Number.isFinite(observed) && observed >= from && observed <= to;
    })
    .sort((left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.channelId.localeCompare(right.channelId) ||
      left.threadTs.localeCompare(right.threadTs));
  const jobs = eligible.map((candidate) => createKnowledgeJob({
    teamId: scope.teamId,
    projectId: scope.projectId,
    channelId: candidate.channelId,
    threadTs: candidate.threadTs,
    configVersion: request.sourceConfigVersions[candidate.channelId]!,
    requestedAt: candidate.observedAt,
    reason: "backfill",
  }));
  const completeDiscovery = discovery ?? {
    status: "complete" as const,
    pages: 0,
    channels: scope.channelIds.map((channelId) => ({
      channelId,
      status: "exhausted" as const,
      pageCount: 0,
    })),
  };
  return {
    manifest: {
      ...scope,
      mode: "dry_run",
      count: jobs.length,
      sourceKeys: jobs.map((job) => job.sourceKey),
      jobs,
      discovery: completeDiscovery,
    },
    jobs,
  };
}

async function fetchSlackHistoryPage(input: {
  token: string;
  channelId: string;
  from: string;
  to: string;
  cursor?: string;
  fetchImpl: typeof fetch;
}): Promise<{
  candidates: KnowledgeBackfillCandidate[];
  exhausted: boolean;
  nextCursor?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    KNOWLEDGE_BACKFILL_LIMITS.requestTimeoutMs,
  );
  try {
    const body = new URLSearchParams({
      channel: input.channelId,
      oldest: String(Date.parse(input.from) / 1_000),
      latest: String(Date.parse(input.to) / 1_000),
      inclusive: "true",
      limit: String(KNOWLEDGE_BACKFILL_LIMITS.slackPageSize),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    const response = await input.fetchImpl(
      "https://slack.com/api/conversations.history",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`slack_backfill_history_http_${response.status}`);
    }
    const page = await response.json() as SlackHistoryPage;
    if (page.ok !== true) {
      throw new Error(
        `slack_backfill_history_${
          typeof page.error === "string" ? page.error : "failed"
        }`,
      );
    }
    if (!Array.isArray(page.messages)) {
      throw new Error("slack_backfill_history_malformed");
    }
    const candidates: KnowledgeBackfillCandidate[] = [];
    for (const raw of page.messages as SlackHistoryMessage[]) {
      if (raw.subtype === "message_deleted") continue;
      const ts = typeof raw.thread_ts === "string"
        ? raw.thread_ts
        : typeof raw.ts === "string"
          ? raw.ts
          : undefined;
      if (!ts) continue;
      const observedAt = slackTimestampToIso(ts);
      if (observedAt) {
        candidates.push({
          channelId: input.channelId,
          threadTs: ts,
          observedAt,
        });
      }
    }
    const nextCursor =
      typeof page.response_metadata?.next_cursor === "string"
        ? page.response_metadata.next_cursor.trim()
        : "";
    if (page.has_more === true && !nextCursor) {
      throw new Error("slack_backfill_history_missing_next_cursor");
    }
    return {
      candidates,
      exhausted: !nextCursor,
      ...(nextCursor ? { nextCursor } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function backfillDoRequest<T>(
  namespace: DurableObjectNamespace<any>,
  objectName: string,
  path: string,
  body: unknown,
): Promise<T> {
  const tenantNamespace = namespace as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
  };
  const stub = tenantStub(tenantNamespace, objectName);
  const response = await stub.fetch(`https://do${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `${path.replaceAll("/", "_")}_http_${response.status}:${
        detail.slice(0, 256)
      }`,
    );
  }
  return response.json() as Promise<T>;
}

async function authoritativeBackfillSource(
  env: KnowledgeBackfillEnv,
  input: { teamId: string; projectId: string; channelId: string },
): Promise<TrackedKnowledgeSource> {
  const source = await backfillDoRequest<TrackedKnowledgeSource>(
    env.WORKSPACE_CONFIG,
    input.teamId,
    "/getTrackedKnowledgeSource",
    input,
  );
  if (
    !isTrackedKnowledgeSourceEnabled(source) ||
    source.teamId !== input.teamId ||
    source.projectId !== input.projectId ||
    source.channelId !== input.channelId
  ) {
    throw new Error(
      `backfill source is not enabled for exact channel ${input.channelId}`,
    );
  }
  return source;
}

function sameScopeInput(
  scope: KnowledgeBackfillScope,
  input: {
    teamId: string;
    projectId: string;
    channelIds: string[];
    from: string;
    to: string;
    maximumCount: number;
    maximumRatePerMinute: number;
    maximumErrors: number;
    releaseIds: string[];
    rollbackOwner: string;
  },
): boolean {
  const channels = [...new Set(input.channelIds)].sort();
  return scope.teamId === input.teamId &&
    scope.projectId === input.projectId &&
    scope.from === input.from &&
    scope.to === input.to &&
    scope.executionBudget.maximumCount === input.maximumCount &&
    scope.executionBudget.maximumRatePerMinute ===
      input.maximumRatePerMinute &&
    scope.executionBudget.maximumErrors === input.maximumErrors &&
    scope.rollbackOwner === input.rollbackOwner &&
    canonicalJson(scope.channelIds) === canonicalJson(channels) &&
    canonicalJson(scope.releaseIds) === canonicalJson(input.releaseIds);
}

/**
 * Durable discovery has one identity and one exact scope. Every Slack page is
 * merged behind an expected per-channel state/cursor CAS; a restart resumes
 * the same unvisited/pending channel and no caller may inject cursors.
 */
export async function discoverAndStoreKnowledgeBackfill(
  env: KnowledgeBackfillEnv,
  input: {
    manifestId: string;
    teamId: string;
    projectId: string;
    channelIds: string[];
    from: string;
    to: string;
    maximumCount: number;
    maximumRatePerMinute: number;
    maximumErrors: number;
    releaseIds: string[];
    rollbackOwner: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{
  manifestId: string;
  status: KnowledgeBackfillDiscoveryStatus | "dry_run";
  manifestDigest?: string;
  manifest?: KnowledgeBackfillManifest;
  discovery: DurableKnowledgeBackfillDiscovery;
}> {
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("Slack token is unavailable for backfill discovery");
  }
  exactText(input.manifestId, "manifestId", 128);
  const channelIds = [...new Set(input.channelIds)].sort();
  const validationRequest: KnowledgeBackfillRequest = {
    manifestId: input.manifestId,
    teamId: input.teamId,
    projectId: input.projectId,
    channelIds,
    from: input.from,
    to: input.to,
    limit: input.maximumCount,
    maximumRatePerMinute: input.maximumRatePerMinute,
    maximumErrors: input.maximumErrors,
    releaseIds: input.releaseIds,
    rollbackOwner: input.rollbackOwner,
    dryRun: true,
    sourceConfigVersions: Object.fromEntries(
      channelIds.map((channelId) => [channelId, 1]),
    ),
  };
  validate(validationRequest);

  const prior = await backfillDoRequest<{
    discovery: DurableKnowledgeBackfillDiscovery | null;
  }>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/discovery/get",
    { manifestId: input.manifestId, includeCandidates: false },
  ).then((result) => result.discovery ?? undefined);
  if (prior && !sameScopeInput(prior.scope, input)) {
    throw new Error("backfill discovery scope changed; create a new manifest");
  }

  const sourceConfigVersions: Record<string, number> =
    Object.create(null) as Record<string, number>;
  for (const channelId of channelIds) {
    const source = await authoritativeBackfillSource(env, {
      teamId: input.teamId,
      projectId: input.projectId,
      channelId,
    });
    sourceConfigVersions[channelId] = source.configVersion;
  }

  if (
    prior &&
    prior.scope.sources.some((source) =>
      sourceConfigVersions[source.channelId] !== source.configVersion)
  ) {
    await backfillDoRequest(
      env.KNOWLEDGE,
      input.teamId,
      "/backfill/discovery/block",
      {
        manifestId: prior.manifestId,
        scopeDigest: prior.scopeDigest,
        reason: "source_config_drift",
      },
    );
    throw new Error(
      "backfill discovery source config drifted; create a new manifest",
    );
  }

  const manifestId = input.manifestId;
  const scope = buildScope({
    ...validationRequest,
    manifestId,
    sourceConfigVersions,
  });
  const scopeDigest = await knowledgeBackfillManifestDigest(scope);
  let discovery = await backfillDoRequest<DurableKnowledgeBackfillDiscovery>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/discovery/start",
    { manifestId, scopeDigest, scope, createdAt: new Date().toISOString() },
  );

  if (
    discovery.status === "blocked_config_drift" ||
    discovery.status === "complete_over_budget"
  ) {
    return { manifestId, status: discovery.status, discovery };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let pagesThisInvocation = 0;
  while (
    discovery.status === "discovering" &&
    pagesThisInvocation <
      KNOWLEDGE_BACKFILL_LIMITS.maxDiscoveryPagesPerInvocation
  ) {
    const channel = discovery.channels.find((candidate) =>
      candidate.status !== "exhausted");
    if (!channel) {
      throw new Error("backfill discovery state is inconsistent");
    }
    const page = await fetchSlackHistoryPage({
      token: env.SLACK_BOT_TOKEN,
      channelId: channel.channelId,
      from: scope.from,
      to: scope.to,
      cursor: channel.cursor,
      fetchImpl,
    });
    discovery = await backfillDoRequest<DurableKnowledgeBackfillDiscovery>(
      env.KNOWLEDGE,
      input.teamId,
      "/backfill/discovery/merge",
      {
        manifestId,
        scopeDigest,
        channelId: channel.channelId,
        expectedStatus: channel.status,
        expectedCursor: channel.cursor ?? null,
        nextStatus: page.exhausted ? "exhausted" : "pending",
        nextCursor: page.nextCursor ?? null,
        candidates: page.candidates,
        mergedAt: new Date().toISOString(),
      },
    );
    pagesThisInvocation += 1;
  }

  if (discovery.status !== "complete") {
    return { manifestId, status: discovery.status, discovery };
  }

  const complete = await backfillDoRequest<{
    discovery: DurableKnowledgeBackfillDiscovery;
  }>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/discovery/get",
    { manifestId, includeCandidates: true },
  );
  discovery = complete.discovery;
  if (
    discovery.status !== "complete" ||
    !Array.isArray(discovery.candidates) ||
    discovery.candidates.length !== discovery.candidateCount
  ) {
    throw new Error("backfill discovery is not durably complete");
  }
  const result = createKnowledgeBackfillDryRun({
    ...validationRequest,
    manifestId,
    sourceConfigVersions,
  }, discovery.candidates, {
    status: "complete",
    pages: discovery.pages,
    channels: discovery.channels.map((channel) => {
      if (channel.status !== "exhausted") {
        throw new Error("backfill discovery contains an unexhausted channel");
      }
      return {
        channelId: channel.channelId,
        status: "exhausted" as const,
        pageCount: channel.pageCount,
      };
    }),
  });
  if (result.manifest.count > scope.executionBudget.maximumCount) {
    throw new Error("backfill discovery count exceeds its maximum count");
  }
  const manifestDigest = await knowledgeBackfillManifestDigest(result.manifest);
  await backfillDoRequest(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/manifest",
    {
      manifestId,
      manifestDigest,
      manifest: result.manifest,
      createdAt: discovery.createdAt,
    },
  );
  return {
    manifestId,
    manifestDigest,
    manifest: result.manifest,
    status: "dry_run",
    discovery,
  };
}

function isCompleteManifest(value: unknown): value is KnowledgeBackfillManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<KnowledgeBackfillManifest>;
  return manifest.schemaVersion === 2 &&
    manifest.mode === "dry_run" &&
    typeof manifest.manifestId === "string" &&
    Array.isArray(manifest.channelIds) &&
    Array.isArray(manifest.sources) &&
    Array.isArray(manifest.jobs) &&
    Array.isArray(manifest.sourceKeys) &&
    manifest.count === manifest.jobs.length &&
    manifest.discovery?.status === "complete" &&
    Array.isArray(manifest.discovery.channels) &&
    manifest.discovery.channels.every((channel) =>
      channel.status === "exhausted") &&
    typeof manifest.executionBudget === "object" &&
    Array.isArray(manifest.releaseIds) &&
    typeof manifest.rollbackOwner === "string";
}

export async function approveKnowledgeBackfillManifest(
  env: Pick<KnowledgeBackfillEnv, "KNOWLEDGE">,
  input: {
    teamId: string;
    manifestId: string;
    manifestDigest: string;
    approvalArtifact?: string;
    verifier: KnowledgeBackfillApprovalVerifierConfig;
  },
): Promise<unknown> {
  const stored = await backfillDoRequest<{
    manifest: StoredKnowledgeBackfillManifest | null;
  }>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/get",
    { manifestId: input.manifestId },
  );
  if (!stored.manifest) throw new Error("backfill manifest does not exist");
  if (
    stored.manifest.manifestDigest !== input.manifestDigest ||
    !isCompleteManifest(stored.manifest.manifest) ||
    stored.manifest.manifest.manifestId !== input.manifestId ||
    stored.manifest.manifest.teamId !== input.teamId
  ) {
    throw new Error("backfill manifest identity or completeness mismatch");
  }
  const computedDigest = await knowledgeBackfillManifestDigest(
    stored.manifest.manifest,
  );
  if (computedDigest !== input.manifestDigest) {
    throw new Error("backfill manifest digest mismatch");
  }
  const approval = await verifyKnowledgeBackfillApproval(
    input.approvalArtifact,
    stored.manifest.manifest,
    computedDigest,
    input.verifier,
  );
  return backfillDoRequest(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/approve",
    { approval },
  );
}

function isEnqueueKnowledgeResult(
  value: unknown,
): value is EnqueueKnowledgeResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<EnqueueKnowledgeResult>;
  return typeof result.accepted === "boolean" &&
    typeof result.descriptorKey === "string" &&
    ["new", "superseded", "duplicate", "out_of_order"].includes(
      result.reason ?? "",
    );
}

async function submitApprovedBackfillJob(
  env: Pick<KnowledgeBackfillEnv, "WORKSPACE_CONFIG" | "KNOWLEDGE">,
  input: {
    teamId: string;
    manifestId: string;
    manifestDigest: string;
    pageToken: string;
    job: KnowledgeJob;
  },
): Promise<KnowledgeBackfillPageDisposition> {
  let result: unknown;
  try {
    result = await backfillDoRequest(
      env.KNOWLEDGE,
      input.teamId,
      "/backfill/enqueue",
      input,
    );
  } catch (error) {
    const disposition = await proveKnowledgeDescriptorDisposition(
      env,
      input.job,
      true,
    ).catch(() => undefined);
    if (disposition) return disposition;
    throw error;
  }
  if (!isEnqueueKnowledgeResult(result)) {
    const disposition = await proveKnowledgeDescriptorDisposition(
      env,
      input.job,
      true,
    ).catch(() => undefined);
    if (disposition) return disposition;
    throw new Error("knowledge_backfill_enqueue_result_malformed");
  }
  if (result.accepted) return "accepted";
  const disposition = await proveKnowledgeDescriptorDisposition(
    env,
    input.job,
    false,
  );
  if (disposition) return disposition;
  throw new Error(`knowledge_backfill_enqueue_rejected_${result.reason}`);
}

function dispositionCounts(
  results: Record<string, KnowledgeBackfillPageDisposition>,
): Partial<Record<KnowledgeBackfillPageDisposition, number>> {
  const counts: Partial<Record<KnowledgeBackfillPageDisposition, number>> = {};
  for (const disposition of Object.values(results)) {
    counts[disposition] = (counts[disposition] ?? 0) + 1;
  }
  return counts;
}

export async function executeKnowledgeBackfillPage(
  env: Pick<KnowledgeBackfillEnv, "WORKSPACE_CONFIG" | "KNOWLEDGE">,
  input: {
    teamId: string;
    manifestId: string;
    manifestDigest: string;
    batchLimit?: number;
  },
): Promise<{
  manifestId: string;
  status: "approved" | "running" | "complete";
  pageStatus: "none" | "partial" | "committed";
  nextJobIndex: number;
  enqueued: number;
  processed: number;
  pending: number;
  executionErrorCount: number;
  dispositions: Partial<Record<KnowledgeBackfillPageDisposition, number>>;
  errorCode?: string;
}> {
  const stored = await backfillDoRequest<{
    manifest: StoredKnowledgeBackfillManifest | null;
  }>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/get",
    { manifestId: input.manifestId },
  );
  if (!stored.manifest) throw new Error("backfill manifest does not exist");
  if (stored.manifest.manifestDigest !== input.manifestDigest) {
    throw new Error("backfill manifest digest mismatch");
  }
  const manifest = stored.manifest.manifest;
  if (
    !isCompleteManifest(manifest) ||
    manifest.manifestId !== input.manifestId ||
    manifest.teamId !== input.teamId
  ) {
    throw new Error("backfill manifest team scope or completeness mismatch");
  }
  if (
    manifest.count > manifest.executionBudget.maximumCount ||
    manifest.count !== manifest.jobs.length
  ) {
    throw new Error("backfill manifest exceeds its approved count budget");
  }

  for (const pinned of manifest.sources) {
    const source = await authoritativeBackfillSource(
      env as KnowledgeBackfillEnv,
      {
        teamId: manifest.teamId,
        projectId: manifest.projectId,
        channelId: pinned.channelId,
      },
    );
    if (source.configVersion !== pinned.configVersion) {
      throw new Error(
        `backfill manifest config mismatch for channel ${pinned.channelId}`,
      );
    }
  }

  let claimed = await backfillDoRequest<StoredKnowledgeBackfillManifest>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/claim",
    {
      manifestId: input.manifestId,
      manifestDigest: input.manifestDigest,
      limit: input.batchLimit ?? 10,
    },
  );
  if (!claimed.pendingPageToken || !claimed.pendingJobs?.length) {
    return {
      manifestId: input.manifestId,
      status: claimed.status as "approved" | "running" | "complete",
      pageStatus: "none",
      nextJobIndex: claimed.nextJobIndex,
      enqueued: 0,
      processed: 0,
      pending: 0,
      executionErrorCount: claimed.executionErrorCount ?? 0,
      dispositions: {},
    };
  }

  const pageToken = claimed.pendingPageToken;
  const pendingJobs = claimed.pendingJobs;
  const results = { ...(claimed.pendingResults ?? {}) };
  let newlyEnqueued = 0;
  for (const job of pendingJobs) {
    const descriptorKey = `${job.sourceKey}|${job.configVersion}|${
      job.requestedAt
    }|${job.reason}`;
    if (results[descriptorKey]) continue;
    try {
      const pinned = manifest.sources.find((source) =>
        source.channelId === job.channelId);
      const current = await authoritativeBackfillSource(
        env as KnowledgeBackfillEnv,
        {
          teamId: job.teamId,
          projectId: job.projectId,
          channelId: job.channelId,
        },
      );
      if (
        !pinned ||
        job.teamId !== manifest.teamId ||
        job.projectId !== manifest.projectId ||
        job.configVersion !== pinned.configVersion ||
        current.configVersion !== pinned.configVersion
      ) {
        throw new Error(
          `backfill manifest scope/config mismatch for source ${job.sourceKey}`,
        );
      }
      const disposition = await submitApprovedBackfillJob(env, {
        teamId: input.teamId,
        manifestId: input.manifestId,
        manifestDigest: input.manifestDigest,
        pageToken,
        job,
      });
      if (disposition === "accepted") newlyEnqueued += 1;
      claimed = await backfillDoRequest<StoredKnowledgeBackfillManifest>(
        env.KNOWLEDGE,
        input.teamId,
        "/backfill/result",
        {
          manifestId: input.manifestId,
          manifestDigest: input.manifestDigest,
          pageToken,
          descriptorKey,
          disposition,
        },
      );
      Object.assign(results, claimed.pendingResults ?? {});
    } catch (error) {
      const errorCode = (error instanceof Error ? error.message : "unknown")
        .slice(0, 256);
      claimed = await backfillDoRequest<StoredKnowledgeBackfillManifest>(
        env.KNOWLEDGE,
        input.teamId,
        "/backfill/fail",
        {
          manifestId: input.manifestId,
          manifestDigest: input.manifestDigest,
          pageToken,
          descriptorKey,
          errorCode,
        },
      );
      const counts = dispositionCounts(claimed.pendingResults ?? results);
      const processed = Object.values(counts).reduce(
        (total, count) => total + (count ?? 0),
        0,
      );
      return {
        manifestId: input.manifestId,
        status: claimed.status as "approved" | "running",
        pageStatus: "partial",
        nextJobIndex: claimed.nextJobIndex,
        enqueued: newlyEnqueued,
        processed,
        pending: pendingJobs.length - processed,
        executionErrorCount: claimed.executionErrorCount ?? 0,
        dispositions: counts,
        errorCode,
      };
    }
  }

  const counts = dispositionCounts(claimed.pendingResults ?? results);
  const committed = await backfillDoRequest<StoredKnowledgeBackfillManifest>(
    env.KNOWLEDGE,
    input.teamId,
    "/backfill/commit",
    {
      manifestId: input.manifestId,
      manifestDigest: input.manifestDigest,
      pageToken,
    },
  );
  const processed = Object.values(counts).reduce(
    (total, count) => total + (count ?? 0),
    0,
  );
  return {
    manifestId: input.manifestId,
    status: committed.status as "running" | "complete",
    pageStatus: "committed",
    nextJobIndex: committed.nextJobIndex,
    enqueued: newlyEnqueued,
    processed,
    pending: 0,
    executionErrorCount: committed.executionErrorCount ?? 0,
    dispositions: counts,
  };
}

export type { VerifiedKnowledgeBackfillApproval };
