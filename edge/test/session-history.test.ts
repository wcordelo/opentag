import { describe, expect, it } from "vitest";
import {
  normalizeSlackHistoryMessage,
  reconstructSessionHistory,
  slackDisplayText,
} from "../src/slack/session-history.js";

describe("canonical session history", () => {
  it("restores block-only text and prior attachment references", () => {
    const raw = {
      ts: "1.2",
      user: "U1",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Compare this" } }],
      files: [{ id: "F1", name: "plan.pdf", mimetype: "application/pdf", size: 42 }],
    };
    expect(slackDisplayText(raw)).toContain("Compare this");
    const normalized = normalizeSlackHistoryMessage(raw);
    expect(normalized.text).toContain("[Attachment: plan.pdf (application/pdf)]");
    expect(normalized.attachments).toEqual([
      { id: "F1", name: "plan.pdf", mimetype: "application/pdf", size: 42 },
    ]);
  });

  it("reconstructs ordered turns while excluding the active execution", () => {
    const events = [
      { id: 1, executionId: "old", kind: "input", payload: "question", createdAt: 1 },
      { id: 2, executionId: "old", kind: "output", payload: { text: "answer" }, createdAt: 2 },
      { id: 3, executionId: "current", kind: "input", payload: "latest", createdAt: 3 },
    ];
    expect(reconstructSessionHistory(events, "current")).toEqual([
      { role: "user", text: "question" },
      { role: "bot", text: "answer" },
    ]);
  });

  it("reconstructs structured attachment refs and useful tool summaries", () => {
    const events = [
      {
        id: 1,
        executionId: "old",
        kind: "input",
        payload: JSON.stringify({
          type: "opentag_input_v1",
          text: "compare the plan",
          attachments: [{
            kind: "staged",
            id: "F1",
            name: "plan.pdf",
            mimeType: "application/pdf",
            size: 9_000_000,
            stageKey: "slack-attachments/abc/plan.pdf",
            sha256: "abc",
          }],
        }),
        createdAt: 1,
      },
      {
        id: 2,
        executionId: "old",
        kind: "output",
        payload: { tool: "read_thread", summary: "Found the prior decision" },
        createdAt: 2,
      },
    ];
    expect(reconstructSessionHistory(events)).toEqual([
      {
        role: "user",
        text: "compare the plan",
        attachments: [{
          kind: "staged",
          id: "F1",
          name: "plan.pdf",
          mimeType: "application/pdf",
          size: 9_000_000,
          stageKey: "slack-attachments/abc/plan.pdf",
          sha256: "abc",
        }],
      },
      { role: "bot", text: "[Tool read_thread: Found the prior decision]" },
    ]);
  });
});
