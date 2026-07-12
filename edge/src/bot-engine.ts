/**
 * Bot engine — createBot + CloudflareSlackAdapter + DO StateStore.
 */
import { createBot, type Bot } from "@copilotkit/channels";
import { HttpAgent } from "@ag-ui/client";
import { startTask } from "./tasks/runtime.js";
import { memoryWrite } from "./memory/knowledge-do.js";
import { createBotStoreAdapter } from "./create-bot-store.js";
import { CloudflareSlackAdapter } from "./slack/cloudflare-slack-adapter.js";
import { defaultSlackContext } from "./slack/channels-slack-lite.js";
import {
  ALL_EDGE_TOOLS,
  ALL_EDGE_TOOL_NAMES,
  bindToolEnv,
} from "./tools/index.js";
import { edgeCommands, bindCommandEnv } from "./commands/index.js";
import { resolveAllowedTools } from "./config/access-bundle.js";
import { loadTurnAccess } from "./config/workspace-config-do.js";
import {
  setCurrentTeamId,
  getCurrentTeamId,
  runWithTeamId,
} from "./request-context.js";
import { runBundledAgentTurn } from "./agent-turn.js";
import type { Env } from "./env.js";

export type BotEngineKind = "createBot";

type BotHandle = {
  bot: Bot;
  adapter: CloudflareSlackAdapter;
};

let singleton: BotHandle | null = null;

export async function resolveBotEngineKind(): Promise<BotEngineKind> {
  return "createBot";
}

/**
 * Get or create the isolate-scoped bot. Requires SLACK_BOT_TOKEN + AGENT_URL.
 */
export async function getOrCreateBot(env: Env): Promise<BotHandle> {
  bindToolEnv(env);
  bindCommandEnv(env);

  if (singleton) return singleton;

  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is required for the CF bot Worker");
  }
  if (!env.AGENT_URL) {
    throw new Error("AGENT_URL is required for AG-UI agent replies");
  }

  const adapter = new CloudflareSlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
  });

  const headers = env.AGENT_AUTH_HEADER
    ? { Authorization: env.AGENT_AUTH_HEADER }
    : undefined;

  const bot = createBot({
    name: "opentag",
    adapters: [adapter],
    store: { adapter: createBotStoreAdapter(env.BOT_STATE) },
    agent: (threadId) => {
      const a = new HttpAgent({
        url: env.AGENT_URL,
        headers,
      });
      a.threadId = threadId;
      return a;
    },
    tools: [...ALL_EDGE_TOOLS],
    context: [
      ...defaultSlackContext,
      {
        description: "product",
        value:
          "You are OpenTag, an open-source Claude Tag alternative on Cloudflare. Respect access bundles. Client tools available: lookup_slack_user, read_thread, confirm_write, issue_card, issue_list, page_list, show_status, show_links, show_incident, memory_search, memory_write, start_task, research_progress. Chart/diagram image tools are NOT available on the Workers bot.",
      },
    ],
    commands: edgeCommands,
  });

  bot.onMention(async ({ thread, message }) => {
    try {
      const teamId = getCurrentTeamId();
      const channelId = (thread.conversationKey ?? "").split("::")[0] ?? "";

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

      const text = message.text ?? "";
      const isResearch =
        /^\s*research\b/i.test(text) || /\bresearch:\s*/i.test(text);

      if (isResearch) {
        if (!allowed.has("start_task")) {
          await thread.post(
            "⛔ Research / `start_task` is not allowed by this channel's access bundle or policies.",
          );
          return;
        }
        const objective = text
          .replace(/<@[^>]+>/g, "")
          .replace(/^\s*research[:\s]+/i, "")
          .trim();
        const scope = (thread.conversationKey ?? "").split("::")[1];
        const threadTs =
          scope && scope !== "dm" && !scope.startsWith("slash::")
            ? scope
            : undefined;
        const result = await startTask(env, {
          type: "research",
          teamId,
          threadKey: `slack:${channelId}:${threadTs ?? channelId}`,
          channelId,
          threadTs,
          payload: { objective: objective || text },
        });
        await thread.post(
          `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
        );
        return;
      }

      const remember = text.match(/^\s*remember[:\s]+(.+)/i);
      if (remember) {
        if (!allowed.has("memory_write")) {
          await thread.post(
            "⛔ `memory_write` is not allowed by this channel's access bundle or policies.",
          );
          return;
        }
        await memoryWrite(env.KNOWLEDGE, {
          id: crypto.randomUUID(),
          teamId,
          channelId,
          title: `note-${new Date().toISOString().slice(0, 10)}`,
          body: remember[1]!.trim(),
          updatedAt: new Date().toISOString(),
        });
        await thread.post("💾 Saved to channel knowledge.");
        return;
      }

      await runBundledAgentTurn(env, thread, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot] onMention failed", msg);
      try {
        await thread.post(`⚠️ Something went wrong: ${msg.slice(0, 200)}`);
      } catch {
        /* ignore */
      }
    }
  });

  await bot.start();
  singleton = { bot, adapter };
  return singleton;
}

/** Reset singleton (tests). */
export function resetBotSingleton(): void {
  singleton = null;
}

export { setCurrentTeamId, getCurrentTeamId, runWithTeamId };
