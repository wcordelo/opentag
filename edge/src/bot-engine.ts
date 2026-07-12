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
import { trivialAckReply, trivialAck } from "./trivial-ack.js";
import { reactIntent } from "./react-intent.js";
import {
  bindInboundToThread,
  getInboundMessage,
} from "./slack/inbound-target.js";
import {
  activeTurnKvKey,
  firstSlackTs,
  slackObligationThreadKey,
  type ActiveTurnRecord,
} from "./slack/obligation-thread-key.js";
import { resolveThreadOverrides } from "./store/thread-overrides.js";
import type { Env } from "./env.js";
import type { SessionEventsRpc } from "./store/conversation-state-do.js";

export type BotEngineKind = "createBot";

export { trivialAckReply, trivialAck } from "./trivial-ack.js";

type BotHandle = {
  bot: Bot;
  adapter: CloudflareSlackAdapter;
};

/**
 * Render-obligation timeout (SPEC.md §3.1 / GOAL.md Phase A2). MUST exceed
 * `createBot({ store: { lockTtl } })` below (15 minutes) — otherwise the
 * `ConversationStateDO` alarm could fire and "recover" a turn that's still
 * legitimately mid-flight (e.g. waiting on a HITL confirmation), producing a
 * double post. Kept in lockstep with `conversation-state-do.ts`'s own
 * `DEFAULT_OBLIGATION_TIMEOUT_MS`, which applies the same default when
 * `timeoutMs` is omitted — passed explicitly here anyway so the two files
 * don't silently drift.
 */
const RENDER_OBLIGATION_TIMEOUT_MS = 20 * 60_000;

/** Structured metric line (SPEC.md §4.3's minimum counters). */
function logMetric(
  metric: string,
  fields: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ metric, ...fields }));
}

/**
 * Write the render obligation for a turn that's about to start. Best-effort:
 * a write failure must never block the turn (GOAL.md: never-silent is a
 * safety net, not a hard dependency of the happy path).
 *
 * `afterEventId` is the current tip of the thread's `SessionEventDO` event
 * log — if the binding isn't registered yet (`env.SESSION_EVENTS` undefined,
 * true until a later phase wires it into wrangler.toml), it defaults to `0`;
 * the alarm fallback then degrades gracefully to the generic "please retry"
 * error card instead of a reconstructed replay.
 */
async function writeRenderObligation(
  env: Env,
  stateStore: ReturnType<typeof createBotStoreAdapter>,
  args: { threadKey: string; executionId: string; channel: string; threadTs?: string },
): Promise<void> {
  try {
    let afterEventId = 0;
    if (env.SESSION_EVENTS) {
      // See `SessionEventsRpc` in conversation-state-do.ts for why this cast
      // is needed (RPC return-type inference collapses to `never` on
      // `replay()`'s `payload: unknown` field).
      const sessionDo = env.SESSION_EVENTS.get(
        env.SESSION_EVENTS.idFromName(args.threadKey),
      ) as unknown as SessionEventsRpc;
      const events = await sessionDo.replay();
      afterEventId = events.length > 0 ? events[events.length - 1]!.id : 0;
    }
    await stateStore.obligation.set({
      threadKey: args.threadKey,
      executionId: args.executionId,
      afterEventId,
      channel: args.channel,
      threadTs: args.threadTs,
      timeoutMs: RENDER_OBLIGATION_TIMEOUT_MS,
    });
  } catch (err) {
    console.error("[bot] render obligation write failed", err);
  }
}

/** Clear a render obligation. Best-effort — failure to clear is recovered by the alarm. */
async function clearRenderObligation(
  stateStore: ReturnType<typeof createBotStoreAdapter>,
  threadKey: string,
  executionId: string,
): Promise<void> {
  try {
    await stateStore.obligation.clear({ threadKey, executionId });
  } catch (err) {
    console.error("[bot] render obligation clear failed", err);
  }
}

/** Mark a turn as executing in SessionEventDO so the obligation alarm can defer. */
async function beginSessionExecution(
  env: Env,
  threadKey: string,
  executionId: string,
  inputText: string,
): Promise<void> {
  if (!env.SESSION_EVENTS) return;
  try {
    const sessionDo = env.SESSION_EVENTS.get(
      env.SESSION_EVENTS.idFromName(threadKey),
    ) as unknown as SessionEventsRpc;
    await sessionDo.execute({
      executionId,
      inputLines: [inputText.slice(0, 4000)],
    });
  } catch (err) {
    console.error("[bot] session execute failed", err);
  }
}

