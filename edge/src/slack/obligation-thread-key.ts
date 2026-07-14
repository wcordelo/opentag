/**
 * Shared Slack obligation / session partition key (SPEC §3.1 / GOAL Phase A2).
 *
 * `bot-engine.ts` and `stop-routing.ts` must derive the same
 * `slack:{channel}:{scope}` id — divergent keys make stop clear the wrong DO
 * and leave the obligation alarm pointed at a stale partition.
 */

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

/** Inverse of {@link slackObligationThreadKey} for abort routing when registry state is stale. */
export function conversationKeyFromThreadKey(threadKey: string): string {
  const match = /^slack:([^:]+):(.+)$/.exec(threadKey);
  if (!match) return "";
  const channelId = match[1]!;
  if (channelId.startsWith("D")) return `${channelId}::dm`;
  return `${channelId}::${match[2]!}`;
}
