import type { Env } from "../env.js";
import { requireRequestContext } from "../request-context.js";
import { createBotStoreAdapter } from "../create-bot-store.js";
import type { ActiveTurnRecord } from "./active-turn-registry.js";
import {
  ActiveTurnRenderSuppressedError,
  markThreadNextRenderFinal,
  type CloudflareSlackAdapter,
} from "./cloudflare-slack-adapter.js";
import { bindTurnExecutionContext } from "./turn-execution-context.js";
import type { ActiveTurnEffectResource } from "../store/active-turn-types.js";

export type AdoptedShortcut = Readonly<{
  record: ActiveTurnRecord;
  store: ReturnType<typeof createBotStoreAdapter>;
}>;

/** Adopt ingress ownership before any shortcut-specific await or mutation. */
export async function adoptSlackShortcut(
  env: Pick<Env, "BOT_STATE">,
  adapter: CloudflareSlackAdapter,
  thread: object,
): Promise<AdoptedShortcut> {
  const record = requireRequestContext(thread).preAdmittedTurn?.record;
  if (!record) throw new Error("pre_admitted_turn_required_for_shortcut");
  adapter.bindThreadExecutionFence(thread, record);
  bindTurnExecutionContext(thread, record);
  const adopted = Object.freeze({
    record,
    store: createBotStoreAdapter(env.BOT_STATE),
  });
  // preAdmitSlackTurn atomically created the active row and obligation before
  // the adapter performed profile/network lookup. Adoption verifies that
  // exact ownership without ever recreating an obligation after Stop cleared
  // it.
  if (!(await shortcutStillPending(adopted))) {
    throw new ActiveTurnRenderSuppressedError();
  }
  return adopted;
}

export async function shortcutStillPending(
  adopted: AdoptedShortcut,
): Promise<boolean> {
  const snapshot = await adopted.store.activeTurn.get(adopted.record.threadKey);
  return Boolean(
    snapshot &&
      snapshot.record.executionId === adopted.record.executionId &&
      snapshot.status === "pending" &&
      !snapshot.stopEventId &&
      !snapshot.renderToken &&
      !snapshot.effectToken,
  );
}

/** Fence a direct non-Slack shortcut mutation with exact execution ownership. */
export async function runShortcutEffect<T>(
  adopted: AdoptedShortcut,
  effectName: string,
  action: () => Promise<T>,
  options?: {
    resource?: (value: T) => ActiveTurnEffectResource | undefined;
    cancelIfStopped?: (resource: ActiveTurnEffectResource) => Promise<void>;
  },
): Promise<{ status: "completed"; value: T } | { status: "suppressed" }> {
  const claim = await adopted.store.activeTurn.beginEffect({
    threadKey: adopted.record.threadKey,
    executionId: adopted.record.executionId,
    effectName,
  });
  if (claim.status !== "claimed") return { status: "suppressed" };
  const value = await action();
  const resource = options?.resource?.(value);
  if (resource) {
    const snapshot = await adopted.store.activeTurn.get(adopted.record.threadKey);
    if (
      !snapshot ||
      snapshot.record.executionId !== adopted.record.executionId ||
      snapshot.effectToken !== claim.token
    ) {
      throw new Error("active_turn_effect_confirmation_failed");
    }
    if (snapshot.stopEventId) {
      await options?.cancelIfStopped?.(resource);
    }
  }
  const confirmed = await adopted.store.activeTurn.confirmEffect({
    threadKey: adopted.record.threadKey,
    executionId: adopted.record.executionId,
    token: claim.token,
    resource,
  });
  if (!confirmed) throw new Error("active_turn_effect_confirmation_failed");
  if (!(await shortcutStillPending(adopted))) return { status: "suppressed" };
  return { status: "completed", value };
}

/** Final Slack post and lifecycle cleanup are one render confirmation. */
export async function postFinalShortcut(
  thread: { post(text: string): Promise<unknown> },
  text: string,
): Promise<boolean> {
  try {
    markThreadNextRenderFinal(thread);
    await thread.post(text);
    return true;
  } catch (err) {
    if (
      err instanceof Error && err.message === "active_turn_render_suppressed"
    ) return false;
    throw err;
  }
}

/** A successful silent shortcut still releases only a pristine provisional. */
export async function finishSilentShortcut(
  adopted: AdoptedShortcut,
): Promise<boolean> {
  return adopted.store.activeTurn.abandonPristine({
    threadKey: adopted.record.threadKey,
    executionId: adopted.record.executionId,
  });
}
