/**
 * Slash commands for the CF bot Worker.
 */
import { defineBotCommand } from "@copilotkit/channels";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  type WorkspaceChannelConfig,
} from "../config/access-bundle.js";
import { startTask } from "../tasks/runtime.js";
import { getCurrentTeamId } from "../request-context.js";
import type { Env } from "../env.js";

let boundEnv: Env | null = null;

export function bindCommandEnv(env: Env): void {
  boundEnv = env;
}

function requireEnv(): Env {
  if (!boundEnv) throw new Error("command env not bound");
  return boundEnv;
}

function conversationKeyOf(thread: { conversationKey?: string }): string {
  return thread.conversationKey ?? "";
}

function channelFromKey(conversationKey: string): string {
  return conversationKey.split("::")[0] ?? "";
}

function threadTsFromKey(conversationKey: string): string | undefined {
  const scope = conversationKey.split("::")[1];
  if (!scope || scope === "dm" || scope.startsWith("slash::")) return undefined;
  return scope;
}

export const edgeCommands = [
  defineBotCommand({
    name: "config",
    description: "Set the channel system prompt.",
    async handler({ thread, text }) {
      const env = requireEnv();
      const key = conversationKeyOf(thread as { conversationKey?: string });
      const channelId = channelFromKey(key);
      const teamId = getCurrentTeamId();
      const stub = env.WORKSPACE_CONFIG.get(
        env.WORKSPACE_CONFIG.idFromName(teamId),
      );
      await stub.fetch("https://do/putConfig", {
        method: "POST",
        body: JSON.stringify({
          teamId,
          channelId,
          systemPrompt: text || DEFAULT_SYSTEM_PROMPT,
          policies: { allowMemoryWrite: true, allowTasks: true },
          accessBundleId: DEFAULT_BUNDLE.id,
          updatedAt: new Date().toISOString(),
        } satisfies WorkspaceChannelConfig),
      });
      await thread.post(
        `Channel prompt updated (${(text ?? "").length} chars). Bundle: \`${DEFAULT_BUNDLE.id}\`.`,
      );
    },
  }),

  defineBotCommand({
    name: "research",
    description: "Run deep research on a topic.",
    async handler({ thread, text }) {
      const env = requireEnv();
      if (!text?.trim()) {
        await thread.post("Usage: `/research <topic>`");
        return;
      }
      const key = conversationKeyOf(thread as { conversationKey?: string });
      const channelId = channelFromKey(key);
      const threadTs = threadTsFromKey(key);
      const teamId = getCurrentTeamId();
      const threadKey = `slack:${channelId}:${threadTs ?? channelId}`;
      const result = await startTask(env, {
        type: "research",
        teamId,
        threadKey,
        channelId,
        threadTs,
        payload: { objective: text.trim() },
      });
      await thread.post(
        `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
      );
    },
  }),

  defineBotCommand({
    name: "agent",
    description: "Talk to the agent without an @-mention.",
    async handler({ thread, text }) {
      if (!text?.trim()) {
        await thread.post("Usage: `/agent <message>`");
        return;
      }
      await thread.runAgent({ prompt: text.trim() });
    },
  }),
];
