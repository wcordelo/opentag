/** Pure, runtime-neutral validation for the pinned harness /turn envelope. */

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Production turn IDs are fixed-length, purpose-tagged SHA-256 base64url
// values emitted by edge/src/harness/wire-id.ts. Keep execution and message
// identities distinct so neither can be substituted for the other.
const EXECUTION_ID_RE = /^ot1e_[A-Za-z0-9_-]{43}$/;
const FORWARDED_MESSAGE_ID_RE = /^ot1m_[A-Za-z0-9_-]{43}$/;
const THREAD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_REF_RE = /^(?![./])(?!.*(?:\.\.|@\{|\/\/|\\))[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
const ATTRIBUTION_RE = /^Prompted by: (?:@[A-Za-z0-9][A-Za-z0-9._-]{0,79}|[\p{L}\p{N}][\p{L}\p{N} ._'()-]{0,79})$/u;

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
    },
  };
}
