import type { LifecycleStateStore } from "../store/state-store-contract.js";
import { ACTIVE_TURN_TTL_MS, type ActiveTurnRecord } from "../store/active-turn-types.js";

export { ACTIVE_TURN_TTL_MS, type ActiveTurnRecord } from "../store/active-turn-types.js";

/**
 * `pending` may be cancelled. `delivering` is the irreversible commit point:
 * Slack I/O happens after that state is durable, so Stop must stay silent.
 * Cancellation is similarly split into durable suppression, accepted control,
 * and visible acknowledgement.
 */
export type ActiveTurnDeliveryState =
  | { status: "pending"; updatedAt: number }
  | { status: "delivering"; updatedAt: number }
  | { status: "delivered"; updatedAt: number }
  | { status: "cancelled"; updatedAt: number }
  | { status: "cancel_controlled"; updatedAt: number }
  | { status: "cancel_confirmed"; updatedAt: number };

export function activeTurnThreadKvKey(threadKey: string): string {
  return `active-turn:thread:${threadKey}`;
}

export function activeTurnRegistryKey(channelId: string): string {
  return `active-turn:channel:${channelId}`;
}

export function activeTurnDeliveryStateKey(
  threadKey: string,
  executionId: string,
): string {
  return `active-turn:delivery:${threadKey}:${executionId}`;
}

/** Retained as a compatibility alias for tests/diagnostics from the marker era. */
export function activeTurnDeliveryCancellationKey(
  threadKey: string,
  executionId: string,
): string {
  return activeTurnDeliveryStateKey(threadKey, executionId);
}

export type CancellationClaim =
  | "claimed"
  | "retry"
  | "ack_retry"
  | "effect_in_flight"
  | "render_in_flight"
  | "committed"
  | "lock_unavailable";

/**
 * Atomically suppress delivery. No Slack, DO, or container call occurs while
 * this short lock is held.
 */
export async function claimActiveTurnCancellation(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
  stopEventId = `legacy:${record.executionId}`,
): Promise<CancellationClaim> {
  const result = await store.activeTurn.claimCancellation({ ...record, stopEventId });
  if (result === "in_flight") return "render_in_flight";
  if (result === "missing") return "committed";
  return result;
}

export async function markActiveTurnCancelControlled(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
  stopEventId = `legacy:${record.executionId}`,
): Promise<boolean> {
  return store.activeTurn.markCancelControlled({ ...record, stopEventId });
}

export async function markActiveTurnCancelConfirmed(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "channelId" | "threadKey" | "executionId">,
  stopEventId = `legacy:${record.executionId}`,
): Promise<boolean> {
  return store.activeTurn.confirmCancellationAndClear({ ...record, stopEventId });
}

export async function beginActiveTurnCancelAck(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
  stopEventId: string,
): Promise<boolean> {
  return store.activeTurn.beginCancelAck({ ...record, stopEventId });
}

export async function failActiveTurnCancelAck(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
  stopEventId: string,
): Promise<boolean> {
  return store.activeTurn.failCancelAck({ ...record, stopEventId });
}

export async function discardInterruptedActiveTurnRedelivery(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "channelId" | "threadKey" | "executionId">,
): Promise<boolean> {
  return store.activeTurn.discardInterruptedRedelivery(record);
}

/**
 * Claim the irreversible delivery state under a short lock, then release it
 * before Slack I/O. A stalled network request can never outlive a lock lease
 * and let Stop acknowledge ahead of its eventual success.
 */
export async function deliverActiveTurnOutput(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
  deliver: () => Promise<void>,
  isDefinitiveFailure: (error: unknown) => boolean = () => false,
): Promise<"delivered" | "cancelled" | "committed" | "lock_unavailable"> {
  const claim = await store.activeTurn.beginRender(record);
  if (claim.status !== "claimed") {
    return claim.status === "cancelled" ? "cancelled" : "committed";
  }
  try {
    await deliver();
  } catch (err) {
    // A transport/application rejection proves no visible effect occurred,
    // so this exact render can be retried or cancelled. A thrown network
    // error is ambiguous after request dispatch: retain render_token as an
    // irreversible unknown until exact idempotent retry or TTL recovery.
    if (isDefinitiveFailure(err)) {
      await store.activeTurn.failRender({ ...record, token: claim.token });
    }
    throw err;
  }
  const confirmed = await store.activeTurn.confirmRender({
    ...record,
    token: claim.token,
    final: true,
    output: true,
  });
  if (!confirmed) throw new Error("active_turn_final_confirmation_failed");
  return "delivered";
}

/** Fence one renderer network step while keeping the turn open afterwards. */
export async function renderActiveTurnStep<T>(
  store: LifecycleStateStore,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
  render: () => Promise<T>,
  final = false,
  opts: {
    output?: boolean;
    isDefinitiveFailure?: (error: unknown) => boolean;
  } = {},
): Promise<{ status: "rendered"; value: T } | { status: "suppressed" }> {
  const claim = await store.activeTurn.beginRender(record);
  if (claim.status !== "claimed") return { status: "suppressed" };
  try {
    const value = await render();
    const confirmed = await store.activeTurn.confirmRender({
      ...record,
      token: claim.token,
      final,
      output: opts.output ?? true,
    });
    if (!confirmed) throw new Error("active_turn_render_confirmation_failed");
    return { status: "rendered", value };
  } catch (err) {
    if (opts.isDefinitiveFailure?.(err)) {
      await store.activeTurn.failRender({ ...record, token: claim.token });
    }
    throw err;
  }
}

export async function registerActiveTurn(
  store: LifecycleStateStore,
  record: ActiveTurnRecord,
): Promise<{ accepted: boolean; duplicate: boolean }> {
  return store.activeTurn.register(record);
}

/** Refresh exact routing at lifecycle boundaries without changing ownership. */
export async function refreshActiveTurn(
  store: LifecycleStateStore,
  record: ActiveTurnRecord,
): Promise<boolean> {
  return store.activeTurn.refresh(record);
}

export async function getActiveTurnForThread(
  store: LifecycleStateStore,
  threadKey: string,
): Promise<ActiveTurnRecord | undefined> {
  return (await store.activeTurn.get(threadKey))?.record;
}

/** Newest still-authoritative active turn in a channel (for unthreaded Stop). */
export async function getLatestActiveTurn(
  store: LifecycleStateStore,
  channelId: string,
): Promise<ActiveTurnRecord | undefined> {
  return (await store.activeTurn.latest(channelId))?.record;
}
