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
import { getCurrentTeamId } from "./request-context.js";
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
import type { AgentContentPart } from "./slack/download-files.js";
import { createSlackWebClient } from "./slack/web-api.js";

type Requester = {
  id?: string;
  name?: string;
  handle?: string;
  email?: string;
  /** IANA tz from Slack users.info (e.g. America/Los_Angeles). */
  timezone?: string;
};

/** Ensure we have profile email from Slack (users:read.email). */
async function ensureRequesterProfile(
  env: Env,
  requester?: Requester,
): Promise<Requester | undefined> {
  if (!requester?.id) return requester;
  if (requester.email?.trim() && timezoneOf(requester)) return requester;
  if (!env.SLACK_BOT_TOKEN) return requester;
  try {
    const fresh = await createSlackWebClient(env.SLACK_BOT_TOKEN).resolveUser(
      requester.id,
    );
    const freshTz = timezoneOf(fresh as Requester);
    return {
      ...requester,
      email: fresh.email?.trim() || requester.email,
      name: fresh.name ?? requester.name,
      handle: fresh.handle ?? requester.handle,
      timezone: freshTz ?? requester.timezone,
    };
  } catch (err) {
    console.warn(
      "[agent-turn] resolveUser refresh failed",
      err instanceof Error ? err.message : err,
    );
    return requester;
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

type AgentThread = {
  conversationKey?: string;
  post: (ui: never) => Promise<unknown>;
  getMessages?: () => Promise<ThreadMessageLite[]>;
  runAgent: (opts: {
    prompt: string | AgentContentPart[];
    context?: Array<{ description: string; value: string }>;
    tools?: ReturnType<typeof guardToolsByBundle>;
  }) => Promise<unknown>;
};

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

export async function runBundledAgentTurn(
  env: Env,
  thread: AgentThread,
  prompt: string | AgentContentPart[],
  requesterIn?: Requester,
): Promise<void> {
  const requester = await ensureRequesterProfile(env, requesterIn);
  const teamId = getCurrentTeamId();
  const channelId = channelFromThread(thread);
  const conversationKey = thread.conversationKey ?? "";
  const store = createDurableObjectStore(env.BOT_STATE);

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

  await thread.runAgent({
    prompt: enrichedPrompt,
    context: toolContext,
    tools: guardToolsByBundle(
      ALL_EDGE_TOOLS.filter((t) => allowed.has(t.name)),
      allowed,
    ),
  });
}
