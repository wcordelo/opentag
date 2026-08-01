/**
 * Shared Slack obligation / session partition key (SPEC §3.1 / GOAL Phase A2).
 *
 * `bot-engine.ts` and `stop-routing.ts` must derive the same tenant-qualified
 * id — divergent keys make stop clear the wrong DO and leave the obligation
 * alarm pointed at a stale partition.
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
  teamId: string,
  channelId: string,
  statusThreadTs?: string,
): string;
export function slackObligationThreadKey(
  channelId: string,
  statusThreadTs?: string,
): string;
export function slackObligationThreadKey(
  first: string,
  second?: string,
  third?: string,
): string {
  const tenantScoped = arguments.length >= 3;
  const tenantId = tenantScoped ? first : undefined;
  const channelId = tenantScoped ? second! : first;
  const statusThreadTs = tenantScoped ? third : second;
  const scope = channelId.startsWith("D")
    ? channelId
    : (statusThreadTs ?? channelId);
  const key = `slack:${channelId}:${scope}`;
  return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${key}` : key;
}

/** Pre-tenant rollout partition id for the same channel/thread, when distinct. */
export function legacySlackObligationThreadKey(
  teamId: string,
  channelId: string,
  statusThreadTs?: string,
): string | undefined {
  const tenantKey = slackObligationThreadKey(teamId, channelId, statusThreadTs);
  const legacyKey = slackObligationThreadKey(channelId, statusThreadTs);
  return legacyKey !== tenantKey ? legacyKey : undefined;
}

/** Inverse of tenant qualification for an already-derived partition key. */
export function legacySlackObligationThreadKeyFromKey(
  threadKey: string,
): string | undefined {
  const match = /^(?:tenant:[^:]+:)?(slack:.+)$/.exec(threadKey);
  if (!match) return undefined;
  const legacyKey = match[1]!;
  return legacyKey !== threadKey ? legacyKey : undefined;
}

/** Inverse of {@link slackObligationThreadKey} for abort routing when registry state is stale. */
export function conversationKeyFromThreadKey(threadKey: string): string {
  const match = /^(?:tenant:[^:]+:)?slack:([^:]+):(.+)$/.exec(threadKey);
  if (!match) return "";
  const channelId = match[1]!;
  if (channelId.startsWith("D")) return `${channelId}::dm`;
  return `${channelId}::${match[2]!}`;
}
