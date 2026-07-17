import type { Env } from "../env.js";
import {
  requesterIdForActor,
  slackTurnIdentitySync,
  type RequestActor,
  type RequestContext,
} from "../request-context.js";
import { DurableObjectStateStore } from "../store/durable-object-state-store.js";
import { ACTIVE_TURN_TTL_MS, type ActiveTurnRecord } from "./active-turn-registry.js";
import { conversationKeyOf, DM_SCOPE, stripMentions } from "./channels-slack-lite.js";
import { slackObligationThreadKey } from "./obligation-thread-key.js";
import { stableSlackClientMessageId } from "./client-message-id.js";
import {
  classifyTrustedRichTrigger,
  type TrustedTriggerConfig,
} from "./trusted-trigger.js";

/** Exact durable ownership established before any bot/profile/file/config await. */
export type PreAdmittedTurn = Readonly<{
  record: ActiveTurnRecord;
}>;

export type PreAdmissionResult =
  | Readonly<{ status: "accepted"; turn: PreAdmittedTurn }>
  | Readonly<{ status: "duplicate"; turn: PreAdmittedTurn }>
  | Readonly<{ status: "concurrent" }>
  | Readonly<{ status: "ineligible" }>;

type RawEvent = {
  team_id?: unknown;
  event_id?: unknown;
  event?: {
    type?: unknown;
    subtype?: unknown;
    bot_id?: unknown;
    app_id?: unknown;
    bot_profile?: unknown;
    channel?: unknown;
    channel_type?: unknown;
    user?: unknown;
    text?: unknown;
    files?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    blocks?: unknown;
    attachments?: unknown;
  };
};

export type PreAdmissionIdentity = Readonly<{
  teamId: string;
  channelId: string;
  conversationKey: string;
  threadTs?: string;
  actor: RequestActor;
  requesterId: string;
  inboundTs: string;
  eventId: string;
}>;

/** Pure extraction only: no Slack lookup and no mutable isolate state. */
export function preAdmissionIdentityForEvent(
  body: unknown,
  trustedConfig?: TrustedTriggerConfig,
): PreAdmissionIdentity | undefined {
  const raw = body as RawEvent;
  const event = raw?.event;
  const type = typeof event?.type === "string" ? event.type : "";
  const trusted = classifyTrustedRichTrigger(event, trustedConfig ?? {
    actors: new Set(),
    valid: true,
  });
  const isDmMessage = type === "message" && event?.channel_type === "im";
  const isThreadReply =
    type === "message" &&
    event?.channel_type !== "im" &&
    typeof event?.thread_ts === "string" &&
    event.thread_ts.trim().length > 0;
  if (
    type !== "app_mention" &&
    !isDmMessage &&
    !isThreadReply &&
    !trusted
  ) return undefined;
  if (
    event?.subtype &&
    event.subtype !== "file_share" &&
    !(trusted && event.subtype === "bot_message")
  ) return undefined;
  if (event?.bot_id && !event?.user && !trusted) return undefined;
  const text = trusted
    ? trusted.displayText
    : typeof event?.text === "string"
      ? stripMentions(event.text)
      : "";
  const hasFiles = Array.isArray(event?.files) && event.files.length > 0;
  if (!text && !hasFiles) return undefined;
  const teamId = typeof raw.team_id === "string" ? raw.team_id : "unknown";
  const envelopeId = typeof raw.event_id === "string" ? raw.event_id.trim() : "";
  const channelId = typeof event?.channel === "string" ? event.channel.trim() : "";
  const actor: RequestActor = trusted?.actor ?? {
    kind: "slack_user",
    userId: typeof event?.user === "string" ? event.user.trim() : "",
  };
  const requesterId = requesterIdForActor(actor);
  const inboundTs = typeof event?.ts === "string" ? event.ts.trim() : "";
  const rawThreadTs =
    typeof event?.thread_ts === "string" ? event.thread_ts.trim() : "";
  const eventId = envelopeId || (channelId && inboundTs ? `${channelId}:${inboundTs}` : "");
  if (!eventId || !channelId || !requesterId || !inboundTs) return undefined;
  const threadTs = rawThreadTs || inboundTs;
  // threadTs falls back to the message's own ts for top-level mentions —
  // that message roots the bot's reply thread, so the mention and its
  // thread share one conversation (see handleEventsBody for the rationale).
  const scope = isDmMessage ? DM_SCOPE : threadTs;
  return {
    teamId,
    channelId,
    conversationKey: conversationKeyOf({ channelId, scope }),
    threadTs,
    actor,
    requesterId,
    inboundTs,
    eventId,
  };
}

