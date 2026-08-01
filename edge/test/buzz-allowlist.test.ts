/**
 * M1 installation allowlist — origin independence + loss-side chokepoint.
 *
 * §14.6 canaries must fail *open* if the grant becomes self-derived from the
 * fetch base (Prometheus) or if loss-side re-entry skips the gate.
 */

import { describe, expect, it } from "vitest";
import {
  BUZZ_M1_POLICY_AUDIT_MARKER,
  BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR,
  buildBuzzInstallationAllowlist,
  enforceBuzzRelayOriginAllowlist,
  loadBuzzAllowedRelayOrigin,
  normalizeBuzzRelayOrigin,
} from "../src/buzz/allowlist.js";
import {
  BuzzContractError,
  canonicalInternalTenantId,
} from "../src/buzz/contract.js";
import { randomPrivateKeyHex } from "../src/buzz/nostr-crypto.js";
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
  BUZZ_OPEN_TAG_SIGNER_SECRET_NAME,
  BUZZ_RELAY_HTTP_BASE_URL_VAR,
} from "../src/buzz/signer-secret.js";
import { tryBuildBuzzWakeReceiveDeps } from "../src/buzz/wake-bindings.js";
import { handleBuzzWakeHttp } from "../src/buzz/wake-http.js";
import type {
  BuzzChannelTenantDirectory,
  BuzzEventDedupe,
  BuzzWakeDedupe,
} from "../src/buzz/wake.js";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

const CHANNEL = "80d210c7-6cf2-49b3-8dab-06cbee389c04";
const MESSAGE = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const ROOT = "c".repeat(64);
const TENANT = canonicalInternalTenantId("11111111-1111-4111-8111-111111111111");
const NOW = 1_785_424_252;
const ALLOWED = "https://berendo.communities.buzz.xyz";
const OTHER_ORIGIN = "https://evil.example.invalid";

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

function wake() {
  return {
    message_id: MESSAGE,
    channel_id: CHANNEL,
    author: AUTHOR,
    timestamp: NOW,
  };
}

function verifiedEvent() {
  return {
    id: MESSAGE,
    pubkey: AUTHOR,
    created_at: NOW,
    kind: 9,
    content: "allowlist contract test",
    tags: [
      ["h", CHANNEL],
      ["e", ROOT, "", "root"],
    ],
  };
}

describe("normalizeBuzzRelayOrigin", () => {
  it("strips trailing slash and lowercases host", () => {
    expect(normalizeBuzzRelayOrigin("https://Berendo.Communities.Buzz.xyz/")).toBe(
      "https://berendo.communities.buzz.xyz",
    );
  });

  it("rejects empty / whitespace / non-http", () => {
    expect(() => normalizeBuzzRelayOrigin("")).toThrow(
      new BuzzContractError("buzz_allowlist_not_configured"),
    );
    expect(() => normalizeBuzzRelayOrigin("   ")).toThrow(
      new BuzzContractError("buzz_allowlist_not_configured"),
    );
    expect(() => normalizeBuzzRelayOrigin("not-a-url")).toThrow(
      new BuzzContractError("buzz_relay_origin_invalid_shape"),
    );
    expect(() => normalizeBuzzRelayOrigin("ftp://example.com")).toThrow(
      new BuzzContractError("buzz_relay_origin_invalid_shape"),
    );
  });
});

describe("loadBuzzAllowedRelayOrigin", () => {
  it("unset/empty → undefined (never falls back to a fetch base)", () => {
    expect(loadBuzzAllowedRelayOrigin(undefined)).toBeUndefined();
    expect(loadBuzzAllowedRelayOrigin("")).toBeUndefined();
  });
});

