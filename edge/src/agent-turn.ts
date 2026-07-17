/**
 * Shared bundled agent turn — used by onMention and `/agent`.
 * Kept separate from bot-engine to avoid circular imports with commands.
 */
import {
  ALL_EDGE_TOOLS,
  ALL_EDGE_TOOL_NAMES,
  guardToolsByBundle,
} from "./tools/index.js";
import { resolveAllowedTools } from "./config/access-bundle.js";
import { loadTurnAccess } from "./config/workspace-config-do.js";
import {
  requireRequestContext,
  type RequestActor,
} from "./request-context.js";
import { createDurableObjectStore } from "./store/index.js";
import {
  appendThreadMemory,
  candidateFieldLines,
  formatDraftContext,
  formatLastIssueContext,
  parseLastCreatedIssue,
  parseTicketDraft,
  readThreadMemory,
} from "./slack/thread-memory.js";
import type { Env } from "./env.js";
import type { Renderable } from "@copilotkit/channels-ui";
import {
  buildFileContentParts,
  contentPartsFromCanonicalAttachments,
  createR2AttachmentStager,
  mergePromptParts,
  type AgentContentPart,
  type PreparedAttachment,
  type SlackFileRef,
} from "./slack/download-files.js";
export type { AgentContentPart } from "./slack/download-files.js";
import {
  createSlackWebClient,
  isDefinitiveSlackFailure,
  sharedSlackRateScheduler,
} from "./slack/web-api.js";
import { getInboundMessage } from "./slack/inbound-target.js";
import {
  firstSlackTs,
  slackObligationThreadKey,
} from "./slack/obligation-thread-key.js";
import { extractMessageOverrides } from "./slack/overrides.js";
import {
  resolveThreadOverrides,
  type ResolvedThreadOverrides,
} from "./store/thread-overrides.js";
import {
  runHarnessTurn,
  type HarnessFailureKind,
} from "./harness/client.js";
import { makeWireTurnIdentity } from "./harness/wire-id.js";
import { isRepositoryCodingIntent } from "./coding-intent.js";
import {
  deliverActiveTurnOutput,
  renderActiveTurnStep,
} from "./slack/active-turn-registry.js";
import { markThreadNextRenderFinal } from "./slack/cloudflare-slack-adapter.js";
import { getTurnExecutionContext } from "./slack/turn-execution-context.js";
import { reconstructSessionHistory } from "./slack/session-history.js";
import { AUTOMATION_SAFE_TOOLS } from "./permissions/contract.js";
import { bindPermissionSnapshot } from "./permissions/context.js";
import { buildPermissionSnapshot } from "./permissions/snapshot.js";

type Requester = {
  id?: string;
  name?: string;
  handle?: string;
  email?: string;
  /** IANA tz from Slack users.info (e.g. America/Los_Angeles). */
  timezone?: string;
  /** Best-effort GitHub handle scraped from the Slack profile (SPEC §5-A5 item 5). */
  githubHandle?: string;
  /** Prevent repeated users.info calls when Slack has no GitHub profile data. */
  profileEnrichmentAttempted?: boolean;
};

const PROFILE_REFRESH_COOLDOWN_MS = 5 * 60_000;
const profileRefreshCache = new Map<
  string,
  { at: number; requester: Requester }
>();

/** Ensure we have profile email from Slack (users:read.email). */
async function ensureRequesterProfile(
  env: Env,
  requester?: Requester,
): Promise<Requester | undefined> {
  if (!requester?.id) return requester;
  const cachedRefresh = profileRefreshCache.get(requester.id);
  if (
    requester.email?.trim() &&
    timezoneOf(requester) &&
    (requester.githubHandle?.trim() ||
      requester.profileEnrichmentAttempted)
  ) {
    return requester;
  }
  if (
    cachedRefresh &&
    Date.now() - cachedRefresh.at < PROFILE_REFRESH_COOLDOWN_MS
  ) {
    return { ...requester, ...cachedRefresh.requester, id: requester.id };
  }
  if (!env.SLACK_BOT_TOKEN) return requester;
  try {
    const fresh = await createSlackWebClient(env.SLACK_BOT_TOKEN, {
      scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
    }).resolveUser(
      requester.id,
    );
    const freshTz = timezoneOf(fresh as Requester);
    const freshGithub = (fresh as Requester).githubHandle;
    const enriched: Requester = {
      ...requester,
      email: fresh.email?.trim() || requester.email,
      name: fresh.name ?? requester.name,
      handle: fresh.handle ?? requester.handle,
      timezone: freshTz ?? requester.timezone,
      githubHandle: freshGithub ?? requester.githubHandle,
      profileEnrichmentAttempted: true,
    };
    profileRefreshCache.set(requester.id, {
      at: Date.now(),
      requester: enriched,
    });
    return enriched;
  } catch (err) {
    console.warn(
      "[agent-turn] resolveUser refresh failed",
      err instanceof Error ? err.message : err,
    );
    const attempted = { ...requester, profileEnrichmentAttempted: true };
    profileRefreshCache.set(requester.id, {
      at: Date.now(),
      requester: attempted,
    });
    return attempted;
  }
}

function timezoneOf(requester?: Requester): string | undefined {
  if (!requester) return undefined;
  const ext = requester as Requester & { timezone?: string };
  return ext.timezone?.trim() || undefined;
}

