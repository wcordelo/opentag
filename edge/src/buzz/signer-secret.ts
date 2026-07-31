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
 * Redact any occurrence of known secret-shaped substrings from a diagnostic
 * string. Used by tests and fail-closed error paths that must not leak the
 * Cloudflare secret or a NIP-98 Authorization header value.
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
  return out;
}
