import { describe, expect, it } from "vitest";
import {
  harnessModelAllowed,
  resolveHarnessCapabilityProfile,
} from "../src/harness/capability-profile.js";

describe("harness capability profiles", () => {
  it("keeps model compatibility explicit", () => {
    expect(harnessModelAllowed("nanocodex", "gpt-5.6-sol")).toBe(true);
    expect(harnessModelAllowed("nanocodex", "claude-sonnet-5")).toBe(false);
    expect(harnessModelAllowed("claudecode", "claude-sonnet-5")).toBe(true);
    expect(harnessModelAllowed("claudecode", "gpt-5.6-sol")).toBe(false);
  });

  it("distinguishes the native adapter from the CLI harness", () => {
    expect(resolveHarnessCapabilityProfile({
      harnessType: "nanocodex",
      model: "gpt-5.6-sol",
      nativeResponses: true,
      source: "provider_reported",
    })).toMatchObject({
      mode: "native_responses",
      provider: "openai",
      source: "provider_reported",
      capabilities: {
        toolCalls: false,
        fullHistoryReplay: true,
        codingWorkspace: false,
      },
    });
  });
});
