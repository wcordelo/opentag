/**
 * Untrusted Buzz workflow-wake boundary.
 *
 * A channel-scoped `message_posted` workflow may POST only identity fields.
 * This module validates that shape and claims the event ID as a *pre-fetch
 * fast path* before any canonical fetch / turn admission. It never trusts
 * wake body text, never takes a tenant from the wake body, and does not
 * verify Nostr signatures — those belong to the transport after custody.
 *
 * Authority boundary (Athena / M0 receive-strategy):
 * - Tenant for the dedupe key comes only from a server-side channel→tenant
 *   directory (host/community binding). An unbound channel fails closed.
 * - `claimBuzzWake` is **not** authoritative. Authoritative event-ID dedupe
 *   lives in the per-community/channel Durable Object *after* canonical
 *   fetch + signature verify, before runtime work. A wake `first` result
 *   must never bypass that post-fetch check.
 *
 * See RESEARCH/OPEN_TAG_BUZZ_M0_SOURCE_AUDIT.md receive-strategy steps 1–4.
 */

import {
  BuzzContractError,
  type CanonicalInternalTenantId,
  canonicalInternalTenantId,
} from "./contract.js";

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const CHANNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exact allowlist — wake must not carry content/text/attachments. */
const WAKE_KEYS = new Set([
  "message_id",
  "channel_id",
  "author",
  "timestamp",
]);

/** Default first-seen TTL for wake redelivery (7 days). */
export const BUZZ_WAKE_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Subset of {@link StateStore}["dedup"] used at the wake boundary.
 * `seen` returns true when the key was already claimed (duplicate).
 */
export type BuzzWakeDedupe = {
  seen(key: string, ttlMs: number): Promise<boolean>;
};

/**
 * Authoritative event-ID dedupe. Extends {@link BuzzWakeDedupe} with a
 * read-only probe so a pre-fetch redelivery can detect "wake claimed, but
 * never admitted" without writing the authoritative key (Prometheus loss-side).
 */
export type BuzzEventDedupe = BuzzWakeDedupe & {
  /** True when an unexpired claim exists. Must not insert or refresh TTL. */
  has(key: string): Promise<boolean>;
};

/**
 * Trusted server-side channel→tenant/community map. Never populated from a
 * wake body. Unknown channels must resolve to `undefined` (fail closed).
 */
export type BuzzChannelTenantDirectory = {
  resolveTenant(channelId: string): CanonicalInternalTenantId | undefined;
};

export type BuzzWakeEnvelope = Readonly<{
  messageId: string;
  channelId: string;
  authorPubkey: string;
  createdAt: number;
}>;

/**
 * Pre-fetch claim only. Callers MUST still run authoritative DO event-ID
 * dedupe after canonical fetch + signature verification.
 */
export type BuzzWakeClaimResult = Readonly<{
  status: "first" | "duplicate";
  wake: BuzzWakeEnvelope;
  tenantId: CanonicalInternalTenantId;
  dedupeKey: string;
  authority: "pre_fetch_fast_path";
}>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function lengthPrefixed(value: string): string {
  return `${utf8Bytes(value)}:${value}`;
}

function requireHex(value: string, expression: RegExp, code: string): string {
  if (!expression.test(value)) throw new BuzzContractError(code);
  return value;
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuzzContractError(code);
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BuzzContractError("buzz_wake_invalid_timestamp");
    }
    return value;
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BuzzContractError("buzz_wake_invalid_timestamp");
    }
    return parsed;
  }
  throw new BuzzContractError("buzz_wake_invalid_timestamp");
}

/**
 * Validates an untrusted workflow-wake body. Exact key set only — content,
 * text, tags, or attachments fail closed so the wake cannot be treated as a
 * trusted event body. Does not resolve tenant; that is a separate trusted
 * directory lookup.
 */
export function validateBuzzWakeEnvelope(raw: unknown): BuzzWakeEnvelope {
  const value = requireObject(raw, "buzz_wake_invalid_shape");

  const keys = Object.keys(value);
  if (
    keys.length !== WAKE_KEYS.size
    || keys.some((key) => !WAKE_KEYS.has(key))
  ) {
    throw new BuzzContractError("buzz_wake_unexpected_fields");
  }

  if (typeof value.message_id !== "string") {
    throw new BuzzContractError("buzz_wake_invalid_message_id");
  }
  if (typeof value.channel_id !== "string") {
    throw new BuzzContractError("buzz_wake_invalid_channel_id");
  }
  if (typeof value.author !== "string") {
    throw new BuzzContractError("buzz_wake_invalid_author");
  }

  const messageId = requireHex(
    value.message_id,
    EVENT_ID_RE,
    "buzz_wake_invalid_message_id",
  );
  const channelId = requireHex(
    value.channel_id,
    CHANNEL_ID_RE,
    "buzz_wake_invalid_channel_id",
  );
  const authorPubkey = requireHex(
    value.author,
    PUBKEY_RE,
    "buzz_wake_invalid_author",
  );
  const createdAt = parseTimestamp(value.timestamp);

  return Object.freeze({
    messageId,
    channelId,
    authorPubkey,
    createdAt,
  });
}

/**
 * Resolve the wake channel against the trusted directory. Fail closed when
 * the channel has no configured tenant/community binding.
 */
export function resolveWakeTenant(
  wake: Pick<BuzzWakeEnvelope, "channelId">,
  directory: BuzzChannelTenantDirectory,
): CanonicalInternalTenantId {
  requireHex(wake.channelId, CHANNEL_ID_RE, "buzz_wake_invalid_channel_id");
  const tenantId = directory.resolveTenant(wake.channelId);
  if (tenantId === undefined) {
    throw new BuzzContractError("buzz_wake_unbound_channel");
  }
  return canonicalInternalTenantId(tenantId);
}

/** Tenant/channel/event partition for the wake first-seen claim. */
export function buzzWakeDedupeKey(
  tenantId: CanonicalInternalTenantId,
  wake: Pick<BuzzWakeEnvelope, "channelId" | "messageId">,
): string {
  canonicalInternalTenantId(tenantId);
  requireHex(wake.channelId, CHANNEL_ID_RE, "buzz_wake_invalid_channel_id");
  requireHex(wake.messageId, EVENT_ID_RE, "buzz_wake_invalid_message_id");
  return `buzz-wake:v1:${lengthPrefixed(tenantId)}${lengthPrefixed(wake.channelId)}${lengthPrefixed(wake.messageId)}`;
}

/**
 * Validate the wake, resolve tenant from the trusted channel directory, then
 * claim the event ID as a pre-fetch fast path. A redelivery of the same
 * message_id for the same bound tenant/channel returns `duplicate`.
 *
 * This is never admission: callers must still persist authoritative event-ID
 * dedupe after canonical fetch + signature verify.
 */
export async function claimBuzzWake(
  raw: unknown,
  directory: BuzzChannelTenantDirectory,
  dedupe: BuzzWakeDedupe,
  ttlMs: number = BUZZ_WAKE_DEDUPE_TTL_MS,
): Promise<BuzzWakeClaimResult> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new BuzzContractError("buzz_wake_invalid_dedupe_ttl");
  }
  const wake = validateBuzzWakeEnvelope(raw);
  const tenantId = resolveWakeTenant(wake, directory);
  const dedupeKey = buzzWakeDedupeKey(tenantId, wake);
  const duplicate = await dedupe.seen(dedupeKey, ttlMs);
  return Object.freeze({
    status: duplicate ? "duplicate" : "first",
    wake,
    tenantId,
    dedupeKey,
    authority: "pre_fetch_fast_path",
  });
}
