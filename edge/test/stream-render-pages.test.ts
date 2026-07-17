import { describe, expect, it } from "vitest";
import {
  buildMrkdwnBlocks,
  buildSlackMessagePages,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_BLOCK_CHARS,
  MAX_FALLBACK_CHARS,
  splitIntoSegments,
} from "../src/slack/stream-render.js";

describe("Slack mrkdwn translation", () => {
  it("translates standard Markdown before building blocks and fallbacks", () => {
    const input = [
      "# Capabilities",
      "",
      "- **Incident triage:** summarize a thread",
      "- See [the runbook](https://example.com/runbook)",
      "- Keep `**literal code**` unchanged",
    ].join("\n");
    const expected = [
      "*Capabilities*",
      "",
      "•  *Incident triage:* summarize a thread",
      "•  See <https://example.com/runbook|the runbook>",
      "•  Keep `**literal code**` unchanged",
    ].join("\n");

    const pages = buildSlackMessagePages(input);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toBe(expected);
    expect(pages[0]!.blocks.map((block) => block.text.text).join(""))
      .toBe(expected);
    expect(buildMrkdwnBlocks(input).map((block) => block.text.text).join(""))
      .toBe(expected);
  });
});

describe("lossless Slack continuation paging", () => {
  it("preserves every newline at and around the 3,000-character boundary", () => {
    const cases = [
      "\n" + "a".repeat(MAX_BLOCK_CHARS + 2),
      "a".repeat(MAX_BLOCK_CHARS - 1) + "\n" + "b",
      "a".repeat(MAX_BLOCK_CHARS) + "\n" + "b",
      "a".repeat(MAX_BLOCK_CHARS + 1) + "\n\nb",
      `${"a".repeat(MAX_BLOCK_CHARS - 2)}\n\n${"b".repeat(MAX_BLOCK_CHARS)}\n`,
    ];
    for (const input of cases) {
      const segments = splitIntoSegments(input, MAX_BLOCK_CHARS);
      expect(segments.join("")).toBe(input);
      expect(segments.every((segment) => segment.length <= MAX_BLOCK_CHARS))
        .toBe(true);
    }
  });

  it("keeps blocks and per-page fallback byte-identical across the 50-block boundary", () => {
    const fullBlockLine = `${"n".repeat(MAX_BLOCK_CHARS - 1)}\n`;
    const input = fullBlockLine.repeat(MAX_BLOCKS_PER_MESSAGE) +
      `tail\n\n${"z".repeat(MAX_BLOCK_CHARS + 7)}`;
    const pages = buildSlackMessagePages(input);

    expect(pages.length).toBe(2);
    expect(pages[0]!.blocks).toHaveLength(MAX_BLOCKS_PER_MESSAGE);
    const reconstructed = pages
      .flatMap((page) => page.blocks)
      .map((block) => block.text.text)
      .join("");
    expect(reconstructed).toBe(input);

    for (const page of pages) {
      const exactPage = page.blocks.map((block) => block.text.text).join("");
      expect(page.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
      expect(page.blocks.every(
        (block) => block.text.text.length <= MAX_BLOCK_CHARS,
      )).toBe(true);
      if (exactPage.length <= MAX_FALLBACK_CHARS) {
        expect(page.text).toBe(exactPage);
      }
    }
  });

  it("preserves huge output across deterministic <=50-block pages", () => {
    const input = "x".repeat(200_000);
    const pages = buildSlackMessagePages(input);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.index)).toEqual(
      pages.map((_, index) => index),
    );
    for (const page of pages) {
      expect(page.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
      expect(page.text.length).toBeLessThanOrEqual(MAX_FALLBACK_CHARS);
      for (const block of page.blocks) {
        expect(block.text.text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
      }
    }
    expect(
      pages.flatMap((page) => page.blocks).map((block) => block.text.text).join(""),
    ).toBe(input);
  });
});
