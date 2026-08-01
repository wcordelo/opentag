/**
 * NIP-98-authenticated Buzz `POST /events` publisher for post-admit replies.
 *
 * Posts a fixed-shape text-only kind-9 reply as the OpenTag signer. Never
 * echoes wake/user content into the reply body (injection + size bound).
 * Secret / auth-tag material never enters thrown messages (§14.4 / §14.6).
 */

import type { BuzzInboundEvent } from "./contract.js";
import { buildNip98AuthorizationHeader } from "./nip98-auth.js";
import type { NostrSignedEvent } from "./nostr-crypto.js";
import {
  BUZZ_OPEN_TAG_AUTH_TAG_HEADER,
  type BuzzOpenTagSigner,
} from "./signer-secret.js";

/** Opaque permanent auth-rejection code (relay 401/403). */
export const BUZZ_REPLY_AUTH_REJECTED = "buzz_reply_auth_rejected";
/** Opaque transient publish failure (network / 5xx / timeout / bad body). */
export const BUZZ_REPLY_PUBLISH_FAILED = "buzz_reply_publish_failed";
/** Relay accepted the request but rejected the event (4xx non-auth). */
export const BUZZ_REPLY_REJECTED = "buzz_reply_rejected";

export const BUZZ_EVENTS_DEFAULT_TIMEOUT_MS = 10_000;

/** Fixed M1 ack — no inbound content echo. */
export const BUZZ_ADMIT_REPLY_CONTENT = "opentag: admitted";

export type BuzzEventsPublisherOptions = Readonly<{
  relayHttpBaseUrl: string;
  signer: BuzzOpenTagSigner;
  authTagJson?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowSeconds?: () => number;
}>;

export type BuzzAdmitReplyPublisher = {
  publishAdmitReply(input: Readonly<{
    inbound: BuzzInboundEvent;
  }>): Promise<Readonly<{ replyEventId: string }>>;
};

function normalizeRelayBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error("buzz_reply_invalid_relay_base_url");
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
 * Build kind-9 tags for a reply to `inbound` in its channel.
 * Mentions the inbound author so the human sees the ack.
 */
export function buildAdmitReplyTags(
  inbound: BuzzInboundEvent,
): readonly (readonly string[])[] {
  const tags: string[][] = [["h", inbound.channelId]];
  if (inbound.rootEventId !== inbound.eventId) {
    tags.push(["e", inbound.rootEventId, "", "root"]);
    tags.push(["e", inbound.eventId, "", "reply"]);
  } else {
    tags.push(["e", inbound.eventId, "", "reply"]);
  }
  tags.push(["p", inbound.authorPubkey]);
  return Object.freeze(tags.map((tag) => Object.freeze([...tag])));
}

/**
 * Build a {@link BuzzAdmitReplyPublisher} that signs + POSTs kind-9 to
 * `{base}/events` under NIP-98 (+ optional NIP-OA `x-auth-tag`).
 */
export function createBuzzNip98EventsPublisher(
  options: BuzzEventsPublisherOptions,
): BuzzAdmitReplyPublisher {
  const baseUrl = normalizeRelayBaseUrl(options.relayHttpBaseUrl);
  const eventsUrl = `${baseUrl}/events`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BUZZ_EVENTS_DEFAULT_TIMEOUT_MS;

  return {
    async publishAdmitReply(input) {
      // Defense-in-depth: never reply to self (workflow filter should already skip).
      if (input.inbound.authorPubkey === options.signer.publicKeyHex) {
        return Object.freeze({ replyEventId: input.inbound.eventId });
      }

      const created_at = options.nowSeconds?.()
        ?? Math.floor(Date.now() / 1000);
      let signed: NostrSignedEvent;
      try {
        signed = await options.signer.sign({
          kind: 9,
          created_at,
          content: BUZZ_ADMIT_REPLY_CONTENT,
          tags: buildAdmitReplyTags(input.inbound),
        });
      } catch {
        throwOpaque(BUZZ_REPLY_PUBLISH_FAILED);
      }

      const bodyText = JSON.stringify({
        id: signed.id,
        pubkey: signed.pubkey,
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      });
      const bodyBytes = new TextEncoder().encode(bodyText);

      let authorization: string;
      try {
        authorization = await buildNip98AuthorizationHeader(options.signer, {
          url: eventsUrl,
          method: "POST",
          body: bodyBytes,
          createdAt: options.nowSeconds?.(),
        });
      } catch {
        throwOpaque(BUZZ_REPLY_PUBLISH_FAILED);
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
        response = await fetchImpl(eventsUrl, {
          method: "POST",
          headers,
          body: bodyText,
          signal: controller.signal,
        });
      } catch {
        throwOpaque(BUZZ_REPLY_PUBLISH_FAILED);
      } finally {
        clearTimeout(timer);
      }

      if (isAuthRejectedStatus(response.status)) {
        throwOpaque(BUZZ_REPLY_AUTH_REJECTED);
      }
      if (response.status >= 500) {
        throwOpaque(BUZZ_REPLY_PUBLISH_FAILED);
      }
      if (!response.ok) {
        throwOpaque(BUZZ_REPLY_REJECTED);
      }

      return Object.freeze({ replyEventId: signed.id });
    },
  };
}
