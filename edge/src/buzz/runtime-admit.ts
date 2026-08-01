/**
 * Minimal post-authoritative Buzz runtime admit.
 *
 * Records a durable, secret-free admission marker after the authoritative
 * event-ID claim succeeds, then optionally posts a fixed kind-9 ack via an
 * injected publisher (NIP-98 `/events`). Does **not** invoke the Slack
 * bot-engine turn path — that stays a later slice.
 *
 * Marker / reply-claim values contain only public event identity fields plus
 * a forensic policy audit stamp (never key/auth-tag material).
 *
 * `policy_audit_marker` is non-enforcing in M1 — forensic only, not
 * versioning/revoke/monotonic authorization.
 */

import type { BuzzAdmitReplyPublisher } from "./events-publisher.js";
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
  /** Forensic non-enforcing stamp from the installation allowlist. */
  policy_audit_marker: string;
}>;

export type BuzzRuntimeReplyClaim = Readonly<{
  v: 1;
  tenant_id: string;
  inbound_event_id: string;
  reply_event_id: string;
  claimed_at: number;
}>;

export function buzzRuntimeAdmitKey(
  tenantId: string,
  eventId: string,
): string {
  return `buzz-admit:v1:${tenantId}:${eventId}`;
}

export function buzzRuntimeReplyKey(
  tenantId: string,
  inboundEventId: string,
): string {
  return `buzz-reply:v1:${tenantId}:${inboundEventId}`;
}

/**
 * Build a {@link BuzzWakeRuntime} that persists a public admission marker
 * and, when `replyPublisher` is set, posts a kind-9 ack (idempotent via reply
 * claim KV). Reply publish failure throws after the marker write so the
 * receive pipeline can forget the authoritative claim and retry; the reply
 * claim is only written after a successful publish.
 */
export function createBuzzRuntimeAdmit(
  store: Pick<StateStore, "kv">,
  options: Readonly<{
    nowMs?: () => number;
    ttlMs?: number;
    replyPublisher?: BuzzAdmitReplyPublisher;
  }> = {},
): BuzzWakeRuntime {
  const nowMs = options.nowMs ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? BUZZ_RUNTIME_ADMIT_TTL_MS;
  const replyPublisher = options.replyPublisher;
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
        policy_audit_marker: input.policyAuditMarker,
      });
      await store.kv.set(
        buzzRuntimeAdmitKey(input.tenantId, input.inbound.eventId),
        record,
        ttlMs,
      );

      if (replyPublisher === undefined) {
        return;
      }

      const replyKey = buzzRuntimeReplyKey(
        input.tenantId,
        input.inbound.eventId,
      );
      const prior = await store.kv.get<BuzzRuntimeReplyClaim>(replyKey);
      if (prior !== undefined) {
        return;
      }

      const published = await replyPublisher.publishAdmitReply({
        inbound: input.inbound,
      });

      const claim: BuzzRuntimeReplyClaim = Object.freeze({
        v: 1,
        tenant_id: input.tenantId,
        inbound_event_id: input.inbound.eventId,
        reply_event_id: published.replyEventId,
        claimed_at: nowMs(),
      });
      await store.kv.set(replyKey, claim, ttlMs);
    },
  };
}
