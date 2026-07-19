/**
 * Bot engine — createBot + CloudflareSlackAdapter + DO StateStore.
 */
import { createBot, type Bot } from "@copilotkit/channels";
import { HttpAgent } from "@ag-ui/client";
import { cancelTask, startTask } from "./tasks/runtime.js";
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
import { extractMessageOverrides } from "./slack/overrides.js";
import { resolveThreadOverrides } from "./store/thread-overrides.js";
import type { Env } from "./env.js";
import { runSlackTurnLifecycle } from "./slack/turn-lifecycle.js";
import { sharedSlackRateScheduler } from "./slack/web-api.js";
import {
  adoptSlackShortcut,
  finishSilentShortcut,
  postFinalShortcut,
  runShortcutEffect,
  shortcutStillPending,
  type AdoptedShortcut,
} from "./slack/shortcut-lifecycle.js";
import {
  parseTrustedTriggerConfig,
  trustedTriggerReadiness,
} from "./slack/trusted-trigger.js";
import { AUTOMATION_SAFE_TOOLS } from "./permissions/contract.js";

export type BotEngineKind = "createBot";

export { trivialAckReply, trivialAck } from "./trivial-ack.js";

type BotHandle = {
  bot: Bot;
  adapter: CloudflareSlackAdapter;
};

function findExecutionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const hit = findExecutionId(child);
      if (hit) return hit;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.description === "OpenTag execution control" &&
    typeof record.value === "string"
  ) {
    try {
      const parsed = JSON.parse(record.value) as { executionId?: unknown };
      if (typeof parsed.executionId === "string") return parsed.executionId;
    } catch { /* malformed context is ignored */ }
  }
  for (const child of Object.values(record)) {
    const hit = findExecutionId(child);
    if (hit) return hit;
  }
  return undefined;
}

