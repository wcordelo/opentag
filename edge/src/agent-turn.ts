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
import { requireRequestContext } from "./request-context.js";
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
import type { AgentContentPart } from "./slack/download-files.js";
export type { AgentContentPart } from "./slack/download-files.js";
import { createSlackWebClient } from "./slack/web-api.js";
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
    const fresh = await createSlackWebClient(env.SLACK_BOT_TOKEN).resolveUser(
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

type ThreadMessageLite = {
  text?: string;
  ts?: string;
  isBot?: boolean;
  user?: { name?: string; handle?: string; id?: string };
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

function mergeHistory(
  slack: ThreadMessageLite[],
  memory: Array<{ role: "user" | "bot"; text: string; name?: string }>,
): ThreadMessageLite[] {
  if (slack.length === 0) {
    return memory.map((m) => ({
      text: m.text,
      isBot: m.role === "bot",
      user: m.name ? { name: m.name } : undefined,
    }));
  }
  // Prefer Slack when present; append any DO-only user lines not already seen.
  const seen = new Set(
    slack.map((m) => (m.text ?? "").replace(/\s+/g, " ").trim().toLowerCase()),
  );
  const out = [...slack];
  for (const m of memory) {
    const key = m.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: m.text,
      isBot: m.role === "bot",
      user: m.name ? { name: m.name } : undefined,
    });
  }
  return out;
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

export function buildRequesterContextBlock(requester?: Requester): string | undefined {
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

/** Text parts joined; non-text parts (images, etc.) noted rather than dropped silently. */
function harnessPromptText(prompt: string | AgentContentPart[]): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((p) => (p.type === "text" ? p.text : "[attachment omitted]"))
    .join("\n");
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
  return `✓ Saved: ${summary} (applies to this thread)`;
}

/**
 * Strip override flags from `prompt` (SPEC §2.2, GOAL Phase A3), merge them
 * into the thread's sticky overrides, and return the cleaned prompt plus the
 * effective model/harness/reasoning for this turn.
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
): Promise<{
  cleanedPrompt: string | AgentContentPart[];
  resolved: ResolvedThreadOverrides;
}> {
  if (typeof prompt === "string") {
    const resolved = await resolveThreadOverrides(store, conversationKey, prompt);
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
  const requester = await ensureRequesterProfile(env, requesterIn);
  const teamId = requireRequestContext(thread).teamId;
  const channelId = channelFromThread(thread);
  const conversationKey = thread.conversationKey ?? "";
  const store = createDurableObjectStore(env.BOT_STATE);

  // Phase A3 (GOAL.md / SPEC §2.2): parse + strip --model/--harness/-rsn
  // flags before anything downstream sees raw text, and resolve sticky
  // thread-level overrides (last flag wins per-field, absent fields keep the
  // stored value).
  const { cleanedPrompt, resolved: overrides } = await stripOverridesFromPrompt(
    store,
    conversationKey,
    promptIn,
  );
  const prompt = cleanedPrompt;

  // Phase A5 (GOAL.md / SPEC §3.6 + §4.4): route to the Claude Code harness
  // container instead of the AG-UI agent when the thread's effective harness
  // is "claudecode" AND a way to reach the container is actually configured.
  // Neither binding set (the default until the container Worker deploys) —
  // this stays false and behavior is byte-for-byte what it was pre-A5.
  const useHarness =
    overrides.effectiveHarnessType === "claudecode" &&
    Boolean(env.HARNESS || env.HARNESS_URL);

  if (overrides.hasMessageFlags && isEmptyAfterStrip(prompt)) {
    try {
      await thread.post(formatOverrideConfirmation(overrides));
    } catch (err) {
      console.warn(
        "[agent-turn] override confirmation post failed",
        err instanceof Error ? err.message : err,
      );
    }
    return { status: "completed" };
  }

  const { config, bundle } = await loadTurnAccess(
    env.WORKSPACE_CONFIG,
    teamId,
    channelId,
  );
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

  // Assistant thread title from the first user message (SPEC §3.5). Durable
  // dedup makes this once-per-thread across isolates; errors are best-effort.
  if (env.SLACK_BOT_TOKEN && promptText.trim() && conversationKey) {
    try {
      const titled = await store.dedup.seen(
        `title:${conversationKey}`,
        30 * 86_400_000,
      );
      if (!titled) {
        const scope = conversationKey.split("::")[1];
        const inbound = getInboundMessage(conversationKey, thread);
        // The conversation scope is authoritative for this turn. Request-scoped
        // inbound metadata may describe a reply while the title belongs to the
        // root assistant thread.
        const titleThreadTs = firstSlackTs(scope, inbound?.threadTs, inbound?.ts);
        if (titleThreadTs) {
          await createSlackWebClient(env.SLACK_BOT_TOKEN).setTitle({
            channel_id: channelId,
            thread_ts: titleThreadTs,
            title: promptText.trim().slice(0, 100),
          });
        }
      }
    } catch (err) {
      console.warn(
        "[agent-turn] setTitle failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

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

  let durableHistory: Awaited<ReturnType<typeof readThreadMemory>> = [];
  try {
    durableHistory = await readThreadMemory(store, conversationKey);
  } catch (err) {
    console.error(
      "[agent-turn] readThreadMemory failed",
      err instanceof Error ? err.message : err,
    );
  }

  const history = mergeHistory(slackHistory, durableHistory);

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
  const requesterContextBlock = buildRequesterContextBlock(requester);
  if (requesterContextBlock) {
    toolContext.push({
      description: "Requester Context",
      value: requesterContextBlock,
    });
  }

  if (assigneeEmail) {
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
  } else if (requester?.id) {
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
    if (overrides.effectiveReasoning)
      requested.push(`reasoning effort ${overrides.effectiveReasoning}`);
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

  if (useHarness) {
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
    const codingTask =
      Boolean(env.HARNESS_REPO_URL) &&
      (identity.createPullRequest === true || isRepositoryCodingIntent(promptText));
    const harnessResult = await runHarnessTurn(env, {
      threadKey: harnessThreadKey,
      conversationKey,
      executionId: identity.executionId,
      forwardedMessageId: identity.forwardedMessageId,
      prompt: harnessPromptText(prompt),
      model: overrides.effectiveModel,
      requesterContext: requesterContextBlock,
      transcript: buildHarnessTranscript(history),
      codingTask,
      remoteGitApproved: identity.remoteGitApproved === true,
      createPullRequest: identity.createPullRequest === true,
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
      await thread.post(
        text || "_(Claude Code harness turn completed with no output.)_",
      );
      return {
        status: "completed",
        terminalPersisted: harnessResult.terminalPersisted,
      };
    }

    if (codingTask) {
      throw new AuthoritativeHarnessError(
        harnessResult.failureKind,
        harnessResult.error,
        harnessResult.terminalPersisted,
      );
    }

    // Harness configured but the turn failed (unavailable, duplicate
    // execution, container error, stream ended without `done`, etc.) — fall
    // back to the normal AG-UI path below so users aren't stranded, rather
    // than surfacing a harness-specific error. `runHarnessTurn` has already
    // given the SessionEventDO event log a terminal `done` event of its own.
    logMetric("harness_fallback", {
      threadKey: harnessThreadKey,
      error: harnessResult.error ?? "unknown",
    });
  }

  await thread.runAgent({
    prompt: enrichedPrompt,
    context: toolContext,
    tools: guardToolsByBundle(
      ALL_EDGE_TOOLS.filter((t) => allowed.has(t.name)),
      allowed,
    ),
  });
  return { status: "completed" };
}
