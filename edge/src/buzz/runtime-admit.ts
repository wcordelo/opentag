/**
 * Minimal post-authoritative Buzz runtime admit.
 *
 * Records a durable, secret-free admission marker after the authoritative
 * event-ID claim succeeds, then optionally posts a fixed kind-9 ack via an
 * injected publisher (NIP-98 `/events`). Does **not** invoke the Slack
 * bot-engine turn path — that stays a later slice.
 *
 * Outbound reply idempotency (§14.6): reserve with atomic `dedup.seen` on
 * `buzz-reply:v1:…` **before** publish. Forget the reservation only on
 * transient publish failure. After a successful publish (or a permanent
 * reject), never drop the reservation — even if forensic metadata `kv.set`
 * fails — so redelivery cannot emit a second kind-9.
 *
 * A separate `…:post-accepted` dedupe key is set immediately after relay
 * POST succeeds so a crash between reservation and accept can be retried
 * without double-publishing once accept is recorded.
 *
 * Marker / reply-claim values contain only public event identity fields plus
 * a forensic policy audit stamp (never key/auth-tag material).
 *
 * `policy_audit_marker` is non-enforcing in M1 — forensic only, not
 * versioning/revoke/monotonic authorization.
 */

import {
  BUZZ_REPLY_AUTH_REJECTED,
  BUZZ_REPLY_REJECTED,
  type BuzzAdmitReplyPublisher,
} from "./events-publisher.js";
import type { BuzzWakeRuntime } from "./receive.js";
import type { StateStore } from "../store/state-store-contract.js";

/** Admission marker TTL — aligns with authoritative event claim window. */
export const BUZZ_RUNTIME_ADMIT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const PERMANENT_REPLY_CODES = new Set([
  BUZZ_REPLY_AUTH_REJECTED,
  BUZZ_REPLY_REJECTED,
]);

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

export function buzzReplyPostAcceptedKey(replyKey: string): string {
  return `${replyKey}:post-accepted`;
}

/** False when admission ran but the relay kind-9 publish is still incomplete. */
export async function buzzReplyPublishIsComplete(
  store: Pick<StateStore, "kv" | "dedup"> | undefined,
  tenantId: string,
  inboundEventId: string,
): Promise<boolean> {
  if (store === undefined) {
    return true;
  }
  const replyKey = buzzRuntimeReplyKey(tenantId, inboundEventId);
  const claim = await store.kv.get<BuzzRuntimeReplyClaim>(replyKey);
  if ((claim?.reply_event_id ?? "") !== "") {
    return true;
  }
  if (await store.dedup.has(buzzReplyPostAcceptedKey(replyKey))) {
    return true;
  }
  const admitted = await store.kv.get<BuzzRuntimeAdmitRecord>(
    buzzRuntimeAdmitKey(tenantId, inboundEventId),
  );
  if (admitted === undefined) {
    return true;
  }
  return false;
}

/**
 * Build a {@link BuzzWakeRuntime} that persists a public admission marker
 * and, when `replyPublisher` is set, posts a kind-9 ack with §14.6-safe
 * outbound reservation.
 */
export function createBuzzRuntimeAdmit(
  store: Pick<StateStore, "kv" | "dedup">,
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
      const postAcceptedKey = buzzReplyPostAcceptedKey(replyKey);
      if (await store.dedup.has(postAcceptedKey)) {
        return;
      }

      if (!(await store.dedup.has(replyKey))) {
        await store.dedup.seen(replyKey, ttlMs);
      }

      let replyEventId: string;
      try {
        const published = await replyPublisher.publishAdmitReply({
          inbound: input.inbound,
        });
        replyEventId = published.replyEventId;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (PERMANENT_REPLY_CODES.has(code)) {
          // F2: keep reservation so webhook redelivery cannot hammer /events.
          await store.dedup.seen(postAcceptedKey, ttlMs);
          return;
        }
        // Transient — release reservation so a later wake can retry publish.
        await store.dedup.forget(replyKey);
        throw error;
      }

      await store.dedup.seen(postAcceptedKey, ttlMs);

      // Forensic metadata only — reservation already holds idempotency.
      // Never forget reservation if this write fails (F1).
      try {
        const claim: BuzzRuntimeReplyClaim = Object.freeze({
          v: 1,
          tenant_id: input.tenantId,
          inbound_event_id: input.inbound.eventId,
          reply_event_id: replyEventId,
          claimed_at: nowMs(),
        });
        await store.kv.set(replyKey, claim, ttlMs);
      } catch {
        // Orphan reservation ≫ duplicate kind-9.
      }
    },
  };
}
