import { describe, expect, it } from "vitest";
import { formatRuntimeIdentity } from "../src/runtime-identity.js";

describe("formatRuntimeIdentity", () => {
  it("describes AG-UI without inventing a third harness product", () => {
    const text = formatRuntimeIdentity({
      engine: "agui",
      model: "gpt-5.5",
      modelSource: "deployment",
      harnessConnected: true,
    });
    expect(text).toContain("Engine this turn: AG-UI triage runtime");
    expect(text).toContain("not a coding harness");
    expect(text).toContain("Model: gpt-5.5 (source: deployment)");
    expect(text).toContain("Coding harness connected: yes");
    expect(text).toContain("OpenTag is the product");
    expect(text).toContain('Do not invent a third product called an "OpenTag Slack bot harness"');
  });

  it("describes Claude Code / Claudex / Nanocodex engines", () => {
    expect(
      formatRuntimeIdentity({
        engine: "claudecode",
        harnessConnected: true,
      }),
    ).toContain("Claude Code harness");
    expect(
      formatRuntimeIdentity({
        engine: "claudex",
        model: "gpt-5.5",
        harnessConnected: true,
      }),
    ).toContain("Claude Code harness via Claudex");
    expect(
      formatRuntimeIdentity({
        engine: "nanocodex",
        model: "gpt-5.6-sol",
        harnessConnected: true,
      }),
    ).toContain("Nanocodex coding harness");
  });
});
