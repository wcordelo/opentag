import { describe, expect, it } from "vitest";
import {
  BuzzContractError,
  buzzConversationKey,
  canonicalInternalTenantId,
} from "../src/buzz/contract.js";
import {
  BUZZ_AUTHORITATIVE_EVENT_DEDUPE_TTL_MS,
  bindVerifiedEventToWake,
  buzzAuthoritativeEventDedupeKey,
  claimAuthoritativeBuzzEvent,
  processBuzzWakeReceive,
  stateStoreBuzzEventDedupe,
  type BuzzWakeReceiveDeps,
} from "../src/buzz/receive.js";
import {
  handleBuzzWakeHttp,
  readBuzzWakeJsonBody,
} from "../src/buzz/wake-http.js";
import { BUZZ_WAKE_DEDUPE_TTL_MS } from "../src/buzz/wake.js";
import type {
  BuzzChannelTenantDirectory,
  BuzzEventDedupe,
  BuzzWakeDedupe,
} from "../src/buzz/wake.js";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

const CHANNEL = "80d210c7-6cf2-49b3-8dab-06cbee389c04";
const OTHER_CHANNEL = "90d210c7-6cf2-49b3-8dab-06cbee389c04";
const MESSAGE = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const ROOT = "c".repeat(64);
const TENANT = canonicalInternalTenantId("11111111-1111-4111-8111-111111111111");
const NOW = 1_785_424_252;

function wake(overrides: Record<string, unknown> = {}) {
  return {
    message_id: MESSAGE,
    channel_id: CHANNEL,
    author: AUTHOR,
    timestamp: NOW,
    ...overrides,
  };
}

function verifiedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE,
    pubkey: AUTHOR,
    created_at: NOW,
    kind: 9,
    content: "hello from the receive test",
    tags: [
      ["h", CHANNEL],
      ["e", ROOT, "", "root"],
    ],
    ...overrides,
  };
}

