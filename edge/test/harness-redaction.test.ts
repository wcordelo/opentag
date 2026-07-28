import { describe, expect, it } from "vitest";
import {
  MAX_REDACTION_DEPTH,
  REDACTION_MARKER,
  redactString,
  sanitizeValue,
  malformedNdjsonDigest,
} from "../src/harness/redaction.js";

describe("harness redaction", () => {
  it("redacts bearer, slack, anthropic, openai, github, and sandbox tokens", () => {
    const input = [
      "Authorization: Bearer abcdefghijklmnop",
      "token xoxb-1234567890-abcdefghij",
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "openai sk-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz1234",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "sbx1.abcdefghijklmnop",
    ].join("\n");
    const { text, replacementCount, categories } = redactString(input);
    expect(text).not.toMatch(/Bearer abc|xoxb-|sk-ant-|sk-abcdefgh|ghp_|github_pat_|sbx1\./);
    expect(text.split(REDACTION_MARKER).length).toBeGreaterThan(5);
    expect(replacementCount).toBeGreaterThanOrEqual(6);
    expect(categories).toEqual(
      expect.arrayContaining([
        "bearer",
        "slack_token",
        "anthropic_key",
        "openai_key",
        "github_token",
        "sandbox_token",
      ]),
    );
  });

  it("redacts sensitive environment assignments without rewriting ordinary prose", () => {
    const { text } = redactString(
      'API_KEY=supersecretvalue TOKEN="tok" risk-adjusted returns look fine',
    );
    expect(text).toContain(REDACTION_MARKER);
    expect(text).toContain("risk-adjusted");
    expect(text).not.toContain("supersecretvalue");
  });

  it("preserves short sk- words and ordinary GitHub prose", () => {
    const { text, replacementCount } = redactString(
      "The sk-risk case and GitHub PR #12 are fine",
    );
    expect(text).toBe("The sk-risk case and GitHub PR #12 are fine");
    expect(replacementCount).toBe(0);
  });

  it("redacts exact configured secrets", () => {
    const { text } = redactString("leak my-real-secret-value here", [
      "my-real-secret-value",
    ]);
    expect(text).toBe(`leak ${REDACTION_MARKER} here`);
  });

  it("sanitizes nested arrays and objects without shape changes", () => {
    const result = sanitizeValue({
      text: "Bearer secrettokenvalue123",
      nested: [{ msg: "xoxb-1234567890-abcdefghij" }, 1, true, null],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      text: expect.stringContaining(REDACTION_MARKER),
      nested: [expect.objectContaining({ msg: expect.stringContaining(REDACTION_MARKER) }), 1, true, null],
    });
  });

  it("fails closed on deep structures", () => {
    let deep: unknown = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < MAX_REDACTION_DEPTH + 2; i += 1) deep = { deep };
    const result = sanitizeValue(deep);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("depth_exceeded");
  });

  it("fails closed on oversized node graphs", () => {
    const arr = Array.from({ length: 10_001 }, () => "ok");
    const result = sanitizeValue(arr);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("node_limit_exceeded");
  });

  it("malformed diagnostics expose only length, digest, and reason", async () => {
    const dig = await malformedNdjsonDigest('{"kind":"output","payload":{"text":"xoxb-secret"}}');
    expect(dig.reason).toBe("malformed_ndjson");
    expect(dig.byteLength).toBeGreaterThan(10);
    expect(dig.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(dig)).not.toContain("xoxb");
  });
});
