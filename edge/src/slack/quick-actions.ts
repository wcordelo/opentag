/**
 * Quick button-click handling (ported pattern from centaur's quick-actions.ts).
 *
 * Rather than building a parallel button-execution path, clicks are converted
 * into ordinary agent turns in the originating thread: the click becomes a
 * synthetic in-thread message authored by the CLICKING user and enters the
 * bot's normal ingress sink — inheriting dedup, requester identity, the turn
 * lock, render obligations, and tool permission checks (SPEC.md §3.4, §6
 * "buttons are just user turns").
 */
import type { IncomingTurn } from "@copilotkit/channels";
import {
  QUICK_ACTION_PREFIX,
  type QuickActionKind,
  type QuickRef,
} from "./quick-card.js";
import { conversationKeyOf, DM_SCOPE } from "./channels-slack-lite.js";
import { bindRequestContext } from "../request-context.js";
import { createSlackWebClient } from "./web-api.js";
import { getOrCreateBot } from "../bot-engine.js";
import type { Env } from "../env.js";

export interface QuickAction {
  kind: QuickActionKind;
  ref: QuickRef;
}

const PROMPTS: Record<QuickActionKind, (ref: QuickRef) => string> = {
  regenerate: (ref) =>
    ref.type === "artifact"
      ? `Re-generate the artifact \`${ref.artifactId}\` (${ref.url}). Rebuild it with the same intent as the original request in this thread, improving on any feedback above, and publish it to the same location.`
      : `Re-run the previous request in this thread and post the updated result.`,
  files: (ref) =>
    ref.type === "artifact"
      ? `Show the current file listing and metadata for the artifact \`${ref.artifactId}\` (${ref.url}), and summarize it briefly.`
      : `List the files/outputs produced by the previous request in this thread.`,
  delete: (ref) =>
    ref.type === "artifact"
      ? `Delete the artifact \`${ref.artifactId}\` (${ref.url}), then confirm what was removed.`
      : `Delete the output produced by the previous request in this thread, then confirm what was removed.`,
  retry: (ref) =>
    ref.type === "issue_list"
      ? `Re-run the previous Linear issue search in this thread${ref.heading ? ` ("${ref.heading}")` : ""} and post the updated results.`
      : `Retry the previous request in this thread with the same parameters.`,
};

const QUICK_KINDS: ReadonlySet<string> = new Set([
  "regenerate",
  "files",
  "delete",
  "retry",
] satisfies QuickActionKind[]);

/** Map a Slack action_id back to its quick action kind, or null. */
export function parseQuickActionKind(actionId: string): QuickActionKind | null {
  if (!actionId.startsWith(QUICK_ACTION_PREFIX)) return null;
  const kind = actionId.slice(QUICK_ACTION_PREFIX.length);
  return QUICK_KINDS.has(kind) ? (kind as QuickActionKind) : null;
}

