import { describe, expect, it } from "vitest";
import { slackConversationModelContext } from "../src/slack/built-in-context.js";

describe("Slack conversation context", () => {
  it("matches flexible response routing", () => {
    expect(slackConversationModelContext.value).toContain(
      "questions,",
    );
    expect(slackConversationModelContext.value).toContain(
      "A channel reply does not need an explicit bot @-mention",
    );
    expect(slackConversationModelContext.value).not.toContain(
      "Top-level channel messages also require an explicit bot @-mention.",
    );
  });
});
