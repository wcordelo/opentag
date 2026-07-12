/**
 * Inbound Slack message targets for reactions.
 *
 * CopilotKit's IncomingMessage.ref is empty on the CF path (`ref: { id: "" }`),
 * and thread.getMessages() can return [] if replies fetch fails, so we stash
 * channel+ts at ingress / bind it to the per-turn Thread object.
 *
 * Prefer thread-bound targets (WeakMap) so concurrent turns in the same isolate
 * cannot steal each other's reaction target via a shared conversation Map.
 */
import {
  getCurrentInboundMessage,
  setCurrentInboundMessage,
  type InboundMessageTarget,
} from "../request-context.js";

export type { InboundMessageTarget };

/** Per-turn Thread instance → inbound message to react on. */
const inboundByThread = new WeakMap<object, InboundMessageTarget>();

export function rememberInboundMessage(
  conversationKey: string,
  channel: string,
  ts: string,
): void {
  if (!channel || !ts) return;
  // Request-scoped for short-circuit reacts in the same waitUntil turn.
  void conversationKey;
  setCurrentInboundMessage(channel, ts);
}

/** Bind the react target to this turn's Thread (call once at onMention start). */
export function bindInboundToThread(
  thread: object,
  target: InboundMessageTarget | undefined,
): void {
  if (!target?.channel || !target.ts) return;
  inboundByThread.set(thread, target);
}

export function getInboundForThread(
  thread: object,
): InboundMessageTarget | undefined {
  return inboundByThread.get(thread);
}

/**
 * Resolve inbound target for reactions.
 * Prefer thread-bound (concurrent-safe), then request-scoped.
 * Does NOT use a conversation-wide Map (that raced across overlapping turns
 * and leaked stale targets into slash-command turns).
 */
export function getInboundMessage(
  conversationKey: string,
  thread?: object,
): InboundMessageTarget | undefined {
  if (thread) {
    const bound = inboundByThread.get(thread);
    if (bound) return bound;
  }
  const fromTurn = getCurrentInboundMessage();
  if (fromTurn) return fromTurn;
  // Last resort: conversation key encodes channel::threadTs (or message ts).
  if (!conversationKey.includes("::")) return undefined;
  const [channel, scope] = conversationKey.split("::");
  if (channel && scope && /^\d+\.\d+$/.test(scope)) {
    return { channel, ts: scope };
  }
  return undefined;
}