function attachmentDedupeKeys(attachment: {
  id?: string;
  kind?: string;
  stageKey?: string;
  sha256?: string;
}): string[] {
  const keys: string[] = [];
  if (attachment.id) keys.push(`id:${attachment.id}`);
  if (attachment.kind === "staged" && attachment.stageKey) {
    keys.push(`stage:${attachment.stageKey}`);
  }
  if (attachment.sha256) keys.push(`sha256:${attachment.sha256}`);
  return keys;
}

type ThreadMessageLite = {
  text?: string;
  ts?: string;
  isBot?: boolean;
  user?: { name?: string; handle?: string; id?: string };
  attachments?: SlackFileRef[];
};

export type AgentThread = {
  conversationKey?: string;
  /** Subset of Thread.post(ui: Renderable) — plain strings are valid Renderables. */
  post: (ui: string) => Promise<unknown>;
  awaitChoice<T = unknown>(ui: Renderable): Promise<T>;
  getMessages?: () => Promise<ThreadMessageLite[]>;
  runAgent: (opts: {
    prompt: string | AgentContentPart[];
    context?: Array<{ description: string; value: string }>;
    tools?: ReturnType<typeof guardToolsByBundle>;
  }) => Promise<unknown>;
};

export interface TurnExecutionIdentity {
  executionId: string;
  forwardedMessageId: string;
  /** Set only by an upstream HITL approval handler. */
  remoteGitApproved?: boolean;
  /** The approved action specifically requires a GitHub pull request. */
  createPullRequest?: boolean;
}

export type AgentTurnOutcome =
  | { status: "completed"; terminalPersisted?: boolean }
  | { status: "interrupted" }
  | { status: "rejected"; reason: "duplicate" | "concurrent" };

export class AuthoritativeHarnessError extends Error {
  constructor(
    readonly failureKind: HarnessFailureKind,
    message: string,
    readonly terminalPersisted = false,
  ) {
    super(message);
    this.name = "AuthoritativeHarnessError";
  }
}

function channelFromThread(thread: { conversationKey?: string }): string {
  return (thread.conversationKey ?? "").split("::")[0] ?? "";
}

function formatInZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(now);
}

function calendarDateInZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function buildClockContext(timeZone: string): string {
  const now = new Date();
  const localDate = calendarDateInZone(now, timeZone);
  const utcDate = calendarDateInZone(now, "UTC");
  return [
    `Requester timezone: ${timeZone}`,
    `Requester local now: ${formatInZone(now, timeZone)} (calendar date ${localDate})`,
    `UTC now: ${formatInZone(now, "UTC")} (calendar date ${utcDate})`,
    `CRITICAL: When the user says "today", "tonight", "this morning", or "scheduled today",`,
    `interpret that as requester-local calendar date ${localDate} — NOT the UTC date`,
    `(${utcDate}). Evening events in US timezones often fall on the next UTC day.`,
  ].join("\n");
}

function buildTranscriptContext(messages: ThreadMessageLite[]): string {
  const lines = messages.slice(-40).map((m) => {
    const who =
      m.user?.name ?? m.user?.handle ?? (m.isBot ? "bot" : "unknown");
    const text = (m.text ?? "").replace(/\s+/g, " ").trim();
    return `${who}: ${text.slice(0, 500)}`;
  });
  return [
    "Messages already in this Slack thread (oldest → newest).",
    "Treat this as established context — do NOT ask the user to repeat it.",
    "If they correct you, re-check facts (web_search) against this thread.",
    "If the latest message is only a greeting but an earlier user question in",
    "this transcript still has no bot reply after it, answer that pending",
    "question now instead of only greeting back.",
    "Emails, assignees, titles, and descriptions already stated here are FACTS",
    "for this turn — reuse them; never claim you cannot see earlier messages.",
    "",
    ...lines,
  ].join("\n");
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Prefer emails from human messages in this conversation (newest wins). */
function emailsFromTranscript(messages: ThreadMessageLite[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.isBot) continue;
    const text = m.text ?? "";
    for (const match of text.match(EMAIL_RE) ?? []) {
      const email = match.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      found.push(email);
    }
  }
  return found;
}

function historySortKey(ts?: string, at?: number): number {
  if (ts) {
    const n = Number(ts);
    if (Number.isFinite(n)) return n;
  }
  if (typeof at === "number") return at / 1000;
  return 0;
}

