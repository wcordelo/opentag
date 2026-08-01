/**
 * Assemble {@link BuzzWakeReceiveDeps} from Worker env when the signer seam,
 * relay base URL, distinct allowed-origin grant, and channel→tenant directory
 * are all configured.
 *
 * Returns `undefined` when any required piece is missing so `POST /buzz/wake`
 * stays fail-closed (503). Never logs or returns secret material.
 *
 * The Durable Object store is injected by the Worker mount — this module stays
 * free of `cloudflare:workers` so unit tests can import it under Node/vitest.
 */

import {
  BUZZ_M1_POLICY_AUDIT_MARKER,
  BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR,
  buildBuzzInstallationAllowlist,
  enforceBuzzRelayOriginAllowlist,
  loadBuzzAllowedRelayOrigin,
} from "./allowlist.js";
import {
  BuzzContractError,
  canonicalInternalTenantId,
  type CanonicalInternalTenantId,
} from "./contract.js";
import {
  stateStoreBuzzEventDedupe,
  type BuzzWakeReceiveDeps,
} from "./receive.js";
import { createBuzzNip98QueryFetcher } from "./query-fetcher.js";
import { createBuzzRuntimeAdmit } from "./runtime-admit.js";
import {
  BUZZ_CHANNEL_TENANT_MAP_VAR,
  BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME,
  BUZZ_OPEN_TAG_SIGNER_SECRET_NAME,
  BUZZ_RELAY_HTTP_BASE_URL_VAR,
  loadBuzzOpenTagAuthTag,
  loadBuzzOpenTagSigner,
} from "./signer-secret.js";
import type { BuzzChannelTenantDirectory } from "./wake.js";
import type { StateStore } from "../store/state-store-contract.js";

const CHANNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BuzzWakeEnvBindings = Readonly<{
  [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]?: string;
  [BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME]?: string;
  [BUZZ_RELAY_HTTP_BASE_URL_VAR]?: string;
  [BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR]?: string;
  [BUZZ_CHANNEL_TENANT_MAP_VAR]?: string;
}>;

/**
 * Parse the server-side channel→tenant JSON map.
 * Throws opaque contract codes — never echoes the raw JSON in the message.
 */
export function parseBuzzChannelTenantMap(
  raw: string,
): BuzzChannelTenantDirectory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BuzzContractError("buzz_receive_invalid_channel_tenant_map");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BuzzContractError("buzz_receive_invalid_channel_tenant_map");
  }
  const entries = new Map<string, CanonicalInternalTenantId>();
  for (const [channelId, tenantRaw] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!CHANNEL_ID_RE.test(channelId) || typeof tenantRaw !== "string") {
      throw new BuzzContractError("buzz_receive_invalid_channel_tenant_map");
    }
    let tenantId: CanonicalInternalTenantId;
    try {
      tenantId = canonicalInternalTenantId(tenantRaw);
    } catch {
      throw new BuzzContractError("buzz_receive_invalid_channel_tenant_map");
    }
    entries.set(channelId, tenantId);
  }
  return {
    resolveTenant(channelId) {
      return entries.get(channelId);
    },
  };
}

/**
 * Build receive deps when the NIP-98 signer seam is fully configured.
 * Missing optional/unset pieces → `undefined` (route stays 503).
 *
 * `store` must be a production StateStore (DO-backed in the Worker).
 *
 * Allowed origin is loaded from {@link BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR}
 * independently of the fetch base — never derived from it.
 */
export function tryBuildBuzzWakeReceiveDeps(
  env: BuzzWakeEnvBindings,
  store: Pick<StateStore, "kv" | "dedup"> | undefined,
  options: Readonly<{
    fetchImpl?: typeof fetch;
    nowSeconds?: () => number;
  }> = {},
): BuzzWakeReceiveDeps | undefined {
  const secret = env[BUZZ_OPEN_TAG_SIGNER_SECRET_NAME];
  const relayBase = env[BUZZ_RELAY_HTTP_BASE_URL_VAR];
  const allowedOriginRaw = env[BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR];
  const mapJson = env[BUZZ_CHANNEL_TENANT_MAP_VAR];
  if (
    secret === undefined
    || secret.length === 0
    || relayBase === undefined
    || relayBase.length === 0
    || allowedOriginRaw === undefined
    || allowedOriginRaw.length === 0
    || mapJson === undefined
    || mapJson.length === 0
    || store === undefined
  ) {
    return undefined;
  }

  // Shape-validate the distinct grant early (whitespace / malformed → throw).
  const allowedLoaded = loadBuzzAllowedRelayOrigin(allowedOriginRaw);
  if (allowedLoaded === undefined) {
    return undefined;
  }

  const signer = loadBuzzOpenTagSigner(secret);
  if (signer === undefined) {
    return undefined;
  }

  // Optional owner-attested path. Unset → NIP-98 only (explicit). Malformed
  // (incl. whitespace-only) throws opaque buzz_auth_tag_invalid_shape so the
  // Worker can 503 without attempting a fetch that would look like auth 403.
  const authTagJson = loadBuzzOpenTagAuthTag(
    env[BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME],
  );

  const allowlist = buildBuzzInstallationAllowlist({
    allowedRelayOriginRaw: allowedOriginRaw,
    relayHttpBaseUrlRaw: relayBase,
    policyAuditMarker: BUZZ_M1_POLICY_AUDIT_MARKER,
  });
  // Config-consistency fast-fail (Athena): mismatch is known at build time —
  // fail closed here so a misprovisioned install 503s without a wasted fetch.
  // Per-event enforceBuzzRelayOriginAllowlist in receive remains the load-bearing gate.
  enforceBuzzRelayOriginAllowlist(allowlist);

  const directory = parseBuzzChannelTenantMap(mapJson);
  const dedupe = stateStoreBuzzEventDedupe(store);

  return Object.freeze({
    directory,
    wakeDedupe: dedupe,
    authoritativeDedupe: dedupe,
    allowlist,
    fetcher: createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: relayBase,
      signer,
      authTagJson,
      fetchImpl: options.fetchImpl,
      nowSeconds: options.nowSeconds,
    }),
    runtime: createBuzzRuntimeAdmit(store),
  });
}
