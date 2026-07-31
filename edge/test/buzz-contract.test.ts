import { describe, expect, it } from "vitest";
import {
  BuzzContractError,
  buzzConversationKey,
  canonicalInternalTenantId,
  normalizeBuzzInboundEvent,
} from "../src/buzz/contract.js";

const CHANNEL = "80d210c7-6cf2-49b3-8dab-06cbee389c04";
const ROOT = "a".repeat(64);
const EVENT = "b".repeat(64);
const PARENT = "c".repeat(64);
const AUTHOR = "d".repeat(64);
const MENTION = "e".repeat(64);
const TENANT = canonicalInternalTenantId("11111111-1111-4111-8111-111111111111");

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT,
    pubkey: AUTHOR,
    created_at: 1_785_424_252,
    kind: 9,
    content: "hello from the contract test",
    tags: [
      ["h", CHANNEL],
      ["e", ROOT, "", "root"],
      ["e", PARENT, "", "reply"],
      ["p", MENTION],
    ],
    ...overrides,
  };
}

describe("Buzz M1 text contract", () => {
  it("normalizes a verified threaded text event with a deterministic partition key", () => {
    const inbound = normalizeBuzzInboundEvent(message(), CHANNEL);
    expect(inbound).toEqual({
      eventId: EVENT,
      authorPubkey: AUTHOR,
      createdAt: 1_785_424_252,
      channelId: CHANNEL,
      content: "hello from the contract test",
      rootEventId: ROOT,
      parentEventId: PARENT,
      mentionPubkeys: [MENTION],
    });
    expect(buzzConversationKey(TENANT, inbound)).toBe(
      `buzz:v1:36:${TENANT}36:${CHANNEL}64:${ROOT}`,
    );
  });

  it("uses a top-level event as its own thread root", () => {
    const inbound = normalizeBuzzInboundEvent(message({ tags: [["h", CHANNEL]] }), CHANNEL);
    expect(inbound.rootEventId).toBe(EVENT);
    expect(inbound.parentEventId).toBeUndefined();
  });

  it.each([
    ["wrong channel", message({ tags: [["h", "00000000-0000-0000-0000-000000000000"]] }), "buzz_channel_binding_mismatch"],
    ["attachments", message({ tags: [["h", CHANNEL], ["imeta", "url https://example.invalid/file"]] }), "buzz_attachments_disabled"],
    ["wrong kind", message({ kind: 1 }), "buzz_unsupported_kind"],
    ["invalid author", message({ pubkey: "not-a-pubkey" }), "buzz_invalid_author_pubkey"],
    ["invalid reply id", message({ tags: [["h", CHANNEL], ["e", "bad", "", "reply"]] }), "buzz_invalid_reply_event_id"],
    ["ambiguous replies", message({ tags: [["h", CHANNEL], ["e", ROOT, "", "reply"], ["e", PARENT, "", "reply"]] }), "buzz_ambiguous_thread_reference"],
    ["ambiguous root markers", message({ tags: [["h", CHANNEL], ["e", ROOT, "", "root"], ["e", PARENT]] }), "buzz_ambiguous_thread_reference"],
    ["unknown thread marker", message({ tags: [["h", CHANNEL], ["e", ROOT, "", "mention"]] }), "buzz_unsupported_thread_marker"],
    ["invalid mention", message({ tags: [["h", CHANNEL], ["p", "bad"]] }), "buzz_invalid_mention_pubkey"],
    ["too many raw mentions", message({ tags: [["h", CHANNEL], ...Array.from({ length: 51 }, () => ["p", MENTION])] }), "buzz_too_many_mentions"],
    ["whitespace-only text", message({ content: " \n\t " }), "buzz_invalid_content"],
    ["malformed tag", message({ tags: ["not-an-array"] }), "buzz_invalid_tag_shape"],
    ["too many tags", message({ tags: Array.from({ length: 129 }, () => ["x", "1"]) }), "buzz_invalid_tags"],
  ])("fails closed for %s", (_label, raw, code) => {
    expect(() => normalizeBuzzInboundEvent(raw as never, CHANNEL)).toThrow(
      new BuzzContractError(code),
    );
  });

  it("deduplicates mention recipients and rejects a foreign partition root", () => {
    const inbound = normalizeBuzzInboundEvent(message({
      tags: [["h", CHANNEL], ["p", MENTION], ["p", MENTION]],
    }), CHANNEL);
    expect(inbound.mentionPubkeys).toEqual([MENTION]);
    expect(() => buzzConversationKey(TENANT, { ...inbound, rootEventId: "bad" }))
      .toThrow(new BuzzContractError("buzz_invalid_root_event_id"));
  });

  it("requires canonical internal tenants and preserves unambiguous key boundaries", () => {
    expect(() => canonicalInternalTenantId("tenant:one"))
      .toThrow(new BuzzContractError("buzz_invalid_internal_tenant"));
    expect(() => canonicalInternalTenantId("１１１１１１１１-１１１１-４１１１-８１１１-１１１１１１１１１１１１"))
      .toThrow(new BuzzContractError("buzz_invalid_internal_tenant"));
    const inbound = normalizeBuzzInboundEvent(message(), CHANNEL);
    const otherTenant = canonicalInternalTenantId("22222222-2222-4222-8222-222222222222");
    expect(buzzConversationKey(TENANT, inbound)).not.toBe(buzzConversationKey(otherTenant, inbound));
  });
});
