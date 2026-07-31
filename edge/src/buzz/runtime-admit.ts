/**
 * Minimal post-authoritative Buzz runtime admit.
 *
 * Records a durable, secret-free admission marker after the authoritative
 * event-ID claim succeeds. Does **not** invoke the Slack bot-engine turn path
 * — that stays a later slice. Marker values contain only public event identity
 * fields (never key/auth-tag material).
 */

import type { BuzzWakeRuntime } from "./receive.js";
import type { StateStore } from "../store/state-store-contract.js";

/** Admission marker TTL — aligns with authoritative event claim window. */
export const BUZZ_RUNTIME_ADMIT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type BuzzRuntimeAdmitRecord = Readonly<{
  v: 1;
  tenant_id: string;
  channel_id: string;
  event_id: string;
  author_pubkey: string;
  conversation_key: string;
  admitted_at: number;
}>;

export function buzzRuntimeAdmitKey(
  tenantId: string,
  eventId: string,
): string {
  return `buzz-admit:v1:${tenantId}:${eventId}`;
}

/**
 * Build a {@link BuzzWakeRuntime} that persists a public admission marker.
 */
export function createBuzzRuntimeAdmit(
  store: Pick<StateStore, "kv">,
  options: Readonly<{ nowMs?: () => number; ttlMs?: number }> = {},
): BuzzWakeRuntime {
  const nowMs = options.nowMs ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? BUZZ_RUNTIME_ADMIT_TTL_MS;
  return {
    async admit(input) {
      const record: BuzzRuntimeAdmitRecord = Object.freeze({
        v: 1,
        tenant_id: input.tenantId,
        channel_id: input.inbound.channelId,
        event_id: input.inbound.eventId,
        author_pubkey: input.inbound.authorPubkey,
        conversation_key: input.conversationKey,
        admitted_at: nowMs(),
      });
      await store.kv.set(
        buzzRuntimeAdmitKey(input.tenantId, input.inbound.eventId),
        record,
        ttlMs,
      );
    },
  };
}
