/**
 * Canonical Buzz `/query` fetcher with NIP-98 auth + local event verify.
 *
 * Failure taxonomy (Athena permanent vs transient):
 * - 401/403 → permanent `buzz_receive_auth_rejected` (config / membership)
 * - network / timeout / 5xx / 200-empty / malformed → transient
 *   `buzz_receive_fetch_failed` (redelivery may recover)
 * - 200 + event that fails local id/sig verify → `buzz_receive_event_unverified`
 *
 * Secret / auth-tag material never enters thrown messages (§14.4 / §14.6).
 */

import type { BuzzCanonicalEventFetcher } from "./receive.js";
import {
  BUZZ_OPEN_TAG_AUTH_TAG_HEADER,
  type BuzzOpenTagSigner,
} from "./signer-secret.js";
import { buildNip98AuthorizationHeader } from "./nip98-auth.js";
import { verifyNostrEvent } from "./nostr-crypto.js";

/** Opaque permanent auth-rejection code (relay 401/403). */
export const BUZZ_RECEIVE_AUTH_REJECTED = "buzz_receive_auth_rejected";
/** Opaque transient fetch failure (empty / 5xx / timeout / network). */
export const BUZZ_RECEIVE_FETCH_FAILED = "buzz_receive_fetch_failed";
/** Local id/sig verify failed on a returned event. */
export const BUZZ_RECEIVE_EVENT_UNVERIFIED = "buzz_receive_event_unverified";

export const BUZZ_QUERY_DEFAULT_TIMEOUT_MS = 10_000;

export type BuzzQueryFetcherOptions = Readonly<{
  relayHttpBaseUrl: string;
  signer: BuzzOpenTagSigner;
  /**
   * Optional NIP-OA auth-tag JSON for closed relays (owner-attested path).
   * Sent as `x-auth-tag` when non-empty; omitted when unset/empty — that
   * omission is the explicit standalone (NIP-98-only) mode. Callers must
   * reject malformed secrets before constructing the fetcher so mis-sets
   * never reach this path as a silent omit.
   */
  authTagJson?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowSeconds?: () => number;
}>;

function normalizeRelayBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error("buzz_receive_invalid_relay_base_url");
  }
  return trimmed;
}

function throwOpaque(code: string): never {
  throw new Error(code);
}

function isAuthRejectedStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Build a {@link BuzzCanonicalEventFetcher} that POSTs NIP-98-authenticated
 * filters to `{base}/query` and verifies the returned event locally.
 */
export function createBuzzNip98QueryFetcher(
  options: BuzzQueryFetcherOptions,
): BuzzCanonicalEventFetcher {
  const baseUrl = normalizeRelayBaseUrl(options.relayHttpBaseUrl);
  const queryUrl = `${baseUrl}/query`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BUZZ_QUERY_DEFAULT_TIMEOUT_MS;

  return {
    async fetchAndVerify(input) {
      const filters = [
        {
          ids: [input.messageId],
          limit: 1,
        },
      ];
      const bodyText = JSON.stringify(filters);
      const bodyBytes = new TextEncoder().encode(bodyText);

      let authorization: string;
      try {
        authorization = await buildNip98AuthorizationHeader(options.signer, {
          url: queryUrl,
          method: "POST",
          body: bodyBytes,
          createdAt: options.nowSeconds?.(),
        });
      } catch {
        // Never echo signer/crypto detail.
        throwOpaque(BUZZ_RECEIVE_FETCH_FAILED);
      }

      const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
        authorization,
      };
      if (options.authTagJson !== undefined && options.authTagJson.length > 0) {
        headers[BUZZ_OPEN_TAG_AUTH_TAG_HEADER] = options.authTagJson;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(queryUrl, {
          method: "POST",
          headers,
          body: bodyText,
          signal: controller.signal,
        });
      } catch {
        throwOpaque(BUZZ_RECEIVE_FETCH_FAILED);
      } finally {
        clearTimeout(timer);
      }

      if (isAuthRejectedStatus(response.status)) {
        throwOpaque(BUZZ_RECEIVE_AUTH_REJECTED);
      }
      if (!response.ok) {
        throwOpaque(BUZZ_RECEIVE_FETCH_FAILED);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throwOpaque(BUZZ_RECEIVE_FETCH_FAILED);
      }

      if (!Array.isArray(payload)) {
        throwOpaque(BUZZ_RECEIVE_FETCH_FAILED);
      }
      if (payload.length === 0) {
        // Empty can be propagation lag — transient, redelivery may recover.
        throwOpaque(BUZZ_RECEIVE_FETCH_FAILED);
      }

      const event = payload[0];
      const verified = await verifyNostrEvent(event);
      if (!verified) {
        throwOpaque(BUZZ_RECEIVE_EVENT_UNVERIFIED);
      }
      return event;
    },
  };
}
