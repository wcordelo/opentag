/**
 * Last inbound Slack message per conversation — used for reactions.
 * CopilotKit's IncomingMessage.ref is empty on the CF path (`ref: { id: "" }`),
 * and thread.getMessages() can return [] if replies fetch fails, so we stash
 * channel+ts at ingress time.
 *
 * Prefer request-scoped storage (same waitUntil/turn stack as tools) so we
 * don't depend on conversationKey matching across Map lookups.
 */
import {
  getCurrentInboundMessage,
  setCurrentInboundMessage,
  type InboundMessageTarget,
} from "../request-context.js";

const lastInboundByConversation = new Map<string, InboundMessageTarget>();

export function rememberInboundMessage(
  conversationKey: string,
  channel: string,
  ts: string,
): void {
  if (!channel || !ts) return;
  setCurrentInboundMessage(channel, ts);
  if (conversationKey) {
    lastInboundByConversation.set(conversationKey, { channel, ts });
  }
}

export function getInboundMessage(
  conversationKey: string,
): InboundMessageTarget | undefined {
  // Request-scoped first — set at ingress inside runWithTeamId.
  const fromTurn = getCurrentInboundMessage();
  if (fromTurn) return fromTurn;
  if (!conversationKey) return undefined;
  return lastInboundByConversation.get(conversationKey);
}
