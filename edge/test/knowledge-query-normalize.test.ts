import { describe, expect, it } from "vitest";
import {
  expandKnowledgeSearchQuery,
  tokenizeForLexicalSearch,
} from "../src/memory/retrieval/knowledge-query-normalize.js";

describe("knowledge query normalization", () => {
  it("splits camelCase identifiers for hybrid search expansion", () => {
    const expanded = expandKnowledgeSearchQuery("KnowledgeCitationBase contentRevision");
    expect(expanded).toContain("KnowledgeCitationBase");
    expect(expanded).toContain("Knowledge Citation Base");
    expect(tokenizeForLexicalSearch("KnowledgeCitationBase")).toContain("citation");
  });

  it("keeps single-digit numerals for lexical scoring", () => {
    expect(tokenizeForLexicalSearch("schema 0 to 10")).toContain("0");
    expect(tokenizeForLexicalSearch("schema 0 to 10")).toContain("10");
  });
});
