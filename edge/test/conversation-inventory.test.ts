import { describe, expect, it } from "vitest";
import {
  enumerateSlackConversations,
  type SlackConversationInventoryReceipt,
} from "../src/slack/conversation-inventory.js";
import { SlackApiError } from "../src/slack/web-api.js";

describe("Slack conversation inventory", () => {
  it("classifies every server-visible conversation and produces a stable receipt", async () => {
    const calls: Array<string | undefined> = [];
    const client = {
      listConversations: async ({ cursor }: { cursor?: string } = {}) => {
        calls.push(cursor);
        return cursor
          ? {
              conversations: [
                { id: "G1", isMember: false, isMpim: true },
                { id: "C2", isMember: true, isArchived: true, isIm: false, isMpim: false },
              ],
            }
          : {
              conversations: [
                { id: "C1", isMember: true, isIm: false, isMpim: false },
                { id: "D1", isMember: true, isIm: true },
              ],
              nextCursor: "next",
            };
      },
    };

    const receipt = await enumerateSlackConversations(client);
    expect(receipt).toMatchObject({
      status: "complete",
      pages: 2,
      visibleCount: 4,
      eligibleCount: 2,
      eligibleConversationIds: ["C1", "D1"],
      excludedCount: 2,
      excluded: [
        { conversationId: "C2", reason: "archived" },
        { conversationId: "G1", reason: "bot_not_member" },
      ],
    });
    expect(receipt.inventoryDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(calls).toEqual([undefined, "next"]);
  });

  it("returns an incomplete receipt instead of silently truncating pagination", async () => {
    const receipt = await enumerateSlackConversations(
      {
        listConversations: async () => ({
          conversations: [{ id: "C1", isMember: true, isIm: false, isMpim: false }],
          nextCursor: "more",
        }),
      },
      { pageSize: 1, maxPages: 1, maxVisibleConversations: 10 },
    );
    expect(receipt).toMatchObject({
      status: "incomplete",
      incompleteReason: "page_limit",
      eligibleConversationIds: ["C1"],
    });
  });

  it("records bounded API failure evidence without exposing a response body", async () => {
    const receipt: SlackConversationInventoryReceipt = await enumerateSlackConversations({
      listConversations: async () => {
        throw new SlackApiError("conversations.list", "missing_scope");
      },
    });
    expect(receipt).toMatchObject({
      status: "incomplete",
      incompleteReason: "api_error",
      errorCode: "missing_scope",
      pages: 0,
      visibleCount: 0,
    });
    expect(JSON.stringify(receipt)).not.toContain("response body");
  });
});
