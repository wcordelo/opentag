import {
  makeWireTurnIdentity,
  makeWireTurnIdentitySync,
} from "./harness/wire-id.js";
import type { ActiveTurnRecord } from "./store/active-turn-types.js";

/** Immutable Slack ingress identity bound to concrete per-invocation objects. */
export type InboundMessageTarget = {
  channel: string;
  ts: string;
  /** Thread root ts (assistant status/title APIs need this, not the message ts). */
  threadTs?: string;
  /** Stable ingress/action/command identity; distinct from the reaction target. */
  identity?: string;
};

export type RequestActor =
  | Readonly<{
      kind: "slack_user";
      userId: string;
    }>
  | Readonly<{
      kind: "slack_automation";
      botId?: string;
      appId?: string;
      displayName?: string;
    }>;

export type RequestContext = Readonly<{
  teamId: string;
  actor: RequestActor;
  /** Compatibility identifier. Authorization must use `actor`, not this label. */
  requesterId: string;
  inbound?: Readonly<InboundMessageTarget>;
  /** Durable ownership established at verified Worker ingress. */
  preAdmittedTurn?: Readonly<{ record: ActiveTurnRecord }>;
}>;

// Cloudflare Workers may overlap requests in one isolate. A module-level stack
// cannot follow async continuations: after an await, another request can be its
// top frame. The framework preserves the PlatformUser object from IncomingTurn
// to IncomingMessage, and bot/command handlers then bind the same immutable
// context to their concrete Thread object. Weak keys prevent stale identities.
let contextByInvocation = new WeakMap<object, RequestContext>();

export function bindRequestContext(
  invocation: object,
  context: {
    teamId: string;
    actor?: RequestActor;
    requesterId?: string;
    inbound?: InboundMessageTarget;
    preAdmittedTurn?: Readonly<{ record: ActiveTurnRecord }>;
  },
): RequestContext {
  const actor = normalizeRequestActor(
    context.actor ??
      Object.freeze({
        kind: "slack_user" as const,
        userId: context.requesterId ?? "",
      }),
  );
  const inbound = context.inbound
    ? Object.freeze({ ...context.inbound })
    : undefined;
  const immutable = Object.freeze({
    teamId: context.teamId || "unknown",
    actor,
    requesterId: requesterIdForActor(actor),
    ...(inbound ? { inbound } : {}),
    ...(context.preAdmittedTurn
      ? { preAdmittedTurn: Object.freeze({ record: Object.freeze({ ...context.preAdmittedTurn.record }) }) }
      : {}),
  });
  contextByInvocation.set(invocation, immutable);
  return immutable;
}

function boundedIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim().slice(0, 256);
  return normalized || undefined;
}

export function normalizeRequestActor(actor: RequestActor): RequestActor {
  if (actor.kind === "slack_user") {
    const userId = boundedIdentity(actor.userId);
    if (!userId) throw new Error("slack_user actor requires userId");
    return Object.freeze({ kind: "slack_user", userId });
  }
  const botId = boundedIdentity(actor.botId);
  const appId = boundedIdentity(actor.appId);
  if (!botId && !appId) {
    throw new Error("slack_automation actor requires botId or appId");
  }
  const displayName = boundedIdentity(actor.displayName);
  return Object.freeze({
    kind: "slack_automation",
    ...(botId ? { botId } : {}),
    ...(appId ? { appId } : {}),
    ...(displayName ? { displayName } : {}),
  });
}

export function requesterIdForActor(actor: RequestActor): string {
  if (actor.kind === "slack_user") return actor.userId;
  return actor.appId ? `app:${actor.appId}` : `bot:${actor.botId}`;
}

export function copyRequestContext(from: object, to: object): RequestContext {
  const context = requireRequestContext(from);
  contextByInvocation.set(to, context);
  return context;
}

export function getRequestContext(
  invocation: object | undefined,
): RequestContext | undefined {
  return invocation ? contextByInvocation.get(invocation) : undefined;
}

export function requireRequestContext(invocation: object): RequestContext {
  const context = contextByInvocation.get(invocation);
  if (!context) {
    throw new Error("Slack request context was not bound to this invocation");
  }
  return context;
}

export async function slackTurnIdentity(
  context: RequestContext,
  channelId: string,
): Promise<{ executionId: string; forwardedMessageId: string }> {
  if (!context.inbound?.ts || !channelId) {
    throw new Error("Slack turn is missing its immutable inbound message identity");
  }
  if (context.inbound.channel !== channelId) {
    throw new Error("Slack turn context channel does not match its thread");
  }
  return makeWireTurnIdentity("slack-event", [
    context.teamId,
    channelId,
    context.inbound.threadTs ?? "",
    context.inbound.ts,
    context.inbound.identity ?? context.inbound.ts,
  ]);
}

/** Await-free equivalent used by ingress before its first durable RPC. */
export function slackTurnIdentitySync(
  context: RequestContext,
  channelId: string,
): { executionId: string; forwardedMessageId: string } {
  if (!context.inbound?.ts || !channelId) {
    throw new Error("Slack turn is missing its immutable inbound message identity");
  }
  if (context.inbound.channel !== channelId) {
    throw new Error("Slack turn context channel does not match its thread");
  }
  return makeWireTurnIdentitySync("slack-event", [
    context.teamId,
    channelId,
    context.inbound.threadTs ?? "",
    context.inbound.ts,
    context.inbound.identity ?? context.inbound.ts,
  ]);
}

/** Reset weak bindings (tests only). */
export function resetRequestContext(): void {
  contextByInvocation = new WeakMap<object, RequestContext>();
}
