/**
 * Minimal NIP-01 event id + BIP-340 Schnorr helpers for the Buzz edge path.
 *
 * Built on `@noble/curves` / `@noble/hashes` so the Worker never depends on
 * `nostr-tools`. Secret material must never be logged or persisted by callers.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;

export type NostrUnsignedEvent = Readonly<{
  kind: number;
  created_at: number;
  tags: readonly (readonly string[])[];
  content: string;
}>;

export type NostrSignedEvent = NostrUnsignedEvent & Readonly<{
  id: string;
  pubkey: string;
  sig: string;
}>;

export function isHex64(value: string): boolean {
  return HEX64_RE.test(value);
}

export function parsePrivateKeyHex(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  if (!HEX64_RE.test(normalized)) {
    throw new Error("buzz_signer_invalid_secret_shape");
  }
  return hexToBytes(normalized);
}

export function publicKeyHexFromPrivate(secret: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secret));
}

function serializeEventForId(
  pubkey: string,
  event: NostrUnsignedEvent,
): string {
  return JSON.stringify([
    0,
    pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export async function computeEventId(
  pubkey: string,
  event: NostrUnsignedEvent,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeEventForId(pubkey, event)),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function signNostrEvent(
  event: NostrUnsignedEvent,
  secret: Uint8Array,
): Promise<NostrSignedEvent> {
  const pubkey = publicKeyHexFromPrivate(secret);
  const id = await computeEventId(pubkey, event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
  return Object.freeze({
    id,
    pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => Object.freeze([...tag])),
    content: event.content,
    sig,
  });
}

/**
 * Verify NIP-01 id + Schnorr signature. Returns false on any structural or
 * cryptographic failure — never throws secret-shaped detail.
 */
export async function verifyNostrEvent(raw: unknown): Promise<boolean> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.pubkey !== "string"
    || typeof value.sig !== "string"
    || typeof value.created_at !== "number"
    || typeof value.kind !== "number"
    || typeof value.content !== "string"
    || !Array.isArray(value.tags)
  ) {
    return false;
  }
  if (!HEX64_RE.test(value.id) || !HEX64_RE.test(value.pubkey) || !HEX128_RE.test(value.sig)) {
    return false;
  }
  if (!Number.isSafeInteger(value.created_at) || !Number.isSafeInteger(value.kind)) {
    return false;
  }
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || tag.some((entry) => typeof entry !== "string")) {
      return false;
    }
  }

  const expectedId = await computeEventId(value.pubkey, {
    kind: value.kind,
    created_at: value.created_at,
    tags: value.tags as readonly (readonly string[])[],
    content: value.content,
  });
  if (expectedId !== value.id) return false;

  try {
    return schnorr.verify(
      hexToBytes(value.sig),
      hexToBytes(value.id),
      hexToBytes(value.pubkey),
    );
  } catch {
    return false;
  }
}

export function verifyNipOaAuthTag(input: Readonly<{
  ownerPubkeyHex: string;
  conditions: string;
  signatureHex: string;
  agentPubkeyHex: string;
}>): boolean {
  if (
    !HEX64_RE.test(input.ownerPubkeyHex)
    || !HEX64_RE.test(input.agentPubkeyHex)
    || !HEX128_RE.test(input.signatureHex)
    || input.ownerPubkeyHex === input.agentPubkeyHex
  ) {
    return false;
  }
  const message = sha256(
    new TextEncoder().encode(
      `nostr:agent-auth:${input.agentPubkeyHex}:${input.conditions}`,
    ),
  );
  try {
    return schnorr.verify(
      hexToBytes(input.signatureHex),
      message,
      hexToBytes(input.ownerPubkeyHex),
    );
  } catch {
    return false;
  }
}

/** SHA-256 hex of arbitrary request body bytes (NIP-98 payload tag). */
export async function sha256HexBytes(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return bytesToHex(new Uint8Array(digest));
}

export function randomPrivateKeyHex(): string {
  return bytesToHex(schnorr.utils.randomSecretKey());
}

/** @internal test helper — stable sha256 without WebCrypto for Node unit paths. */
export function sha256HexSyncUtf8(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}
