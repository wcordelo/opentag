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
import { copyRequestContext } from "./request-context.js";
import { trivialAckReply, trivialAck } from "./trivial-ack.js";
import { reactIntent } from "./react-intent.js";
import {
  bindInboundToThread,
  getInboundMessage,
} from "./slack/inbound-target.js";
import {
  firstSlackTs,
  slackObligationThreadKey,
} from "./slack/obligation-thread-key.js";
import { resolveThreadOverrides } from "./store/thread-overrides.js";
import type { Env } from "./env.js";
import { runSlackTurnLifecycle } from "./slack/turn-lifecycle.js";

export type BotEngineKind = "createBot";

export { trivialAckReply, trivialAck } from "./trivial-ack.js";

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

  const stateStore = createBotStoreAdapter(env.BOT_STATE);
  const adapter = new CloudflareSlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
    stateStore,
  });
  bindCommandEnv(env, adapter);

  const headers = env.AGENT_AUTH_HEADER
    ? { Authorization: env.AGENT_AUTH_HEADER }
    : undefined;

  // Prefer service binding so Worker→Worker does not hit CF 1042 (same-zone
  // workers.dev fetch is blocked). AGENT_URL still supplies the request URL/path.
  const agentFetch = env.AGENT_RUNTIME
    ? (url: string, init: RequestInit) => env.AGENT_RUNTIME!.fetch(url, init)
    : undefined;

  const bot = createBot({
    name: "opentag",
    adapters: [adapter],
    store: {
      adapter: stateStore,
      // Keep the turn lock for the full HITL wait (default 60s is too short).
      lockTtl: 15 * 60_000,
    },
    agent: (threadId) => {
      const a = new HttpAgent({
        url: env.AGENT_URL,
        headers,
        ...(agentFetch ? { fetch: agentFetch } : {}),
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
          "You are OpenTag, an open-source Claude Tag alternative on Cloudflare. Respect access bundles. Client tools available: lookup_slack_user, read_thread, confirm_write, issue_card, issue_list, page_list, show_status, show_links, show_incident, memory_search, memory_write, start_task, research_progress, react_message. When asked to react, call react_message — never post emoji as text. Chart/diagram image tools are NOT available on the Workers bot.",
      },
    ],
    commands: edgeCommands,
  });

  bot.onMention(async ({ thread, message }) => {
    try {
      const requestContext = copyRequestContext(message.user, thread);
      const teamId = requestContext.teamId;
      const channelId = (thread.conversationKey ?? "").split("::")[0] ?? "";
      // Snapshot react target for this turn before any concurrent ingress can
      // overwrite request-scoped state; bind to the Thread for tool handlers.
      const reactTarget = requestContext.inbound;
      bindInboundToThread(thread, reactTarget);

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
        const conversationKey = thread.conversationKey ?? "";
        const { cleanedText, effectiveModel } = await resolveThreadOverrides(
          stateStore,
          conversationKey,
          text,
        );
        const objective = cleanedText
          .replace(/<@[^>]+>/g, "")
          .replace(/^\s*research[:\s]+/i, "")
          .trim();
        const statusScope = conversationKey.split("::")[1];
        const threadTs = firstSlackTs(statusScope);
        const result = await startTask(env, {
          type: "research",
          teamId,
          threadKey: slackObligationThreadKey(channelId, threadTs),
          channelId,
          threadTs,
          model: effectiveModel,
          payload: { objective: objective || cleanedText },
        });
        if (result.status === "error") {
          await thread.post(
            `⚠️ Research failed: ${result.detail ?? "unknown"}\n` +
              `Hint: start \`npm run dev:research\` and match INTERNAL_SECRET.`,
          );
          return;
        }
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

      // Skip the full AG-UI/MCP/LLM round-trip for pure acknowledgments —
      // react on the user message instead of posting a chat reply.
      const trivial = trivialAck(text);
      if (trivial) {
        if (trivial.mode === "react") {
          const reacted = await adapter.react(
            thread.conversationKey ?? "",
            trivial.emoji,
            reactTarget,
          );
          if (!reacted) {
            await thread.post(
              trivial.emoji === "heart" ? "You're welcome." : "👍",
            );
          }
        } else {
          await thread.post(trivial.text);
        }
        return;
      }

      // Explicit "react to my message" / "don't react" — no LLM tool flakiness.
      const intent = reactIntent(text);
      if (intent) {
        if (intent.action === "skip") {
          // Silent — user asked for no reaction; avoid chat spam too.
          return;
        }
        const reacted = await adapter.react(
          thread.conversationKey ?? "",
          intent.emoji,
          reactTarget,
        );
        if (!reacted) {
          console.error(
            "[bot] react intent failed",
            thread.conversationKey,
            intent.emoji,
          );
          await thread.post(
            "Couldn't add a reaction (missing message target or `reactions:write`).",
          );
        }
        return;
      }

      await runSlackTurnLifecycle(
        env,
        adapter,
        thread as Parameters<typeof runSlackTurnLifecycle>[2],
        message.contentParts && message.contentParts.length > 0
          ? message.contentParts
          : text,
        message.user,
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot] onMention failed", msg);
      try {
        await thread.post(
          `⚠️ Something went wrong (agent didn't finish): ${msg.slice(0, 180)}\n` +
            `Check AGENT_RUNTIME / opentag-agent — retry in a few seconds.`,
        );
      } catch {
        /* best-effort error visibility for pre-lifecycle shortcuts */
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
