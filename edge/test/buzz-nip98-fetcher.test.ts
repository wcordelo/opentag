/**
 * Task #27 — NIP-98 query fetcher + runtime-admit + §14.4/§14.6 secret-shape.
 *
 * Live signed pilot is OUT of this slice; all relay I/O is mocked.
 */

import { describe, expect, it } from "vitest";
import {
  BuzzContractError,
  canonicalInternalTenantId,
} from "../src/buzz/contract.js";
import {
  computeEventId,
  parsePrivateKeyHex,
  publicKeyHexFromPrivate,
  randomPrivateKeyHex,
  signNostrEvent,
  verifyNostrEvent,
} from "../src/buzz/nostr-crypto.js";
import { buildNip98AuthorizationHeader } from "../src/buzz/nip98-auth.js";
import {
  BUZZ_RECEIVE_AUTH_REJECTED,
  BUZZ_RECEIVE_EVENT_UNVERIFIED,
  BUZZ_RECEIVE_FETCH_FAILED,
  createBuzzNip98QueryFetcher,
} from "../src/buzz/query-fetcher.js";
import {
  processBuzzWakeReceive,
  type BuzzWakeReceiveDeps,
} from "../src/buzz/receive.js";
import {
  buzzRuntimeAdmitKey,
  createBuzzRuntimeAdmit,
} from "../src/buzz/runtime-admit.js";
import {
  BUZZ_CHANNEL_TENANT_MAP_VAR,
  BUZZ_OPEN_TAG_AUTH_TAG_HEADER,
  BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME,
  BUZZ_OPEN_TAG_SIGNER_SECRET_NAME,
  BUZZ_RELAY_HTTP_BASE_URL_VAR,
  loadBuzzOpenTagAuthTag,
  loadBuzzOpenTagSigner,
  redactSecretShaped,
} from "../src/buzz/signer-secret.js";
import {
  parseBuzzChannelTenantMap,
  tryBuildBuzzWakeReceiveDeps,
} from "../src/buzz/wake-bindings.js";
import { handleBuzzWakeHttp } from "../src/buzz/wake-http.js";
import type {
  BuzzChannelTenantDirectory,
  BuzzEventDedupe,
  BuzzWakeDedupe,
} from "../src/buzz/wake.js";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

const CHANNEL = "80d210c7-6cf2-49b3-8dab-06cbee389c04";
const ROOT = "c".repeat(64);
const TENANT = canonicalInternalTenantId("11111111-1111-4111-8111-111111111111");
const RELAY_BASE = "https://opentag-contract-test.example.invalid";
const NOW = 1_785_424_252;

function directory(): BuzzChannelTenantDirectory {
  return {
    resolveTenant(channelId) {
      return channelId === CHANNEL ? TENANT : undefined;
    },
  };
}

function memoryDedupe(): BuzzWakeDedupe & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    async seen(key: string, ttlMs: number) {
      const expiresAt = keys.get(key);
      if (expiresAt !== undefined && expiresAt > Date.now()) return true;
      keys.set(key, Date.now() + ttlMs);
      return false;
    },
  };
}

function memoryEventDedupe(): BuzzEventDedupe & {
  keys: Map<string, number>;
  forgotten: string[];
} {
  const base = memoryDedupe();
  const forgotten: string[] = [];
  return {
    ...base,
    forgotten,
    async has(key: string) {
      const expiresAt = base.keys.get(key);
      return expiresAt !== undefined && expiresAt > Date.now();
    },
    async forget(key: string) {
      forgotten.push(key);
      base.keys.delete(key);
    },
  };
}

async function signedKind9(secretHex: string, content = "hello from nip98 test") {
  const secret = parsePrivateKeyHex(secretHex);
  const pubkey = publicKeyHexFromPrivate(secret);
  const unsigned = {
    kind: 9,
    created_at: NOW,
    content,
    tags: [
      ["h", CHANNEL],
      ["e", ROOT, "", "root"],
    ] as const,
  };
  const signed = await signNostrEvent(unsigned, secret);
  return { secretHex, pubkey, event: signed };
}

function wakeFor(event: { id: string; pubkey: string }) {
  return {
    message_id: event.id,
    channel_id: CHANNEL,
    author: event.pubkey,
    timestamp: NOW,
  };
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStrings(entry, out);
    }
  }
}