/** Clear session:executing when a turn finishes or fails. */
async function endSessionExecution(
  env: Env,
  threadKey: string,
  executionId: string,
  kind: "done" | "error",
  payload?: unknown,
): Promise<void> {
  if (!env.SESSION_EVENTS) return;
  try {
    const sessionDo = env.SESSION_EVENTS.get(
      env.SESSION_EVENTS.idFromName(threadKey),
    ) as unknown as SessionEventsRpc;
    await sessionDo.appendEvent({
      executionId,
      kind,
      payload: payload ?? {},
    });
  } catch (err) {
    console.error("[bot] session appendEvent failed", err);
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

  const stateStore = createBotStoreAdapter(env.BOT_STATE);
  const adapter = new CloudflareSlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
    stateStore,
  });

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
    // Hoisted so the outer catch (below) can clear the obligation after it
    // posts the "Something went wrong" error card — set once the turn
    // actually starts (research/remember/trivial-ack/react-intent short
    // circuits never reach that point and never write an obligation).
    let renderObligationThreadKey: string | undefined;
    let renderObligationExecutionId: string | undefined;
    try {
      const teamId = getCurrentTeamId();
      const channelId = (thread.conversationKey ?? "").split("::")[0] ?? "";
      // Snapshot react target for this turn before any concurrent ingress can
      // overwrite request-scoped state; bind to the Thread for tool handlers.
      const reactTarget = getInboundMessage(thread.conversationKey ?? "");
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

      // Assistant status indicator (DM pane only — no-ops elsewhere, swallowed
      // by web-api). The streaming placeholder message covers channel visibility.
      const statusScope = (thread.conversationKey ?? "").split("::")[1];
      // Deterministic scope first: it comes from THIS turn's conversationKey,
      // while reactTarget reads request-scoped state that a concurrent turn in
      // the same isolate can overwrite (wrong-thread obligation = wrong-thread
      // fallback post). reactTarget is only consulted for DMs, whose scope is
      // the literal "dm" rather than a ts; assistant.threads.* wants the
      // thread-root ts, hence threadTs before the reply ts.
      const statusThreadTs = firstSlackTs(
        statusScope,
        reactTarget?.threadTs,
        reactTarget?.ts,
      );

      if (statusThreadTs) {
        void adapter
          .setStatus({
            channel: channelId,
            threadTs: statusThreadTs,
            status: "Thinking…".slice(0, 50),
          })
          .catch(() => undefined);
      }

      // Never-silent guarantee (SPEC.md §3.1 / GOAL.md Phase A2): write a
      // render obligation before the turn runs so `ConversationStateDO`'s
      // alarm can recover if this isolate crashes or the agent hangs.
      const executionId = crypto.randomUUID();
      const obligationThreadKey = slackObligationThreadKey(
        channelId,
        statusThreadTs,
      );
      const conversationKey = thread.conversationKey ?? "";
      renderObligationThreadKey = obligationThreadKey;
      renderObligationExecutionId = executionId;
      logMetric("turn_started", { threadKey: obligationThreadKey, executionId });
      await writeRenderObligation(env, stateStore, {
        threadKey: obligationThreadKey,
        executionId,
        channel: channelId,
        threadTs: statusThreadTs,
      });
      await beginSessionExecution(env, obligationThreadKey, executionId, text);
      try {
        await stateStore.kv.set<ActiveTurnRecord>(
          activeTurnKvKey(channelId),
          { threadKey: obligationThreadKey, conversationKey },
          RENDER_OBLIGATION_TIMEOUT_MS,
        );
      } catch (err) {
        console.error("[bot] active turn registration failed", err);
      }

      try {
        try {
          await runBundledAgentTurn(
            env,
            thread as Parameters<typeof runBundledAgentTurn>[1],
            message.contentParts && message.contentParts.length > 0
              ? message.contentParts
              : text,
            message.user,
          );
        } finally {
          if (statusThreadTs) {
            void adapter
              .setStatus({ channel: channelId, threadTs: statusThreadTs, status: "" })
              .catch(() => undefined);
          }
        }
        await endSessionExecution(env, obligationThreadKey, executionId, "done");
        logMetric("turn_completed", { threadKey: obligationThreadKey, executionId });
        await clearRenderObligation(stateStore, obligationThreadKey, executionId);
      } catch (turnErr) {
        const errMsg =
          turnErr instanceof Error ? turnErr.message : String(turnErr);
        await endSessionExecution(env, obligationThreadKey, executionId, "error", {
          message: errMsg.slice(0, 500),
        });
        logMetric("turn_failed", { threadKey: obligationThreadKey, executionId });
        throw turnErr;
      } finally {
        try {
          await stateStore.kv.delete(activeTurnKvKey(channelId));
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot] onMention failed", msg);
      try {
        await thread.post(
          `⚠️ Something went wrong (agent didn't finish): ${msg.slice(0, 180)}\n` +
            `Check AGENT_RUNTIME / opentag-agent — retry in a few seconds.`,
        );
        // The error card just landed (error_visible already achieved) — safe
        // to clear now. If the post above throws instead, we fall into this
        // catch's own catch below and deliberately leave the obligation in
        // place so the alarm can recover (fallback replay or its own error
        // card, whichever applies).
        if (renderObligationThreadKey && renderObligationExecutionId) {
          await clearRenderObligation(
            stateStore,
            renderObligationThreadKey,
            renderObligationExecutionId,
          );
        }
      } catch {
        /* ignore — obligation intentionally left for alarm recovery */
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
