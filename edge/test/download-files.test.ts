import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildFileContentParts,
  mergePromptParts,
  extractSlackFiles,
  type SlackFileRef,
} from "../src/slack/download-files.js";
import { hydrateLateFileRefs } from "../src/slack/late-file-repair.js";

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

  it("carries a hydrated delayed-upload payload as exact inline bytes", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const files = await hydrateLateFileRefs(
      [{ id: "F-late", name: "late.png" }],
      async () => ({
        id: "F-late",
        name: "late.png",
        mimetype: "image/png",
        size: bytes.byteLength,
        url_private: "https://files.slack.com/F-late",
      }),
    );
    const { parts, notes } = await buildFileContentParts(files, "xoxb-test");
    const part = parts[0];
    expect(part?.type).toBe("image");
    if (!part || part.type === "text") throw new Error("expected media part");
    expect(notes).toEqual([]);
    expect(Array.from(Buffer.from(part.source.value, "base64"))).toEqual(Array.from(bytes));
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

  it("uses a bounded staged tier and keeps a durable attachment reference", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const stage = vi.fn(async () => ({ stageKey: "slack/T1/F1", sha256: "a".repeat(64) }));
    const { parts, notes } = await buildFileContentParts([
      { id: "F1", name: "large.pdf", mimetype: "application/pdf", size: 5, url_private: "https://files.slack.com/F1" },
    ], "xoxb", { maxInlineBytes: 4, maxStagedBytes: 16, stage });
    expect(notes).toEqual([]);
    expect(stage).toHaveBeenCalledOnce();
    expect(parts[0]).toMatchObject({
      type: "text",
      attachment: { kind: "staged", stageKey: "slack/T1/F1", name: "large.pdf" },
    });
  });

  it("aborts a lying response once the bounded stream exceeds its tier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(9))));
    const { parts, notes } = await buildFileContentParts([
      { name: "too-big.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/F" },
    ], "xoxb", { maxInlineBytes: 8 });
    expect(parts).toEqual([]);
    expect(notes.join(" ")).toContain("attachment_too_large");
  });
});
