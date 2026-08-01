import { describe, expect, it } from "vitest";
import {
  formatRuntimeIdentity,
  projectRuntimeEvidence,
} from "../src/runtime-identity.js";

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
    expect(text).toContain("Runtime evidence: unconfirmed (source: unconfirmed)");
    expect(text).toContain("Repository-local instructions and source files are not live deployment evidence.");
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

  it("distinguishes fresh live evidence from configured evidence", () => {
    const nowMs = Date.parse("2026-08-01T20:00:00.000Z");
    expect(
      projectRuntimeEvidence({
        source: "deployment",
        environment: "production",
        release: "2026.08.01.1",
        provider: "cloudflare",
        capabilities: ["harness", "knowledge.read"],
        observedAt: "2026-08-01T19:55:00.000Z",
        nowMs,
      }),
    ).toEqual({
      source: "deployment",
      status: "live",
      environment: "production",
      release: "2026.08.01.1",
      provider: "cloudflare",
      capabilities: ["harness", "knowledge.read"],
      observedAt: "2026-08-01T19:55:00.000Z",
    });
    expect(
      projectRuntimeEvidence({
        source: "configuration",
        environment: "staging",
        observedAt: "not-live-proof",
      }),
    ).toEqual({
      source: "configuration",
      status: "configured",
      environment: "staging",
      capabilities: [],
    });
  });

  it("marks stale and invalid live evidence explicitly", () => {
    const nowMs = Date.parse("2026-08-01T20:00:00.000Z");
    expect(
      projectRuntimeEvidence({
        source: "health",
        observedAt: "2026-08-01T19:00:00.000Z",
        nowMs,
        maxAgeMs: 1_000,
      }).status,
    ).toBe("stale");
    expect(
      projectRuntimeEvidence({
        source: "deployment",
        observedAt: "not-a-date",
        nowMs,
      }).status,
    ).toBe("invalid");
    expect(
      projectRuntimeEvidence({
        source: "deployment",
        environment: "production",
      }).status,
    ).toBe("unconfirmed");
  });

  it("bounds capabilities and removes sensitive evidence", () => {
    const text = formatRuntimeIdentity({
      engine: "agui",
      harnessConnected: false,
      deployment: {
        source: "configuration",
        environment: "production token=should-not-appear",
        release: "release-1",
        capabilities: [
          "Harness.Read",
          "token-value",
          "not safe",
          ...Array.from({ length: 20 }, (_, index) => `cap-${index}`),
        ],
      },
    });
    expect(text).not.toContain("should-not-appear");
    expect(text).not.toContain("token-value");
    expect(text).toContain("Reported runtime capabilities: harness.read");
    expect(text).not.toContain("cap-12");
  });
});
