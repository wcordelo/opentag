import { describe, expect, it } from "vitest";
import {
  buildSlackMessagePages,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_BLOCK_CHARS,
  MAX_FALLBACK_CHARS,
} from "../src/slack/stream-render.js";

describe("lossless Slack continuation paging", () => {
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
