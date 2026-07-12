import { describe, it, expect } from "vitest";
import {
  canonicalizeFieldLabel,
  candidateFieldLines,
  coerceTicketFields,
  formatDraftContext,
  formatLastIssueContext,
  parseLabeledFields,
  parseLastCreatedIssue,
  parseTicketDraft,
} from "../src/slack/thread-memory.js";

describe("canonicalizeFieldLabel", () => {
  it("maps description typos via prefix / edit distance", () => {
    expect(canonicalizeFieldLabel("description")).toBe("description");
    expect(canonicalizeFieldLabel("descripton")).toBe("description");
    expect(canonicalizeFieldLabel("desciroption")).toBe("description");
    expect(canonicalizeFieldLabel("desc")).toBe("description");
    expect(canonicalizeFieldLabel("title")).toBe("title");
    expect(canonicalizeFieldLabel("email")).toBe("email");
  });
});

describe("parseTicketDraft", () => {
  it("extracts title, description, and email from separate lines", () => {
    const draft = parseTicketDraft([
      { text: "create a linear ticket for me" },
      { text: "title: test\ndescription: test test" },
      { text: "email: williamlopezc@gmail.com" },
      { text: "ok create the ticket" },
    ]);
    expect(draft).toEqual({
      title: "test",
      description: "test test",
      email: "williamlopezc@gmail.com",
    });
  });

  it("does not swallow description into title on one line", () => {
    expect(
      parseLabeledFields("title: test description: test test"),
    ).toEqual({
      title: "test",
      description: "test test",
    });
  });

  it("splits description typos without a colon", () => {
    expect(
      parseLabeledFields("title: test descripton test test"),
    ).toEqual({
      title: "test",
      description: "test test",
    });
  });

  it("coerceTicketFields repairs mashed model title", () => {
    expect(
      coerceTicketFields({ title: "test descripton test test" }),
    ).toEqual({
      title: "test",
      description: "test test",
    });
  });

  it("ignores bot lines", () => {
    const draft = parseTicketDraft([
      { text: "title: from-bot", isBot: true },
      { text: "title: real" },
    ]);
    expect(draft.title).toBe("real");
  });

  it("surfaces candidate lines for the agent", () => {
    const lines = [
      { text: "title: test descripton test test" },
    ];
    expect(candidateFieldLines(lines)).toEqual([lines[0]!.text]);
    expect(formatDraftContext(parseTicketDraft(lines), candidateFieldLines(lines)))
      .toContain("title = \"test\"");
  });

  it("formatDraftContext steers structured confirm_write", () => {
    const text = formatDraftContext({
      title: "t",
      description: "d",
      email: "a@b.com",
    });
    expect(text).toContain("confirm_write");
    expect(text).toContain("structured title");
  });
});

describe("parseLastCreatedIssue", () => {
  it("finds Created Linear issue BER-6", () => {
    const last = parseLastCreatedIssue([
      { text: "Created Linear issue BER-6: test description: test test", isBot: true },
      { text: "provide linear link" },
    ]);
    expect(last?.identifier).toBe("BER-6");
    expect(formatLastIssueContext(last!)).toContain("BER-6");
    expect(formatLastIssueContext(last!)).toContain("Do NOT call confirm_write");
  });
});
