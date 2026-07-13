/**
 * Stop-command routing (GOAL.md Phase A2 Task 1 / SPEC.md §2.4, §3.2).
 *
 * Split out of `worker.ts` to keep the events handler readable and to make
 * the detection logic testable without a full Hono app (Task 3): pass a
 * parsed Slack events payload + env, get back either "this was a stop
 * command, here's what happened" or "let it flow to the bot engine".
 */
import { isSlackStopCommand } from "./stop-command.js";
import { createBotStoreAdapter } from "../create-bot-store.js";
import { createSlackWebClient } from "./web-api.js";
import {
  conversationKeyFromThreadKey,
  firstSlackTs,
  slackObligationThreadKey,
} from "./obligation-thread-key.js";
import {
  clearActiveTurn,
  getActiveTurnForThread,
  getLatestActiveTurn,
  type ActiveTurnRecord,
} from "./active-turn-registry.js";
import { cancelHitlChoice } from "../hitl/durable-choice.js";
import { getOrCreateBot } from "../bot-engine.js";
import type { Env } from "../env.js";
import { interruptHarnessTurn } from "../harness/client.js";

/** The subset of a Slack Events API `event` object this module reads. */
export interface SlackStopEvent {
  type?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/** The subset of the top-level Events API envelope this module reads. */
export interface SlackEventCallbackPayload {
  type?: string;
  event_id?: string;
  team_id?: string;
  event?: SlackStopEvent;
}

/**
 * The one `SessionEventDO` RPC call this module needs, typed by hand instead
 * of via `DurableObjectStub<SessionEventDO>` — same workaround documented on
 * `SessionEventsRpc` in `conversation-state-do.ts` (Cloudflare's RPC
 * `Provider<T>` mapped type doesn't structurally resolve cleanly through the
 * generated stub type, so callers cast through `unknown` to a narrow
 * hand-written interface). Kept local rather than importing
 * `SessionEventsRpc` because that interface doesn't include `interrupt()`.
 */
interface SessionInterruptRpc {
  interrupt(): Promise<{ interrupted: boolean }>;
  interruptExpected(
    executionId: string,
  ): Promise<{ interrupted: boolean; cancelled: true }>;
  getState(): Promise<{
    sessionId?: string;
    executing?: { executionId: string; startedAt: number };
  }>;
}

/**
 * Detects whether a Slack Events API payload is a stop/cancel command that
 * should short-circuit routing to the bot engine.
 *
 * Matches only `event_callback` payloads whose `event.type` is
 * `"app_mention"` or (for threaded replies and DMs) `"message"`, with a
 * non-empty `event.text`, and not authored by a bot (`event.bot_id` absent).
 * Top-level channel stops require an app mention. `event.subtype` is deliberately
 * not inspected — a stop message flows through this check the same way
 * regardless of subtype.
 *
 * Returns the matched event on a hit, or `undefined` if this payload must
 * flow to the bot engine unchanged (including: not a stop phrase at all).
 */
export function extractStopCommandEvent(
  payload: SlackEventCallbackPayload,
): SlackStopEvent | undefined {
  if (payload?.type !== "event_callback") return undefined;
  const event = payload.event;
  if (!event) return undefined;
  if (event.type !== "app_mention" && event.type !== "message") {
    return undefined;
  }
  // Ordinary top-level channel chatter must never cancel an unrelated turn.
  // Thread replies and DMs are already scoped to a bot conversation.
  if (!event.thread_ts && event.type !== "app_mention") {
    const channel = event.channel;
    if (!(typeof channel === "string" && channel.startsWith("D"))) {
      return undefined;
    }
  }
  if (event.bot_id) return undefined;
  const text = event.text;
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  if (!isSlackStopCommand({ text })) return undefined;
  return event;
}

/**
 * Handle a detected stop command. Best-effort end to end: every step is
 * wrapped so a failure anywhere (dedup store, DO RPC, Slack API) never
 * throws out of this function — the HTTP `{ ok: true }` ack has already been
 * sent by the caller (`worker.ts`, from inside `waitUntil`) by the time this
 * runs.
 *
 * Steps (GOAL.md Phase A2 Task 1):
 *  1. Derive `threadKey` using the same rule as `bot-engine.ts` obligation
 *     writes (`slack:{channel}:{statusThreadTs ?? channel}`), falling back
 *     to the channel's registered active turn when stop is sent outside a
 *     thread while a threaded turn is in flight.
 *  2. Dedup on `stop:${event_id}` (Slack redelivers events aggressively —
 *     house rule 3) so a redelivered stop is a total no-op.
 *  3. Interrupt the thread's `SessionEventDO`, if registered.
 *  4. Abort any in-flight AG-UI run for the active conversation.
 *  5. Clear the render obligation for the thread (no `executionId` — a stop
 *     clears whatever is pending, not just the latest turn).
 *  6. Clear the assistant status.
 *  7. Post a short confirmation to the thread.
 *  8. Log a structured `stop_command_received` metric line.
 */
export async function handleStopCommand(
  env: Env,
  event: SlackStopEvent,
  eventId: string | undefined,
): Promise<void> {
  try {
    const channel = event.channel;
    if (!channel) return;

    const stateStore = createBotStoreAdapter(env.BOT_STATE);

    const statusThreadTs = firstSlackTs(event.thread_ts, event.ts);
    const directThreadKey = slackObligationThreadKey(channel, statusThreadTs);
    let activeTurn: ActiveTurnRecord | undefined;
    try {
      activeTurn = event.thread_ts || channel.startsWith("D")
        ? await getActiveTurnForThread(stateStore, directThreadKey)
        : await getLatestActiveTurn(stateStore, channel);
    } catch (err) {
      console.error("[stop-command] active turn lookup failed", channel, err);
    }

    const threadKey = activeTurn?.threadKey ?? directThreadKey;
    const postThreadTs = activeTurn?.threadTs ?? statusThreadTs;
    if (!postThreadTs) return;

    // Idempotency (house rule 3): a redelivered stop event must be a total
    // no-op, not a second interrupt/clear/post cycle.
    const dedupKey = `stop:${eventId ?? `${channel}:${postThreadTs}:${event.ts ?? "noeventid"}`}`;
    const alreadySeen = await stateStore.dedup.seen(dedupKey, 10 * 60_000);
    if (alreadySeen) return;

    const hitlCancellation = activeTurn?.choiceId
      ? cancelHitlChoice(stateStore, {
          conversationKey: activeTurn.conversationKey,
          choiceId: activeTurn.choiceId,
        }).catch((err) => {
          console.error("[stop-command] cancellation marker failed", threadKey, err);
        })
      : Promise.resolve();

    if (env.SESSION_EVENTS) {
      try {
        const sessionDo = env.SESSION_EVENTS.get(
          env.SESSION_EVENTS.idFromName(threadKey),
        ) as unknown as SessionInterruptRpc;
        if (activeTurn) {
          // Exact durable revocation is the first awaited action in this DO;
          // session metadata remains available after terminalization.
          await sessionDo.interruptExpected(activeTurn.executionId);
          const state: { sessionId?: string } = typeof sessionDo.getState === "function"
            ? await sessionDo.getState().catch(() => ({}))
            : {};
          // The live control plane works before /turn headers and aborts
          // clone/spawn; polling remains defense-in-depth.
          if (state.sessionId) {
            await interruptHarnessTurn(env, {
              sessionId: state.sessionId,
              threadKey,
              executionId: activeTurn.executionId,
            });
          }
        } else await sessionDo.interrupt();
      } catch (err) {
        console.error("[stop-command] interrupt failed", threadKey, err);
      }
    }
    await hitlCancellation;

    const conversationKey =
      activeTurn?.conversationKey || conversationKeyFromThreadKey(threadKey);
    if (conversationKey) {
      try {
        const { adapter } = await getOrCreateBot(env);
        adapter.abortConversation(conversationKey);
      } catch (err) {
        console.error(
          "[stop-command] abortConversation failed",
          conversationKey,
          err,
        );
      }
    }

    if (activeTurn) {
      try {
        await clearActiveTurn(stateStore, activeTurn);
      } catch (err) {
        console.error("[stop-command] active turn clear failed", threadKey, err);
      }
    }

    try {
      // No executionId: a stop clears whatever obligation is currently
      // pending for this thread, regardless of which turn wrote it.
      await stateStore.obligation.clear({ threadKey });
    } catch (err) {
      console.error("[stop-command] obligation clear failed", threadKey, err);
    }

    if (env.SLACK_BOT_TOKEN) {
      const client = createSlackWebClient(env.SLACK_BOT_TOKEN);
      try {
        await client.setStatus({
          channel_id: channel,
          thread_ts: postThreadTs,
          status: "",
        });
      } catch (err) {
        console.error("[stop-command] setStatus failed", threadKey, err);
      }
      try {
        await client.postMessage({
          channel,
          thread_ts: postThreadTs,
          text: "🛑 Stopped.",
        });
      } catch (err) {
        console.error("[stop-command] postMessage failed", threadKey, err);
      }
    }

    console.log(JSON.stringify({ metric: "stop_command_received", threadKey }));
  } catch (err) {
    console.error("[stop-command] handleStopCommand failed", err);
  }
}
