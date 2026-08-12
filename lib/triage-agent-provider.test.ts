import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  resolveTriageAgentProvider,
} from "./triage-agent.js";

describe("triage model provider configuration", () => {
  it("defaults to DeepSeek V4 Flash when its key is available", () => {
    expect(resolveTriageAgentProvider({ DEEPSEEK_API_KEY: "test-key" })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com/",
    });
  });

  it("normalizes an explicitly configured DeepSeek model", () => {
    expect(resolveTriageAgentProvider({
      AGENT_PROVIDER: "deepseek",
      AGENT_BASE_URL: "https://deepseek.example/",
      AGENT_MODEL: "deepseek/deepseek-v4-flash",
      DEEPSEEK_API_KEY: "test-key",
    })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://deepseek.example/",
    });
  });

  it("preserves the OpenAI provider as an explicit rollback path", () => {
    expect(resolveTriageAgentProvider({
      AGENT_PROVIDER: "openai",
      AGENT_MODEL: "openai/gpt-5.5",
      DEEPSEEK_API_KEY: "test-key",
    })).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("rejects an incompatible provider/model pairing", () => {
    expect(() => resolveTriageAgentProvider({
      AGENT_PROVIDER: "deepseek",
      AGENT_MODEL: "gpt-5.5",
    })).toThrow("incompatible with DeepSeek");
  });

  it("identifies the configured provider in the system prompt", () => {
    expect(buildSystemPrompt({
      AGENT_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
    })).toContain('running DeepSeek model "deepseek-v4-flash"');
  });
});
