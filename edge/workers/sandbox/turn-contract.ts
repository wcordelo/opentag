/** Pure, runtime-neutral validation for the pinned harness /turn envelope. */

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Production turn IDs are fixed-length, purpose-tagged SHA-256 base64url
// values emitted by edge/src/harness/wire-id.ts. Keep execution and message
// identities distinct so neither can be substituted for the other.
const EXECUTION_ID_RE = /^ot1e_[A-Za-z0-9_-]{43}$/;
const FORWARDED_MESSAGE_ID_RE = /^ot1m_[A-Za-z0-9_-]{43}$/;
const THREAD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const GIT_REF_RE = /^(?![./])(?!.*(?:\.\.|@\{|\/\/|\\))[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
const ATTRIBUTION_RE = /^Prompted by: (?:@[A-Za-z0-9][A-Za-z0-9._-]{0,79}|[\p{L}\p{N}][\p{L}\p{N} ._'()-]{0,79})$/u;
const PERMISSION_MAX_BYTES = 64 * 1024;
const PERMISSION_SOURCES = new Set(["explicit", "sticky", "channel", "deployment"]);

/** Internal process-to-egress binding; stripped by the Worker before upstream. */
export const EXECUTION_BINDING_HEADER = "x-opentag-execution-id";

export interface RepoPolicy {
  allowedHosts: ReadonlySet<string>;
  allowedOrgs: ReadonlySet<string>;
}

export interface RepoSpec {
  url: string;
  branch?: string;
}

export type TurnAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
} & (
  | { kind: "inline"; dataBase64: string }
  | { kind: "staged"; stageKey: string; sha256?: string }
);

export interface TurnRequestBody {
  sessionId: string;
  executionId: string;
  forwardedMessageId?: string;
  threadKey: string;
  inputLines: string[];
  attachments?: TurnAttachment[];
  model?: string;
  repo?: RepoSpec;
  requesterContext?: string;
  transcript?: string;
  codingTask?: boolean;
  remoteGitApproved?: boolean;
  createPullRequest?: boolean;
  permissionSnapshot?: PermissionSnapshotV1;
}

export interface PermissionSnapshotV1 {
  version: 1;
  scope: {
    teamId: string;
    channelId: string;
    conversationKey?: string;
    executionId?: string;
    actorKind: "slack_user" | "slack_automation" | "operator";
  };
  channelAccess: {
    bundleId: string;
    metadataVisibility: "full_names" | "restricted";
    allowedTools: string[];
    deniedTools: string[];
    policies: { allowMemoryWrite: boolean; allowTasks: boolean };
    mcpEndpoints: Array<{ origin: string; path: string }>;
    secretRefs: string[];
  };
  runtime: {
    harnessType?: "claudecode";
    model?: string;
    harnessSource: "explicit" | "sticky" | "channel" | "deployment";
    modelSource: "explicit" | "sticky" | "channel" | "deployment";
    harnessConnected: boolean;
  };
  sandbox?: {
    network: "denied_by_default";
    credentialExposure: "sentinel_only";
    allowedRepoHosts: string[];
    allowedRepoOrgs: string[];
    remoteGitApproved: boolean;
    createPullRequest: boolean;
  };
  generatedAt: string;
}

export type TurnValidation =
  | { ok: true; body: TurnRequestBody }
  | { ok: false; error: string };

export interface InterruptRequestBody {
  sessionId: string;
  executionId: string;
  threadKey: string;
}

export function validateInterruptRequest(body: unknown):
  | { ok: true; body: InterruptRequestBody }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_request" };
  }
  const record = body as Record<string, unknown>;
  if (!isSafeIdentifier(record.sessionId)) return { ok: false, error: "invalid_session_id" };
  if (typeof record.executionId !== "string" || !EXECUTION_ID_RE.test(record.executionId)) {
    return { ok: false, error: "invalid_execution_id" };
  }
  if (typeof record.threadKey !== "string" || !THREAD_KEY_RE.test(record.threadKey)) {
    return { ok: false, error: "invalid_thread_key" };
  }
  return { ok: true, body: record as unknown as InterruptRequestBody };
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

/** Accept only the exact, single-line attribution formats emitted by agent-turn. */
export function requesterAttribution(requesterContext?: string): string | undefined {
  const matches = requesterContext
    ?.split(/\r?\n/)
    .filter((line) => ATTRIBUTION_RE.test(line)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function boundedStrings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 200 &&
    value.every((item) => typeof item === "string" && item.length <= 256);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedUniqueSortedStrings(value: unknown): value is string[] {
  return boundedStrings(value) &&
    new Set(value).size === value.length &&
    value.every((item, index) => index === 0 || value[index - 1]! < item);
}

export function validatePermissionSnapshot(
  value: unknown,
): { ok: true; snapshot: PermissionSnapshotV1 } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid_permission_snapshot" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, error: "invalid_permission_snapshot" };
  }
  if (new TextEncoder().encode(serialized).byteLength > PERMISSION_MAX_BYTES) {
    return { ok: false, error: "permission_snapshot_too_large" };
  }
  if (/"(?:authorization|cookie|headers|rawEvent|rawPayload)"\s*:/i.test(serialized)) {
    return { ok: false, error: "permission_snapshot_forbidden_field" };
  }
  const snapshot = value as Record<string, unknown>;
  const scope = snapshot.scope as Record<string, unknown> | undefined;
  const access = snapshot.channelAccess as Record<string, unknown> | undefined;
  const runtime = snapshot.runtime as Record<string, unknown> | undefined;
  const sandbox = snapshot.sandbox as Record<string, unknown> | undefined;
  if (
    !hasOnlyKeys(snapshot, [
      "version",
      "scope",
      "channelAccess",
      "runtime",
      "sandbox",
      "generatedAt",
    ]) ||
    snapshot.version !== 1 ||
    !scope ||
    !access ||
    !runtime ||
    !hasOnlyKeys(scope, [
      "teamId",
      "channelId",
      "conversationKey",
      "executionId",
      "actorKind",
    ]) ||
    !hasOnlyKeys(access, [
      "bundleId",
      "metadataVisibility",
      "allowedTools",
      "deniedTools",
      "policies",
      "mcpEndpoints",
      "secretRefs",
    ]) ||
    !hasOnlyKeys(runtime, [
      "harnessType",
      "model",
      "harnessSource",
      "modelSource",
      "harnessConnected",
    ]) ||
    !["slack_user", "slack_automation", "operator"].includes(String(scope.actorKind)) ||
    !["full_names", "restricted"].includes(String(access.metadataVisibility)) ||
    !boundedUniqueSortedStrings(access.allowedTools) ||
    !boundedUniqueSortedStrings(access.deniedTools) ||
    !boundedUniqueSortedStrings(access.secretRefs) ||
    !PERMISSION_SOURCES.has(String(runtime.harnessSource)) ||
    !PERMISSION_SOURCES.has(String(runtime.modelSource)) ||
    typeof runtime.harnessConnected !== "boolean" ||
    typeof snapshot.generatedAt !== "string" ||
    snapshot.generatedAt.length > 256
  ) {
    return { ok: false, error: "invalid_permission_snapshot" };
  }
  for (const field of ["teamId", "channelId", "conversationKey", "executionId"]) {
    const item = scope[field];
    if (item !== undefined && (typeof item !== "string" || item.length > 256)) {
      return { ok: false, error: "invalid_permission_snapshot" };
    }
  }
  if (
    typeof access.bundleId !== "string" ||
    access.bundleId.length > 256 ||
    !access.policies ||
    typeof access.policies !== "object" ||
    Array.isArray(access.policies) ||
    !hasOnlyKeys(
      access.policies as Record<string, unknown>,
      ["allowMemoryWrite", "allowTasks"],
    ) ||
    typeof (access.policies as Record<string, unknown>).allowMemoryWrite !== "boolean" ||
    typeof (access.policies as Record<string, unknown>).allowTasks !== "boolean" ||
    !Array.isArray(access.mcpEndpoints) ||
    access.mcpEndpoints.length > 200 ||
    (runtime.harnessType !== undefined && runtime.harnessType !== "claudecode") ||
    (runtime.model !== undefined &&
      (typeof runtime.model !== "string" ||
        runtime.model.length > 256 ||
        !MODEL_RE.test(runtime.model)))
  ) {
    return { ok: false, error: "invalid_permission_snapshot" };
  }
  const actorKind = String(scope.actorKind);
  const metadataVisibility = String(access.metadataVisibility);
  if (
    (actorKind === "slack_automation" &&
      (metadataVisibility !== "restricted" ||
        access.mcpEndpoints.length !== 0 ||
        access.secretRefs.length !== 0)) ||
    (actorKind !== "slack_automation" && metadataVisibility !== "full_names")
  ) {
    return { ok: false, error: "invalid_permission_snapshot" };
  }
  for (const endpoint of access.mcpEndpoints) {
    if (!endpoint || typeof endpoint !== "object") {
      return { ok: false, error: "invalid_permission_snapshot" };
    }
    const { origin, path } = endpoint as { origin?: unknown; path?: unknown };
    if (
      !hasOnlyKeys(endpoint as Record<string, unknown>, ["origin", "path"]) ||
      typeof origin !== "string" ||
      typeof path !== "string" ||
      origin.length > 256 ||
      path.length > 256 ||
      (path !== "" && (!path.startsWith("/") || path.includes("?") || path.includes("#")))
    ) return { ok: false, error: "invalid_permission_snapshot" };
    if (origin !== "[invalid]") {
      try {
        const parsed = new URL(origin);
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          parsed.pathname !== "/"
        ) return { ok: false, error: "invalid_permission_snapshot" };
      } catch {
        return { ok: false, error: "invalid_permission_snapshot" };
      }
    }
  }
  if (sandbox) {
    if (
      !hasOnlyKeys(sandbox, [
        "network",
        "credentialExposure",
        "allowedRepoHosts",
        "allowedRepoOrgs",
        "remoteGitApproved",
        "createPullRequest",
      ]) ||
      sandbox.network !== "denied_by_default" ||
      sandbox.credentialExposure !== "sentinel_only" ||
      !boundedUniqueSortedStrings(sandbox.allowedRepoHosts) ||
      !boundedUniqueSortedStrings(sandbox.allowedRepoOrgs) ||
      typeof sandbox.remoteGitApproved !== "boolean" ||
      typeof sandbox.createPullRequest !== "boolean"
    ) {
      return { ok: false, error: "invalid_permission_snapshot" };
    }
  }
  return { ok: true, snapshot: value as PermissionSnapshotV1 };
}

export function validateRepoSpec(repo: unknown, policy: RepoPolicy):
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string } {
  if (!repo || typeof repo !== "object" || Array.isArray(repo)) {
    return { ok: false, error: "invalid_repo" };
  }
  const record = repo as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length > 2048) {
    return { ok: false, error: "invalid_repo_url" };
  }
  if (record.branch !== undefined &&
      (typeof record.branch !== "string" || !GIT_REF_RE.test(record.branch))) {
    return { ok: false, error: "invalid_repo_branch" };
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return { ok: false, error: "invalid_repo_url" };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || !policy.allowedHosts.has(host)) {
    return { ok: false, error: "repo_not_allowed" };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0] ?? "")) {
    return { ok: false, error: "invalid_repo_url" };
  }
  const org = (parts[0] ?? "").toLowerCase();
  const repoName = (parts[1] ?? "").replace(/\.git$/, "");
  if (!repoName || !/^[A-Za-z0-9_.-]+$/.test(repoName) || !policy.allowedOrgs.has(org)) {
    return { ok: false, error: "repo_not_allowed" };
  }
  return { ok: true, normalizedUrl: `https://${host}/${parts[0]}/${repoName}.git` };
}

