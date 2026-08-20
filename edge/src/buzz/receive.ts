/**
 * Buzz wake receive pipeline (signer-agnostic wiring).
 *
 * Order is load-bearing (Athena A2 / M0 receive-strategy):
 * 1. Untrusted wake → `claimBuzzWake` (pre-fetch fast path only)
 * 2. Injected canonical fetch + signature verify (custody stays outside)
 * 3. Bind/normalize via {@link normalizeBuzzInboundEvent}
 *    (`expectedChannelId` = wake `channel_id` — arms channel cross-check)
 * 4. Installation allowlist (distinct relay-origin grant) — never skip on
 *    wake `first` alone; loss-side re-entry must re-hit this gate
 * 5. Authoritative per-tenant/channel DO event-ID claim (`buzz-event:v1:`)
 * 6. Injected runtime admit
 *
 * A wake `first` must never bypass steps 4–5. Pre-fetch and authoritative keys
 * use distinct namespaces so they cannot collide in the shared `dedup` table.
 * Both keys use the same directory-resolved tenant (Athena).
 *
 * Loss-side (Prometheus): a pre-fetch `duplicate` does **not** skip by itself.
 * Cross-check authoritative via read-only `has` on the wake's
 * `(tenant, channel_id, message_id)` under `buzz-event:v1:`. If authoritative
 * is unseen, the prior attempt died before admission → re-fetch. If seen,
 * skip is safe (no double-run).
 *
 * No NIP-98 signer, secrets, membership, or deploy live here — those stay
 * injected or loco-gated.
 */

import {
  enforceBuzzRelayOriginAllowlist,
  type BuzzInstallationAllowlist,
} from "./allowlist.js";
import {
  BuzzContractError,
  buzzConversationKey,
  normalizeBuzzInboundEvent,
  type BuzzInboundEvent,
  type CanonicalInternalTenantId,
} from "./contract.js";
import {
  BUZZ_WAKE_DEDUPE_TTL_MS,
  claimBuzzWake,
  type BuzzChannelTenantDirectory,
  type BuzzEventDedupe,
  type BuzzWakeClaimResult,
  type BuzzWakeDedupe,
  type BuzzWakeEnvelope,
} from "./wake.js";
import type { StateStore } from "../store/state-store-contract.js";

/**
 * Default TTL for authoritative post-fetch event-ID claims.
 * Strictly greater than {@link BUZZ_WAKE_DEDUPE_TTL_MS} (7d) so the
 * "processed" guarantee outlives the pre-fetch fast-path with margin.
 */
export const BUZZ_AUTHORITATIVE_EVENT_DEDUPE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Transport seam: fetch the canonical event by ID and verify its Nostr
 * signature. Implementations own custody/NIP-98; this module only consumes a
 * verified raw event object.
 */
export type BuzzCanonicalEventFetcher = {
  fetchAndVerify(input: Readonly<{
    messageId: string;
    channelId: string;
    authorPubkey: string;
    tenantId: CanonicalInternalTenantId;
  }>): Promise<unknown>;
};

/** Runtime seam after authoritative admission. Not the Slack bot engine. */
export type BuzzWakeRuntime = {
  admit(input: Readonly<{
    tenantId: CanonicalInternalTenantId;
    inbound: BuzzInboundEvent;
    conversationKey: string;
    /** Forensic non-enforcing stamp from the installation allowlist. */
    policyAuditMarker: string;
  }>): Promise<void>;
};

export type BuzzWakeReceiveDeps = Readonly<{
  directory: BuzzChannelTenantDirectory;
  wakeDedupe: BuzzWakeDedupe;
  /** Must support read-only `has` for loss-safe pre-fetch redelivery. */
  authoritativeDedupe: BuzzEventDedupe;
  fetcher: BuzzCanonicalEventFetcher;
  runtime: BuzzWakeRuntime;
  /**
   * Installation allowlist. Distinct allowed-origin vs live fetch base.
   * Required — absence would bypass the only M1 origin gate.
   */
  allowlist: BuzzInstallationAllowlist;
  wakeDedupeTtlMs?: number;
  authoritativeDedupeTtlMs?: number;
}>;

