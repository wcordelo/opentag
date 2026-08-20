export const SLACK_LIFECYCLE_EVENT_TYPES = [
  "app_uninstalled",
  "tokens_revoked",
  "channel_archive",
  "channel_unarchive",
  "channel_deleted",
  "channel_left",
  "channel_unshared",
  "group_archive",
  "group_unarchive",
  "group_deleted",
  "group_close",
  "group_open",
  "group_left",
  "member_left_channel",
] as const;

export type SlackLifecycleEventType = typeof SLACK_LIFECYCLE_EVENT_TYPES[number];

export type SlackLifecycleEvent = {
  teamId: string;
  eventId: string;
  eventType: SlackLifecycleEventType;
  channelId?: string;
  observedAt?: string;
};

export type SlackLifecycleChannelStatus = "active" | "archived" | "left";

type SlackLifecycleCallback = {
  type?: string;
  event_id?: string;
  team_id?: string;
  event_time?: number;
  event?: {
    type?: string;
    channel?: string;
    user?: string;
    event_ts?: string;
    tokens?: { bot?: unknown[]; oauth?: unknown[] };
  };
};

function observedAt(callback: SlackLifecycleCallback): string | undefined {
  const eventTs = callback.event?.event_ts;
  if (typeof eventTs === "string" && Number.isFinite(Number(eventTs))) {
    return new Date(Number(eventTs) * 1_000).toISOString();
  }
  if (typeof callback.event_time === "number" && Number.isFinite(callback.event_time)) {
    return new Date(callback.event_time * 1_000).toISOString();
  }
  return undefined;
}

export function slackLifecycleEventFromCallback(
  callback: SlackLifecycleCallback,
  botUserId?: string,
): SlackLifecycleEvent | undefined {
  if (callback.type !== "event_callback") return undefined;
  const teamId = callback.team_id?.trim();
  const eventType = callback.event?.type;
  if (!teamId || !eventType) return undefined;
  if (!(SLACK_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return undefined;
  }
  if (eventType === "tokens_revoked") {
    const botTokens = callback.event?.tokens?.bot;
    if (Array.isArray(botTokens) && (
      botTokens.length === 0 ||
      botUserId && !botTokens.includes(botUserId)
    )) return undefined;
  }
  if (eventType === "member_left_channel" && callback.event?.user !== botUserId) {
    return undefined;
  }
  const channelRequired = eventType !== "app_uninstalled" && eventType !== "tokens_revoked";
  const channelId = callback.event?.channel?.trim();
  if (channelRequired && !channelId) return undefined;
  const eventId = callback.event_id?.trim() || [
    "slack-lifecycle",
    teamId,
    eventType,
    channelId ?? "workspace",
    callback.event?.event_ts ?? "",
  ].join(":");
  const timestamp = observedAt(callback);
  return {
    teamId,
    eventId,
    eventType: eventType as SlackLifecycleEventType,
    ...(channelId ? { channelId } : {}),
    ...(timestamp ? { observedAt: timestamp } : {}),
  };
}

export function slackLifecycleEventDisablesInstallation(
  eventType: SlackLifecycleEventType,
): boolean {
  return eventType === "app_uninstalled" || eventType === "tokens_revoked";
}

export function slackLifecycleEventDisablesChannel(
  eventType: SlackLifecycleEventType,
): boolean {
  return eventType === "channel_archive" ||
    eventType === "channel_deleted" ||
    eventType === "channel_unshared" ||
    eventType === "channel_left" ||
    eventType === "group_archive" ||
    eventType === "group_deleted" ||
    eventType === "group_close" ||
    eventType === "group_left" ||
    eventType === "member_left_channel";
}

export function slackLifecycleChannelStatus(
  eventType: SlackLifecycleEventType,
): SlackLifecycleChannelStatus {
  if (
    eventType === "channel_unarchive" ||
    eventType === "group_unarchive" ||
    eventType === "group_open"
  ) return "active";
  if (
    eventType === "channel_left" ||
    eventType === "group_left" ||
    eventType === "member_left_channel"
  ) return "left";
  return "archived";
}
