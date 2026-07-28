import { describe, expect, it } from "vitest";
import { createIdfFn } from "../src/memory/distill/idf.js";
import {
  groupBursts,
  scoreBurst,
  selectBurstsForEmbed,
  type SlackBurstMessage,
} from "../src/memory/distill/slack-bursts.js";

function msg(authorId: string, text: string, reactions?: number): SlackBurstMessage {
  return reactions === undefined ? { authorId, text } : { authorId, text, reactions };
}

describe("slack bursts", () => {
  it("groups consecutive same-author messages", () => {
    const bursts = groupBursts([
      msg("U1", "hello"),
      msg("U1", "more"),
      msg("U2", "reply"),
      msg("U1", "again"),
    ]);
    expect(bursts).toHaveLength(3);
    expect(bursts[0]).toMatchObject({
      authorId: "U1",
      text: "hello\nmore",
      messages: [{ text: "hello" }, { text: "more" }],
    });
    expect(bursts[1]?.authorId).toBe("U2");
    expect(bursts[2]?.text).toBe("again");
  });

  it("scores bursts with unique token IDF and reaction boost", () => {
    const idf = createIdfFn({ rare: 1, common: 50 }, 100);
    const burst = groupBursts([msg("U1", "rare rare common", 3)])[0]!;
    const scored = scoreBurst(burst, idf);
    expect(scored).toBeGreaterThan(idf("rare") + idf("common"));
  });

  it("selects bursts that pass length+idf together", () => {
    const rare = "unique_token_xyz";
    const idf = (token: string) => (token === rare.toLowerCase() ? 5 : 0.5);
    const longRare = `${rare} ${"word ".repeat(40)}`.trim(); // > 200 chars with high idf
    expect(longRare.length).toBeGreaterThanOrEqual(200);

    const selected = selectBurstsForEmbed({
      messages: [
        msg("U1", longRare),
        msg("U2", "short"),
        msg("U3", `${"padding ".repeat(40)}common`), // long but low idf
      ],
      threadTopic: "deploy failures",
      corpusIdf: idf,
      minChars: 200,
      minIdf: 4,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.burst.authorId).toBe("U1");
    expect(selected[0]?.embedText.startsWith("deploy failures\n")).toBe(true);
    expect(selected[0]?.embedText).toContain(rare);
  });

  it("selects short bursts that have reactions", () => {
    const selected = selectBurstsForEmbed({
      messages: [msg("U1", "ack", 2)],
      threadTopic: "topic",
      corpusIdf: () => 0.1,
      minChars: 200,
      minIdf: 4,
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.embedText).toBe("topic\nack");
  });

  it("requireReaction still allows length+idf without reactions", () => {
    const rare = "signal_token";
    const longRare = `${rare} ${"x".repeat(200)}`;
    const selected = selectBurstsForEmbed({
      messages: [msg("U1", longRare)],
      threadTopic: "t",
      corpusIdf: (token) => (token === rare ? 9 : 0.1),
      requireReaction: true,
    });
    expect(selected).toHaveLength(1);
  });

  it("skips bursts that fail both gates", () => {
    const selected = selectBurstsForEmbed({
      messages: [msg("U1", "tiny"), msg("U2", `${"pad ".repeat(60)}`, 0)],
      threadTopic: "t",
      corpusIdf: () => 1,
      minChars: 200,
      minIdf: 4,
    });
    expect(selected).toHaveLength(0);
  });
});
