import { describe, expect, it } from "vitest";
import { normalizeSlackThread } from "../src/memory/normalize-slack-thread.js";
import type { CompleteThread, SlackThreadMessage } from "../src/slack/knowledge-thread-fetcher.js";

const context = {
  teamId: "T1",
  projectId: "P1",
  channelId: "C1",
  threadTs: "1.000001",
  aclPolicyRef: "bundle:readers",
};

function complete(messages: SlackThreadMessage[]): CompleteThread {
  return { status: "complete", messages, pages: 2, bytes: 123 };
}

describe("canonical Slack thread normalization", () => {
  it("hashes equivalent order, Unicode, whitespace, duplicates, and transient fields identically", async () => {
    const first = await normalizeSlackThread(complete([
      {
        ts: "2.000001",
        client_msg_id: "client-2",
        user: "U2",
        text: "Cafe\u0301\r\n  follow   up ",
        reactions: [{ name: "eyes", count: 4 }],
        edited: { ts: "9.0" },
      },
      {
        ts: "1.000001",
        client_msg_id: "client-1",
        user: "U1",
        text: "  Hello\tworld  ",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: " Details  here " } }],
      },
      // Pagination overlap is deterministic and does not create a second row.
      { ts: "1.000001", client_msg_id: "client-1", user: "U1", text: "Hello world" },
    ]), context);
    const second = await normalizeSlackThread(complete([
      {
        ts: "1.000001",
        client_msg_id: "different-transient-id",
        user: "U1",
        text: "Hello world",
        blocks: [{ text: { text: "Details here", type: "mrkdwn" }, type: "section" }],
        reply_count: 99,
      },
      {
        ts: "2.000001",
        client_msg_id: "client-2",
        user: "U2",
        text: "Café\nfollow up",
        reactions: [{ name: "eyes", count: 4 }],
      },
    ]), context);
    expect(first.status).toBe("complete");
    expect(second.status).toBe("complete");
    if (first.status !== "complete" || second.status !== "complete") throw new Error("expected complete");
    expect(first.revision).toBe(second.revision);
    expect(first.canonical.messages.map((message) => message.ts)).toEqual(["1.000001", "2.000001"]);
  });

  it("changes revision for permitted edits and policy-visible metadata", async () => {
    const original = await normalizeSlackThread(
      complete([{ ts: "1.000001", user: "U1", text: "original" }]),
      context,
    );
    const edited = await normalizeSlackThread(
      complete([{ ts: "1.000001", user: "U1", text: "edited" }]),
      context,
    );
    const differentPolicy = await normalizeSlackThread(
      complete([{ ts: "1.000001", user: "U1", text: "original" }]),
      { ...context, aclPolicyRef: "bundle:other" },
    );
    if (original.status !== "complete" || edited.status !== "complete" || differentPolicy.status !== "complete") {
      throw new Error("expected complete");
    }
    expect(edited.revision).not.toBe(original.revision);
    expect(differentPolicy.revision).not.toBe(original.revision);
  });

  it("retains aggregate reaction counts and changes the revision when engagement changes", async () => {
    const reacted = await normalizeSlackThread(
      complete([{ ts: "1.000001", user: "U1", text: "important", reactions: [{ name: "eyes", count: 2 }] }]),
      context,
    );
    const unreacted = await normalizeSlackThread(
      complete([{ ts: "1.000001", user: "U1", text: "important" }]),
      context,
    );
    if (reacted.status !== "complete" || unreacted.status !== "complete") {
      throw new Error("expected complete");
    }
    expect(reacted.canonical.messages[0]?.reactions).toBe(2);
    expect(reacted.content).toContain("engagement reactions:2");
    expect(reacted.revision).not.toBe(unreacted.revision);
  });

  it("passes incomplete outcomes through without content or a revision", async () => {
    const incomplete = {
      status: "incomplete" as const,
      reason: "cursor_missing" as const,
      cursor: "cursor-1",
      pages: 1,
      messages: 100,
      bytes: 5_000,
    };
    expect(await normalizeSlackThread(incomplete, context)).toEqual(incomplete);
  });

  it("indexes bot messages while marking deleted and unsupported messages", async () => {
    const normalized = await normalizeSlackThread(complete([
      { ts: "1.0", subtype: "message_deleted" },
      { ts: "2.0", subtype: "bot_message", bot_id: "B1", text: "noisy status" },
      { ts: "3.0", user: "U1", subtype: "channel_join", text: "joined" },
    ]), context);
    if (normalized.status !== "complete") throw new Error("expected complete");
    expect(normalized.canonical.messages.map((message) => message.kind))
      .toEqual(["deleted_marker", "message", "omitted_marker"]);
    expect(normalized.canonical.messages[1]).toMatchObject({
      authorId: "B1",
      authorKind: "bot",
      text: "noisy status",
    });
    expect(normalized.content).toContain("bot:B1: noisy status");
  });

  it("excludes internal action values while retaining documented display text", async () => {
    const normalized = await normalizeSlackThread(complete([{
      ts: "1.0",
      user: "U1",
      text: "root",
      blocks: [{
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Approve" }, value: "internal-secret-id" }],
      }],
    }]), context);
    if (normalized.status !== "complete") throw new Error("expected complete");
    expect(normalized.content).toContain("Approve");
    expect(normalized.content).not.toContain("internal-secret-id");
  });
});
