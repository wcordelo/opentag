import { describe, expect, it } from "vitest";
import {
  distillSlackThread,
  embedTextFromArtifact,
  parseSlackDistillArtifact,
} from "../src/memory/distill/slack-distill.js";

describe("slack distill", () => {
  it("parses LLM JSON and builds embedText from artifact fields", async () => {
    const artifact = {
      question: "Why is deploy failing?",
      summary: "Missing env var in Worker.",
      resolution: "Added SECRET to wrangler.",
      systems: ["wrangler", "cloudflare"],
      code_refs: ["edge/wrangler.toml"],
    };
    const result = await distillSlackThread({
      transcript: "raw thread text that should not be used on ok",
      llm: async () => JSON.stringify(artifact),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.artifact).toEqual(artifact);
    expect(result.embedText).toBe(embedTextFromArtifact(artifact));
    expect(result.embedText).toContain("Why is deploy failing?");
    expect(result.embedText).toContain("wrangler, cloudflare");
    expect(result.embedText).toContain("edge/wrangler.toml");
  });

  it("strips markdown fences when parsing", () => {
    const artifact = parseSlackDistillArtifact(`\`\`\`json
{"question":"q","summary":"s","resolution":"r","systems":[],"code_refs":[]}
\`\`\``);
    expect(artifact.question).toBe("q");
  });

  it("fails closed to raw transcript on parse error", async () => {
    const transcript = "original transcript body";
    const result = await distillSlackThread({
      transcript,
      llm: async () => "not-json",
    });
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toMatch(/JSON|Unexpected|position/i);
    expect(result.embedText).toBe(transcript);
  });

  it("fails closed to raw transcript on timeout", async () => {
    const transcript = "slow thread";
    const result = await distillSlackThread({
      transcript,
      timeoutMs: 20,
      llm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return JSON.stringify({
          question: "q",
          summary: "s",
          resolution: "r",
          systems: [],
          code_refs: [],
        });
      },
    });
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toMatch(/timed out/i);
    expect(result.embedText).toBe(transcript);
  });

  it("fails closed when LLM rejects", async () => {
    const transcript = "boom";
    const result = await distillSlackThread({
      transcript,
      llm: async () => {
        throw new Error("provider down");
      },
    });
    expect(result).toMatchObject({
      status: "skipped",
      reason: "provider down",
      embedText: transcript,
    });
  });

  it("rejects artifacts missing required fields", async () => {
    const result = await distillSlackThread({
      transcript: "t",
      llm: async () => JSON.stringify({ question: "q", summary: "s" }),
    });
    expect(result.status).toBe("skipped");
  });
});
