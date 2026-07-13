/**
 * Shared Slack obligation / session partition key (SPEC §3.1 / GOAL Phase A2).
 *
 * `bot-engine.ts` and `stop-routing.ts` must derive the same
 * `slack:{channel}:{scope}` id — divergent keys make stop clear the wrong DO
 * and leave the obligation alarm pointed at a stale partition.
 */

export type ActiveTurnRecord = {
  threadKey: string;
  conversationKey: string;
};

/** KV slot: which thread partition currently owns an in-flight turn. */
export const ACTIVE_TURN_KV_PREFIX = "active-turn:";

/** Per-thread active-turn record (obligation / SessionEventDO partition). */
export function activeTurnKvKey(threadKey: string): string {
  return `${ACTIVE_TURN_KV_PREFIX}${threadKey}`;
}

/** Channel-level index of in-flight turns (top-level stop without thread_ts). */
export function channelActiveTurnsKvKey(channelId: string): string {
  return `${ACTIVE_TURN_KV_PREFIX}channel:${channelId}`;
}

/** First Slack `ts`-shaped string among candidates (thread root / message ts). */
export function firstSlackTs(
  ...candidates: Array<string | undefined>
): string | undefined {
  return candidates.find((v): v is string => Boolean(v && /^\d+\.\d+$/.test(v)));
}

/**
 * Obligation + SessionEventDO partition id for a Slack channel/thread.
 *
 * DMs key on the channel: their conversationKey scope is the literal "dm"
 * (the whole DM is one conversation), so keying per-message-ts would
 * fragment sessions across turns AND make an unthreaded DM "stop" derive a
 * different key than the turn it targets. Channel turns key on the thread
 * root ts.
 */
export function slackObligationThreadKey(
  channelId: string,
  statusThreadTs?: string,
): string {
  const scope = channelId.startsWith("D")
    ? channelId
    : (statusThreadTs ?? channelId);
  return `slack:${channelId}:${scope}`;
}