export type BuzzWakeReceiveResult =
  | Readonly<{
    status: "accepted";
    wake: BuzzWakeEnvelope;
    tenantId: CanonicalInternalTenantId;
    inbound: BuzzInboundEvent;
    conversationKey: string;
    wakeClaim: BuzzWakeClaimResult;
    authoritativeDedupeKey: string;
  }>
  | Readonly<{
    status: "duplicate";
    stage: "pre_fetch" | "authoritative";
    wake: BuzzWakeEnvelope;
    tenantId: CanonicalInternalTenantId;
    dedupeKey: string;
    wakeClaim: BuzzWakeClaimResult;
    inbound?: BuzzInboundEvent;
  }>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function lengthPrefixed(value: string): string {
  return `${utf8Bytes(value)}:${value}`;
}

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const CHANNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Authoritative post-fetch event-ID key. Distinct from `buzz-wake:v1:` so a
 * pre-fetch claim can never satisfy (or collide with) admission dedupe.
 */
export function buzzAuthoritativeEventDedupeKey(
  tenantId: CanonicalInternalTenantId,
  event: Pick<BuzzInboundEvent, "channelId" | "eventId">,
): string {
  if (!CHANNEL_ID_RE.test(event.channelId)) {
    throw new BuzzContractError("buzz_invalid_channel");
  }
  if (!EVENT_ID_RE.test(event.eventId)) {
    throw new BuzzContractError("buzz_invalid_event_id");
  }
  return `buzz-event:v1:${lengthPrefixed(tenantId)}${lengthPrefixed(event.channelId)}${lengthPrefixed(event.eventId)}`;
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuzzContractError(code);
  }
  return value as Record<string, unknown>;
}

/**
 * Bind a signature-verified raw event to the wake identity before normalize.
 * Prevents a fetcher from admitting a different event than the wake named.
 */
export function bindVerifiedEventToWake(
  raw: unknown,
  wake: BuzzWakeEnvelope,
): BuzzInboundEvent {
  const value = requireObject(raw, "buzz_receive_invalid_verified_event");
  if (typeof value.id !== "string" || value.id !== wake.messageId) {
    throw new BuzzContractError("buzz_receive_event_id_mismatch");
  }
  if (typeof value.pubkey !== "string" || value.pubkey !== wake.authorPubkey) {
    throw new BuzzContractError("buzz_receive_author_mismatch");
  }
  return normalizeBuzzInboundEvent(raw, wake.channelId);
}

/**
 * Claim the event ID in the authoritative namespace after fetch + verify.
 * `seen` returns true when already claimed (duplicate).
 * Uses the same directory-resolved `tenantId` as the wake claim.
 */
export async function claimAuthoritativeBuzzEvent(
  tenantId: CanonicalInternalTenantId,
  inbound: BuzzInboundEvent,
  dedupe: BuzzWakeDedupe,
  ttlMs: number = BUZZ_AUTHORITATIVE_EVENT_DEDUPE_TTL_MS,
): Promise<Readonly<{ status: "first" | "duplicate"; dedupeKey: string }>> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new BuzzContractError("buzz_receive_invalid_dedupe_ttl");
  }
  const dedupeKey = buzzAuthoritativeEventDedupeKey(tenantId, inbound);
  const duplicate = await dedupe.seen(dedupeKey, ttlMs);
  return Object.freeze({
    status: duplicate ? "duplicate" : "first",
    dedupeKey,
  });
}

/**
 * Read-only authoritative probe keyed from wake identity (no fetch required).
 * Does not write — safe to call on pre-fetch redelivery.
 */
