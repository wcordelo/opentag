import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildFileContentParts,
  mergePromptParts,
  extractSlackFiles,
  type SlackFileRef,
} from "../src/slack/download-files.js";

afterEach(() => vi.unstubAllGlobals());

describe("download-files", () => {
  it("extractSlackFiles keeps objects with url_private", () => {
    expect(
      extractSlackFiles({
        files: [
          { name: "a.png", url_private: "https://files.slack.com/a" },
          { name: "no-url" },
        ],
      }),
    ).toHaveLength(1);
  });

  it("turns an image into a base64 image part", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      })),
    );
    const img: SlackFileRef = {
      name: "shot.png",
      mimetype: "image/png",
      url_private: "https://files.slack.com/shot.png",
    };
    const { parts, notes } = await buildFileContentParts([img], "xoxb-tok");
    expect(notes).toEqual([]);
    expect(parts[0]).toMatchObject({
      type: "image",
      source: { type: "data", mimeType: "image/png" },
    });
  });

  it("mergePromptParts prepends user text", () => {
    const merged = mergePromptParts(
      "look at this",
      [{ type: "text", text: "Attached file…" }],
      [],
    );
    expect(Array.isArray(merged)).toBe(true);
    expect((merged as { type: string; text: string }[])[0]!.text).toBe(
      "look at this",
    );
  });
});
