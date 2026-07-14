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
import {
  createSlackWebClient,
  isDefinitiveSlackFailure,
  SlackApiError,
} from "./web-api.js";
import {
  conversationKeyFromThreadKey,
  firstSlackTs,
  slackObligationThreadKey,
} from "./obligation-thread-key.js";
import {
  beginActiveTurnCancelAck,
  claimActiveTurnCancellation,
  failActiveTurnCancelAck,
  getActiveTurnForThread,
  getLatestActiveTurn,
  markActiveTurnCancelConfirmed,
  markActiveTurnCancelControlled,
  type ActiveTurnRecord,
} from "./active-turn-registry.js";
import { getOrCreateBot } from "../bot-engine.js";
import type { Env } from "../env.js";
import { interruptHarnessTurn } from "../harness/client.js";
import { cancelTask } from "../tasks/runtime.js";
async function stableSlackClientMessageId(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  ).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  getState?(): Promise<{
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
 *  2. Atomically claim cancellation for this exact execution and Stop event.
 *  3. Interrupt the thread's `SessionEventDO` and harness execution.
 *  4. Abort any in-flight AG-UI run for the active conversation.
 *  5. Post an idempotent acknowledgement keyed by the Stop event.
 *  6. Atomically clear the exact active turn and render obligation. If that
 *     cleanup fails, the same Slack event may replay step 5 with the same
 *     client_msg_id and retry cleanup; a distinct event cannot adopt it.
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
      if (!activeTurn && (event.thread_ts || channel.startsWith("D"))) {
        const obligation = await stateStore.obligation.get(directThreadKey);
        if (obligation) {
          activeTurn = {
            channelId: channel,
            threadKey: directThreadKey,
            conversationKey: conversationKeyFromThreadKey(directThreadKey) ?? "",
            executionId: obligation.executionId,
            threadTs: obligation.threadTs ?? statusThreadTs,
            registeredAt: 0,
          };
        }
      }
    } catch (err) {
      console.error("[stop-command] active turn lookup failed", channel, err);
    }

    const threadKey = activeTurn?.threadKey ?? directThreadKey;
    const postThreadTs = activeTurn?.threadTs ?? statusThreadTs;
    if (!postThreadTs) return;

    // The active-turn row owns retry/final state for this exact Slack event.
    // Do not consume generic dedup before control succeeds: Slack may redeliver
    // the identical event after a binding/container/Slack failure.
    const stopEventId = eventId ?? `${channel}:${postThreadTs}:${event.ts ?? "noeventid"}`;

    // An idle Stop has no exact execution to revoke. It is deliberately a
    // no-op: never create a generic cancel-next tombstone and never claim a
    // visible stop for unrelated future work.
    if (!activeTurn) {
      console.log(JSON.stringify({ metric: "stop_command_idle", threadKey }));
      return;
    }

    const slackClient = env.SLACK_BOT_TOKEN
      ? createSlackWebClient(env.SLACK_BOT_TOKEN)
      : undefined;

    // First make success delivery durably impossible. The short state lock is
    // already released when this function returns; none of the network calls
    // below are protected by a fixed-TTL lease.
    let cancellationClaim = await claimActiveTurnCancellation(
      stateStore,
      activeTurn,
      stopEventId,
    );
    // A non-Slack mutation has a durable pending-Stop marker. Give its RPC a
    // short chance to become definitive; effect completion atomically moves
    // the row to cancelled before another tool can begin. Ambiguous outcomes
    // retain the token and therefore never produce a false acknowledgement.
    // Effect RPCs have a bounded lifecycle and the Worker waitUntil budget is
    // long enough to keep this exact Stop delivery alive. Render requests get
    // the shorter ambiguity window; an unresolved network render must remain
    // silent rather than risk a false acknowledgement.
    // The lifecycle DO alarm durably resumes a Stop whose effect resolves
    // after this short request-local window; do not burn the Worker
    // subrequest budget polling hundreds of times.
    const maxInFlightPolls = 20;
    for (let attempt = 0;
      (cancellationClaim === "effect_in_flight" ||
        cancellationClaim === "render_in_flight") && attempt < maxInFlightPolls;
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      cancellationClaim = await claimActiveTurnCancellation(
        stateStore,
        activeTurn,
        stopEventId,
      );
    }
    if (
      cancellationClaim === "effect_in_flight" ||
      cancellationClaim === "render_in_flight"
    ) {
      console.log(JSON.stringify({
        metric: cancellationClaim === "effect_in_flight"
          ? "stop_command_effect_unresolved"
          : "stop_command_render_unresolved",
        threadKey,
      }));
      return;
    }
    if (cancellationClaim === "committed") {
      // Completion has crossed its irreversible Slack-delivery fence. It is
      // too late to promise Stopped, even if the network request is slow.
      console.log(JSON.stringify({ metric: "stop_command_delivery_committed", threadKey }));
      return;
    }
    if (cancellationClaim === "lock_unavailable") {
      console.error("[stop-command] delivery fence unavailable", threadKey);
      return;
    }

    // The pre-claim record intentionally contains routing fields only. Read
    // the exact row again after the cancellation/effect fence settles so a
    // persisted downstream research resource can never be missed. This check
    // also runs for cancel-ack recovery: a prior control transition does not
    // make it safe to acknowledge while its delivery effect is non-quiescent.
    const currentTurn = await stateStore.activeTurn.get(threadKey);
    if (!currentTurn || currentTurn.record.executionId !== activeTurn.executionId) {
      console.error("[stop-command] exact active turn disappeared", threadKey);
      return;
    }
    if (currentTurn.effectResource?.kind === "research_task") {
      if (!env.RESEARCH_TASKS || !env.INTERNAL_SECRET) {
        console.error("[stop-command] research cancellation unavailable", threadKey);
        return;
      }
      try {
        await cancelTask(env, {
          teamId: currentTurn.effectResource.teamId,
          taskId: currentTurn.effectResource.taskId,
          threadKey: currentTurn.effectResource.threadKey,
        });
      } catch (err) {
        // Non-2xx, mismatched/malformed/false-quiescent responses and
        // transport ambiguity all leave the exact Stop row retryable and
        // silent. The lifecycle alarm will invoke the same contract again.
        console.error("[stop-command] research cancellation unconfirmed", threadKey, err);
        return;
      }
    }

    const retryAcknowledgementCleanup = cancellationClaim === "ack_retry";

    let controlAccepted = false;
    if (!retryAcknowledgementCleanup) try {
      // Revoke every dynamically registered exact-id picker in the same DO
      // transaction that owns the cancelled active row. A picker registering
      // concurrently is therefore either included or observes cancellation
      // and never renders.
      await stateStore.activeTurn.cancelRegisteredChoices({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });

      if (!env.SESSION_EVENTS) {
        throw new Error("session_events_unavailable");
      }
      const sessionDo = env.SESSION_EVENTS.get(
        env.SESSION_EVENTS.idFromName(threadKey),
      ) as unknown as SessionInterruptRpc;
      const durableInterrupt = await sessionDo.interruptExpected(
        activeTurn.executionId,
      );
      if (durableInterrupt.cancelled !== true) {
        throw new Error("durable_interrupt_not_accepted");
      }

      const state = typeof sessionDo.getState === "function"
        ? await sessionDo.getState()
        : durableInterrupt.interrupted
          ? (() => { throw new Error("session_state_unavailable"); })()
          : {};
      // A session id proves a container turn was created. In that case the
      // authenticated exact /interrupt request must be accepted (a 200 no-op
      // is valid for an already-terminal/no-live-process execution).
      if (state.sessionId) {
        const harnessInterrupt = await interruptHarnessTurn(env, {
          sessionId: state.sessionId,
          threadKey,
          executionId: activeTurn.executionId,
        });
        if (!harnessInterrupt.accepted) {
          throw new Error("harness_interrupt_not_accepted");
        }
      }

      const conversationKey =
        activeTurn.conversationKey || conversationKeyFromThreadKey(threadKey);
      if (conversationKey) {
        const { adapter } = await getOrCreateBot(env);
        if (typeof adapter.abortConversation === "function") {
          adapter.abortConversation(conversationKey);
        }
      }
      controlAccepted = await markActiveTurnCancelControlled(
        stateStore,
        activeTurn,
        stopEventId,
      );
      if (!controlAccepted) throw new Error("cancel_control_state_failed");
    } catch (err) {
      console.error("[stop-command] exact interrupt failed", threadKey, err);
      // Keep both the exact active mapping and durable suppression marker so a
      // later explicit Stop can retry control without risking late success.
      return;
    }

    if (slackClient) {
      if (!retryAcknowledgementCleanup &&
          !await beginActiveTurnCancelAck(stateStore, activeTurn, stopEventId)) {
        // An identical concurrent delivery already owns the acknowledgement,
        // or this attempt no longer owns the exact execution.
        return;
      }
      try {
        await slackClient.setStatus({
          channel_id: channel,
          thread_ts: postThreadTs,
          status: "",
        });
      } catch (err) {
        console.error("[stop-command] setStatus failed", threadKey, err);
      }
      try {
        // This is intentionally last: durable suppression, exact DO
        // cancellation, approval revocation, and container /interrupt have
        // all completed successfully before the user sees this promise.
        const clientMessageId = await stableSlackClientMessageId(stopEventId);
        let posted = false;
        let lastError: unknown;
        // A thrown network failure is ambiguous. Retry only with the same
        // Slack idempotency key, so at most one acknowledgement is visible.
        for (let attempt = 0; attempt < 2 && !posted; attempt += 1) {
          try {
            const result = await slackClient.postMessage({
              channel,
              thread_ts: postThreadTs,
              text: "🛑 Stopped.",
              client_msg_id: clientMessageId,
            });
            if (!result.ok) {
              throw new SlackApiError(
                "chat.postMessage",
                result.error ?? "unknown",
              );
            }
            posted = true;
          } catch (err) {
            lastError = err;
            if (isDefinitiveSlackFailure(err)) throw err;
          }
        }
        if (!posted) throw lastError ?? new Error("stop_ack_transport_unknown");
      } catch (err) {
        console.error("[stop-command] postMessage failed", threadKey, err);
        // Only a parsed Slack rejection proves the acknowledgement was not
        // applied. Ambiguous transport failures retain cancel_ack_in_flight;
        // a different Stop cannot steal it, and TTL/obligation recovery owns
        // the unresolved outcome.
        if (isDefinitiveSlackFailure(err)) {
          await failActiveTurnCancelAck(stateStore, activeTurn, stopEventId);
        }
        return;
      }
    } else {
      // Without a visible acknowledgement the cancellation lifecycle is not
      // complete; preserve exact routing for a later retry.
      return;
    }

    let confirmed = false;
    let confirmationError: unknown;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt += 1) {
      try {
        confirmed = await markActiveTurnCancelConfirmed(
          stateStore,
          activeTurn,
          stopEventId,
        );
      } catch (err) {
        confirmationError = err;
      }
    }
    if (!confirmed) {
      console.error(
        "[stop-command] atomic confirmation/cleanup failed",
        threadKey,
        confirmationError,
      );
      return;
    }

    console.log(JSON.stringify({ metric: "stop_command_received", threadKey }));
  } catch (err) {
    console.error("[stop-command] handleStopCommand failed", err);
  }
}
