/**
 * Edge bot tools — Workers-safe triage + memory + research + Slack builtins.
 */
import { z } from "zod";
import { defineBotTool } from "@copilotkit/channels";
import { jsx, jsxs } from "@copilotkit/channels-ui/jsx-runtime";
import {
  Message,
  Header,
  Section,
  Context,
  Actions,
  Button,
} from "@copilotkit/channels-ui";
import { memorySearch, memoryWrite } from "../memory/knowledge-do.js";
import { startTask } from "../tasks/runtime.js";
import type { Env } from "../env.js";
import { getCurrentTeamId } from "../request-context.js";
import {
  IssueCard,
  IssueList,
  PageList,
  StatusCard,
  LinksCard,
  IncidentCard,
  issueCardSchema,
  issueListSchema,
  pageListSchema,
  statusSchema,
  linksSchema,
  incidentSchema,
} from "../components/cards.js";
import { guardToolsByBundle } from "./guard.js";

export { guardToolsByBundle } from "./guard.js";

/** Bound once when the bot isolate constructs tools. */
let boundEnv: Env | null = null;

export function bindToolEnv(env: Env): void {
  boundEnv = env;
}

function requireEnv(): Env {
  if (!boundEnv) throw new Error("tool env not bound — call bindToolEnv first");
  return boundEnv;
}

function conversationKeyOf(thread: unknown): string {
  return (
    (thread as { conversationKey?: string } | undefined)?.conversationKey ?? ""
  );
}

function channelFromThread(thread: unknown): string {
  return conversationKeyOf(thread).split("::")[0] ?? "";
}

function threadTsFromThread(thread: unknown): string | undefined {
  const scope = conversationKeyOf(thread).split("::")[1];
  if (!scope || scope === "dm" || scope.startsWith("slash::")) return undefined;
  return scope;
}

function ConfirmWriteCard(props: { action: string; detail?: string }) {
  const kids: unknown[] = [jsx(Header, { children: `📝 ${props.action}?` })];
  if (props.detail) {
    kids.push(jsx(Section, { children: props.detail }));
  }
  kids.push(
    jsx(Context, {
      children: "🔒 Nothing is written until you click Create.",
    }),
    jsxs(Actions, {
      children: [
        jsx(Button, {
          value: { confirmed: true },
          style: "primary",
          children: "Create",
        }),
        jsx(Button, {
          value: { confirmed: false },
          style: "danger",
          children: "Cancel",
        }),
      ],
    }),
  );
  return jsxs(Message, { accent: "#E2B340", children: kids });
}

export const confirmWriteTool = defineBotTool({
  name: "confirm_write",
  description:
    "Ask the user to approve a write before you perform it. Posts a " +
    "confirm/cancel card and BLOCKS until the user clicks; returns " +
    "whether they confirmed. Call before creating/modifying Linear or Notion.",
  parameters: z.object({
    action: z.string().describe("One-line summary of the write"),
    detail: z.string().optional().describe("Optional detail under the prompt"),
  }),
  async handler({ action, detail }, { thread }) {
    const choice = await thread.awaitChoice<{ confirmed?: boolean }>(
      ConfirmWriteCard({ action, detail }),
    );
    return choice?.confirmed
      ? "The user APPROVED the write — proceed."
      : "The user DECLINED — do not write; acknowledge and stop.";
  },
});

export const lookupSlackUserTool = defineBotTool({
  name: "lookup_slack_user",
  description:
    "Resolve a person to a Slack user ID so you can @-mention them. " +
    "Accepts a handle, display name, first name, or email. Returns " +
    "`found` and on success a `mention` string (e.g. `<@U123>`) — put that " +
    "string verbatim in your reply to ping them.",
  parameters: z.object({
    query: z
      .string()
      .min(1)
      .describe("Handle, display name, first name, or email."),
  }),
  async handler({ query }, { thread }) {
    const u = await thread.lookupUser(query);
    return u
      ? {
          found: true,
          query,
          userId: u.id,
          name: u.name,
          handle: u.handle,
          email: u.email,
          mention: `<@${u.id}>`,
        }
      : { found: false, query };
  },
});

export const readThreadTool = defineBotTool({
  name: "read_thread",
  description:
    "Fetch the messages in the current conversation thread so you can " +
    "summarize or act on them. Call before turning a conversation into a " +
    "Linear issue or Notion postmortem — never guess what was said.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    const messages = await thread.getMessages();
    return {
      count: messages.length,
      messages: messages.map((m) => ({
        user: m.user?.name ?? m.user?.handle ?? (m.isBot ? "bot" : "unknown"),
        text: m.text,
        ts: m.ts,
      })),
    };
  },
});

export const issueCardTool = defineBotTool({
  name: "issue_card",
  description:
    "Render ONE Linear issue as a rich card. Use for a single issue, or " +
    "right after creating one (set justCreated: true).",
  parameters: issueCardSchema,
  async handler(props, { thread }) {
    await thread.post(IssueCard(props));
    return "Displayed the issue card to the user.";
  },
});

