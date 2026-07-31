/**
 * NIP-98 (kind:27235) Authorization header builder for Buzz HTTP bridge calls.
 *
 * Signs u/method/nonce/(payload) tags against the Cloudflare-secret signer.
 * The Authorization value is ephemeral request material — callers must not
 * persist it to DO state, queues, logs, fixtures, or replies (§14.4 / §14.6).
 */

import type { BuzzOpenTagSigner } from "./signer-secret.js";
import { sha256HexBytes } from "./nostr-crypto.js";

const NIP98_KIND = 27235;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Build `Authorization` header value `Nostr <base64(event-json)>`.
 *
 * Always includes `payload` (body SHA-256) and a unique `nonce` for body-bearing
 * POSTs — matches Buzz ACP client practice even when the bridge does not yet
 * require the payload tag on `/query`.
 */
export async function buildNip98AuthorizationHeader(
  signer: BuzzOpenTagSigner,
  input: Readonly<{
    url: string;
    method: string;
    body: Uint8Array;
    createdAt?: number;
    nonce?: string;
  }>,
): Promise<string> {
  const method = input.method.toUpperCase();
  const payloadHex = await sha256HexBytes(input.body);
  const nonce = input.nonce ?? crypto.randomUUID();
  const created_at = input.createdAt
    ?? Math.floor(Date.now() / 1000);
  const signed = await signer.sign({
    kind: NIP98_KIND,
    created_at,
    content: "",
    tags: [
      ["u", input.url],
      ["method", method],
      ["nonce", nonce],
      ["payload", payloadHex],
    ],
  });
  const json = JSON.stringify({
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  });
  return `Nostr ${bytesToBase64(new TextEncoder().encode(json))}`;
}
