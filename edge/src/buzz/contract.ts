/**
 * Strict, transport-neutral Buzz event contract for the text-only M1 pilot.
 *
 * This module deliberately does not verify Nostr signatures or sign outbound
 * events. The ingress transport must establish those properties before it
 * calls `normalizeBuzzInboundEvent`; a signer implementation is injected at
 * the transport boundary after custody is configured.
 */

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_MENTIONS = 50;
const MAX_TAGS = 128;
const MAX_TAG_VALUES = 8;
const MAX_TAG_VALUE_BYTES = 4 * 1024;

type BuzzRawEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;

/**
 * A canonical internal tenant identifier returned by the verified tenant
 * locator. This M1 foundation deliberately accepts no platform tenant ID,
 * display name, or legacy Slack team ID in its place.
 */
export type CanonicalInternalTenantId = string & {
  readonly __canonicalInternalTenantId: unique symbol;
};

export type BuzzInboundEvent = Readonly<{
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  channelId: string;
  content: string;
  rootEventId: string;
  parentEventId?: string;
  mentionPubkeys: readonly string[];
}>;

export class BuzzContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BuzzContractError";
  }
}

function requireHex(value: string, expression: RegExp, code: string): string {
  if (!expression.test(value)) throw new BuzzContractError(code);
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuzzContractError(code);
  }
  return value as Record<string, unknown>;
}

/**
 * Runtime boundary for relay JSON. Signature verification belongs to the
 * transport, but shape and resource bounds are enforced here before any tag
 * interpretation or Durable Object key construction.
 */
function decodeBuzzRawEvent(raw: unknown): BuzzRawEvent {
  const value = requireObject(raw, "buzz_invalid_event_shape");
  const tags = value.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw new BuzzContractError("buzz_invalid_tags");
  }
  const decodedTags = tags.map((tag) => {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > MAX_TAG_VALUES) {
      throw new BuzzContractError("buzz_invalid_tag_shape");
    }
    return tag.map((entry) => {
      if (typeof entry !== "string" || utf8Bytes(entry) > MAX_TAG_VALUE_BYTES) {
        throw new BuzzContractError("buzz_invalid_tag_value");
      }
      return entry;
    });
  });
  if (
    typeof value.id !== "string"
    || typeof value.pubkey !== "string"
    || typeof value.created_at !== "number"
    || typeof value.kind !== "number"
    || typeof value.content !== "string"
  ) {
    throw new BuzzContractError("buzz_invalid_event_shape");
  }
  return {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: value.kind,
    content: value.content,
    tags: decodedTags,
  };
}

function replyTarget(tags: readonly (readonly string[])[]): {
  rootEventId?: string;
  parentEventId?: string;
} {
  const references = tags
    .filter((tag) => tag[0] === "e")
    .map((tag) => ({
      eventId: typeof tag[1] === "string" ? tag[1] : "",
      marker: typeof tag[3] === "string" ? tag[3] : "",
    }));
  for (const reference of references) {
    requireHex(reference.eventId, EVENT_ID_RE, "buzz_invalid_reply_event_id");
  }
  const parents = references.filter((reference) => reference.marker === "reply");
  const roots = references.filter((reference) => reference.marker === "root");
  const legacyRoots = references.filter((reference) => reference.marker === "");
  if (references.some((reference) => !["root", "reply", ""].includes(reference.marker))) {
    throw new BuzzContractError("buzz_unsupported_thread_marker");
  }
  if (parents.length > 1 || roots.length > 1 || legacyRoots.length > 1 || (roots.length && legacyRoots.length)) {
    throw new BuzzContractError("buzz_ambiguous_thread_reference");
  }
  const parent = parents[0]?.eventId;
  const root = roots[0]?.eventId
    ?? legacyRoots[0]?.eventId
    ?? parent;
  return { rootEventId: root, ...(parent ? { parentEventId: parent } : {}) };
}

/**
 * Converts a previously signature-verified relay event into the only M1
 * application shape. Unknown channel, attachment metadata, invalid tags, and
 * oversized text fail before a turn can be admitted.
 */
export function normalizeBuzzInboundEvent(
  raw: unknown,
  expectedChannelId: string,
): BuzzInboundEvent {
  const event = decodeBuzzRawEvent(raw);
  requireHex(expectedChannelId, CHANNEL_ID_RE, "buzz_invalid_expected_channel");
  requireHex(event.id, EVENT_ID_RE, "buzz_invalid_event_id");
  requireHex(event.pubkey, PUBKEY_RE, "buzz_invalid_author_pubkey");
  if (event.kind !== 9) throw new BuzzContractError("buzz_unsupported_kind");
  if (!Number.isSafeInteger(event.created_at) || event.created_at <= 0) {
    throw new BuzzContractError("buzz_invalid_created_at");
  }
  if (!event.content.trim() || utf8Bytes(event.content) > MAX_TEXT_BYTES) {
    throw new BuzzContractError("buzz_invalid_content");
  }

  const channelTags = event.tags.filter((tag) => tag[0] === "h");
  if (channelTags.length !== 1 || channelTags[0]?.[1] !== expectedChannelId) {
    throw new BuzzContractError("buzz_channel_binding_mismatch");
  }
  if (event.tags.some((tag) => tag[0] === "imeta")) {
    throw new BuzzContractError("buzz_attachments_disabled");
  }

  const mentionTags = event.tags.filter((tag) => tag[0] === "p");
  if (mentionTags.length > MAX_MENTIONS) throw new BuzzContractError("buzz_too_many_mentions");
  const mentions = [...new Set(mentionTags
    .map((tag) => requireHex(tag[1] ?? "", PUBKEY_RE, "buzz_invalid_mention_pubkey")))];

  const target = replyTarget(event.tags);
  return Object.freeze({
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    channelId: expectedChannelId,
    content: event.content,
    rootEventId: target.rootEventId ?? event.id,
    ...(target.parentEventId ? { parentEventId: target.parentEventId } : {}),
    mentionPubkeys: Object.freeze(mentions),
  });
}

/** Same tenant, channel, and thread always serialize through one DO key. */
export function canonicalInternalTenantId(value: string): CanonicalInternalTenantId {
  requireHex(value, CHANNEL_ID_RE, "buzz_invalid_internal_tenant");
  return value as CanonicalInternalTenantId;
}

function lengthPrefixed(value: string): string {
  return `${utf8Bytes(value)}:${value}`;
}

export function buzzConversationKey(
  tenantId: CanonicalInternalTenantId,
  event: Pick<BuzzInboundEvent, "channelId" | "rootEventId">,
): string {
  canonicalInternalTenantId(tenantId);
  requireHex(event.channelId, CHANNEL_ID_RE, "buzz_invalid_channel");
  requireHex(event.rootEventId, EVENT_ID_RE, "buzz_invalid_root_event_id");
  return `buzz:v1:${lengthPrefixed(tenantId)}${lengthPrefixed(event.channelId)}${lengthPrefixed(event.rootEventId)}`;
}
