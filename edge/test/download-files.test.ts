import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildFileContentParts,
  contentPartsFromCanonicalAttachments,
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

  it("durably stages inline bytes and restores that canonical ref after isolate loss", async () => {
    const bytes = new Uint8Array([4, 3, 2, 1]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const stage = vi.fn(async () => ({
      stageKey: "slack-attachments/hash/plan.pdf",
      sha256: "b".repeat(64),
    }));
    const built = await buildFileContentParts([{
      id: "F-inline",
      name: "plan.pdf",
      mimetype: "application/pdf",
      size: bytes.byteLength,
      url_private: "https://files.slack.com/F-inline",
    }], "xoxb", { stage });
    expect(built.parts[0]).toMatchObject({
      type: "document",
      attachment: {
        kind: "inline",
        stageKey: "slack-attachments/hash/plan.pdf",
      },
    });

    const restored = contentPartsFromCanonicalAttachments([{
      kind: "inline",
      id: "F-inline",
      name: "plan.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      stageKey: "slack-attachments/hash/plan.pdf",
      sha256: "b".repeat(64),
    }]);
    expect(restored.notes).toEqual([]);
    expect(restored.parts[0]).toMatchObject({
      type: "text",
      attachment: {
        kind: "staged",
        stageKey: "slack-attachments/hash/plan.pdf",
      },
    });
  });

  it("fails closed when configured durable staging rejects inline bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/pdf" },
      })));
    await expect(buildFileContentParts([{
      id: "F-stage-fail",
      name: "plan.pdf",
      mimetype: "application/pdf",
      size: 3,
      url_private: "https://files.slack.test/F-stage-fail",
    }], "xoxb", {
      stage: vi.fn(async () => {
        throw new Error("r2_put_failed");
      }),
    })).rejects.toThrow(
      "attachment_staging_failed:plan.pdf:r2_put_failed",
    );
  });

  it("stages the exact bytes on a durable retry after the first R2 put fails", async () => {
    const bytes = new Uint8Array([7, 6, 5, 4, 3, 2]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const stage = vi.fn()
      .mockRejectedValueOnce(new Error("first_put_failed"))
      .mockResolvedValueOnce({
        stageKey: "slack-attachments/retry/report.pdf",
        sha256: "c".repeat(64),
      });
    const file = {
      id: "F-retry",
      name: "report.pdf",
      mimetype: "application/pdf",
      size: bytes.byteLength,
      url_private: "https://files.slack.test/F-retry",
    };
    const config = { maxInlineBytes: 4, maxStagedBytes: 16, stage };
    await expect(buildFileContentParts([file], "xoxb", config))
      .rejects.toThrow("attachment_staging_failed:report.pdf:first_put_failed");
    await expect(buildFileContentParts([file], "xoxb", config))
      .resolves.toMatchObject({
        parts: [expect.objectContaining({
          attachment: expect.objectContaining({
            kind: "staged",
            stageKey: "slack-attachments/retry/report.pdf",
          }),
        })],
      });
    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage.mock.calls[1]![0].bytes).toEqual(bytes);
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
