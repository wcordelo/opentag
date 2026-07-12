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

/** KV slot: which thread partition currently owns the channel's in-flight turn. */
export const ACTIVE_TURN_KV_PREFIX = "active-turn:";

export function activeTurnKvKey(channelId: string): string {
  return `${ACTIVE_TURN_KV_PREFIX}${channelId}`;
}

/** First Slack `ts`-shaped string among candidates (thread root / message ts). */
export function firstSlackTs(
  ...candidates: Array<string | undefined>
): string | undefined {
  return candidates.find((v): v is string => Boolean(v && /^\d+\.\d+$/.test(v)));
}

/** Obligation + SessionEventDO partition id for a Slack channel/thread. */
export function slackObligationThreadKey(
  channelId: string,
  statusThreadTs?: string,
): string {
  return `slack:${channelId}:${statusThreadTs ?? channelId}`;
}
