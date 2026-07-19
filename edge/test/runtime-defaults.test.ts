import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
import {
  normalizeChannelRuntimeDefaults,
} from "../src/config/access-bundle.js";
import { parseRuntimeCommand } from "../src/commands/index.js";

describe("channel runtime defaults", () => {
  it("accepts Claudex with a GPT model", () => {
    expect(normalizeChannelRuntimeDefaults({
      harnessType: "claudex",
      model: "gpt-5.6-sol",
    })).toEqual({ harnessType: "claudex", model: "gpt-5.6-sol" });
  });

  it("normalizes the supported harness and model aliases", () => {
    expect(normalizeChannelRuntimeDefaults({
      harnessType: "claude-code",
      model: "opus",
    })).toEqual({
      harnessType: "claudecode",
      model: "claude-opus-4-8",
    });
  });

  it.each([
    [{ harnessType: "codex" }, /unsupported channel harness/],
    [{ model: "claude-sonnet-5" }, /requires harnessType/],
    [{ harnessType: "claudecode", model: "bad model" }, /invalid channel model/],
    [{ harnessType: "claudecode", reasoning: "high" }, /unknown runtimeDefaults field/],
    [{ harnessType: "claudex", model: "claude-opus-4-8" }, /Claudex requires a GPT model/],
    [{ harnessType: "claudecode", model: "gpt-5.6-sol" }, /Claude Code requires a Claude model/],
  ])("rejects invalid configuration atomically", (value, error) => {
    expect(() => normalizeChannelRuntimeDefaults(value)).toThrow(error);
  });

  it("routes only exact runtime show/set/clear prefixes", () => {
    expect(parseRuntimeCommand("runtime show")).toEqual({ kind: "show" });
    expect(parseRuntimeCommand("runtime clear")).toEqual({ kind: "clear" });
    expect(parseRuntimeCommand(
      "runtime set --harness claude-code --model sonnet",
    )).toEqual({
      kind: "set",
      value: { harnessType: "claude-code", model: "sonnet" },
    });
    expect(parseRuntimeCommand("runtime guidance for this channel")).toBeUndefined();
    expect(() => parseRuntimeCommand("runtime show extra")).toThrow(
      "Usage: /config runtime show",
    );
  });
});
