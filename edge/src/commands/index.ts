/**
 * Slash commands for the CF bot Worker.
 */
import { defineBotCommand } from "@copilotkit/channels";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  resolveAllowedTools,
  type WorkspaceChannelConfig,
} from "../config/access-bundle.js";
import { ALL_EDGE_TOOL_NAMES } from "../tools/index.js";
import { loadTurnAccess } from "../config/workspace-config-do.js";
import { startTask } from "../tasks/runtime.js";
import { getCurrentTeamId } from "../request-context.js";
import { runBundledAgentTurn } from "../agent-turn.js";
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
    description: "Set the channel system prompt (preserves bundle + policies).",
    async handler({ thread, text }) {
      const env = requireEnv();
      const key = conversationKeyOf(thread as { conversationKey?: string });
      const channelId = channelFromKey(key);
      const teamId = getCurrentTeamId();
      const { config: existing } = await loadTurnAccess(
        env.WORKSPACE_CONFIG,
        teamId,
        channelId,
      );
      const stub = env.WORKSPACE_CONFIG.get(
        env.WORKSPACE_CONFIG.idFromName(teamId),
      );
      const next: WorkspaceChannelConfig = {
        teamId,
        channelId,
        systemPrompt: text?.trim() || DEFAULT_SYSTEM_PROMPT,
        // Preserve access setup — only the prompt changes via /config.
        policies: existing.policies ?? {
          allowMemoryWrite: true,
          allowTasks: true,
        },
        accessBundleId: existing.accessBundleId || DEFAULT_BUNDLE.id,
        updatedAt: new Date().toISOString(),
      };
      await stub.fetch("https://do/putConfig", {
        method: "POST",
        body: JSON.stringify(next),
      });
      await thread.post(
        `Channel prompt updated (${next.systemPrompt.length} chars). Bundle: \`${next.accessBundleId}\` (unchanged).`,
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
      const { config, bundle } = await loadTurnAccess(
        env.WORKSPACE_CONFIG,
        teamId,
        channelId,
      );
      const allowed = new Set(
        resolveAllowedTools([...ALL_EDGE_TOOL_NAMES], bundle),
      );
      if (config.policies.allowTasks === false) {
        allowed.delete("start_task");
        allowed.delete("research_progress");
      }
      if (!allowed.has("start_task")) {
        await thread.post(
          "⛔ Research / `start_task` is not allowed by this channel's access bundle or policies.",
        );
        return;
      }
      const threadKey = `slack:${channelId}:${threadTs ?? channelId}`;
      const result = await startTask(env, {
        type: "research",
        teamId,
        threadKey,
        channelId,
        threadTs,
        payload: { objective: text.trim() },
      });
      if (result.status === "error") {
        await thread.post(
          `⚠️ Research failed: ${result.detail ?? "unknown"}\n` +
            `Hint: run \`npm run dev:research\` locally (or deploy opentag-orchestrator) and ensure INTERNAL_SECRET matches.`,
        );
        return;
      }
      await thread.post(
        `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
      );
    },
  }),

  defineBotCommand({
    name: "agent",
    description: "Talk to the agent without an @-mention.",
    async handler({ thread, text, user }) {
      const env = requireEnv();
      if (!text?.trim()) {
        await thread.post("Usage: `/agent <message>`");
        return;
      }
      try {
        await runBundledAgentTurn(
          env,
          thread as Parameters<typeof runBundledAgentTurn>[1],
          text.trim(),
          user,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await thread.post(`⚠️ Something went wrong: ${msg.slice(0, 200)}`);
      }
    },
  }),
];