/** Decode the ref carried in a quick button's `value` payload, or null. */
export function parseQuickRef(value: string | undefined): QuickRef | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as {
      type?: unknown;
      artifactId?: unknown;
      url?: unknown;
      heading?: unknown;
    };
    if (
      parsed.type === "artifact" &&
      typeof parsed.artifactId === "string" &&
      typeof parsed.url === "string"
    ) {
      return { type: "artifact", artifactId: parsed.artifactId, url: parsed.url };
    }
    if (parsed.type === "issue_list") {
      return {
        type: "issue_list",
        ...(typeof parsed.heading === "string"
          ? { heading: parsed.heading }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse a block_actions action (id + value) into a QuickAction, or null. */
export function parseQuickAction(
  actionId: string,
  value: string | undefined,
): QuickAction | null {
  const kind = parseQuickActionKind(actionId);
  if (!kind) return null;
  const ref = parseQuickRef(value);
  if (!ref) return null;
  return { kind, ref };
}

/** The natural-language instruction the agent receives for this click. */
export function buildQuickActionPrompt(action: QuickAction): string {
  return PROMPTS[action.kind](action.ref);
}

type QuickInteractionPayload = {
  type?: string;
  trigger_id?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ action_id?: string; value?: string; action_ts?: string }>;
};

/** True when a block_actions payload should be routed to handleQuickAction. */
export function isQuickInteraction(payload: unknown): boolean {
  const body = payload as QuickInteractionPayload;
  return (
    body?.type === "block_actions" &&
    typeof body.actions?.[0]?.action_id === "string" &&
    body.actions[0].action_id.startsWith(QUICK_ACTION_PREFIX)
  );
}

/** Stable identity for a standard Slack click; absent means reject ingress. */
export function quickActionEventId(payload: unknown): string | undefined {
  const body = payload as QuickInteractionPayload;
  const actionTs = body.actions?.[0]?.action_ts?.trim();
  const messageTs = body.message?.ts?.trim();
  const channel = body.channel?.id?.trim();
  if (!actionTs || !messageTs || !channel) return undefined;
  return `quick:${channel}:${messageTs}:${actionTs}`;
}

/**
 * Turn a quick button click into a synthetic agent turn via the bot's normal
 * ingress sink. Best-effort: malformed payloads log and return handled:false;
 * they never throw out of the interactions route.
 */
export async function handleQuickAction(
  env: Env,
  payload: unknown,
  teamId = "unknown",
): Promise<{ handled: boolean }> {
  const body = payload as QuickInteractionPayload;
  const action = body.actions?.[0];
  const channel = body.channel?.id;
  const userId = body.user?.id;
  const messageTs = body.message?.ts;
  if (!action?.action_id || !channel || !userId) {
    console.warn("[quick-actions] payload missing action/channel/user");
    return { handled: false };
  }

  const quick = parseQuickAction(action.action_id, action.value);
  if (!quick) {
    console.warn(
      "[quick-actions] undecodable quick action",
      action.action_id,
      (action.value ?? "").slice(0, 120),
    );
    return { handled: false };
  }

  const threadTs = body.message?.thread_ts ?? messageTs;
  const isDm = channel.startsWith("D");
  const scope = isDm ? DM_SCOPE : (threadTs ?? channel);
  const conversationKey = conversationKeyOf({ channelId: channel, scope });

  const { adapter } = await getOrCreateBot(env);
  const resolvedProfile = await resolveClickingUser(env, userId);
  const resolved = { ...resolvedProfile, id: resolvedProfile?.id ?? userId };
  const quickEventId = quickActionEventId(body);
  if (!quickEventId) {
    console.warn("[quick-actions] rejecting click without message.ts/action_ts");
    return { handled: false };
  }

  const turn: IncomingTurn = {
    conversationKey,
    // messageTs is the CLICKED message (reactions target it); threadTs is the
    // thread root — mirrors handleEventsBody's replyTarget field semantics.
    replyTarget: isDm
      ? {
          channel,
          statusTs: threadTs,
          messageTs: messageTs ?? threadTs,
          recipientUserId: userId,
        }
      : {
          channel,
          threadTs,
          messageTs: messageTs ?? threadTs,
          recipientUserId: userId,
        },
    userText: buildQuickActionPrompt(quick),
    user: resolved,
    // Deterministic per click: Slack redelivers interactions; the pipeline's
    // event dedup keys on this (house rule 3).
    eventId: quickEventId,
    platform: "slack",
  };

  bindRequestContext(resolved, {
    teamId,
    requesterId: resolved.id,
    ...((messageTs ?? threadTs)
      ? {
          inbound: {
            channel,
            ts: (messageTs ?? threadTs)!,
            threadTs,
            identity: quickEventId,
          },
        }
      : {}),
  });
  await adapter.getSink().onTurn(turn);
  console.log(
    JSON.stringify({
      metric: "quick_action_turn",
      kind: quick.kind,
      conversationKey,
    }),
  );
  return { handled: true };
}

/**
 * Resolve the clicking user's display name/email so the synthetic turn carries
 * real requester identity ([Requester Context], tool permission checks).
 */
async function resolveClickingUser(env: Env, userId: string) {
  if (!env.SLACK_BOT_TOKEN) return { id: userId };
  try {
    return await createSlackWebClient(env.SLACK_BOT_TOKEN).resolveUser(userId);
  } catch {
    return { id: userId };
  }
}
