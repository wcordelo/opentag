/**
 * Post-admit kind-9 reply publisher + runtime-admit reply claim.
 */

import { describe, expect, it } from "vitest";
import { canonicalInternalTenantId } from "../src/buzz/contract.js";
import {
  BUZZ_ADMIT_REPLY_CONTENT,
  BUZZ_REPLY_AUTH_REJECTED,
  BUZZ_REPLY_PUBLISH_FAILED,
  BUZZ_REPLY_REJECTED,
  buildAdmitReplyTags,
  createBuzzNip98EventsPublisher,
} from "../src/buzz/events-publisher.js";
import { publicKeyHexFromPrivate, parsePrivateKeyHex, randomPrivateKeyHex } from "../src/buzz/nostr-crypto.js";
import {
  buzzRuntimeAdmitKey,
  buzzRuntimeReplyKey,
  createBuzzRuntimeAdmit,
} from "../src/buzz/runtime-admit.js";
import {
  BUZZ_OPEN_TAG_AUTH_TAG_HEADER,
  loadBuzzOpenTagSigner,
} from "../src/buzz/signer-secret.js";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

const CHANNEL = "80d210c7-6cf2-49b3-8dab-06cbee389c04";
const ROOT = "c".repeat(64);
const EVENT = "d".repeat(64);
const AUTHOR = "a".repeat(64);
const TENANT = canonicalInternalTenantId("11111111-1111-4111-8111-111111111111");
const RELAY_BASE = "https://opentag-contract-test.example.invalid";
const NOW = 1_785_424_252;

describe("buildAdmitReplyTags", () => {
  it("uses a single reply e-tag for top-level inbound", () => {
    expect(buildAdmitReplyTags({
      eventId: EVENT,
      authorPubkey: AUTHOR,
      createdAt: NOW,
      channelId: CHANNEL,
      content: "hi",
      rootEventId: EVENT,
      mentionPubkeys: [],
    })).toEqual([
      ["h", CHANNEL],
      ["e", EVENT, "", "reply"],
      ["p", AUTHOR],
    ]);
  });

  it("uses root + reply e-tags for nested inbound", () => {
    expect(buildAdmitReplyTags({
      eventId: EVENT,
      authorPubkey: AUTHOR,
      createdAt: NOW,
      channelId: CHANNEL,
      content: "hi",
      rootEventId: ROOT,
      parentEventId: ROOT,
      mentionPubkeys: [],
    })).toEqual([
      ["h", CHANNEL],
      ["e", ROOT, "", "root"],
      ["e", EVENT, "", "reply"],
      ["p", AUTHOR],
    ]);
  });
});

describe("createBuzzNip98EventsPublisher", () => {
  it("POSTs a fixed kind-9 with NIP-98 (+ optional auth-tag) and no content echo", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const authTag = JSON.stringify([
      "auth",
      "b".repeat(64),
      "",
      "c".repeat(128),
    ]);
    let sawUrl = "";
    let sawAuthTag: string | null = null;
    let sawBody: Record<string, unknown> | undefined;
    const publisher = createBuzzNip98EventsPublisher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      authTagJson: authTag,
      nowSeconds: () => NOW,
      fetchImpl: async (url, init) => {
        sawUrl = String(url);
        const headers = new Headers(init?.headers);
        sawAuthTag = headers.get(BUZZ_OPEN_TAG_AUTH_TAG_HEADER);
        expect(headers.get("authorization")?.startsWith("Nostr ")).toBe(true);
        sawBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      },
    });

    const result = await publisher.publishAdmitReply({
      inbound: {
        eventId: EVENT,
        authorPubkey: AUTHOR,
        createdAt: NOW,
        channelId: CHANNEL,
        content: "SECRET_USER_TEXT_SHOULD_NOT_ECHO",
        rootEventId: EVENT,
        mentionPubkeys: [],
      },
    });

    expect(sawUrl).toBe(`${RELAY_BASE}/events`);
    expect(sawAuthTag).toBe(authTag);
    expect(sawBody?.kind).toBe(9);
    expect(sawBody?.content).toBe(BUZZ_ADMIT_REPLY_CONTENT);
    expect(JSON.stringify(sawBody)).not.toContain("SECRET_USER_TEXT");
    expect(sawBody?.pubkey).toBe(signer.publicKeyHex);
    expect(result.replyEventId).toBe(sawBody?.id);
  });

  it("skips publish when inbound author is the signer (self)", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    let calls = 0;
    const publisher = createBuzzNip98EventsPublisher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    const result = await publisher.publishAdmitReply({
      inbound: {
        eventId: EVENT,
        authorPubkey: signer.publicKeyHex,
        createdAt: NOW,
        channelId: CHANNEL,
        content: "self",
        rootEventId: EVENT,
        mentionPubkeys: [],
      },
    });
    expect(calls).toBe(0);
    expect(result.replyEventId).toBe(EVENT);
  });

  it("maps 401/403 to auth rejected and 4xx to rejected", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const inbound = {
      eventId: EVENT,
      authorPubkey: AUTHOR,
      createdAt: NOW,
      channelId: CHANNEL,
      content: "hi",
      rootEventId: EVENT,
      mentionPubkeys: [] as const,
    };
    await expect(
      createBuzzNip98EventsPublisher({
        relayHttpBaseUrl: RELAY_BASE,
        signer,
        fetchImpl: async () => new Response("no", { status: 403 }),
      }).publishAdmitReply({ inbound }),
    ).rejects.toThrow(BUZZ_REPLY_AUTH_REJECTED);
    await expect(
      createBuzzNip98EventsPublisher({
        relayHttpBaseUrl: RELAY_BASE,
        signer,
        fetchImpl: async () => new Response("no", { status: 400 }),
      }).publishAdmitReply({ inbound }),
    ).rejects.toThrow(BUZZ_REPLY_REJECTED);
    await expect(
      createBuzzNip98EventsPublisher({
        relayHttpBaseUrl: RELAY_BASE,
        signer,
        fetchImpl: async () => new Response("no", { status: 502 }),
      }).publishAdmitReply({ inbound }),
    ).rejects.toThrow(BUZZ_REPLY_PUBLISH_FAILED);
  });
});