export async function hasAuthoritativeBuzzEvent(
  tenantId: CanonicalInternalTenantId,
  wake: Pick<BuzzWakeEnvelope, "channelId" | "messageId">,
  dedupe: BuzzEventDedupe,
): Promise<Readonly<{ claimed: boolean; dedupeKey: string }>> {
  const dedupeKey = buzzAuthoritativeEventDedupeKey(tenantId, {
    channelId: wake.channelId,
    eventId: wake.messageId,
  });
  const claimed = await dedupe.has(dedupeKey);
  return Object.freeze({ claimed, dedupeKey });
}

/**
 * Full wake→admit pipeline. Callers supply fetch/verify and runtime; this
 * function enforces ordering and fail-closed identity checks.
 */
export async function processBuzzWakeReceive(
  rawWake: unknown,
  deps: BuzzWakeReceiveDeps,
): Promise<BuzzWakeReceiveResult> {
  const wakeClaim = await claimBuzzWake(
    rawWake,
    deps.directory,
    deps.wakeDedupe,
    deps.wakeDedupeTtlMs ?? BUZZ_WAKE_DEDUPE_TTL_MS,
  );

  // Pre-fetch duplicate is not sufficient to skip: prior attempt may have
  // written the wake key then died before authoritative admission (loss-side).
  if (wakeClaim.status === "duplicate") {
    const prior = await hasAuthoritativeBuzzEvent(
      wakeClaim.tenantId,
      wakeClaim.wake,
      deps.authoritativeDedupe,
    );
    if (prior.claimed) {
      return Object.freeze({
        status: "duplicate",
        stage: "pre_fetch",
        wake: wakeClaim.wake,
        tenantId: wakeClaim.tenantId,
        dedupeKey: wakeClaim.dedupeKey,
        wakeClaim,
      });
    }
    // Authoritative unseen → re-enter fetch/admit path below.
  }

  enforceBuzzRelayOriginAllowlist(deps.allowlist);

  const verifiedRaw = await deps.fetcher.fetchAndVerify({
    messageId: wakeClaim.wake.messageId,
    channelId: wakeClaim.wake.channelId,
    authorPubkey: wakeClaim.wake.authorPubkey,
    tenantId: wakeClaim.tenantId,
  });
  // Wake channel_id is expectedChannelId — rejects fetched events from another channel.
  const inbound = bindVerifiedEventToWake(verifiedRaw, wakeClaim.wake);
  const conversationKey = buzzConversationKey(wakeClaim.tenantId, inbound);

  const authoritative = await claimAuthoritativeBuzzEvent(
    wakeClaim.tenantId,
    inbound,
    deps.authoritativeDedupe,
    deps.authoritativeDedupeTtlMs ?? BUZZ_AUTHORITATIVE_EVENT_DEDUPE_TTL_MS,
  );

  if (authoritative.status === "duplicate") {
    return Object.freeze({
      status: "duplicate",
      stage: "authoritative",
      wake: wakeClaim.wake,
      tenantId: wakeClaim.tenantId,
      dedupeKey: authoritative.dedupeKey,
      wakeClaim,
      inbound,
    });
  }

  try {
    await deps.runtime.admit({
      tenantId: wakeClaim.tenantId,
      inbound,
      conversationKey,
      policyAuditMarker: deps.allowlist.policyAuditMarker,
    });
  } catch (error) {
    await deps.authoritativeDedupe.forget(authoritative.dedupeKey);
    throw error;
  }

  return Object.freeze({
    status: "accepted",
    wake: wakeClaim.wake,
    tenantId: wakeClaim.tenantId,
    inbound,
    conversationKey,
    wakeClaim,
    authoritativeDedupeKey: authoritative.dedupeKey,
  });
}

/**
 * Bridge a production {@link StateStore} dedup surface onto the Buzz receive
 * seams. Uses the same `seen`/`has` pair the Durable Object implements — not
 * a Map double — so loss-side recovery is backed by the real primitive.
 */
export function stateStoreBuzzEventDedupe(
  store: Pick<StateStore, "dedup">,
): BuzzEventDedupe {
  return {
    seen: (key, ttlMs) => store.dedup.seen(key, ttlMs),
    has: (key) => store.dedup.has(key),
    forget: (key) => store.dedup.forget(key),
  };
}
