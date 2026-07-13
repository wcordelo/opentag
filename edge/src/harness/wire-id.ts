/**
 * Versioned, wire-safe turn identities.
 *
 * Format: `ot1e_<sha256-base64url>` for executions and
 * `ot1m_<sha256-base64url>` for forwarded messages. The digest input is a
 * JSON tuple, so component boundaries are unambiguous and punctuation or
 * Unicode cannot create the collisions caused by delimiter replacement.
 */
export type WireIdPurpose = "execution" | "forwarded-message";

const PREFIX: Record<WireIdPurpose, string> = {
  execution: "ot1e_",
  "forwarded-message": "ot1m_",
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function makeWireId(
  purpose: WireIdPurpose,
  source: string,
  components: readonly string[],
): Promise<string> {
  const framed = JSON.stringify(["opentag-turn-id-v1", source, ...components]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(framed));
  return `${PREFIX[purpose]}${base64Url(new Uint8Array(digest))}`;
}

export async function makeWireTurnIdentity(
  source: string,
  components: readonly string[],
): Promise<{ executionId: string; forwardedMessageId: string }> {
  const [executionId, forwardedMessageId] = await Promise.all([
    makeWireId("execution", source, components),
    makeWireId("forwarded-message", source, components),
  ]);
  return { executionId, forwardedMessageId };
}