describe("Buzz signer secret seam", () => {
  it("loads a 64-hex secret and derives a stable pubkey without echoing the key", () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret);
    expect(signer).toBeDefined();
    expect(signer!.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(loadBuzzOpenTagSigner(undefined)).toBeUndefined();
    expect(loadBuzzOpenTagSigner("")).toBeUndefined();
    expect(() => loadBuzzOpenTagSigner("not-a-key")).toThrow(
      "buzz_signer_invalid_secret_shape",
    );
    try {
      loadBuzzOpenTagSigner("gg".repeat(32));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("gg".repeat(32));
    }
  });

  it("exports the exact provisioning contract names", () => {
    expect(BUZZ_OPEN_TAG_SIGNER_SECRET_NAME).toBe("BUZZ_OPEN_TAG_SIGNER_SECRET");
    expect(BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME).toBe("BUZZ_OPEN_TAG_AUTH_TAG");
    expect(BUZZ_OPEN_TAG_AUTH_TAG_HEADER).toBe("x-auth-tag");
    expect(BUZZ_RELAY_HTTP_BASE_URL_VAR).toBe("BUZZ_RELAY_HTTP_BASE_URL");
    expect(BUZZ_CHANNEL_TENANT_MAP_VAR).toBe("BUZZ_CHANNEL_TENANT_MAP");
  });

  it("loads optional NIP-OA auth-tag JSON opaquely", () => {
    const tag = JSON.stringify([
      "auth",
      "a".repeat(64),
      "",
      "b".repeat(128),
    ]);
    // Explicit defaults: truly unset/empty → NIP-98-only mode (not a mis-set).
    expect(loadBuzzOpenTagAuthTag(undefined)).toBeUndefined();
    expect(loadBuzzOpenTagAuthTag("")).toBeUndefined();
    expect(loadBuzzOpenTagAuthTag(tag)).toBe(tag);
    // Present-but-malformed (incl. whitespace-only) → fail closed, never omit.
    expect(() => loadBuzzOpenTagAuthTag("   \t\n  ")).toThrow(
      "buzz_auth_tag_invalid_shape",
    );
    expect(() => loadBuzzOpenTagAuthTag("not-json")).toThrow(
      "buzz_auth_tag_invalid_shape",
    );
    expect(() => loadBuzzOpenTagAuthTag('["auth","short","",""]')).toThrow(
      "buzz_auth_tag_invalid_shape",
    );
    try {
      loadBuzzOpenTagAuthTag(tag.slice(0, -1));
      expect.unreachable();
    } catch (error) {
      const text = String(error);
      expect(text).toContain("buzz_auth_tag_invalid_shape");
      expect(text).not.toContain("a".repeat(64));
      expect(text).not.toContain("b".repeat(128));
    }
  });
});

describe("NIP-98 auth header", () => {
  it("binds u/method/payload/nonce and verifies as a signed kind-27235", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const body = new TextEncoder().encode('[{"ids":["aa"],"limit":1}]');
    const header = await buildNip98AuthorizationHeader(signer, {
      url: `${RELAY_BASE}/query`,
      method: "POST",
      body,
      createdAt: NOW,
      nonce: "test-nonce-1",
    });
    expect(header.startsWith("Nostr ")).toBe(true);
    const b64 = header.slice("Nostr ".length);
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    const event = JSON.parse(json) as Record<string, unknown>;
    expect(event.kind).toBe(27235);
    expect(await verifyNostrEvent(event)).toBe(true);
    const tags = event.tags as string[][];
    expect(tags).toContainEqual(["u", `${RELAY_BASE}/query`]);
    expect(tags).toContainEqual(["method", "POST"]);
    expect(tags).toContainEqual(["nonce", "test-nonce-1"]);
    expect(tags.some((t) => t[0] === "payload" && /^[0-9a-f]{64}$/.test(t[1]!))).toBe(
      true,
    );
  });
});