export function agentExecutionIdFromRequest(init: RequestInit): string | undefined {
  if (typeof init.body !== "string") return undefined;
  try {
    return findExecutionId(JSON.parse(init.body));
  } catch {
    return undefined;
  }
}

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
  if (env.ENVIRONMENT === "production" && !env.SESSION_EVENTS) {
    throw new Error("SESSION_EVENTS is required for production terminal ownership");
  }

  const stateStore = createBotStoreAdapter(env.BOT_STATE);
  const slackScheduler = sharedSlackRateScheduler(
    env.ENVIRONMENT,
    env.SLACK_RATE_LIMIT,
  );
  const trustedTriggerConfig = parseTrustedTriggerConfig(
    env.SLACK_BOT_USER_ID,
    env.SLACK_TRUSTED_TRIGGER_ACTORS,
  );
  const trustedReadiness = trustedTriggerReadiness(trustedTriggerConfig);
  if (!trustedReadiness.ok || trustedReadiness.invalidActorCount > 0) {
    console.warn("[trusted-rich-trigger] configuration", {
      reason: trustedReadiness.reason,
      actorCount: trustedReadiness.actorCount,
      invalidActorCount: trustedReadiness.invalidActorCount,
      hasBotUserId: trustedTriggerConfig.botUserIdStatus === "valid",
    });
  }
  const adapter = new CloudflareSlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
    ...(trustedTriggerConfig.botUserId
      ? { botUserId: trustedTriggerConfig.botUserId }
      : {}),
    stateStore,
    slackScheduler,
    deliveryMetrics: env.DELIVERY_METRICS,
    trustedTriggerConfig,
    ...(env.SESSION_EVENTS ? { sessionEvents: env.SESSION_EVENTS } : {}),
    ...(env.BLOBS ? { blobs: env.BLOBS } : {}),
    ...(env.SESSION_VIEWER_BASE_URL && env.ADMIN_SECRET
      ? {
          sessionViewer: {
            baseUrl: env.SESSION_VIEWER_BASE_URL,
            secret: env.ADMIN_SECRET,
            runtimeLabel: `AG-UI · ${env.AGENT_MODEL ?? "runtime default"}`,
          },
        }
      : {}),
    ...(env.QUICK_BASE_DOMAIN ? { quickBaseDomain: env.QUICK_BASE_DOMAIN } : {}),
  });
  bindCommandEnv(env, adapter);

  const headers = env.AGENT_AUTH_HEADER
    ? { Authorization: env.AGENT_AUTH_HEADER }
    : undefined;

  // Prefer service binding so Worker→Worker does not hit CF 1042 (same-zone
  // workers.dev fetch is blocked). AGENT_URL still supplies the request URL/path.
  const agentFetch = env.AGENT_RUNTIME
    ? (url: string, init: RequestInit) => {
        const executionId = agentExecutionIdFromRequest(init);
        const headers = new Headers(init.headers);
        if (executionId) headers.set("x-opentag-execution-id", executionId);
        return env.AGENT_RUNTIME!.fetch(url, { ...init, headers });
      }
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
          "You are OpenTag, an open-source Claude Tag alternative on Cloudflare. Respect access bundles. Client tools available: lookup_slack_user, read_thread, confirm_write, issue_card, issue_list, page_list, show_status, show_links, show_incident, show_permissions, memory_search, memory_write, start_task, research_progress, react_message. Use show_permissions to explain effective access; its output is informational, not authorization. When asked to react, call react_message — never post emoji as text. Chart/diagram image tools are NOT available on the Workers bot.",
      },
    ],
    commands: edgeCommands,
  });

  bot.onMention(async ({ thread, message }) => {
    let adopted: AdoptedShortcut | undefined;
    try {
      const requestContext = copyRequestContext(message.user, thread);
      // Every production mention, including lightweight shortcuts, adopts the
      // ingress row before its first config/profile/task await.
      adopted = await adoptSlackShortcut(env, adapter, thread);
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
      if (!(await shortcutStillPending(adopted))) return;
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
      const humanActor = requestContext.actor.kind === "slack_user";
      if (!humanActor) {
        for (const toolName of [...allowed]) {
          if (!AUTOMATION_SAFE_TOOLS.has(toolName)) allowed.delete(toolName);
        }
      }

      const text = message.text ?? "";
      const isResearch =
        /^\s*research\b/i.test(text) || /\bresearch:\s*/i.test(text);

      if (humanActor && isResearch) {
        if (!allowed.has("start_task")) {
          await postFinalShortcut(thread,
            "⛔ Research / `start_task` is not allowed by this channel's access bundle or policies.",
          );
          return;
        }
        const requestedOverrides = extractMessageOverrides(text);
        if (requestedOverrides.errors.length > 0) {
          await postFinalShortcut(
            thread,
            `⚠️ ${requestedOverrides.errors.join("; ")}. No preference was saved.`,
          );
          return;
        }
        const conversationKey = thread.conversationKey ?? "";
        const { cleanedText, effectiveModel } = await resolveThreadOverrides(
          stateStore,
          conversationKey,
          text,
          config.runtimeDefaults,
        );
        if (!(await shortcutStillPending(adopted))) return;
        const objective = cleanedText
          .replace(/<@[^>]+>/g, "")
          .replace(/^\s*research[:\s]+/i, "")
          .trim();
        const statusScope = conversationKey.split("::")[1];
        const threadTs = firstSlackTs(statusScope);
        const researchThreadKey = slackObligationThreadKey(channelId, threadTs);
        const effect = await runShortcutEffect(adopted, "mention_research", () =>
          startTask(env, {
            type: "research",
            teamId,
            threadKey: researchThreadKey,
            channelId,
            threadTs,
            model: effectiveModel,
            payload: { objective: objective || cleanedText },
          }), {
            resource: (started) => started.status === "error" ? undefined : {
              kind: "research_task",
              teamId,
              taskId: started.taskId,
              threadKey: researchThreadKey,
            },
            cancelIfStopped: (resource) => cancelTask(env, {
              teamId: resource.teamId,
              taskId: resource.taskId,
              threadKey: resource.threadKey,
            }).then(() => undefined),
          },
        );
        if (effect.status === "suppressed") return;
        const result = effect.value;
        if (result.status === "error") {
          await postFinalShortcut(thread,
            `⚠️ Research failed: ${result.detail ?? "unknown"}\n` +
              `Hint: start \`npm run dev:research\` and match INTERNAL_SECRET.`,
          );
          return;
        }
        await postFinalShortcut(thread,
          `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
        );
        return;
      }

      const remember = text.match(/^\s*remember[:\s]+(.+)/i);
      if (humanActor && remember) {
        if (!allowed.has("memory_write")) {
          await postFinalShortcut(thread,
            "⛔ `memory_write` is not allowed by this channel's access bundle or policies.",
          );
          return;
        }
        const effect = await runShortcutEffect(adopted, "mention_memory_write", () =>
          memoryWrite(env.KNOWLEDGE, {
            id: crypto.randomUUID(),
            teamId,
            channelId,
            title: `note-${new Date().toISOString().slice(0, 10)}`,
            body: remember[1]!.trim(),
            updatedAt: new Date().toISOString(),
          }),
        );
        if (effect.status === "suppressed") return;
        await postFinalShortcut(thread, "💾 Saved to channel knowledge.");
        return;
      }

      // Skip the full AG-UI/MCP/LLM round-trip for pure acknowledgments —
      // react on the user message instead of posting a chat reply.
      const trivial = trivialAck(text);
      if (humanActor && trivial) {
        if (trivial.mode === "react") {
          const reacted = await adapter.react(
            thread.conversationKey ?? "",
            trivial.emoji,
            reactTarget,
            adopted.record,
            true,
          );
          if (!reacted) {
            await postFinalShortcut(thread,
              trivial.emoji === "heart" ? "You're welcome." : "👍",
            );
          }
        } else {
          await postFinalShortcut(thread, trivial.text);
        }
        return;
      }

      // Explicit "react to my message" / "don't react" — no LLM tool flakiness.
      const intent = reactIntent(text);
      if (humanActor && intent) {
        if (intent.action === "skip") {
          // Silent — user asked for no reaction; avoid chat spam too.
          await finishSilentShortcut(adopted);
          return;
        }
        const reacted = await adapter.react(
          thread.conversationKey ?? "",
          intent.emoji,
          reactTarget,
          adopted.record,
          true,
        );
        if (!reacted) {
          console.error(
            "[bot] react intent failed",
            thread.conversationKey,
            intent.emoji,
          );
          await postFinalShortcut(thread,
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
      if (
        err instanceof Error &&
          ["active_turn_render_suppressed", "active_turn_tool_suppressed"].includes(err.message)
      ) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot] onMention failed", msg);
      try {
        if (!adopted || !(await shortcutStillPending(adopted))) return;
        await postFinalShortcut(thread,
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
