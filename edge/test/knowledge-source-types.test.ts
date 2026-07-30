import { describe, expect, it } from "vitest";
import {
  codeSourceKey,
  customDbSourceKey,
  parseKnowledgeSourceType,
  parseSourceTypeFromKey,
  wikiSourceKey,
} from "../src/memory/knowledge-source-types.js";
import { slackSourceKey } from "../src/memory/knowledge-contract.js";
import { CONNECTOR_REGISTRY } from "../src/memory/knowledge-connector.js";

describe("knowledge source types (K2)", () => {
  it("parses only the four sourceType values", () => {
    expect(parseKnowledgeSourceType("slack")).toBe("slack");
    expect(parseKnowledgeSourceType("wiki")).toBe("wiki");
    expect(parseKnowledgeSourceType("code")).toBe("code");
    expect(parseKnowledgeSourceType("custom_db")).toBe("custom_db");
    for (const bad of ["Slack", "notion", "", null, 1, undefined]) {
      expect(() => parseKnowledgeSourceType(bad)).toThrow("sourceType");
    }
  });

  it("builds wiki/code/custom_db source keys with Slack-consistent validation", () => {
    expect(wikiSourceKey("T1", "S1", "page-1")).toBe("wiki:T1:S1:page-1");
    expect(codeSourceKey("T1", "repo1", "chunk.0")).toBe("code:T1:repo1:chunk.0");
    expect(customDbSourceKey("T1", "conn1", "row-9")).toBe("custom_db:T1:conn1:row-9");
    expect(slackSourceKey("T1", "C1", "171234.000100")).toBe("slack:T1:C1:171234_000100");

    expect(() => wikiSourceKey("T1:x", "S1", "p")).toThrow("safe identifier");
    expect(() => codeSourceKey("T1", "repo:1", "c")).toThrow("safe identifier");
    expect(() => customDbSourceKey("T1", "c", "row\u0000")).toThrow("safe source component");
    expect(() => wikiSourceKey("", "S1", "p")).toThrow("safe identifier");
  });

  it("derives sourceType from sourceKey prefixes including custom_db", () => {
    expect(parseSourceTypeFromKey("slack:T1:C1:1_0")).toBe("slack");
    expect(parseSourceTypeFromKey("wiki:T1:S1:p")).toBe("wiki");
    expect(parseSourceTypeFromKey("code:T1:r:c")).toBe("code");
    expect(parseSourceTypeFromKey("custom_db:T1:conn:row")).toBe("custom_db");
    expect(() => parseSourceTypeFromKey("")).toThrow("sourceKey");
    expect(() => parseSourceTypeFromKey("notion:T1:x")).toThrow("sourceType");
    expect(() => parseSourceTypeFromKey("nosep")).toThrow("sourceType prefix");
  });

  it("marks wiki/code/custom_db connectors implemented in Phase 2", () => {
    expect(CONNECTOR_REGISTRY.wiki?.implemented).toBe(true);
    expect(CONNECTOR_REGISTRY.code?.implemented).toBe(true);
    expect(CONNECTOR_REGISTRY.custom_db?.implemented).toBe(true);
  });
});
