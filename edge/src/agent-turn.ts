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
import type { Env } from "./env.js";
import type { AgentContentPart } from "./slack/download-files.js";

type Requester = {
  id?: string;
  name?: string;
  handle?: string;
  email?: string;
  /** IANA tz from Slack users.info (e.g. America/Los_Angeles). */
  timezone?: string;
};

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
    "",
    ...lines,
  ].join("\n");
}

export async function runBundledAgentTurn(
  env: Env,
  thread: AgentThread,
  prompt: string | AgentContentPart[],
  requester?: Requester,
): Promise<void> {
  const teamId = getCurrentTeamId();
  const channelId = channelFromThread(thread);

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

  // Each AG-UI run starts with a fresh agent message list (Worker isolates /
  // stub conversationStore). Inject the live Slack thread so the model does
  // not depend on calling read_thread — and cannot claim amnesia mid-thread.
  if (typeof thread.getMessages === "function") {
    try {
      const history = await thread.getMessages();
      if (history.length > 0) {
        toolContext.push({
          description: "Current Slack thread transcript",
          value: buildTranscriptContext(history),
        });
      }
    } catch (err) {
      console.error(
        "[agent-turn] getMessages failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  await thread.runAgent({
    prompt,
    context: toolContext,
    tools: guardToolsByBundle(
      ALL_EDGE_TOOLS.filter((t) => allowed.has(t.name)),
      allowed,
    ),
  });
}
