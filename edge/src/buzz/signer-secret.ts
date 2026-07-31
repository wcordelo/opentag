/**
 * Cloudflare-secret signer seam for OpenTag's Buzz NIP-98 client.
 *
 * Secret binding name is part of the operator contract — provisioning must use
 * the exact string {@link BUZZ_OPEN_TAG_SIGNER_SECRET_NAME}. The private key
 * never leaves this module except as ephemeral signing input; errors never
 * echo key/auth-tag bytes (§14.4).
 */

import {
  parsePrivateKeyHex,
  publicKeyHexFromPrivate,
  signNostrEvent,
  type NostrSignedEvent,
  type NostrUnsignedEvent,
} from "./nostr-crypto.js";

/** Exact Cloudflare Worker secret name for the M1 test-only OpenTag signer. */
export const BUZZ_OPEN_TAG_SIGNER_SECRET_NAME = "BUZZ_OPEN_TAG_SIGNER_SECRET";

/**
 * Non-secret var: absolute HTTPS origin of the Buzz community host
 * (no trailing slash), e.g. `https://berendo.communities.buzz.xyz`.
 */
export const BUZZ_RELAY_HTTP_BASE_URL_VAR = "BUZZ_RELAY_HTTP_BASE_URL";

/**
 * Non-secret var: JSON object mapping channel UUID → canonical internal
 * tenant UUID. Server-side only; never populated from a wake body.
 */
export const BUZZ_CHANNEL_TENANT_MAP_VAR = "BUZZ_CHANNEL_TENANT_MAP";

/**
 * Optional Cloudflare Worker secret: NIP-OA owner-attestation tag JSON for the
 * OpenTag signer pubkey. When set, the `/query` fetcher sends it as
 * `x-auth-tag` (countdown-bot owner-attested path).
 *
 * Default when **unset / empty string**: NIP-98 Authorization only (standalone
 * relay-member path). This is an explicit mode, not silent degradation.
 * Present-but-malformed (incl. whitespace-only) → opaque
 * `buzz_auth_tag_invalid_shape` so `/buzz/wake` stays 503 — never attempt a
 * fetch that would surface as a confusing relay 403.
 *
 * Format: `["auth","<owner-pubkey-hex>","<conditions>","<sig-hex>"]`.
 */
export const BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME = "BUZZ_OPEN_TAG_AUTH_TAG";

/** HTTP header name the Buzz relay reads for NIP-OA on `/query` (bridge.rs). */
export const BUZZ_OPEN_TAG_AUTH_TAG_HEADER = "x-auth-tag";

/** Opaque code when the auth-tag secret is present but not valid NIP-OA JSON. */
export const BUZZ_AUTH_TAG_INVALID_SHAPE = "buzz_auth_tag_invalid_shape";

export type BuzzOpenTagSigner = Readonly<{
  /** Hex pubkey derived from the secret — safe to log / admit to a channel. */
  publicKeyHex: string;
  sign(event: NostrUnsignedEvent): Promise<NostrSignedEvent>;
}>;

/**
 * Load the named Cloudflare secret into a signer. Returns `undefined` when
 * the secret is unset so the wake route stays fail-closed (503).
 *
 * Throws only opaque shape codes — never includes the secret value.
 */
export function loadBuzzOpenTagSigner(
  secretValue: string | undefined,
): BuzzOpenTagSigner | undefined {
  if (secretValue === undefined || secretValue.length === 0) {
    return undefined;
  }
  let secret: Uint8Array;
  try {
    secret = parsePrivateKeyHex(secretValue);
  } catch {
    throw new Error("buzz_signer_invalid_secret_shape");
  }
  const publicKeyHex = publicKeyHexFromPrivate(secret);
  return Object.freeze({
    publicKeyHex,
    async sign(event: NostrUnsignedEvent): Promise<NostrSignedEvent> {
      return signNostrEvent(event, secret);
    },
  });
}

/**
 * Validate optional NIP-OA auth-tag JSON without echoing its contents.
 *
 * - `undefined` / `""` → `undefined` (explicit NIP-98-only mode)
 * - whitespace-only or any present-but-malformed value → throws
 *   {@link BUZZ_AUTH_TAG_INVALID_SHAPE} (fail closed; do not silently omit)
 * - valid 4-element `auth` tag JSON → trimmed string for `x-auth-tag`
 */
export function loadBuzzOpenTagAuthTag(
  raw: string | undefined,
): string | undefined {
  // Truly unset / empty CF secret → standalone NIP-98 path (explicit default).
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  // Present but blank after trim is mis-set, not unset — fail closed.
  if (trimmed.length === 0) {
    throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
  }
  if (parsed[0] !== "auth") {
    throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
  }
  for (let i = 1; i < 4; i += 1) {
    if (typeof parsed[i] !== "string") {
      throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
    }
  }
  const owner = parsed[1] as string;
  const conditions = parsed[2] as string;
  const sig = parsed[3] as string;
  // NIP-OA: owner/sig lowercase hex; conditions empty or ASCII without whitespace.
  if (!/^[0-9a-f]{64}$/.test(owner) || !/^[0-9a-f]{128}$/.test(sig)) {
    throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
  }
  if (/\s/.test(conditions)) {
    throw new Error(BUZZ_AUTH_TAG_INVALID_SHAPE);
  }
  // Return the trimmed original so header bytes match operator provisioning.
  return trimmed;
}

/**
 * Redact any occurrence of known secret-shaped substrings from a diagnostic
 * string. Used by tests and fail-closed error paths that must not leak the
 * Cloudflare secret, NIP-OA auth-tag, or a NIP-98 Authorization header value.
 */
export function redactSecretShaped(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  // Hex-looking 64-char runs that match a known secret are already gone;
  // strip Authorization: Nostr payloads wholesale if present.
  out = out.replace(
    /Authorization:\s*Nostr\s+[A-Za-z0-9+/=]+/gi,
    "Authorization: Nostr [REDACTED]",
  );
  out = out.replace(/\bNostr\s+[A-Za-z0-9+/=]{40,}/g, "Nostr [REDACTED]");
  out = out.replace(
    /x-auth-tag:\s*\[[^\]]+\]/gi,
    "x-auth-tag: [REDACTED]",
  );
  return out;
}