export function validateTurnRequest(body: unknown, repoPolicy: RepoPolicy): TurnValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_request" };
  }
  const record = body as Record<string, unknown>;
  if (!isSafeIdentifier(record.sessionId)) return { ok: false, error: "invalid_session_id" };
  if (typeof record.executionId !== "string" || !EXECUTION_ID_RE.test(record.executionId)) {
    return { ok: false, error: "invalid_execution_id" };
  }
  if (record.forwardedMessageId !== undefined &&
      (typeof record.forwardedMessageId !== "string" || !FORWARDED_MESSAGE_ID_RE.test(record.forwardedMessageId))) {
    return { ok: false, error: "invalid_forwarded_message_id" };
  }
  if (typeof record.threadKey !== "string" || !THREAD_KEY_RE.test(record.threadKey)) {
    return { ok: false, error: "invalid_thread_key" };
  }
  if (!Array.isArray(record.inputLines) || record.inputLines.length === 0 ||
      record.inputLines.length > 100 ||
      record.inputLines.some((line) => typeof line !== "string" || line.trim().length === 0 || line.length > 32_768) ||
      record.inputLines.reduce<number>((sum, line) => sum + (typeof line === "string" ? line.length : 0), 0) > 512 * 1024) {
    return { ok: false, error: "invalid_input_lines" };
  }
  let attachments: TurnAttachment[] | undefined;
  if (record.attachments !== undefined) {
    if (!Array.isArray(record.attachments) || record.attachments.length > 5) {
      return { ok: false, error: "invalid_attachments" };
    }
    let inlineBytes = 0;
    for (const value of record.attachments) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "invalid_attachments" };
      }
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || item.id.length > 256 ||
          typeof item.name !== "string" || item.name.length > 255 ||
          typeof item.mimeType !== "string" || item.mimeType.length > 255 ||
          typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 ||
          item.size > 32 * 1024 * 1024) {
        return { ok: false, error: "invalid_attachments" };
      }
      if (item.kind === "inline") {
        if (typeof item.dataBase64 !== "string" || item.dataBase64.length > 44 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) {
          return { ok: false, error: "invalid_attachments" };
        }
        inlineBytes += Math.floor(item.dataBase64.length * 3 / 4) -
          (item.dataBase64.endsWith("==") ? 2 : item.dataBase64.endsWith("=") ? 1 : 0);
      } else if (item.kind === "staged") {
        if (typeof item.stageKey !== "string" || item.stageKey.length > 512 ||
            !/^[A-Za-z0-9/_.-]+$/.test(item.stageKey) ||
            (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)))) {
          return { ok: false, error: "invalid_attachments" };
        }
      } else {
        return { ok: false, error: "invalid_attachments" };
      }
    }
    // The authenticated frontend resolves staged R2 objects into this same
    // envelope. Keep a hard decoded aggregate cap equal to the staged tier.
    if (inlineBytes > 32 * 1024 * 1024) return { ok: false, error: "attachments_too_large" };
    attachments = record.attachments as TurnAttachment[];
  }
  if (record.model !== undefined &&
      (typeof record.model !== "string" || !MODEL_RE.test(record.model))) {
    return { ok: false, error: "invalid_model" };
  }
  if ((record.requesterContext !== undefined &&
       (typeof record.requesterContext !== "string" || record.requesterContext.length > 16_384)) ||
      (record.transcript !== undefined &&
       (typeof record.transcript !== "string" || record.transcript.length > 256 * 1024))) {
    return { ok: false, error: "invalid_context" };
  }
  let permissionSnapshot: PermissionSnapshotV1 | undefined;
  if (record.permissionSnapshot !== undefined) {
    const result = validatePermissionSnapshot(record.permissionSnapshot);
    if (!result.ok) return result;
    permissionSnapshot = result.snapshot;
  }
  for (const key of ["codingTask", "remoteGitApproved", "createPullRequest"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      return { ok: false, error: "invalid_git_policy" };
    }
  }
  if (record.createPullRequest === true && record.remoteGitApproved !== true) {
    return { ok: false, error: "remote_git_not_approved" };
  }
  let normalizedRepo: RepoSpec | undefined;
  if (record.repo !== undefined) {
    const result = validateRepoSpec(record.repo, repoPolicy);
    if (!result.ok) return result;
    const supplied = record.repo as RepoSpec;
    normalizedRepo = { url: result.normalizedUrl, ...(supplied.branch ? { branch: supplied.branch } : {}) };
  }
  if (record.codingTask === true && !normalizedRepo) {
    return { ok: false, error: "coding_task_requires_repo" };
  }
  if (record.createPullRequest === true) {
    if (!normalizedRepo) return { ok: false, error: "pull_request_requires_repo" };
    if (!requesterAttribution(record.requesterContext as string | undefined)) {
      return { ok: false, error: "pull_request_requires_attribution" };
    }
  }
  return {
    ok: true,
    body: {
      sessionId: record.sessionId,
      executionId: record.executionId,
      ...(record.forwardedMessageId === undefined ? {} : { forwardedMessageId: record.forwardedMessageId as string }),
      threadKey: record.threadKey,
      inputLines: record.inputLines as string[],
      ...(attachments ? { attachments } : {}),
      ...(record.model === undefined ? {} : { model: record.model as string }),
      ...(normalizedRepo ? { repo: normalizedRepo } : {}),
      ...(record.requesterContext === undefined ? {} : { requesterContext: record.requesterContext as string }),
      ...(record.transcript === undefined ? {} : { transcript: record.transcript as string }),
      ...(record.codingTask === undefined ? {} : { codingTask: record.codingTask as boolean }),
      remoteGitApproved: record.remoteGitApproved === true,
      ...(record.createPullRequest === undefined ? {} : { createPullRequest: record.createPullRequest as boolean }),
      ...(permissionSnapshot ? { permissionSnapshot } : {}),
    },
  };
}