describe("createBuzzRuntimeAdmit with reply publisher", () => {
  it("writes marker then reply claim; skips second publish", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      let publishes = 0;
      const runtime = createBuzzRuntimeAdmit(store, {
        nowMs: () => 42,
        replyPublisher: {
          async publishAdmitReply() {
            publishes += 1;
            return { replyEventId: "e".repeat(64) };
          },
        },
      });
      const inbound = {
        eventId: EVENT,
        authorPubkey: AUTHOR,
        createdAt: NOW,
        channelId: CHANNEL,
        content: "hi",
        rootEventId: EVENT,
        mentionPubkeys: [] as const,
      };
      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${EVENT}`,
        policyAuditMarker: "m1",
        inbound,
      });
      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${EVENT}`,
        policyAuditMarker: "m1",
        inbound,
      });
      expect(publishes).toBe(1);
      expect(await store.kv.get(buzzRuntimeAdmitKey(TENANT, EVENT))).toMatchObject({
        event_id: EVENT,
        admitted_at: 42,
      });
      expect(await store.kv.get(buzzRuntimeReplyKey(TENANT, EVENT))).toMatchObject({
        reply_event_id: "e".repeat(64),
        claimed_at: 42,
      });
    } finally {
      close();
    }
  });

  it("does not duplicate publish when forensic claim write fails after publish (F1)", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      let publishes = 0;
      const replyKey = buzzRuntimeReplyKey(TENANT, EVENT);
      const origSet = store.kv.set.bind(store.kv);
      store.kv.set = async (key, value, ttl) => {
        if (key === replyKey) {
          throw new Error("kv_finalize_failed");
        }
        return origSet(key, value, ttl);
      };
      const runtime = createBuzzRuntimeAdmit(store, {
        nowMs: () => 42,
        replyPublisher: {
          async publishAdmitReply() {
            publishes += 1;
            return { replyEventId: "e".repeat(64) };
          },
        },
      });
      const inbound = {
        eventId: EVENT,
        authorPubkey: AUTHOR,
        createdAt: NOW,
        channelId: CHANNEL,
        content: "hi",
        rootEventId: EVENT,
        mentionPubkeys: [] as const,
      };
      // Publish succeeds; forensic kv.set fails — admit still resolves (reservation holds).
      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${EVENT}`,
        policyAuditMarker: "m1",
        inbound,
      });
      expect(publishes).toBe(1);
      expect(await store.kv.get(replyKey)).toBeUndefined();
      expect(await store.dedup.has(replyKey)).toBe(true);

      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${EVENT}`,
        policyAuditMarker: "m1",
        inbound,
      });
      expect(publishes).toBe(1);
    } finally {
      close();
    }
  });

  it("releases reservation on transient publish failure so retry can publish", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      const replyKey = buzzRuntimeReplyKey(TENANT, EVENT);
      const runtime = createBuzzRuntimeAdmit(store, {
        nowMs: () => 7,
        replyPublisher: {
          async publishAdmitReply() {
            throw new Error(BUZZ_REPLY_PUBLISH_FAILED);
          },
        },
      });
      await expect(
        runtime.admit({
          tenantId: TENANT,
          conversationKey: `ck:${EVENT}`,
          policyAuditMarker: "m1",
          inbound: {
            eventId: EVENT,
            authorPubkey: AUTHOR,
            createdAt: NOW,
            channelId: CHANNEL,
            content: "hi",
            rootEventId: EVENT,
            mentionPubkeys: [],
          },
        }),
      ).rejects.toThrow(BUZZ_REPLY_PUBLISH_FAILED);
      // Marker still written (receive pipeline forgets authoritative on throw).
      expect(await store.kv.get(buzzRuntimeAdmitKey(TENANT, EVENT))).toBeDefined();
      expect(await store.kv.get(replyKey)).toBeUndefined();
      expect(await store.dedup.has(replyKey)).toBe(false);
    } finally {
      close();
    }
  });

  it("keeps reservation on permanent reply reject without throwing (F2)", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      let publishes = 0;
      const replyKey = buzzRuntimeReplyKey(TENANT, EVENT);
      const runtime = createBuzzRuntimeAdmit(store, {
        nowMs: () => 9,
        replyPublisher: {
          async publishAdmitReply() {
            publishes += 1;
            throw new Error(BUZZ_REPLY_AUTH_REJECTED);
          },
        },
      });
      const inbound = {
        eventId: EVENT,
        authorPubkey: AUTHOR,
        createdAt: NOW,
        channelId: CHANNEL,
        content: "hi",
        rootEventId: EVENT,
        mentionPubkeys: [] as const,
      };
      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${EVENT}`,
        policyAuditMarker: "m1",
        inbound,
      });
      expect(publishes).toBe(1);
      expect(await store.dedup.has(replyKey)).toBe(true);

      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${EVENT}`,
        policyAuditMarker: "m1",
        inbound,
      });
      expect(publishes).toBe(1);
    } finally {
      close();
    }
  });
});

describe("signer pubkey helper sanity", () => {
  it("derives stable pubkey", () => {
    const secret = randomPrivateKeyHex();
    expect(publicKeyHexFromPrivate(parsePrivateKeyHex(secret))).toHaveLength(64);
  });
});