/** Normalize thread text so SessionEventDO replay dedupes against Slack history. */
function historyDedupeKey(text: string): string {
  let normalized = extractMessageOverrides(text).cleanedText;
  normalized = normalized
    .replace(/<[^|>\s]+\|([^>]+)>/g, "$1")
    .replace(/<@[^>]+>/g, "")
    .replace(/<#[^>]+>/g, "")
    .replace(/<!([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1");
  return normalized.replace(/\s+/g, " ").trim().toLowerCase();
}

function mergeHistory(
  slack: ThreadMessageLite[],
  memory: Array<{
    role: "user" | "bot";
    text: string;
    name?: string;
    at?: number;
    attachments?: ThreadMessageLite["attachments"];
  }>,
): ThreadMessageLite[] {
  type Row = ThreadMessageLite & { _sort: number };
  const rows: Row[] = slack.map((m) => ({
    text: m.text,
    isBot: m.isBot,
    ts: m.ts,
    user: m.user,
    attachments: m.attachments,
    _sort: historySortKey(m.ts),
  }));
  const seen = new Set(
    slack
      .map((m) => historyDedupeKey(m.text ?? ""))
      .filter(Boolean),
  );
  for (const m of memory) {
    const key = historyDedupeKey(m.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      text: m.text,
      isBot: m.role === "bot",
      user: m.name ? { name: m.name } : undefined,
      attachments: m.attachments,
      _sort: historySortKey(undefined, m.at),
    });
  }
  rows.sort((a, b) => a._sort - b._sort);
  return rows.map(({ _sort, ...rest }) => rest);
}

function embedTranscriptInPrompt(
  prompt: string | AgentContentPart[],
  history: ThreadMessageLite[],
): string | AgentContentPart[] {
  if (history.length === 0) return prompt;
  const block = [
    "[Slack thread so far — established facts for this conversation]",
    ...history.slice(-40).map((m) => {
      const who =
        m.user?.name ?? m.user?.handle ?? (m.isBot ? "bot" : "user");
      return `${who}: ${(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400)}`;
    }),
    "[/Slack thread]",
    "",
    "Latest user message:",
  ].join("\n");

  if (typeof prompt === "string") {
    return `${block}\n${prompt}`;
  }
  return [{ type: "text", text: `${block}\n` }, ...prompt];
}

/**
 * `[Requester Context]` block (SPEC §5-A5 item 5) — used both as the
 * harness's `requesterContext` field and as an extra AG-UI context entry so
 * the running system prompt's PR-attribution guidance (`Prompted by: @<handle>`)
 * has something to read regardless of which path a turn takes. Lines with no
 * data are omitted entirely rather than printed empty.
 */
const VERIFIED_GITHUB_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VERIFIED_SLACK_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,79})$/;

function safeSlackDisplayName(value?: string): string | undefined {
  const normalized = value
    ?.normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._'()-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return normalized && /^[\p{L}\p{N}]/u.test(normalized)
    ? normalized
    : undefined;
}

export function buildRequesterContextBlock(
  requester?: Requester,
  actor?: RequestActor,
): string | undefined {
  if (actor?.kind === "slack_automation") {
    const lines = ["[Requester Context]", "Actor: Slack automation"];
    const name = safeSlackDisplayName(actor.displayName);
    if (name) lines.push(`Name: ${name}`);
    if (actor.botId) lines.push(`Bot ID: ${actor.botId.slice(0, 256)}`);
    if (actor.appId) lines.push(`App ID: ${actor.appId.slice(0, 256)}`);
    return lines.join("\n");
  }
  if (!requester) return undefined;
  const lines: string[] = [];
  const githubHandle = requester.githubHandle?.trim();
  const slackHandle = requester.handle?.trim();
  const name =
    safeSlackDisplayName(requester.name) ??
    (slackHandle && VERIFIED_SLACK_HANDLE_RE.test(slackHandle)
      ? slackHandle
      : undefined);
  if (name) lines.push(`Name: ${name}`);
  if (slackHandle && VERIFIED_SLACK_HANDLE_RE.test(slackHandle)) {
    lines.push(`Slack: @${slackHandle}`);
  }
  const email = requester.email?.trim();
  if (email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    lines.push(`Email: ${email}`);
  }
  if (githubHandle && VERIFIED_GITHUB_HANDLE_RE.test(githubHandle)) {
    lines.push(`GitHub: @${githubHandle}`);
  }
  const attribution =
    githubHandle && VERIFIED_GITHUB_HANDLE_RE.test(githubHandle)
      ? `@${githubHandle}`
      : slackHandle && VERIFIED_SLACK_HANDLE_RE.test(slackHandle)
        ? `@${slackHandle}`
        : safeSlackDisplayName(requester.name);
  if (attribution) lines.push(`Prompted by: ${attribution}`);
  if (lines.length === 0) return undefined;
  return ["[Requester Context]", ...lines].join("\n");
}

/**
 * Deterministic per-thread key for the harness / `SessionEventDO`, matching
 * `bot-engine.ts`'s render-obligation `threadKey` convention
 * (`slack:{channel}:{threadTs}`): the conversationKey's own scope segment
 * wins over any request-scoped inbound target, because a concurrent turn in
 * the same isolate can overwrite the latter (see `inbound-target.ts`).
 */
function deriveHarnessThreadKey(
  channelId: string,
  conversationKey: string,
  thread: object,
): string {
  const scope = conversationKey.split("::")[1];
  const inbound = getInboundMessage(conversationKey, thread);
  const threadTs = firstSlackTs(scope, inbound?.threadTs, inbound?.ts);
  // Same key the obligation writer / stop path derive — sessions, obligations
  // and stops must all land on the same SessionEventDO partition.
  return slackObligationThreadKey(channelId, threadTs);
}

/** Text plus human-readable attachment names; binary content travels separately. */
function harnessPromptText(prompt: string | AgentContentPart[]): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((p) => {
      if (p.type === "text") return [p.text];
      if (p.attachment) {
        return [`[Attachment: ${p.attachment.name} (${p.attachment.mimeType}, ${p.attachment.size} bytes)]`];
      }
      // Native media parts duplicate the explicit attachment metadata part.
      return [];
    })
    .join("\n");
}