describe("NIP-98 /query fetcher failure taxonomy", () => {
  it("401 → buzz_receive_auth_rejected (permanent, distinct from fetch_failed)", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    await expect(
      fetcher.fetchAndVerify({
        messageId: "a".repeat(64),
        channelId: CHANNEL,
        authorPubkey: "b".repeat(64),
        tenantId: TENANT,
      }),
    ).rejects.toThrow(BUZZ_RECEIVE_AUTH_REJECTED);
  });

  it("403 → buzz_receive_auth_rejected", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });
    await expect(
      fetcher.fetchAndVerify({
        messageId: "a".repeat(64),
        channelId: CHANNEL,
        authorPubkey: "b".repeat(64),
        tenantId: TENANT,
      }),
    ).rejects.toThrow(BUZZ_RECEIVE_AUTH_REJECTED);
  });

  it("5xx → buzz_receive_fetch_failed (transient)", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () => new Response("boom", { status: 502 }),
    });
    await expect(
      fetcher.fetchAndVerify({
        messageId: "a".repeat(64),
        channelId: CHANNEL,
        authorPubkey: "b".repeat(64),
        tenantId: TENANT,
      }),
    ).rejects.toThrow(BUZZ_RECEIVE_FETCH_FAILED);
  });

  it("200-empty → buzz_receive_fetch_failed (transient / propagation lag)", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      fetcher.fetchAndVerify({
        messageId: "a".repeat(64),
        channelId: CHANNEL,
        authorPubkey: "b".repeat(64),
        tenantId: TENANT,
      }),
    ).rejects.toThrow(BUZZ_RECEIVE_FETCH_FAILED);
  });

  it("timeout / network → buzz_receive_fetch_failed", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    await expect(
      fetcher.fetchAndVerify({
        messageId: "a".repeat(64),
        channelId: CHANNEL,
        authorPubkey: "b".repeat(64),
        tenantId: TENANT,
      }),
    ).rejects.toThrow(BUZZ_RECEIVE_FETCH_FAILED);
  });

  it("200 + bad sig → buzz_receive_event_unverified (no admit path)", async () => {
    const secret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(secret)!;
    const forged = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: NOW,
      kind: 9,
      content: "forged",
      tags: [["h", CHANNEL]],
      sig: "c".repeat(64),
    };
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      fetchImpl: async () =>
        new Response(JSON.stringify([forged]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      fetcher.fetchAndVerify({
        messageId: forged.id,
        channelId: CHANNEL,
        authorPubkey: forged.pubkey,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(BUZZ_RECEIVE_EVENT_UNVERIFIED);
  });

  it("200 + valid signed event → returns the event after local verify", async () => {
    const authorSecret = randomPrivateKeyHex();
    const { pubkey, event } = await signedKind9(authorSecret);
    const signerSecret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(signerSecret)!;
    let sawAuth = false;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      nowSeconds: () => NOW,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization") ?? "";
        expect(auth.startsWith("Nostr ")).toBe(true);
        expect(headers.get(BUZZ_OPEN_TAG_AUTH_TAG_HEADER)).toBeNull();
        sawAuth = true;
        return new Response(JSON.stringify([event]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const got = await fetcher.fetchAndVerify({
      messageId: event.id,
      channelId: CHANNEL,
      authorPubkey: pubkey,
      tenantId: TENANT,
    });
    expect(sawAuth).toBe(true);
    expect(got).toMatchObject({ id: event.id, pubkey });
  });

  it("sends x-auth-tag when optional authTagJson is set", async () => {
    const authorSecret = randomPrivateKeyHex();
    const { pubkey, event } = await signedKind9(authorSecret);
    const signerSecret = randomPrivateKeyHex();
    const signer = loadBuzzOpenTagSigner(signerSecret)!;
    const authTag = JSON.stringify([
      "auth",
      "c".repeat(64),
      "",
      "d".repeat(128),
    ]);
    let sawAuthTag: string | null = null;
    const fetcher = createBuzzNip98QueryFetcher({
      relayHttpBaseUrl: RELAY_BASE,
      signer,
      authTagJson: authTag,
      nowSeconds: () => NOW,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")?.startsWith("Nostr ")).toBe(true);
        sawAuthTag = headers.get(BUZZ_OPEN_TAG_AUTH_TAG_HEADER);
        return new Response(JSON.stringify([event]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await fetcher.fetchAndVerify({
      messageId: event.id,
      channelId: CHANNEL,
      authorPubkey: pubkey,
      tenantId: TENANT,
    });
    expect(sawAuthTag).toBe(authTag);
  });
});

describe("HTTP mapping: permanent vs transient", () => {
  it("maps auth_rejected to 502 with distinct code", async () => {
    const deps: BuzzWakeReceiveDeps = {
      directory: directory(),
      wakeDedupe: memoryDedupe(),
      authoritativeDedupe: memoryEventDedupe(),
      fetcher: {
        async fetchAndVerify() {
          throw new Error(BUZZ_RECEIVE_AUTH_REJECTED);
        },
      },
      runtime: { async admit() {} },
    };
    const response = await handleBuzzWakeHttp(
      wakeFor({ id: "a".repeat(64), pubkey: "b".repeat(64) }),
      deps,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: "error",
      error: BUZZ_RECEIVE_AUTH_REJECTED,
    });
  });

  it("maps transient fetch_failed to 502; redelivery recovers", async () => {
    let attempts = 0;
    const authorSecret = randomPrivateKeyHex();
    const { event } = await signedKind9(authorSecret);
    const wakeDedupe = memoryDedupe();
    const authoritativeDedupe = memoryEventDedupe();
    const admits: unknown[] = [];
    const deps: BuzzWakeReceiveDeps = {
      directory: directory(),
      wakeDedupe,
      authoritativeDedupe,
      fetcher: {
        async fetchAndVerify() {
          attempts += 1;
          if (attempts === 1) throw new Error(BUZZ_RECEIVE_FETCH_FAILED);
          return event;
        },
      },
      runtime: {
        async admit(input) {
          admits.push(input);
        },
      },
    };
    const first = await handleBuzzWakeHttp(wakeFor(event), deps);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({
      status: "error",
      error: BUZZ_RECEIVE_FETCH_FAILED,
    });
    const second = await handleBuzzWakeHttp(wakeFor(event), deps);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "accepted", event_id: event.id });
    expect(admits).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("Runtime admit (minimal, post-authoritative)", () => {
  it("persists a public admission marker without secret fields", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      const runtime = createBuzzRuntimeAdmit(store, { nowMs: () => 42 });
      const authorSecret = randomPrivateKeyHex();
      const { event } = await signedKind9(authorSecret);
      await runtime.admit({
        tenantId: TENANT,
        conversationKey: `ck:${event.id}`,
        inbound: {
          eventId: event.id,
          authorPubkey: event.pubkey,
          createdAt: event.created_at,
          channelId: CHANNEL,
          content: event.content,
          rootEventId: ROOT,
          mentionPubkeys: [],
        },
      });
      const key = buzzRuntimeAdmitKey(TENANT, event.id);
      const record = await store.kv.get<Record<string, unknown>>(key);
      expect(record).toMatchObject({
        v: 1,
        tenant_id: TENANT,
        channel_id: CHANNEL,
        event_id: event.id,
        author_pubkey: event.pubkey,
        admitted_at: 42,
      });
      const blob = JSON.stringify(record);
      expect(blob).not.toContain(authorSecret);
      expect(blob.toLowerCase()).not.toContain("authorization");
    } finally {
      close();
    }
  });
});

describe("Channel→tenant map + wake binding gate", () => {
  it("parses a valid map and rejects malformed JSON opaquely", () => {
    const dir = parseBuzzChannelTenantMap(
      JSON.stringify({ [CHANNEL]: String(TENANT) }),
    );
    expect(dir.resolveTenant(CHANNEL)).toBe(TENANT);
    expect(() => parseBuzzChannelTenantMap("{")).toThrow(
      new BuzzContractError("buzz_receive_invalid_channel_tenant_map"),
    );
  });

  it("tryBuild returns undefined when the signer secret is unset", () => {
    const deps = tryBuildBuzzWakeReceiveDeps(
      {
        [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: undefined,
        [BUZZ_RELAY_HTTP_BASE_URL_VAR]: RELAY_BASE,
        [BUZZ_CHANNEL_TENANT_MAP_VAR]: JSON.stringify({ [CHANNEL]: String(TENANT) }),
      },
      undefined,
    );
    expect(deps).toBeUndefined();
  });

  it("tryBuild wires fetcher + admit when secret/url/map/store are present", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      const secret = randomPrivateKeyHex();
      const deps = tryBuildBuzzWakeReceiveDeps(
        {
          [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: secret,
          [BUZZ_RELAY_HTTP_BASE_URL_VAR]: RELAY_BASE,
          [BUZZ_CHANNEL_TENANT_MAP_VAR]: JSON.stringify({ [CHANNEL]: String(TENANT) }),
        },
        store,
        {
          fetchImpl: async () =>
            new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        },
      );
      expect(deps).toBeDefined();
      await expect(
        deps!.fetcher.fetchAndVerify({
          messageId: "a".repeat(64),
          channelId: CHANNEL,
          authorPubkey: "b".repeat(64),
          tenantId: TENANT,
        }),
      ).rejects.toThrow(BUZZ_RECEIVE_FETCH_FAILED);
    } finally {
      close();
    }
  });

  it("tryBuild forwards optional auth-tag and omits header when unset", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      const secret = randomPrivateKeyHex();
      const authTag = JSON.stringify([
        "auth",
        "e".repeat(64),
        "",
        "f".repeat(128),
      ]);
      const mapJson = JSON.stringify({ [CHANNEL]: String(TENANT) });
      const seen: Array<string | null> = [];
      const depsWith = tryBuildBuzzWakeReceiveDeps(
        {
          [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: secret,
          [BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME]: authTag,
          [BUZZ_RELAY_HTTP_BASE_URL_VAR]: RELAY_BASE,
          [BUZZ_CHANNEL_TENANT_MAP_VAR]: mapJson,
        },
        store,
        {
          fetchImpl: async (_url, init) => {
            seen.push(new Headers(init?.headers).get(BUZZ_OPEN_TAG_AUTH_TAG_HEADER));
            return new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      );
      expect(depsWith).toBeDefined();
      await expect(
        depsWith!.fetcher.fetchAndVerify({
          messageId: "a".repeat(64),
          channelId: CHANNEL,
          authorPubkey: "b".repeat(64),
          tenantId: TENANT,
        }),
      ).rejects.toThrow(BUZZ_RECEIVE_FETCH_FAILED);
      expect(seen).toEqual([authTag]);

      // Explicit unset mode: build succeeds and never sends x-auth-tag.
      const seenUnset: Array<string | null> = [];
      const depsUnset = tryBuildBuzzWakeReceiveDeps(
        {
          [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: secret,
          [BUZZ_RELAY_HTTP_BASE_URL_VAR]: RELAY_BASE,
          [BUZZ_CHANNEL_TENANT_MAP_VAR]: mapJson,
        },
        store,
        {
          fetchImpl: async (_url, init) => {
            seenUnset.push(
              new Headers(init?.headers).get(BUZZ_OPEN_TAG_AUTH_TAG_HEADER),
            );
            return new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      );
      expect(depsUnset).toBeDefined();
      await expect(
        depsUnset!.fetcher.fetchAndVerify({
          messageId: "a".repeat(64),
          channelId: CHANNEL,
          authorPubkey: "b".repeat(64),
          tenantId: TENANT,
        }),
      ).rejects.toThrow(BUZZ_RECEIVE_FETCH_FAILED);
      expect(seenUnset).toEqual([null]);

      expect(() =>
        tryBuildBuzzWakeReceiveDeps(
          {
            [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: secret,
            [BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME]: "not-a-tag",
            [BUZZ_RELAY_HTTP_BASE_URL_VAR]: RELAY_BASE,
            [BUZZ_CHANNEL_TENANT_MAP_VAR]: mapJson,
          },
          store,
        ),
      ).toThrow("buzz_auth_tag_invalid_shape");

      expect(() =>
        tryBuildBuzzWakeReceiveDeps(
          {
            [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: secret,
            [BUZZ_OPEN_TAG_AUTH_TAG_SECRET_NAME]: "   ",
            [BUZZ_RELAY_HTTP_BASE_URL_VAR]: RELAY_BASE,
            [BUZZ_CHANNEL_TENANT_MAP_VAR]: mapJson,
          },
          store,
        ),
      ).toThrow("buzz_auth_tag_invalid_shape");
    } finally {
      close();
    }
  });
});

describe("§14.4 / §14.6 secret-shape full surface", () => {
  it("secret + NIP-98 auth-tag never enter DO/queues/logs/errors/metrics/admit/outbound", async () => {
    const signerSecret = randomPrivateKeyHex();
    const authorSecret = randomPrivateKeyHex();
    const { event } = await signedKind9(authorSecret);
    const signer = loadBuzzOpenTagSigner(signerSecret)!;
    const ownerAuthTag = JSON.stringify([
      "auth",
      "1".repeat(64),
      "",
      "2".repeat(128),
    ]);
    const { store, close } = makeSqliteStateStore();
    const captured: {
      authorization?: string;
      authTagHeader?: string | null;
      urls: string[];
      bodies: string[];
    } = { urls: [], bodies: [] };
    const logLines: string[] = [];
    const metrics: unknown[] = [];
    const outbound: unknown[] = [];

    try {
      const fetcher = createBuzzNip98QueryFetcher({
        relayHttpBaseUrl: RELAY_BASE,
        signer,
        authTagJson: ownerAuthTag,
        nowSeconds: () => NOW,
        fetchImpl: async (url, init) => {
          captured.urls.push(String(url));
          const headers = new Headers(init?.headers);
          captured.authorization = headers.get("authorization") ?? undefined;
          captured.authTagHeader = headers.get(BUZZ_OPEN_TAG_AUTH_TAG_HEADER);
          captured.bodies.push(String(init?.body ?? ""));
          // Intended use of auth header toward the relay — not a leak surface.
          return new Response(JSON.stringify([event]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const wakeDedupe = memoryEventDedupe();
      const authoritativeDedupe = memoryEventDedupe();
      const deps: BuzzWakeReceiveDeps = {
        directory: directory(),
        wakeDedupe,
        authoritativeDedupe,
        fetcher,
        runtime: createBuzzRuntimeAdmit(store, { nowMs: () => NOW * 1000 }),
      };

      const result = await processBuzzWakeReceive(wakeFor(event), deps);
      expect(result.status).toBe("accepted");
      expect(captured.authorization?.startsWith("Nostr ")).toBe(true);
      expect(captured.authTagHeader).toBe(ownerAuthTag);

      // Force an error path and capture the message — must stay opaque.
      const failingFetcher = createBuzzNip98QueryFetcher({
        relayHttpBaseUrl: RELAY_BASE,
        signer,
        authTagJson: ownerAuthTag,
        fetchImpl: async () => new Response(signerSecret, { status: 401 }),
      });
      let authErrorText = "";
      try {
        await failingFetcher.fetchAndVerify({
          messageId: event.id,
          channelId: CHANNEL,
          authorPubkey: event.pubkey,
          tenantId: TENANT,
        });
      } catch (error) {
        authErrorText = error instanceof Error ? error.message : String(error);
        logLines.push(authErrorText);
      }
      expect(authErrorText).toBe(BUZZ_RECEIVE_AUTH_REJECTED);

      // Simulated observable surfaces (§14.4 + §14.6 union).
      const admitKey = buzzRuntimeAdmitKey(TENANT, event.id);
      const admitRecord = await store.kv.get(admitKey);
      const surfaces: unknown[] = [
        [...wakeDedupe.keys.keys()],
        [...authoritativeDedupe.keys.keys()],
        admitRecord,
        logLines,
        metrics,
        outbound,
        // Response / reply shaped objects from the happy path:
        result.status === "accepted"
          ? {
            event_id: result.inbound.eventId,
            channel_id: result.inbound.channelId,
            conversation_key: result.conversationKey,
            content: result.inbound.content,
          }
          : result,
        // Source/fixture proxy: ensure the test fixture itself doesn't embed the
        // *signer* secret (author secret is only used to mint a valid event).
        captured.bodies,
        captured.urls,
        redactSecretShaped("safe", [signerSecret, ownerAuthTag]),
      ];

      const haystackParts: string[] = [];
      for (const surface of surfaces) {
        collectStrings(surface, haystackParts);
      }
      // Also scan raw JSON of store marker + error text.
      haystackParts.push(JSON.stringify(admitRecord), authErrorText);
      const haystack = haystackParts.join("\n");

      expect(haystack).not.toContain(signerSecret);
      expect(haystack.toLowerCase()).not.toContain(signerSecret.toLowerCase());
      expect(haystack).not.toContain(ownerAuthTag);
      // Auth-tag base64 payload must not land in stored/observable surfaces.
      const authTag = captured.authorization!.slice("Nostr ".length);
      expect(authTag.length).toBeGreaterThan(40);
      expect(haystack).not.toContain(authTag);
      expect(haystack).not.toContain(captured.authorization);

      // Intended relay hop still carried the headers (prove the test saw them).
      expect(captured.authorization).toContain(authTag);
      expect(captured.authTagHeader).toBe(ownerAuthTag);
    } finally {
      close();
    }
  });

  it("computeEventId is stable for NIP-01 serialization", async () => {
    const secret = parsePrivateKeyHex(randomPrivateKeyHex());
    const pubkey = publicKeyHexFromPrivate(secret);
    const unsigned = {
      kind: 1,
      created_at: 100,
      tags: [["t", "x"]] as const,
      content: "hi",
    };
    const a = await computeEventId(pubkey, unsigned);
    const b = await computeEventId(pubkey, unsigned);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