describe("enforceBuzzRelayOriginAllowlist", () => {
  it("permits matching origins after normalize", () => {
    const allowlist = buildBuzzInstallationAllowlist({
      allowedRelayOriginRaw: `${ALLOWED}/`,
      relayHttpBaseUrlRaw: ALLOWED,
    });
    expect(() => enforceBuzzRelayOriginAllowlist(allowlist)).not.toThrow();
  });

  it("rejects mismatched live fetch base (origin-independence canary)", () => {
    const allowlist = buildBuzzInstallationAllowlist({
      allowedRelayOriginRaw: ALLOWED,
      relayHttpBaseUrlRaw: OTHER_ORIGIN,
    });
    expect(() => enforceBuzzRelayOriginAllowlist(allowlist)).toThrow(
      new BuzzContractError("buzz_relay_origin_not_allowed"),
    );
  });
});

describe("M1 allowlist chokepoint in processBuzzWakeReceive", () => {
  it("happy path stamps forensic audit marker on admit", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      const wakeDedupe = memoryEventDedupe();
      const authoritativeDedupe = memoryEventDedupe();
      const deps: BuzzWakeReceiveDeps = {
        directory: directory(),
        wakeDedupe,
        authoritativeDedupe,
        allowlist: buildBuzzInstallationAllowlist({
          allowedRelayOriginRaw: ALLOWED,
          relayHttpBaseUrlRaw: ALLOWED,
        }),
        fetcher: {
          async fetchAndVerify() {
            return verifiedEvent();
          },
        },
        runtime: createBuzzRuntimeAdmit(store, { nowMs: () => 99 }),
      };
      const result = await processBuzzWakeReceive(wake(), deps);
      expect(result.status).toBe("accepted");
      const record = await store.kv.get(buzzRuntimeAdmitKey(TENANT, MESSAGE));
      expect(record).toMatchObject({
        policy_audit_marker: BUZZ_M1_POLICY_AUDIT_MARKER,
        admitted_at: 99,
      });
    } finally {
      close();
    }
  });

  it("origin canary: flip live fetch base → reject (grant held fixed)", async () => {
    const deps: BuzzWakeReceiveDeps = {
      directory: directory(),
      wakeDedupe: memoryDedupe(),
      authoritativeDedupe: memoryEventDedupe(),
      allowlist: buildBuzzInstallationAllowlist({
        allowedRelayOriginRaw: ALLOWED,
        relayHttpBaseUrlRaw: OTHER_ORIGIN,
      }),
      fetcher: {
        async fetchAndVerify() {
          return verifiedEvent();
        },
      },
      runtime: { async admit() {} },
    };
    await expect(processBuzzWakeReceive(wake(), deps)).rejects.toThrow(
      new BuzzContractError("buzz_relay_origin_not_allowed"),
    );
    const response = await handleBuzzWakeHttp(wake(), deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      error: "buzz_relay_origin_not_allowed",
    });
  });

  it("loss-side re-entry (wake duplicate, authoritative unseen) re-hits allowlist deny", async () => {
    const wakeDedupe = memoryDedupe();
    const authoritativeDedupe = memoryEventDedupe();
    let fetches = 0;
    const admits: unknown[] = [];

    // First attempt: permit origin, but fail at admit so authoritative is forgotten.
    const okAllowlist = buildBuzzInstallationAllowlist({
      allowedRelayOriginRaw: ALLOWED,
      relayHttpBaseUrlRaw: ALLOWED,
    });
    const firstDeps: BuzzWakeReceiveDeps = {
      directory: directory(),
      wakeDedupe,
      authoritativeDedupe,
      allowlist: okAllowlist,
      fetcher: {
        async fetchAndVerify() {
          fetches += 1;
          return verifiedEvent();
        },
      },
      runtime: {
        async admit() {
          throw new Error("simulated_admit_failure");
        },
      },
    };
    await expect(processBuzzWakeReceive(wake(), firstDeps)).rejects.toThrow(
      "simulated_admit_failure",
    );
    expect(wakeDedupe.keys.size).toBe(1);
    expect(authoritativeDedupe.keys.size).toBe(0);
    expect(admits).toHaveLength(0);

    // Loss-side re-entry with deny allowlist — must fail closed (not skip).
    const denyDeps: BuzzWakeReceiveDeps = {
      directory: directory(),
      wakeDedupe,
      authoritativeDedupe,
      allowlist: buildBuzzInstallationAllowlist({
        allowedRelayOriginRaw: ALLOWED,
        relayHttpBaseUrlRaw: OTHER_ORIGIN,
      }),
      fetcher: {
        async fetchAndVerify() {
          fetches += 1;
          return verifiedEvent();
        },
      },
      runtime: {
        async admit(input) {
          admits.push(input);
        },
      },
    };
    await expect(processBuzzWakeReceive(wake(), denyDeps)).rejects.toThrow(
      new BuzzContractError("buzz_relay_origin_not_allowed"),
    );
    expect(fetches).toBe(2);
    expect(admits).toHaveLength(0);
  });

  it("authoritative-claimed duplicate stays idempotent no-admit (not an allowlist re-check)", async () => {
    const wakeDedupe = memoryDedupe();
    const authoritativeDedupe = memoryEventDedupe();
    let fetches = 0;
    const admits: unknown[] = [];
    const deps: BuzzWakeReceiveDeps = {
      directory: directory(),
      wakeDedupe,
      authoritativeDedupe,
      allowlist: buildBuzzInstallationAllowlist({
        allowedRelayOriginRaw: ALLOWED,
        relayHttpBaseUrlRaw: ALLOWED,
      }),
      fetcher: {
        async fetchAndVerify() {
          fetches += 1;
          return verifiedEvent();
        },
      },
      runtime: {
        async admit(input) {
          admits.push(input);
        },
      },
    };
    expect((await processBuzzWakeReceive(wake(), deps)).status).toBe("accepted");

    // Flip allowlist to deny — already-admitted duplicate must still skip without re-fetch.
    const denyDeps: BuzzWakeReceiveDeps = {
      ...deps,
      allowlist: buildBuzzInstallationAllowlist({
        allowedRelayOriginRaw: ALLOWED,
        relayHttpBaseUrlRaw: OTHER_ORIGIN,
      }),
    };
    const replay = await processBuzzWakeReceive(wake(), denyDeps);
    expect(replay).toMatchObject({ status: "duplicate", stage: "pre_fetch" });
    expect(fetches).toBe(1);
    expect(admits).toHaveLength(1);
  });
});