function harnessAttachments(prompt: string | AgentContentPart[]): PreparedAttachment[] {
  if (typeof prompt === "string") return [];
  return prompt
    .flatMap((part) => part.attachment ? [part.attachment] : []);
}

function agentRuntimePrompt(prompt: string | AgentContentPart[]): string | AgentContentPart[] {
  return prompt;
}

/** SPEC §3.6: transcript re-feed, truncated to 24k chars from the most recent end. */
const HARNESS_TRANSCRIPT_MAX_CHARS = 24_000;

/** Same merged history `embedTranscriptInPrompt` uses, rendered as a flat transcript for the harness. */
function buildHarnessTranscript(history: ThreadMessageLite[]): string | undefined {
  if (history.length === 0) return undefined;
  const full = history
    .map((m) => {
      const who = m.user?.name ?? m.user?.handle ?? (m.isBot ? "bot" : "user");
      return `${who}: ${(m.text ?? "").replace(/\s+/g, " ").trim()}`;
    })
    .join("\n");
  return full.length > HARNESS_TRANSCRIPT_MAX_CHARS
    ? full.slice(full.length - HARNESS_TRANSCRIPT_MAX_CHARS)
    : full;
}

/** Structured metric line (SPEC.md §4.3's minimum counters), matching bot-engine.ts's convention. */
function logMetric(metric: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ metric, ...fields }));
}

/** True if `cleaned` has no user-visible content left after flag stripping. */
function isEmptyAfterStrip(cleaned: string | AgentContentPart[]): boolean {
  if (typeof cleaned === "string") return cleaned.trim() === "";
  if (cleaned.length === 0) return true;
  return cleaned.every((p) => p.type === "text" && !p.text.trim());
}

/** Short thread confirmation for a message that was only override flags. */
function formatOverrideConfirmation(resolved: {
  effectiveModel?: string;
  effectiveHarnessType?: string;
  effectiveReasoning?: string;
}): string {
  const bits: string[] = [];
  if (resolved.effectiveModel) bits.push(`model: ${resolved.effectiveModel}`);
  if (resolved.effectiveHarnessType)
    bits.push(`harness: ${resolved.effectiveHarnessType}`);
  if (resolved.effectiveReasoning)
    bits.push(`reasoning: ${resolved.effectiveReasoning}`);
  const summary = bits.join(", ") || "preference";
  return `✓ Active: ${summary} (applies to this thread)`;
}

function promptOverrideText(prompt: string | AgentContentPart[]): string {
  return typeof prompt === "string"
    ? prompt
    : prompt
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ");
}

function harnessCapability(env: Env): { ok: true } | { ok: false; reason: string } {
  if (!env.HARNESS && !env.HARNESS_URL) {
    return { ok: false, reason: "the Claude Code harness is not connected" };
  }
  return { ok: true };
}

async function postVisibleRuntimeRejection(
  thread: AgentThread,
  message: string,
): Promise<AgentTurnOutcome> {
  try {
    markThreadNextRenderFinal(thread);
    await thread.post(`⚠️ ${message}`);
  } catch (err) {
    if (err instanceof Error && err.message === "active_turn_render_suppressed") {
      return { status: "interrupted" };
    }
    throw err;
  }
  return { status: "completed" };
}

/**
 * Strip override flags from `prompt` (SPEC §2.2, GOAL Phase A3), merge them
 * into the thread's sticky overrides, and return the cleaned prompt plus the
 * effective Claude model/harness for this turn. Reasoning flags are rejected
 * before this function can persist or execute them.
 *
 * String prompts are stripped directly. `AgentContentPart[]` prompts are
 * stripped per text part (a flag never spans parts), but flags are *detected*
 * from the concatenation of all text parts so a message split across parts
 * still resolves a single sticky merge.
 */
async function stripOverridesFromPrompt(
  store: Parameters<typeof resolveThreadOverrides>[0],
  conversationKey: string,
  prompt: string | AgentContentPart[],
  channelDefaults?: Parameters<typeof resolveThreadOverrides>[3],
): Promise<{
  cleanedPrompt: string | AgentContentPart[];
  resolved: ResolvedThreadOverrides;
}> {
  if (typeof prompt === "string") {
    const resolved = await resolveThreadOverrides(
      store,
      conversationKey,
      prompt,
      channelDefaults,
    );
    return { cleanedPrompt: resolved.cleanedText, resolved };
  }

  const detectionText = prompt
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
  const resolved = await resolveThreadOverrides(
    store,
    conversationKey,
    detectionText,
    channelDefaults,
  );
  const cleanedPrompt = prompt.map((p) =>
    p.type === "text"
      ? { ...p, text: extractMessageOverrides(p.text).cleanedText }
      : p,
  );
  return { cleanedPrompt, resolved };
}

