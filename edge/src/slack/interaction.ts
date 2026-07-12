/**
 * Decode Slack block_actions → InteractionEvent (vendored from channels-slack).
 */
import type { InteractionEvent } from "@copilotkit/channels";
import { DM_SCOPE, type ConversationKey } from "./types.js";

export function conversationKeyOf(key: ConversationKey): string {
  return `${key.channelId}::${key.scope}`;
}

export function decodeInteraction(raw: unknown): InteractionEvent | undefined {
  const body = raw as {
    type?: string;
    trigger_id?: string;
    user?: { id?: string; name?: string; username?: string };
    channel?: { id?: string };
    message?: { ts?: string; thread_ts?: string };
    container?: {
      thread_ts?: string;
      message_ts?: string;
      channel_id?: string;
    };
    actions?: Array<{
      action_id?: string;
      value?: string;
      selected_option?: { value?: string };
      selected_options?: Array<{ value?: string }>;
      action_ts?: string;
    }>;
  };
  if (body.type !== "block_actions") return undefined;
  const action = body.actions?.[0];
  if (!action?.action_id) return undefined;

  const channelId = body.channel?.id ?? body.container?.channel_id;
  if (!channelId) return undefined;

  const explicitThreadTs = body.message?.thread_ts ?? body.container?.thread_ts;
  const threadTs =
    explicitThreadTs ?? body.message?.ts ?? body.container?.message_ts;
  const isDm = channelId.startsWith("D");
  const scope = explicitThreadTs
    ? explicitThreadTs
    : isDm
      ? DM_SCOPE
      : (threadTs ?? "");
  const conversationKey = conversationKeyOf({ channelId, scope });
  const replyTarget = {
    channel: channelId,
    threadTs: isDm && !explicitThreadTs ? undefined : threadTs,
  };

  let value: unknown;
  if (action.selected_options) {
    value = action.selected_options.map((o) => parseValue(o.value));
  } else {
    value = parseValue(action.value ?? action.selected_option?.value);
  }

  const user = body.user?.id
    ? { id: body.user.id, name: body.user.name ?? body.user.username }
    : undefined;

  const messageTs = body.message?.ts ?? body.container?.message_ts;
  const messageRef = messageTs
    ? { id: messageTs, channel: channelId }
    : undefined;

  const eventId =
    channelId && messageTs && action.action_ts
      ? `${channelId}:${messageTs}:${action.action_ts}`
      : body.trigger_id;

  return {
    id: action.action_id,
    conversationKey,
    replyTarget,
    value,
    user,
    messageRef,
    triggerId: body.trigger_id,
    eventId,
  };
}

function parseValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
