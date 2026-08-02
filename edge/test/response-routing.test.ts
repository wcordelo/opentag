import { describe, expect, it } from "vitest";
import {
  classifySlackResponseRoute,
  classifySlackThreadReplyRoute,
} from "../src/slack/response-routing.js";

describe("Slack response routing", () => {
  it("responds to questions and action requests without a mention", () => {
    expect(classifySlackResponseRoute({
      source: "thread_reply",
      userText: "whats your latency?",
      hasFiles: false,
    })).toMatchObject({ decision: "respond", reason: "question" });
    expect(classifySlackResponseRoute({
      source: "thread_reply",
      userText: "please check the deploy status",
      hasFiles: false,
    })).toMatchObject({ decision: "respond", reason: "action_request" });
  });

  it("responds to operational problem reports but observes phatic noise", () => {
    expect(classifySlackResponseRoute({
      source: "thread_reply",
      userText: "I am noticing a big delay between messages",
      hasFiles: false,
    })).toMatchObject({ decision: "respond", reason: "problem_report" });
    expect(classifySlackResponseRoute({
      source: "thread_reply",
      userText: "yo",
      hasFiles: false,
    })).toMatchObject({ decision: "observe", reason: "observe_conversation" });
  });

  it("does not wake for conversational statements that contain broad trigger words", () => {
    for (const userText of [
      "I can't make standup today",
      "let me check with her real quick",
      "please don't touch that",
      "```\nthrow new Error('timeout')\n```",
    ]) {
      expect(classifySlackResponseRoute({
        source: "thread_reply",
        userText,
        hasFiles: false,
      })).toMatchObject({ decision: "observe", reason: "observe_conversation" });
    }
  });

  it("keeps intent-bearing action and problem language eligible", () => {
    for (const userText of [
      "Please check the deploy status",
      "I'm noticing a big delay between messages",
      "I cannot access the deploy dashboard",
    ]) {
      expect(classifySlackResponseRoute({
        source: "thread_reply",
        userText,
        hasFiles: false,
      })).toMatchObject({ decision: "respond" });
    }
  });

  it("keeps direct messages, explicit mentions, and file continuations eligible", () => {
    for (const source of ["direct_message", "app_mention", "trusted_rich_mention"] as const) {
      expect(classifySlackResponseRoute({
        source,
        userText: "thanks",
        hasFiles: false,
      }).decision).toBe("respond");
    }
    expect(classifySlackResponseRoute({
      source: "thread_reply",
      userText: "",
      hasFiles: true,
    })).toMatchObject({ decision: "respond", reason: "file_share" });
  });

  it("shares one route contract for thread-reply callers", () => {
    for (const input of [
      { userText: "what is the deploy status?", hasFiles: false },
      { userText: "yo", hasFiles: false },
      { userText: "I cannot access the dashboard", hasFiles: false },
      { userText: "", hasFiles: true },
    ]) {
      expect(classifySlackThreadReplyRoute(input)).toEqual(
        classifySlackResponseRoute({ source: "thread_reply", ...input }),
      );
    }
  });
});