export function preAdmissionIdentityForCommand(body: {
  command?: string;
  channel_id?: string;
  user_id?: string;
  trigger_id?: string;
  team_id?: string;
  thread_ts?: string;
}): PreAdmissionIdentity | undefined {
  // Every production command surface owns an exact lifecycle. Config and
  // research can mutate remote/durable state just as an agent tool can, so
  // they must be stoppable before their first lookup or effect.
  if (!["/agent", "/config", "/research"].includes(body.command ?? "")) {
    return undefined;
  }
  const teamId = body.team_id?.trim() || "unknown";
  const triggerId = body.trigger_id?.trim() || "";
  const channelId = body.channel_id?.trim() || "";
  const requesterId = body.user_id?.trim() || "";
  if (!triggerId || !channelId || !requesterId) return undefined;
  const eventId = `${body.command}:${requesterId}:${triggerId}`;
  const threadTs = body.thread_ts?.trim() || undefined;
  const isDm = channelId.startsWith("D");
  const scope = isDm ? DM_SCOPE : (threadTs ?? channelId);
  return {
    teamId,
    channelId,
    conversationKey: conversationKeyOf({ channelId, scope }),
    threadTs,
    actor: { kind: "slack_user", userId: requesterId },
    requesterId,
    inboundTs: eventId,
    eventId,
  };
}

/**
 * Preserve the authoritative registration outcome. An exact duplicate has
 * the same immutable execution identity and may be acknowledged
 * idempotently; a distinct active execution is concurrent and must be retried
 * by durable ingress rather than treated as consumed.
 */
export async function preAdmitSlackTurnResult(
  env: Pick<Env, "BOT_STATE">,
  identity: PreAdmissionIdentity | undefined,
): Promise<PreAdmissionResult> {
  if (!identity) return Object.freeze({ status: "ineligible" });
  const context: RequestContext = Object.freeze({
    teamId: identity.teamId,
    actor: identity.actor,
    requesterId: identity.requesterId,
    inbound: Object.freeze({
      channel: identity.channelId,
      ts: identity.inboundTs,
      ...(identity.threadTs ? { threadTs: identity.threadTs } : {}),
      identity: identity.eventId,
    }),
  });
  // This derivation is deliberately synchronous: the first await in this
  // function is the authoritative registration RPC below.
  const { executionId } = slackTurnIdentitySync(context, identity.channelId);
  const record: ActiveTurnRecord = {
    channelId: identity.channelId,
    threadKey: slackObligationThreadKey(identity.channelId, identity.threadTs),
    conversationKey: identity.conversationKey,
    executionId,
    liveClientMessageId: stableSlackClientMessageId(executionId),
    ...(identity.threadTs ? { threadTs: identity.threadTs } : {}),
    registeredAt: Date.now(),
  };
  const store = new DurableObjectStateStore({ namespace: env.BOT_STATE });
  // Registration and the never-silent obligation share one SQLite
  // transaction. Thus profile/config/file awaits can never run while Stop
  // sees an active shortcut with no recoverable obligation.
  const registration = await store.activeTurn.registerWithObligation({
    record,
    obligation: {
      afterEventId: 0,
      channel: identity.channelId,
      threadTs: identity.threadTs,
      liveClientMessageId: record.liveClientMessageId,
      liveMessageState: "reserved",
      timeoutMs: ACTIVE_TURN_TTL_MS,
    },
  });
  const turn = Object.freeze({
    record: Object.freeze(record),
  });
  if (registration.accepted) {
    return Object.freeze({ status: "accepted", turn });
  }
  if (registration.duplicate) {
    return Object.freeze({ status: "duplicate", turn });
  }
  return Object.freeze({ status: "concurrent" });
}

/** Compatibility wrapper for callers where any non-accepted result is final. */
export async function preAdmitSlackTurn(
  env: Pick<Env, "BOT_STATE">,
  identity: PreAdmissionIdentity | undefined,
): Promise<PreAdmittedTurn | undefined> {
  const result = await preAdmitSlackTurnResult(env, identity);
  return result.status === "accepted" ? result.turn : undefined;
}

/** Release a provisional row only when ingress failed before framework handoff. */
export async function abandonPreAdmittedTurn(
  env: Pick<Env, "BOT_STATE">,
  turn: PreAdmittedTurn | undefined,
): Promise<void> {
  if (!turn) return;
  await new DurableObjectStateStore({ namespace: env.BOT_STATE }).activeTurn
    .abandonPristine({
      threadKey: turn.record.threadKey,
      executionId: turn.record.executionId,
    });
}

export async function isPreAdmittedTurnPending(
  env: Pick<Env, "BOT_STATE">,
  turn: PreAdmittedTurn,
): Promise<boolean> {
  const snapshot = await new DurableObjectStateStore({ namespace: env.BOT_STATE })
    .activeTurn.get(turn.record.threadKey);
  return Boolean(
    snapshot &&
      snapshot.record.executionId === turn.record.executionId &&
      snapshot.status === "pending" &&
      !snapshot.stopEventId &&
      !snapshot.renderToken &&
      !snapshot.effectToken,
  );
}