export const issueListTool = defineBotTool({
  name: "issue_list",
  description:
    "Render a list of Linear issues as a card. Use whenever showing " +
    "multiple issues instead of prose. For a single issue, use issue_card.",
  parameters: issueListSchema,
  async handler(props, { thread }) {
    await thread.post(IssueList(props));
    return "Displayed the issue list to the user.";
  },
});

export const pageListTool = defineBotTool({
  name: "page_list",
  description:
    "Render a list of Notion pages as a card instead of writing them as prose.",
  parameters: pageListSchema,
  async handler(props, { thread }) {
    await thread.post(PageList(props));
    return "Displayed the Notion pages to the user.";
  },
});

export const showStatusTool = defineBotTool({
  name: "show_status",
  description:
    "Render a status card: heading plus a grid of label/value fields.",
  parameters: statusSchema,
  async handler(props, { thread }) {
    await thread.post(StatusCard(props));
    return "Posted the status card to the user.";
  },
});

export const showLinksTool = defineBotTool({
  name: "show_links",
  description: "Render a card of links (runbooks, dashboards, related pages).",
  parameters: linksSchema,
  async handler(props, { thread }) {
    await thread.post(LinksCard(props));
    return "Posted the links to the user.";
  },
});

export const showIncidentTool = defineBotTool({
  name: "show_incident",
  description:
    "Render an interactive incident card with Acknowledge/Escalate buttons. " +
    "BLOCKS until the user clicks; returns which action they took.",
  parameters: incidentSchema,
  async handler(props, { thread, user }) {
    const choice = await thread.awaitChoice<{ action?: string; id?: string }>(
      IncidentCard(props),
    );
    if (choice?.action === "ack") {
      const who = user?.name ?? user?.handle ?? user?.id ?? "someone";
      await thread.post(`✅ Acknowledged *${props.title}* — ack'd by ${who}`);
      return `The user ACKNOWLEDGED incident ${props.id}.`;
    }
    if (choice?.action === "escalate") {
      await thread.post(
        `🚨 Escalating *${props.title}* — paging the next on-call.`,
      );
      return `The user ESCALATED incident ${props.id}.`;
    }
    return "The user dismissed the incident card without choosing.";
  },
});

export const researchProgressTool = defineBotTool({
  name: "research_progress",
  description: "Post an interim progress update during deep research.",
  parameters: z.object({
    message: z.string().describe("Progress message to post."),
  }),
  async handler({ message }, { thread }) {
    await thread.post(`🔬 ${message}`);
    return "Posted progress update.";
  },
});

export const memorySearchTool = defineBotTool({
  name: "memory_search",
  description: "Search channel knowledge memory for relevant notes.",
  parameters: z.object({
    query: z.string(),
  }),
  async handler({ query }, { thread }) {
    const env = requireEnv();
    const teamId = getCurrentTeamId();
    const channelId = channelFromThread(thread);
    const hits = await memorySearch(env.KNOWLEDGE, teamId, channelId, query, 5);
    return hits.map((h) => ({ title: h.title, body: h.body.slice(0, 400) }));
  },
});

export const memoryWriteTool = defineBotTool({
  name: "memory_write",
  description: "Write a note into channel knowledge memory.",
  parameters: z.object({
    title: z.string(),
    body: z.string(),
  }),
  async handler({ title, body }, { thread }) {
    const env = requireEnv();
    const teamId = getCurrentTeamId();
    const channelId = channelFromThread(thread);
    await memoryWrite(env.KNOWLEDGE, {
      id: crypto.randomUUID(),
      teamId,
      channelId,
      title,
      body,
      updatedAt: new Date().toISOString(),
    });
    return "Saved to channel knowledge.";
  },
});

export const startTaskTool = defineBotTool({
  name: "start_task",
  description: "Start a long-running research task for the current thread.",
  parameters: z.object({
    objective: z.string(),
  }),
  async handler({ objective }, { thread }) {
    const env = requireEnv();
    const teamId = getCurrentTeamId();
    const channelId = channelFromThread(thread);
    const threadTs = threadTsFromThread(thread);
    const threadKey = `slack:${channelId}:${threadTs ?? channelId}`;
    const result = await startTask(env, {
      type: "research",
      teamId,
      threadKey,
      channelId,
      threadTs,
      payload: { objective },
    });
    if (result.status === "error") {
      await thread.post(
        `⚠️ Research failed: ${result.detail ?? "unknown"}\n` +
          `Hint: start the research Worker (\`npm run dev:research\`) and match INTERNAL_SECRET.`,
      );
      return result;
    }
    await thread.post(
      `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
    );
    return result;
  },
});

export const ALL_EDGE_TOOLS = [
  lookupSlackUserTool,
  readThreadTool,
  confirmWriteTool,
  issueCardTool,
  issueListTool,
  pageListTool,
  showStatusTool,
  showLinksTool,
  showIncidentTool,
  researchProgressTool,
  memorySearchTool,
  memoryWriteTool,
  startTaskTool,
] as const;

export const ALL_EDGE_TOOL_NAMES = ALL_EDGE_TOOLS.map((t) => t.name);