export async function runBundledAgentTurn(
  env: Env,
  thread: AgentThread,
  promptIn: string | AgentContentPart[],
  requesterIn?: Requester,
  executionIdentity?: TurnExecutionIdentity,
): Promise<AgentTurnOutcome> {
  const requestContext = requireRequestContext(thread);
  const teamId = requestContext.teamId;
  const channelId = channelFromThread(thread);
  const conversationKey = thread.conversationKey ?? "";
  const store = createDurableObjectStore(env.BOT_STATE);
  const exact = getTurnExecutionContext(thread);
  if (executionIdentity && !exact) {
    throw new Error("active_turn_context_required");
  }
  const exactTurnPending = async (): Promise<boolean> => {
    // Direct unit tests may exercise this exported core without the production
    // lifecycle wrapper. Every production caller supplies executionIdentity.
    if (!executionIdentity) return true;
    if (!exact) return false;
    const snapshot = await store.activeTurn.get(exact.threadKey);
    return Boolean(
      snapshot &&
      snapshot.record.executionId === exact.executionId &&
      snapshot.status === "pending" &&
      !snapshot.stopEventId &&
      !snapshot.renderToken &&
      !snapshot.effectToken,
    );
  };
  if (!(await exactTurnPending())) return { status: "interrupted" };
  const requester =
    requestContext.actor.kind === "slack_user"
      ? await ensureRequesterProfile(env, requesterIn)
      : requesterIn;
  if (!(await exactTurnPending())) return { status: "interrupted" };

  // Capability validation precedes sticky persistence. Unsupported provider
  // flags and disconnected Claude selections must never be saved/confirmed as
  // if a runtime switch took effect.
  const requestedOverrides = extractMessageOverrides(promptOverrideText(promptIn));
  if (requestedOverrides.errors.length > 0) {
    return postVisibleRuntimeRejection(
      thread,
      `${requestedOverrides.errors.join("; ")}. No preference was saved.`,
    );
  }
  if (requestedOverrides.harnessType === "claudecode") {
    const capability = harnessCapability(env);
    if (!capability.ok) {
      return postVisibleRuntimeRejection(
        thread,
        `${capability.reason}; this turn was not sent to another runtime and no preference was saved.`,
      );
    }
  }

  const { config, bundle } = await loadTurnAccess(
    env.WORKSPACE_CONFIG,
    teamId,
    channelId,
  );
  if (!(await exactTurnPending())) return { status: "interrupted" };

  // Phase A3 (GOAL.md / SPEC §2.2): parse + strip --model/--harness/-rsn
  // flags before anything downstream sees raw text, and resolve sticky
  // thread-level overrides (last flag wins per-field, absent fields keep the
  // stored value).
  const { cleanedPrompt, resolved: overrides } = await stripOverridesFromPrompt(
    store,
    conversationKey,
    promptIn,
    config.runtimeDefaults,
  );
  if (!(await exactTurnPending())) return { status: "interrupted" };
  let prompt = cleanedPrompt;

  if (overrides.hasMessageFlags && isEmptyAfterStrip(prompt)) {
    try {
      markThreadNextRenderFinal(thread);
      await thread.post(formatOverrideConfirmation(overrides));
    } catch (err) {
      if (err instanceof Error && err.message === "active_turn_render_suppressed") {
        return { status: "interrupted" };
      }
      throw err;
    }
    return { status: "completed" };
  }

  const allowed = new Set(
    resolveAllowedTools([...ALL_EDGE_TOOL_NAMES], bundle),
  );

  if (config.policies.allowMemoryWrite === false) {
    allowed.delete("memory_write");
  }
  if (config.policies.allowTasks === false) {
    allowed.delete("start_task");
    allowed.delete("research_progress");
  }
  allowed.add("show_permissions");
  if (requestContext.actor.kind === "slack_automation") {
    for (const toolName of [...allowed]) {
      if (!AUTOMATION_SAFE_TOOLS.has(toolName)) allowed.delete(toolName);
    }
  }

  const permissionSnapshot = buildPermissionSnapshot({
    teamId,
    channelId,
    conversationKey,
    executionId: executionIdentity?.executionId,
    actor: requestContext.actor,
    config,
    bundle,
    allToolNames: ALL_EDGE_TOOL_NAMES,
    allowedTools: allowed,
    runtime: {
      ...(overrides.effectiveHarnessType === "claudecode"
        ? { harnessType: "claudecode" as const }
        : {}),
      ...(overrides.effectiveModel ? { model: overrides.effectiveModel } : {}),
      harnessSource: overrides.harnessSource,
      modelSource: overrides.modelSource,
      harnessConnected: harnessCapability(env).ok,
    },
  });
  bindPermissionSnapshot(thread, permissionSnapshot);
  console.log(JSON.stringify({
    metric: "permission_snapshot_generated",
    actorKind: requestContext.actor.kind,
    surface: "agent",
  }));
  console.log(JSON.stringify({
    metric: "runtime_default_selected",
    harnessSource: overrides.harnessSource,
    modelSource: overrides.modelSource,
  }));

  const timeZone =
    timezoneOf(requester) ||
    env.DEFAULT_USER_TIMEZONE?.trim() ||
    "America/Los_Angeles";

  const promptText =
    typeof prompt === "string"
      ? prompt
      : prompt
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ");

  const humanActor = requestContext.actor.kind === "slack_user";
  const repositoryCodingIntent =
    humanActor &&
    (executionIdentity?.createPullRequest === true ||
      isRepositoryCodingIntent(promptText));
  const selectedClaudeHarness = overrides.effectiveHarnessType === "claudecode";
  const useHarness = selectedClaudeHarness || repositoryCodingIntent;
  if (useHarness) {
    const capability = harnessCapability(env);
    if (!capability.ok) {
      return postVisibleRuntimeRejection(
        thread,
        `${capability.reason}. This authoritative turn was not sent to AG-UI.`,
      );
    }
    if (repositoryCodingIntent && !env.HARNESS_REPO_URL) {
      return postVisibleRuntimeRejection(
        thread,
        "repository coding requires HARNESS_REPO_URL; this turn was not sent to AG-UI.",
      );
    }
  }

  // Assistant thread title from the first user message (SPEC §3.5). Durable
  // dedup makes this once-per-thread across isolates; errors are best-effort.
  if (env.SLACK_BOT_TOKEN && promptText.trim() && conversationKey) {
    try {
      const titleKey = `title:${conversationKey}`;
      const titled = await store.kv.get<boolean>(titleKey);
      if (!titled) {
        const scope = conversationKey.split("::")[1];
        const inbound = getInboundMessage(conversationKey, thread);
        // The conversation scope is authoritative for this turn. Request-scoped
        // inbound metadata may describe a reply while the title belongs to the
        // root assistant thread.
        const titleThreadTs = firstSlackTs(scope, inbound?.threadTs, inbound?.ts);
        if (titleThreadTs) {
          const fence = getTurnExecutionContext(thread);
          if (!fence) throw new Error("exact_execution_context_required_for_title");
          const setTitle = () => createSlackWebClient(env.SLACK_BOT_TOKEN!, {
            scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
          }).setTitle({
              channel_id: channelId,
              thread_ts: titleThreadTs,
              title: promptText.trim().slice(0, 100),
            });
          const result = await renderActiveTurnStep(store, fence, setTitle, false, {
            output: false,
            isDefinitiveFailure: isDefinitiveSlackFailure,
          });
          if (result.status !== "rendered") {
            return { status: "interrupted" };
          }
          if (!(await exactTurnPending())) return { status: "interrupted" };
          // Mark only after Slack confirms the effect; failures remain retryable.
          await store.kv.set(titleKey, true, 30 * 86_400_000);
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        ["active_turn_render_suppressed", "active_turn_title_suppressed"].includes(err.message)
      ) return { status: "interrupted" };
      console.warn(
        "[agent-turn] setTitle failed",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  // Durable mid-thread memory (survives isolate hops / empty Slack history).
  if (promptText.trim()) {
    try {
      await appendThreadMemory(store, conversationKey, {
        role: "user",
        text: promptText.trim(),
        at: Date.now(),
        name: requester?.name ?? requester?.handle,
      });
    } catch (err) {
      console.error(
        "[agent-turn] appendThreadMemory failed",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  let slackHistory: ThreadMessageLite[] = [];
  if (typeof thread.getMessages === "function") {
    try {
      slackHistory = await thread.getMessages();
    } catch (err) {
      console.error(
        "[agent-turn] getMessages failed",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  // Re-stage bounded prior-thread files so follow-ups survive isolate loss and
  // use the same AG-UI/harness transport as files on the current event.
  const priorAttachments = slackHistory
    .filter((message) => message.ts !== requestContext.inbound?.ts)
    .flatMap((message) => message.attachments ?? [])
    .slice(-5);
  const seenAttachmentKeys = new Set<string>();
  for (const file of priorAttachments) {
    for (const key of attachmentDedupeKeys({ id: file.id })) {
      seenAttachmentKeys.add(key);
    }
  }
  if (priorAttachments.length > 0 && env.SLACK_BOT_TOKEN) {
    const restored = await buildFileContentParts(
      priorAttachments,
      env.SLACK_BOT_TOKEN,
      env.BLOBS ? { stage: createR2AttachmentStager(env.BLOBS) } : {},
    );
    if (restored.parts.length > 0 || restored.notes.length > 0) {
      prompt = mergePromptParts(
        prompt,
        restored.parts,
        restored.notes.map((note) => `prior-thread ${note}`),
      );
    }
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  let durableHistory: Awaited<ReturnType<typeof readThreadMemory>> = [];
  try {
    durableHistory = await readThreadMemory(store, conversationKey);
  } catch (err) {
    console.error(
      "[agent-turn] readThreadMemory failed",
      err instanceof Error ? err.message : err,
    );
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  let sessionHistory: ReturnType<typeof reconstructSessionHistory> = [];
  if (env.SESSION_EVENTS) {
    try {
      const threadKey = deriveHarnessThreadKey(channelId, conversationKey, thread);
      const session = env.SESSION_EVENTS.get(env.SESSION_EVENTS.idFromName(threadKey)) as unknown as {
        replay(afterEventId?: number): Promise<Parameters<typeof reconstructSessionHistory>[0]>;
      };
      sessionHistory = reconstructSessionHistory(
        await session.replay(),
        executionIdentity?.executionId,
      );
    } catch (err) {
      throw new Error(
        `session_event_replay_failed:${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  // SessionEventDO is the canonical isolate-loss source. Rehydrate its file
  // refs through the same bounded Slack/R2 path even when Slack history is
  // empty; structured tool results remain in `sessionHistory` text below.
  const canonicalAttachments = sessionHistory
    .flatMap((message) => message.attachments ?? [])
    .filter((attachment) => {
      const keys = attachmentDedupeKeys(attachment);
      return keys.length === 0 || !keys.some((key) => seenAttachmentKeys.has(key));
    })
    .slice(-5);
  if (canonicalAttachments.length > 0) {
    const restored = contentPartsFromCanonicalAttachments(canonicalAttachments);
    if (restored.parts.length > 0 || restored.notes.length > 0) {
      prompt = mergePromptParts(
        prompt,
        restored.parts,
        restored.notes.map((note) => `canonical-session ${note}`),
      );
    }
  }
  if (!(await exactTurnPending())) return { status: "interrupted" };

  const history = mergeHistory(slackHistory, [...sessionHistory, ...durableHistory]);

  const transcriptEmails = emailsFromTranscript(history);
  for (const match of promptText.match(EMAIL_RE) ?? []) {
    const email = match.toLowerCase();
    if (!transcriptEmails.includes(email)) transcriptEmails.push(email);
  }

  const draft = parseTicketDraft(history);
  const fieldCandidates = candidateFieldLines(history);
  const lastIssue = parseLastCreatedIssue(history);
  const requesterEmail = requester?.email?.trim() || "";
  // Default assignee = Slack profile email. Explicit thread email only overrides
  // when the user named someone else (not when asking us to invent an email).
  const assigneeEmail =
    draft.email || requesterEmail || transcriptEmails[transcriptEmails.length - 1] || "";

  const toolContext: Array<{ description: string; value: string }> = [
    { description: "systemPrompt", value: config.systemPrompt },
    { description: "accessBundleId", value: bundle.id },
    {
      description: "allowedTools",
      value: JSON.stringify([...allowed]),
    },
    {
      description: "secretRefs",
      value: JSON.stringify(bundle.secretRefs),
    },
    {
      description: "mcpEndpoints",
      value: JSON.stringify(bundle.mcpEndpoints),
    },
    { description: "teamId", value: teamId },
    { description: "channelId", value: channelId },
    {
      description: "Requesting Slack user",
      value: JSON.stringify({
        id: requester?.id ?? "",
        name: requester?.name ?? requester?.handle ?? "",
        email: requester?.email ?? "",
        handle: requester?.handle ?? "",
        timezone: timeZone,
      }),
    },
    {
      description: "Clock / timezone for this turn",
      value: buildClockContext(timeZone),
    },
  ];

  // SPEC §5-A5 item 5: pass the requester block to the harness AND (small
  // win) append it to AG-UI context too, so PR-attribution guidance in the
  // container's SYSTEM_PROMPT — and any future AG-UI attribution use — has
  // something to read regardless of which path this turn takes.
  const requesterContextBlock = buildRequesterContextBlock(
    requester,
    requestContext.actor,
  );
  if (requesterContextBlock) {
    toolContext.push({
      description: "Requester Context",
      value: requesterContextBlock,
    });
  }

  if (humanActor && assigneeEmail) {
    toolContext.push({
      description: "Linear assignee email for this conversation",
      value: [
        `Default Linear assignee email: ${assigneeEmail}`,
        requesterEmail && assigneeEmail === requesterEmail
          ? "Source: requesting Slack user's profile (users.info)."
          : "Source: this Slack conversation (explicit email or transcript).",
        "For create / file / assign-to-me requests, use this email as assigneeEmail.",
        "NEVER ask the user for their email while this is set.",
        "Only ask for an email when assigning to a DIFFERENT person and you do not know theirs.",
      ].join("\n"),
    });
  } else if (humanActor && requester?.id) {
    toolContext.push({
      description: "Linear assignee email for this conversation",
      value: [
        "Requester Slack user id is known but profile email was empty after users.info.",
        "Do NOT invent an email. Prefer filing without assignee, or ask once.",
      ].join("\n"),
    });
  }

  if (draft.title || draft.description || draft.email || fieldCandidates.length > 0) {
    toolContext.push({
      description: "Pending Linear ticket draft",
      value: formatDraftContext(
        {
          ...draft,
          email: draft.email ?? (assigneeEmail || undefined),
        },
        fieldCandidates,
      ),
    });
  }

  if (lastIssue) {
    toolContext.push({
      description: "Last created Linear issue in this thread",
      value: formatLastIssueContext(lastIssue),
    });
  }

  // Phase A3 (GOAL.md / SPEC §2.2): tell the model about a recorded
  // model/harness preference instead of silently ignoring it. Real
  // passthrough targets the Phase A5 container; today this keeps the agent
  // honest if the user asks whether the switch "took".
  if (overrides.effectiveModel || overrides.effectiveHarnessType) {
    const requested: string[] = [];
    if (overrides.effectiveModel)
      requested.push(`model ${overrides.effectiveModel}`);
    if (overrides.effectiveHarnessType)
      requested.push(`harness ${overrides.effectiveHarnessType}`);
    toolContext.push({
      description: "model preference",
      value: useHarness
        ? [
            `The user requested ${requested.join(" / ")} for this thread.`,
            "This turn is running on the Claude Code harness container as",
            "requested.",
          ].join(" ")
        : [
            `The user requested ${requested.join(" / ")} for this thread.`,
            "This preference is recorded and sticky for the thread, but the",
            "current runtime may not support switching the underlying",
            "model/harness yet. If asked, acknowledge that the preference is",
            "recorded rather than claiming it took effect or silently ignoring it.",
          ].join(" "),
    });
  }

  // Each AG-UI run starts with a fresh agent message list (Worker isolates /
  // stub conversationStore). Inject the live Slack thread so the model does
  // not depend on calling read_thread — and cannot claim amnesia mid-thread.
  if (history.length > 0) {
    toolContext.push({
      description: "Current Slack thread transcript",
      value: buildTranscriptContext(history),
    });
  } else {
    console.warn(
      "[agent-turn] empty transcript",
      conversationKey,
      "assigneeEmail=",
      assigneeEmail || "(none)",
      "slack=",
      slackHistory.length,
      "durable=",
      durableHistory.length,
    );
  }

  const enrichedPrompt = embedTranscriptInPrompt(prompt, history);

  // The service-bound AG-UI runtime uses this exact durable identity as its
  // cross-isolate control key. bot-engine also copies it to an HTTP header;
  // keeping it in AG-UI context makes the wire request self-describing.
  if (executionIdentity?.executionId) {
    toolContext.push({
      description: "OpenTag execution control",
      value: JSON.stringify({ executionId: executionIdentity.executionId }),
    });
  }

  if (useHarness) {
    if (!(await exactTurnPending())) return { status: "interrupted" };
    const harnessThreadKey = deriveHarnessThreadKey(
      channelId,
      conversationKey,
      thread,
    );
    // Production Slack callers always pass the lifecycle-issued identity.
    // The deterministic prompt tuple is retained only for direct unit/admin
    // invocations; it never fabricates a retry-defeating random id.
    const identity: TurnExecutionIdentity = executionIdentity ?? await makeWireTurnIdentity(
      "direct-agent-turn",
      [
        teamId,
        conversationKey,
        requireRequestContext(thread).inbound?.identity ??
          requireRequestContext(thread).inbound?.ts ?? harnessPromptText(prompt),
      ],
    );
    const codingTask = repositoryCodingIntent;
    if (!(await exactTurnPending())) return { status: "interrupted" };
    const harnessResult = await runHarnessTurn(env, {
      threadKey: harnessThreadKey,
      conversationKey,
      executionId: identity.executionId,
      forwardedMessageId: identity.forwardedMessageId,
      prompt: harnessPromptText(prompt),
      attachments: harnessAttachments(prompt),
      model: overrides.effectiveModel,
      requesterContext: requesterContextBlock,
      transcript: buildHarnessTranscript(history),
      codingTask,
      remoteGitApproved:
        humanActor && identity.remoteGitApproved === true,
      createPullRequest:
        humanActor && identity.createPullRequest === true,
      permissionSnapshot,
    });

    // Stop owns the sole durable terminal transition. Never fall back to
    // AG-UI and never post accumulated text after an interrupt.
    if (!harnessResult.ok && harnessResult.failureKind === "interrupted") {
      return { status: "interrupted" };
    }

    // These failures mean the turn either already ran/is running, or the
    // harness completed but its terminal record could not be committed.
    // Falling back would duplicate coding work. Surface persistence failure
    // to the outer error path; redelivery/concurrency are intentional no-ops.
    if (
      !harnessResult.ok &&
      (harnessResult.failureKind === "duplicate" ||
        harnessResult.failureKind === "concurrent")
    ) {
      return { status: "rejected", reason: harnessResult.failureKind };
    }

    if (harnessResult.ok) {
      const text = harnessResult.text.trim();
      // Never-silent guarantee: even a nominally "ok" turn must not post
      // nothing (GOAL.md house rule / SPEC §3.1 taxonomy — error_visible /
      // answer_visible, never silent).
      const target = (thread as unknown as {
        deps?: { replyTarget?: { __opentagExecutionFence?: unknown } };
      }).deps?.replyTarget;
      if (target?.__opentagExecutionFence) {
        try {
          markThreadNextRenderFinal(thread);
          await thread.post(
            text || "_(Claude Code harness turn completed with no output.)_",
          );
        } catch (err) {
          if (err instanceof Error && err.message === "active_turn_render_suppressed") {
            return { status: "interrupted" };
          }
          throw err;
        }
      } else {
        // Direct unit/library callers do not have the production adapter's
        // per-target fence. Preserve the same exact suppression semantics.
        const delivery = await deliverActiveTurnOutput(
          store,
          { threadKey: harnessThreadKey, executionId: identity.executionId },
          async () => {
            await thread.post(
              text || "_(Claude Code harness turn completed with no output.)_",
            );
          },
        );
        if (delivery !== "delivered") return { status: "interrupted" };
      }
      return {
        status: "completed",
        terminalPersisted: harnessResult.terminalPersisted,
      };
    }

    // A selected/authoritative harness is never allowed to fall through to a
    // different runtime after any harness-side failure.
    throw new AuthoritativeHarnessError(
      harnessResult.failureKind,
      harnessResult.error,
      harnessResult.terminalPersisted,
    );
  }

  if (!(await exactTurnPending())) return { status: "interrupted" };
  await thread.runAgent({
    prompt: agentRuntimePrompt(enrichedPrompt),
    context: toolContext,
    tools: guardToolsByBundle(
      ALL_EDGE_TOOLS.filter((t) => allowed.has(t.name)),
      allowed,
    ),
  });
  return { status: "completed" };
}
