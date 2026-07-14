/**
 * Edge bot tools — Workers-safe triage + memory + research + Slack builtins.
 */
import { z } from "zod";
import { defineBotTool, type BotTool } from "@copilotkit/channels";
import { jsx, jsxs } from "@copilotkit/channels-ui/jsx-runtime";
import {
  Message,
  Header,
  Section,
  Context,
  Actions,
  Button,
  Fields,
  Field,
} from "@copilotkit/channels-ui";
import { memorySearch, memoryWrite } from "../memory/knowledge-do.js";
import { cancelTask, startTask } from "../tasks/runtime.js";
import { getInboundMessage } from "../slack/inbound-target.js";
import { normalizeEmojiToken } from "../react-intent.js";
import type { Env } from "../env.js";
import { requireRequestContext } from "../request-context.js";
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
import { createDurableObjectStore } from "../store/index.js";
import { awaitChoiceDurable, newHitlChoiceId } from "../hitl/durable-choice.js";
import { coerceTicketFields } from "../slack/thread-memory.js";
import { getTurnExecutionContext } from "../slack/turn-execution-context.js";
import type { ActiveTurnEffectResource } from "../store/active-turn-types.js";

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

function requireStateStore() {
  return createDurableObjectStore(requireEnv().BOT_STATE);
}

async function assertExactTurnActive(thread: object): Promise<void> {
  const exact = getTurnExecutionContext(thread);
  if (!exact) throw new Error("active_turn_context_required");
  const snapshot = await requireStateStore().activeTurn.get(exact.threadKey);
  if (
    !snapshot ||
    snapshot.record.executionId !== exact.executionId ||
    snapshot.status !== "pending" ||
    snapshot.stopEventId !== undefined
  ) {
    throw new Error("active_turn_tool_suppressed");
  }
}

function exactExecutionGuarded<T extends BotTool>(tool: T): T {
  return {
    ...tool,
    async handler(args, ctx) {
      await assertExactTurnActive(ctx.thread);
      return tool.handler(args, ctx);
    },
  } as T;
}

/**
 * Fence direct non-Slack mutations in the lifecycle DO. A thrown transport
 * error is deliberately ambiguous: retain the token so Stop cannot promise
 * completion while the remote mutation may still apply. Successful returns
 * are definitive and release the token before another tool may start.
 */
