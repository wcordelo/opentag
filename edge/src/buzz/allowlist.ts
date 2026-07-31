/**
 * M1 OpenTag installation allowlist — relay-origin enforcement.
 *
 * Closes the gap where `BUZZ_RELAY_HTTP_BASE_URL` targets a relay but nothing
 * enforces that this installation is authorized only for that origin.
 *
 * Load-bearing contract (Athena + Prometheus):
 * - Allowed origin is a **distinct** provisioned var
 *   ({@link BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR}), never derived from the
 *   fetch base. Self-derived → decorative `X === X` check.
 * - Kind stays hardcoded in `contract.ts` for M1 (not provisioned here).
 * - {@link BUZZ_M1_POLICY_AUDIT_MARKER} is a forensic / non-enforcing stamp
 *   for admit markers — not "versioning," "monotonic," or "revoke."
 */

import { BuzzContractError } from "./contract.js";

/** Distinct non-secret var: allowed HTTPS/HTTP origin for this installation. */
export const BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR =
  "BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN";

/**
 * Forensic audit stamp written onto admit markers in M1.
 * Non-enforcing: nothing live-compares this value for revoke/version gates.
 */
export const BUZZ_M1_POLICY_AUDIT_MARKER = "opentag-buzz-m1-allowlist";

export type BuzzInstallationAllowlist = Readonly<{
  /**
   * Separately provisioned allowed origin (normalized).
   * Must not be a copy of the fetch base taken from the same env source.
   */
  allowedRelayOrigin: string;
  /** Live fetch base from `BUZZ_RELAY_HTTP_BASE_URL` (normalized). */
  relayHttpBaseUrl: string;
  /** Forensic stamp for admit markers — not a live revoke/version control. */
  policyAuditMarker: string;
}>;

/**
 * Normalize a relay origin for comparison.
 * Uses URL.origin semantics: scheme + lowercase host + non-default port;
 * strips path/query/hash and trailing-slash variance.
 */
export function normalizeBuzzRelayOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new BuzzContractError("buzz_allowlist_not_configured");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BuzzContractError("buzz_relay_origin_invalid_shape");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BuzzContractError("buzz_relay_origin_invalid_shape");
  }
  return url.origin;
}

/**
 * Load the distinct allowed-origin grant. Unset/empty → `undefined`
 * (caller fail-closes). Whitespace-only / malformed → throw.
 *
 * Never accepts the fetch-base var as a fallback — that would make the
 * origin canary decorative.
 */
export function loadBuzzAllowedRelayOrigin(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return normalizeBuzzRelayOrigin(raw);
}

/**
 * Fail closed when the live fetch base is not the separately provisioned
 * allowed origin. Call after bind, before authoritative claim.
 */
export function enforceBuzzRelayOriginAllowlist(
  allowlist: BuzzInstallationAllowlist,
): void {
  const allowed = normalizeBuzzRelayOrigin(allowlist.allowedRelayOrigin);
  const live = normalizeBuzzRelayOrigin(allowlist.relayHttpBaseUrl);
  if (allowed !== live) {
    throw new BuzzContractError("buzz_relay_origin_not_allowed");
  }
}

/**
 * Build the installation allowlist from independently provisioned pieces.
 * Throws opaque contract codes — never echoes raw env values.
 */
export function buildBuzzInstallationAllowlist(input: Readonly<{
  allowedRelayOriginRaw: string;
  relayHttpBaseUrlRaw: string;
  policyAuditMarker?: string;
}>): BuzzInstallationAllowlist {
  const allowedRelayOrigin = normalizeBuzzRelayOrigin(input.allowedRelayOriginRaw);
  const relayHttpBaseUrl = normalizeBuzzRelayOrigin(input.relayHttpBaseUrlRaw);
  const policyAuditMarker = input.policyAuditMarker ?? BUZZ_M1_POLICY_AUDIT_MARKER;
  if (policyAuditMarker.trim().length === 0) {
    throw new BuzzContractError("buzz_allowlist_not_configured");
  }
  return Object.freeze({
    allowedRelayOrigin,
    relayHttpBaseUrl,
    policyAuditMarker,
  });
}
