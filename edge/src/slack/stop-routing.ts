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
import type { Env } from "../env.js";

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
}

/**
 * Detects whether a Slack Events API payload is a stop/cancel command that
 * should short-circuit routing to the bot engine.
 *
 * Matches only `event_callback` payloads whose `event.type` is
 * `"app_mention"` or `"message"`, with a non-empty `event.text`, and not
 * authored by a bot (`event.bot_id` absent). `event.subtype` is deliberately
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
 *  1. Derive `threadKey` from `channel` + `thread_ts ?? ts`.
 *  2. Dedup on `stop:${event_id}` (Slack redelivers events aggressively —
 *     house rule 3) so a redelivered stop is a total no-op.
 *  3. Interrupt the thread's `SessionEventDO`, if registered.
 *  4. Clear the render obligation for the thread (no `executionId` — a stop
 *     clears whatever is pending, not just the latest turn).
 *  5. Clear the assistant status.
 *  6. Post a short confirmation to the thread.
 *  7. Log a structured `stop_command_received` metric line.
 */
export async function handleStopCommand(
  env: Env,
  event: SlackStopEvent,
  eventId: string | undefined,
): Promise<void> {
  try {
    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    if (!channel || !threadTs) return;
    const threadKey = `slack:${channel}:${threadTs}`;

    const stateStore = createBotStoreAdapter(env.BOT_STATE);

    // Idempotency (house rule 3): a redelivered stop event must be a total
    // no-op, not a second interrupt/clear/post cycle.
    const dedupKey = `stop:${eventId ?? `${channel}:${threadTs}:${event.ts ?? "noeventid"}`}`;
    const alreadySeen = await stateStore.dedup.seen(dedupKey, 10 * 60_000);
    if (alreadySeen) return;

    if (env.SESSION_EVENTS) {
      try {
        const sessionDo = env.SESSION_EVENTS.get(
          env.SESSION_EVENTS.idFromName(threadKey),
        ) as unknown as SessionInterruptRpc;
        await sessionDo.interrupt();
      } catch (err) {
        console.error("[stop-command] interrupt failed", threadKey, err);
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
          thread_ts: threadTs,
          status: "",
        });
      } catch (err) {
        console.error("[stop-command] setStatus failed", threadKey, err);
      }
      try {
        await client.postMessage({
          channel,
          thread_ts: threadTs,
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