async function runExactTurnEffect<T>(
  thread: object,
  effectName: string,
  action: () => Promise<T>,
  options?: {
    resource?: (value: T) => ActiveTurnEffectResource | undefined;
    cancelIfStopped?: (resource: ActiveTurnEffectResource) => Promise<void>;
  },
): Promise<T> {
  const exact = getTurnExecutionContext(thread);
  if (!exact) throw new Error("active_turn_context_required");
  const activeTurn = requireStateStore().activeTurn;
  const claim = await activeTurn.beginEffect({
    threadKey: exact.threadKey,
    executionId: exact.executionId,
    effectName,
  });
  if (claim.status !== "claimed") {
    throw new Error(
      claim.status === "cancelled" || claim.status === "missing"
        ? "active_turn_tool_suppressed"
        : "active_turn_effect_unavailable",
    );
  }
  let value: T;
  try {
    value = await action();
  } catch (err) {
    // Unknown RPC outcome: never clear. This is the irreversible fence that
    // prevents a false visible Stop ahead of a late mutation.
    throw err;
  }
  const resource = options?.resource?.(value);
  if (resource) {
    const snapshot = await activeTurn.get(exact.threadKey);
    if (
      !snapshot ||
      snapshot.record.executionId !== exact.executionId ||
      snapshot.effectToken !== claim.token
    ) {
      throw new Error("active_turn_effect_confirmation_failed");
    }
    if (snapshot.stopEventId) {
      // A Stop already recorded during the launch must quiesce the exact
      // returned task before the effect token can be released visibly.
      await options?.cancelIfStopped?.(resource);
    }
  }
  if (!await activeTurn.confirmEffect({
    threadKey: exact.threadKey,
    executionId: exact.executionId,
    token: claim.token,
    resource,
  })) {
    throw new Error("active_turn_effect_confirmation_failed");
  }
  await assertExactTurnActive(thread);
  return value;
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

function ConfirmWriteCard(props: {
  action: string;
  detail?: string;
  title?: string;
  description?: string;
  assigneeEmail?: string;
  team?: string;
  choiceId: string;
}) {
  const kids: unknown[] = [jsx(Header, { children: `📝 ${props.action}?` })];
  const fields: unknown[] = [];
  if (props.title) {
    fields.push(jsx(Field, { children: `**Title**\n${props.title}` }));
  }
  if (props.description) {
    fields.push(
      jsx(Field, { children: `**Description**\n${props.description}` }),
    );
  }
  if (props.team) {
    fields.push(jsx(Field, { children: `**Team**\n${props.team}` }));
  }
  if (props.assigneeEmail) {
    fields.push(
      jsx(Field, { children: `**Assignee**\n${props.assigneeEmail}` }),
    );
  }
  if (fields.length > 0) {
    kids.push(jsxs(Fields, { children: fields }));
  }
  if (props.detail) {
    kids.push(jsx(Section, { children: props.detail }));
  }
  if (!props.title && !props.description && !props.detail) {
    kids.push(jsx(Section, { children: props.action }));
  }
  kids.push(
    jsx(Context, {
      children: "🔒 Nothing is written until you click Create.",
    }),
    jsxs(Actions, {
      children: [
        jsx(Button, {
          value: { confirmed: true, choiceId: props.choiceId },
          style: "primary",
          children: "Create",
        }),
        jsx(Button, {
          value: { confirmed: false, choiceId: props.choiceId },
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
    "whether they confirmed. For Linear issues, ALWAYS pass structured " +
    "title / description / assigneeEmail / team (inferred from messy human " +
    "input — typos and missing punctuation are fine). Call before " +
    "creating/modifying Linear or Notion.",
  parameters: z.object({
    action: z
      .string()
      .describe('Short summary, e.g. "Create Linear issue"'),
    title: z
      .string()
      .optional()
      .describe(
        "Issue/page title only — never include description text or field labels",
      ),
    description: z
      .string()
      .optional()
      .describe("Issue/page body — separate from title"),
    assigneeEmail: z
      .string()
      .optional()
      .describe("Assignee email when creating a Linear issue"),
    team: z
      .string()
      .optional()
      .describe("Linear team display name when creating an issue"),
    detail: z
      .string()
      .optional()
      .describe("Optional extra notes when structured fields do not apply"),
  }),
  async handler(
    { action, title, description, assigneeEmail, team, detail },
    { thread },
  ) {
    const fields = coerceTicketFields({ title, description });
    const choiceId = newHitlChoiceId();
    console.log("[confirm_write] waiting", {
      choiceId,
      title: fields.title,
      description: fields.description,
      assigneeEmail,
      team,
    });
    const choice = await awaitChoiceDurable<{ confirmed?: boolean }>(
      thread,
      requireStateStore(),
      ConfirmWriteCard({
        action,
        title: fields.title,
        description: fields.description,
        assigneeEmail,
        team,
        detail,
        choiceId,
      }),
      {
        choiceId,
        conversationKey: conversationKeyOf(thread),
      },
    );
    console.log("[confirm_write] resolved", {
      choiceId,
      confirmed: choice?.confirmed,
    });
    if (!choice?.confirmed) {
      return "The user DECLINED — do not write; acknowledge and stop.";
    }
    // A click may have durably won immediately before Stop. Re-check the exact
    // execution after the waiter and before granting the next write tool.
    await assertExactTurnActive(thread);
    // Immediate Slack feedback while the agent calls save_issue (LLM + MCP).
    try {
      await thread.post("⏳ Creating Linear issue…");
    } catch (err) {
      console.warn(
        "[confirm_write] creating ack failed",
        err instanceof Error ? err.message : err,
      );
    }
    // The acknowledgement is fenced, but its historical best-effort catch
    // must not turn a Stop suppression into an approval result. Re-check after
    // that await and fail the handler before the run loop can issue save_issue.
    await assertExactTurnActive(thread);
    const parts = [
      "The user APPROVED the write — proceed IMMEDIATELY.",
      "In this same turn: call save_issue NOW with the fields below (do not ask anything, do not call list_teams first unless save_issue fails).",
      "Then call issue_card with the new identifier + url. No extra prose before those tools.",
      fields.title != null && fields.title !== ""
        ? `title=${JSON.stringify(fields.title)}`
        : null,
      fields.description != null && fields.description !== ""
        ? `description=${JSON.stringify(fields.description)}`
        : null,
      assigneeEmail
        ? `assigneeEmail=${JSON.stringify(assigneeEmail)}`
        : null,
      team ? `team=${JSON.stringify(team)}` : null,
      "Use these exact field values; do not remix them.",
    ].filter(Boolean);
    return parts.join(" ");
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
    "summarize or act on them. Prefer the 'Current Slack thread transcript' " +
    "context when present; call this tool if you need a fresh pull. Never " +
    "claim the thread is empty when transcript context or this tool returns messages.",
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
    await assertExactTurnActive(thread);
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
    await assertExactTurnActive(thread);
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
    await assertExactTurnActive(thread);
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
    await assertExactTurnActive(thread);
    await thread.post(StatusCard(props));
    return "Posted the status card to the user.";
  },
});

export const showLinksTool = defineBotTool({
  name: "show_links",
  description: "Render a card of links (runbooks, dashboards, related pages).",
  parameters: linksSchema,
  async handler(props, { thread }) {
    await assertExactTurnActive(thread);
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
    const choiceId = newHitlChoiceId();
    const choice = await awaitChoiceDurable<{
      action?: string;
      id?: string;
    }>(thread, requireStateStore(), IncidentCard({ ...props, choiceId }), {
      choiceId,
      conversationKey: conversationKeyOf(thread),
    });
    await assertExactTurnActive(thread);
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
    await assertExactTurnActive(thread);
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
    const teamId = requireRequestContext(thread).teamId;
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
    const teamId = requireRequestContext(thread).teamId;
    const channelId = channelFromThread(thread);
    await assertExactTurnActive(thread);
    await runExactTurnEffect(thread, "memory_write", async () => {
      await memoryWrite(env.KNOWLEDGE, {
        id: crypto.randomUUID(),
        teamId,
        channelId,
        title,
        body,
        updatedAt: new Date().toISOString(),
      });
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
    const teamId = requireRequestContext(thread).teamId;
    const channelId = channelFromThread(thread);
    const threadTs = threadTsFromThread(thread);
    const threadKey = `slack:${channelId}:${threadTs ?? channelId}`;
    await assertExactTurnActive(thread);
    const result = await runExactTurnEffect(thread, "start_task", () =>
      startTask(env, {
        type: "research",
        teamId,
        threadKey,
        channelId,
        threadTs,
        payload: { objective },
      }), {
        resource: (started) => started.status === "error" ? undefined : {
          kind: "research_task",
          teamId,
          taskId: started.taskId,
          threadKey,
        },
        cancelIfStopped: (resource) => cancelTask(env, {
          teamId: resource.teamId,
          taskId: resource.taskId,
          threadKey: resource.threadKey,
        }).then(() => undefined),
      },
    );
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

export const reactMessageTool = defineBotTool({
  name: "react_message",
  description:
    "Add an emoji reaction to a Slack message in this thread. Use when the " +
    "user asks you to react, or when a reaction is better than a chat reply. " +
    "NEVER post emoji as plain text like ':+1:' or '👍' — call this tool. " +
    "Emoji names have no colons (thumbsup, heart, eyes). " +
    "Omit messageTs unless you have an exact Slack timestamp (digits.digits).",
  parameters: z.object({
    emoji: z
      .string()
      .describe("Slack emoji short name without colons, e.g. thumbsup or +1"),
    messageTs: z
      .string()
      .optional()
      .describe(
        "Exact Slack message ts (e.g. 1783830175.114279). Omit to react to the inbound user message.",
      ),
  }),
  async handler({ emoji, messageTs }, { thread }) {
    const conversationKey = conversationKeyOf(thread);
    const inbound = getInboundMessage(conversationKey, thread);
    const channel = channelFromThread(thread) || inbound?.channel || "";
    const argTs = messageTs?.trim();
    let ts =
      (argTs && /^\d+\.\d+$/.test(argTs) ? argTs : undefined) ||
      inbound?.ts ||
      undefined;

    if (!ts) {
      const msgs = await thread.getMessages();
      const lastUser = [...msgs].reverse().find((m) => !m.isBot && m.ts);
      const anyTs = [...msgs].reverse().find((m) => m.ts);
      ts = lastUser?.ts ?? anyTs?.ts;
    }

    if (!ts) {
      const scope = conversationKey.split("::")[1];
      if (scope && /^\d+\.\d+$/.test(scope)) ts = scope;
    }

    if (!channel || !ts) {
      console.error("[react_message] no_message_target", {
        conversationKey,
        channel,
        hasInbound: Boolean(inbound),
      });
      return {
        ok: false,
        error: "no_message_target",
        detail: {
          conversationKey,
          channel,
          hasInbound: Boolean(inbound),
        },
      };
    }

    const name = normalizeEmojiToken(emoji);
    if (!name) return { ok: false, error: "empty_emoji" };

    // Thread.react carries the exact reply target into the adapter's durable
    // render fence. A stalled reactions.add therefore commits before Stop, or
    // is suppressed after Stop; it cannot land behind a confirmed Stop ack.
    await assertExactTurnActive(thread);
    const r = await thread.react({ id: ts }, name);
    if (!r.ok && r.error !== "already_reacted") {
      console.error("[react_message] reactions.add failed", r.error, {
        channel,
        ts,
        name,
        requested: emoji,
      });
      return {
        ok: false,
        error: r.error ?? "reactions_add_failed",
        channel,
        ts,
        emoji: name,
      };
    }
    return { ok: true, emoji: name, ts, channel };
  },
});

const RAW_EDGE_TOOLS = [
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
  reactMessageTool,
] as const;

// The upstream run loop does not consult an AbortSignal between tool calls.
// Guard every production tool entry so a stale waiter cannot authorize a
// subsequent client-side handler after exact cancellation.
export const ALL_EDGE_TOOLS = RAW_EDGE_TOOLS.map(exactExecutionGuarded);

export const ALL_EDGE_TOOL_NAMES = ALL_EDGE_TOOLS.map((t) => t.name);
