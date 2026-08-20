import { describe, expect, it } from "vitest";
import { BuzzContractError, canonicalInternalTenantId } from "../src/buzz/contract.js";
import {
  BUZZ_WAKE_DEDUPE_TTL_MS,
  buzzWakeDedupeKey,
  claimBuzzWake,
  resolveWakeTenant,
  validateBuzzWakeEnvelope,
  type BuzzChannelTenantDirectory,
  type BuzzWakeDedupe,
} from "../src/buzz/wake.js";

const CHANNEL = "80d210c7-6cf2-49b3-8dab-06cbee389c04";
const UNKNOWN_CHANNEL = "00000000-0000-0000-0000-000000000000";
const MESSAGE = "a".repeat(64);
const AUTHOR = "b".repeat(64);
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

describe("Buzz untrusted wake envelope", () => {
  it("accepts the exact workflow identity fields and rejects trusted-body extras", () => {
    expect(validateBuzzWakeEnvelope(wake())).toEqual({
      messageId: MESSAGE,
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: NOW,
    });
    expect(validateBuzzWakeEnvelope(wake({ timestamp: String(NOW) })).createdAt).toBe(NOW);
    expect(() => validateBuzzWakeEnvelope(wake({ text: "do not trust me" })))
      .toThrow(new BuzzContractError("buzz_wake_unexpected_fields"));
    expect(() => validateBuzzWakeEnvelope(wake({ content: "nope" })))
      .toThrow(new BuzzContractError("buzz_wake_unexpected_fields"));
  });

  it.each([
    ["invalid message id", wake({ message_id: "not-an-event-id" }), "buzz_wake_invalid_message_id"],
    ["invalid channel id", wake({ channel_id: "not-a-uuid" }), "buzz_wake_invalid_channel_id"],
    ["invalid author", wake({ author: "npub1nothex" }), "buzz_wake_invalid_author"],
    ["zero timestamp", wake({ timestamp: 0 }), "buzz_wake_invalid_timestamp"],
    ["float timestamp", wake({ timestamp: 1.5 }), "buzz_wake_invalid_timestamp"],
    ["missing field", { message_id: MESSAGE, channel_id: CHANNEL, author: AUTHOR }, "buzz_wake_unexpected_fields"],
    ["array body", [], "buzz_wake_invalid_shape"],
    ["null body", null, "buzz_wake_invalid_shape"],
  ])("fails closed for %s", (_label, raw, code) => {
    expect(() => validateBuzzWakeEnvelope(raw as never)).toThrow(
      new BuzzContractError(code),
    );
  });

  it("resolves tenant only from the trusted channel directory and rejects unbound channels", () => {
    const envelope = validateBuzzWakeEnvelope(wake());
    expect(resolveWakeTenant(envelope, directory())).toBe(TENANT);
    expect(() => resolveWakeTenant(
      validateBuzzWakeEnvelope(wake({ channel_id: UNKNOWN_CHANNEL })),
      directory(),
    )).toThrow(new BuzzContractError("buzz_wake_unbound_channel"));
    expect(() => resolveWakeTenant(envelope, directory(new Map())))
      .toThrow(new BuzzContractError("buzz_wake_unbound_channel"));
  });

  it("builds a collision-resistant wake dedupe key from the resolved tenant", () => {
    const envelope = validateBuzzWakeEnvelope(wake());
    const tenantId = resolveWakeTenant(envelope, directory());
    expect(buzzWakeDedupeKey(tenantId, envelope)).toBe(
      `buzz-wake:v1:36:${TENANT}36:${CHANNEL}64:${MESSAGE}`,
    );
    const otherTenant = canonicalInternalTenantId("22222222-2222-4222-8222-222222222222");
    expect(buzzWakeDedupeKey(tenantId, envelope)).not.toBe(
      buzzWakeDedupeKey(otherTenant, envelope),
    );
  });

  it("keeps the same event isolated when directory resolution selects another tenant", async () => {
    const dedupe = memoryDedupe();
    const otherTenant = canonicalInternalTenantId("22222222-2222-4222-8222-222222222222");
    const first = await claimBuzzWake(
      wake(),
      directory(new Map([[CHANNEL, TENANT]])),
      dedupe,
    );
    const isolated = await claimBuzzWake(
      wake(),
      directory(new Map([[CHANNEL, otherTenant]])),
      dedupe,
    );
    expect(first.status).toBe("first");
    expect(isolated.status).toBe("first");
    expect(isolated.tenantId).toBe(otherTenant);
    expect(isolated.dedupeKey).not.toBe(first.dedupeKey);
    expect(dedupe.keys.size).toBe(2);
  });

  it("claims first delivery via resolved tenant and rejects redelivery", async () => {
    const dedupe = memoryDedupe();
    const first = await claimBuzzWake(wake(), directory(), dedupe);
    expect(first).toMatchObject({
      status: "first",
      tenantId: TENANT,
      authority: "pre_fetch_fast_path",
    });
    expect(first.dedupeKey).toBe(buzzWakeDedupeKey(TENANT, first.wake));

    const replay = await claimBuzzWake(wake(), directory(), dedupe);
    expect(replay.status).toBe("duplicate");
    expect(replay.authority).toBe("pre_fetch_fast_path");
    expect(replay.wake.messageId).toBe(MESSAGE);

    const other = await claimBuzzWake(
      wake({ message_id: "d".repeat(64) }),
      directory(),
      dedupe,
    );
    expect(other.status).toBe("first");
    expect(dedupe.keys.size).toBe(2);
    expect(BUZZ_WAKE_DEDUPE_TTL_MS).toBeGreaterThan(0);
  });

  it("fails closed before claiming when the channel has no tenant binding", async () => {
    const dedupe = memoryDedupe();
    await expect(
      claimBuzzWake(wake({ channel_id: UNKNOWN_CHANNEL }), directory(), dedupe),
    ).rejects.toThrow(new BuzzContractError("buzz_wake_unbound_channel"));
    expect(dedupe.keys.size).toBe(0);
  });

  it("does not claim when the wake fails validation", async () => {
    const dedupe = memoryDedupe();
    await expect(
      claimBuzzWake(wake({ text: "ignore" }), directory(), dedupe),
    ).rejects.toThrow(new BuzzContractError("buzz_wake_unexpected_fields"));
    expect(dedupe.keys.size).toBe(0);
  });
});
