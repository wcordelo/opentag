import { PLATFORM_STATE_SCHEMA_VERSION } from "./platform-state-version.js";

/**
 * Derive the canonical internal tenant UUID without a global directory.
 *
 * This helper intentionally has no Durable Object import so external platform
 * workers and ordinary unit tests can share the exact tenant mapping.
 */
export async function deriveInternalTenantId(input: {
  externalPlatform: "slack";
  externalTenantId: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `opentag:tenant:v${PLATFORM_STATE_SCHEMA_VERSION}:${input.externalPlatform}:${input.externalTenantId}`,
    ),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