function directory(
  entries: ReadonlyMap<string, ReturnType<typeof canonicalInternalTenantId>> = new Map([
    [CHANNEL, TENANT],
  ]),
): BuzzChannelTenantDirectory {
  return {
    resolveTenant(channelId) {
      return entries.get(channelId);
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

function memoryEventDedupe(): BuzzEventDedupe & { keys: Map<string, number> } {
  const base = memoryDedupe();
  return {
    ...base,
    async has(key: string) {
      const expiresAt = base.keys.get(key);
      return expiresAt !== undefined && expiresAt > Date.now();
    },
    async forget(key: string) {
      base.keys.delete(key);
    },
  };
}

type TestDeps = BuzzWakeReceiveDeps & {
  wakeDedupe: BuzzWakeDedupe & { keys: Map<string, number> };
  authoritativeDedupe: BuzzEventDedupe & { keys: Map<string, number> };
  admits: Array<unknown>;
  fetches: number;
};

function makeDeps(
  fetchImpl: () => Promise<unknown> = async () => verifiedEvent(),
): TestDeps {
  const wakeDedupe = memoryDedupe();
  const authoritativeDedupe = memoryEventDedupe();
  const admits: Array<unknown> = [];
  let fetches = 0;
  const state: TestDeps = {
    directory: directory(),
    wakeDedupe,
    authoritativeDedupe,
    admits,
    get fetches() {
      return fetches;
    },
    fetcher: {
      async fetchAndVerify() {
        fetches += 1;
        return fetchImpl();
      },
    },
    runtime: {
      async admit(input) {
        admits.push(input);
      },
    },
  };
  return state;
}

describe("Buzz authoritative event dedupe", () => {
  it("uses a namespace distinct from the wake pre-fetch key", () => {
    const inbound = bindVerifiedEventToWake(verifiedEvent(), {
      messageId: MESSAGE,
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: NOW,
    });
    expect(buzzAuthoritativeEventDedupeKey(TENANT, inbound)).toBe(
      `buzz-event:v1:36:${TENANT}36:${CHANNEL}64:${MESSAGE}`,
    );
    expect(buzzAuthoritativeEventDedupeKey(TENANT, inbound)).not.toContain("buzz-wake:");
  });

  it("claims first then duplicate without a second key", async () => {
    const dedupe = memoryEventDedupe();
    const inbound = bindVerifiedEventToWake(verifiedEvent(), {
      messageId: MESSAGE,
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: NOW,
    });
    const first = await claimAuthoritativeBuzzEvent(TENANT, inbound, dedupe);
    expect(first.status).toBe("first");
    const replay = await claimAuthoritativeBuzzEvent(TENANT, inbound, dedupe);
    expect(replay.status).toBe("duplicate");
    expect(dedupe.keys.size).toBe(1);
    expect(await dedupe.has(first.dedupeKey)).toBe(true);
    expect(BUZZ_AUTHORITATIVE_EVENT_DEDUPE_TTL_MS).toBeGreaterThan(
      BUZZ_WAKE_DEDUPE_TTL_MS,
    );
  });
});

describe("Buzz wake receive pipeline", () => {
  it("accepts first delivery through fetch → authoritative claim → runtime", async () => {
    const d = makeDeps();
    const result = await processBuzzWakeReceive(wake(), d);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.wakeClaim.authority).toBe("pre_fetch_fast_path");
    expect(result.authoritativeDedupeKey).toBe(
      buzzAuthoritativeEventDedupeKey(TENANT, result.inbound),
    );
    expect(result.conversationKey).toBe(buzzConversationKey(TENANT, result.inbound));
    expect(d.fetches).toBe(1);
    expect(d.admits).toHaveLength(1);
    expect(d.wakeDedupe.keys.size).toBe(1);
    expect(d.authoritativeDedupe.keys.size).toBe(1);
  });

  it("skips fetch and runtime when pre-fetch redelivery and authoritative already claimed", async () => {
    const d = makeDeps();
    await processBuzzWakeReceive(wake(), d);
    const replay = await processBuzzWakeReceive(wake(), d);
    expect(replay).toMatchObject({
      status: "duplicate",
      stage: "pre_fetch",
    });
    expect(d.fetches).toBe(1);
    expect(d.admits).toHaveLength(1);
    expect(d.authoritativeDedupe.keys.size).toBe(1);
  });

  it("re-fetches when pre-fetch is duplicate but authoritative was never claimed (loss-side)", async () => {
    let attempts = 0;
    const d = makeDeps(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("buzz_receive_fetch_failed");
      }
      return verifiedEvent();
    });

    await expect(processBuzzWakeReceive(wake(), d)).rejects.toThrow(
      "buzz_receive_fetch_failed",
    );
    expect(d.wakeDedupe.keys.size).toBe(1);
    expect(d.authoritativeDedupe.keys.size).toBe(0);
    expect(d.admits).toHaveLength(0);

    const recovered = await processBuzzWakeReceive(wake(), d);
    expect(recovered.status).toBe("accepted");
    expect(d.fetches).toBe(2);
    expect(d.admits).toHaveLength(1);
    expect(d.authoritativeDedupe.keys.size).toBe(1);
  });

  it("no-loss path holds against SqlStateEngine-backed StateStore (production primitive)", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      const buzzDedupe = stateStoreBuzzEventDedupe(store);
      let attempts = 0;
      let fetches = 0;
      const admits: Array<unknown> = [];
      const deps: BuzzWakeReceiveDeps = {
        directory: directory(),
        wakeDedupe: buzzDedupe,
        authoritativeDedupe: buzzDedupe,
        fetcher: {
          async fetchAndVerify() {
            fetches += 1;
            attempts += 1;
            if (attempts === 1) throw new Error("buzz_receive_fetch_failed");
            return verifiedEvent();
          },
        },
        runtime: {
          async admit(input) {
            admits.push(input);
          },
        },
      };

      await expect(processBuzzWakeReceive(wake(), deps)).rejects.toThrow(
        "buzz_receive_fetch_failed",
      );
      // Wake claim written; authoritative has must remain false (read-only).
      const authKey = buzzAuthoritativeEventDedupeKey(TENANT, {
        channelId: CHANNEL,
        eventId: MESSAGE,
      });
      expect(await store.dedup.has(authKey)).toBe(false);
      expect(admits).toHaveLength(0);

      const recovered = await processBuzzWakeReceive(wake(), deps);
      expect(recovered.status).toBe("accepted");
      expect(fetches).toBe(2);
      expect(admits).toHaveLength(1);
      expect(await store.dedup.has(authKey)).toBe(true);
      // Replay after success skips (authoritative has → no third fetch/admit).
      const replay = await processBuzzWakeReceive(wake(), deps);
      expect(replay).toMatchObject({ status: "duplicate", stage: "pre_fetch" });
      expect(fetches).toBe(2);
      expect(admits).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("still runs authoritative claim after a wake first (A2)", async () => {
    const d = makeDeps();
    const inbound = bindVerifiedEventToWake(verifiedEvent(), {
      messageId: MESSAGE,
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: NOW,
    });
    await claimAuthoritativeBuzzEvent(TENANT, inbound, d.authoritativeDedupe);

    const result = await processBuzzWakeReceive(wake(), d);
    expect(result).toMatchObject({
      status: "duplicate",
      stage: "authoritative",
    });
    expect(d.fetches).toBe(1);
    expect(d.admits).toHaveLength(0);
    expect(d.wakeDedupe.keys.size).toBe(1);
  });

  it("fails closed on event id mismatch before authoritative write", async () => {
    const d = makeDeps(async () => verifiedEvent({ id: "f".repeat(64) }));
    await expect(processBuzzWakeReceive(wake(), d)).rejects.toThrow(
      new BuzzContractError("buzz_receive_event_id_mismatch"),
    );
    expect(d.fetches).toBe(1);
    expect(d.admits).toHaveLength(0);
    expect(d.authoritativeDedupe.keys.size).toBe(0);
  });

  it("fails closed on author mismatch before authoritative write", async () => {
    const d = makeDeps(async () => verifiedEvent({ pubkey: "e".repeat(64) }));
    await expect(processBuzzWakeReceive(wake(), d)).rejects.toThrow(
      new BuzzContractError("buzz_receive_author_mismatch"),
    );
    expect(d.fetches).toBe(1);
    expect(d.admits).toHaveLength(0);
    expect(d.authoritativeDedupe.keys.size).toBe(0);
  });

  it("rejects channel-mismatched fetched event via wake expectedChannelId (Athena)", async () => {
    // Wake names CHANNEL; fetcher returns an event tagged for OTHER_CHANNEL.
    // Forgotten expectedChannelId would silently admit the wrong channel.
    const d = makeDeps(async () => verifiedEvent({
      tags: [
        ["h", OTHER_CHANNEL],
        ["e", ROOT, "", "root"],
      ],
    }));
    await expect(processBuzzWakeReceive(wake(), d)).rejects.toThrow(
      new BuzzContractError("buzz_channel_binding_mismatch"),
    );
    expect(d.fetches).toBe(1);
    expect(d.admits).toHaveLength(0);
    expect(d.authoritativeDedupe.keys.size).toBe(0);
  });
});

describe("Buzz wake HTTP adapter", () => {
  it("returns 503 when receive deps are unset", async () => {
    const response = await handleBuzzWakeHttp(wake(), undefined);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      error: "buzz_receive_not_configured",
    });
  });

  it("returns accepted JSON for a first delivery", async () => {
    const d = makeDeps();
    const response = await handleBuzzWakeHttp(wake(), d);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe("accepted");
    expect(body.event_id).toBe(MESSAGE);
    expect(body.channel_id).toBe(CHANNEL);
    expect(typeof body.conversation_key).toBe("string");
    expect(d.admits).toHaveLength(1);
  });

  it("returns duplicate with stage for completed pre-fetch redelivery", async () => {
    const d = makeDeps();
    await handleBuzzWakeHttp(wake(), d);
    const response = await handleBuzzWakeHttp(wake(), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "duplicate",
      stage: "pre_fetch",
      event_id: MESSAGE,
    });
  });

  it("maps validation failures to 400", async () => {
    const d = makeDeps();
    const response = await handleBuzzWakeHttp(wake({ channel_id: "not-a-uuid" }), d);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: "error",
      error: "buzz_wake_invalid_channel_id",
    });
    expect(d.fetches).toBe(0);
    expect(d.admits).toHaveLength(0);
  });

  it("rejects non-JSON content types before the pipeline", async () => {
    await expect(
      readBuzzWakeJsonBody(new Request("https://example.invalid/buzz/wake", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "nope",
      })),
    ).rejects.toThrow(new BuzzContractError("buzz_receive_unsupported_content_type"));
  });
});