describe("tryBuild requires distinct allowed-origin", () => {
  it("missing allowed-origin → undefined even when fetch base is set", () => {
    const deps = tryBuildBuzzWakeReceiveDeps(
      {
        [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: randomPrivateKeyHex(),
        [BUZZ_RELAY_HTTP_BASE_URL_VAR]: ALLOWED,
        [BUZZ_CHANNEL_TENANT_MAP_VAR]: JSON.stringify({ [CHANNEL]: String(TENANT) }),
      },
      undefined,
    );
    expect(deps).toBeUndefined();
  });

  it("wires independently provisioned allowed-origin (canary source independence)", async () => {
    const { store, close } = makeSqliteStateStore();
    try {
      // Mismatched grant vs fetch base must fail at tryBuild (Athena fast-fail),
      // not return deps that would waste a fetch then deny.
      expect(() =>
        tryBuildBuzzWakeReceiveDeps(
          {
            [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: randomPrivateKeyHex(),
            [BUZZ_RELAY_HTTP_BASE_URL_VAR]: OTHER_ORIGIN,
            [BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR]: ALLOWED,
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
        ),
      ).toThrow(new BuzzContractError("buzz_relay_origin_not_allowed"));

      const deps = tryBuildBuzzWakeReceiveDeps(
        {
          [BUZZ_OPEN_TAG_SIGNER_SECRET_NAME]: randomPrivateKeyHex(),
          [BUZZ_RELAY_HTTP_BASE_URL_VAR]: ALLOWED,
          [BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN_VAR]: `${ALLOWED}/`,
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
      expect(deps!.allowlist.allowedRelayOrigin).toBe(ALLOWED);
      expect(deps!.allowlist.relayHttpBaseUrl).toBe(ALLOWED);
    } finally {
      close();
    }
  });
});
