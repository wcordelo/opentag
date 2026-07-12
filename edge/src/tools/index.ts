/**
 * Edge bot tools — Workers-safe subset (no Playwright / heavy UI).
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

function ConfirmWriteCard(props: { action: string; detail?: string }) {
  const kids: unknown[] = [
    jsx(Header, { children: `📝 ${props.action}?` }),
  ];
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
    teamId: z.string(),
    channelId: z.string(),
  }),
  async handler({ query, teamId, channelId }) {
    const env = requireEnv();
    const hits = await memorySearch(env.KNOWLEDGE, teamId, channelId, query, 5);
    return hits.map((h) => ({ title: h.title, body: h.body.slice(0, 400) }));
  },
});

export const memoryWriteTool = defineBotTool({
  name: "memory_write",
  description: "Write a note into channel knowledge memory.",
  parameters: z.object({
    teamId: z.string(),
    channelId: z.string(),
    title: z.string(),
    body: z.string(),
  }),
  async handler({ teamId, channelId, title, body }) {
    const env = requireEnv();
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
    teamId: z.string(),
    channelId: z.string(),
    threadTs: z.string().optional(),
  }),
  async handler({ objective, teamId, channelId, threadTs }, { thread }) {
    const env = requireEnv();
    const threadKey = `slack:${channelId}:${threadTs ?? channelId}`;
    const result = await startTask(env, {
      type: "research",
      teamId,
      threadKey,
      channelId,
      threadTs,
      payload: { objective },
    });
    await thread.post(
      `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
    );
    return result;
  },
});

export const ALL_EDGE_TOOLS = [
  confirmWriteTool,
  researchProgressTool,
  memorySearchTool,
  memoryWriteTool,
  startTaskTool,
] as const;

export const ALL_EDGE_TOOL_NAMES = ALL_EDGE_TOOLS.map((t) => t.name);
