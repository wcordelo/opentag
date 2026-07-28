import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCitationBase } from "../src/memory/knowledge-contract.js";
import { expandCodeWindow, expandWikiNeighbors } from "../src/memory/retrieval/context-expand.js";
import { llmRerank } from "../src/memory/retrieval/rerank.js";
import {
  unifiedKnowledgeSearch,
  type SearchListFn,
} from "../src/memory/retrieval/unified-search.js";

function citation(partial: Partial<KnowledgeCitationBase> & { excerpt: string }): KnowledgeCitationBase {
  return {
    sourceKey: partial.sourceKey ?? "slack:T1:C1:1.0",
    projectId: partial.projectId ?? "P1",
    contentRevision: partial.contentRevision ?? "sha256:abc",
    excerpt: partial.excerpt,
    aclPolicyRef: partial.aclPolicyRef ?? "bundle:readers",
    retrievedAt: partial.retrievedAt ?? "2026-07-28T00:00:00.000Z",
    score: partial.score,
    channelId: partial.channelId,
    threadTs: partial.threadTs,
  };
}

describe("llm rerank", () => {
  it("orders by LLM scores and caps at topN", async () => {
    const candidates = [
      { id: "1", excerpt: "alpha" },
      { id: "2", excerpt: "beta" },
      { id: "3", excerpt: "gamma" },
    ];
    const result = await llmRerank({
      query: "q",
      candidates,
      topN: 2,
      llm: async () => [
        { id: "3", score: 0.9 },
        { id: "1", score: 0.5 },
        { id: "2", score: 0.1 },
      ],
    });
    expect(result.map((item) => item.id)).toEqual(["3", "1"]);
  });

  it("returns original slice on LLM failure", async () => {
    const candidates = [
      { id: "1", excerpt: "a" },
      { id: "2", excerpt: "b" },
    ];
    const result = await llmRerank({
      query: "q",
      candidates,
      topN: 10,
      llm: async () => {
        throw new Error("boom");
      },
    });
    expect(result).toEqual(candidates);
  });
});

describe("unified knowledge search", () => {
  it("fans out in parallel, fuses with RRF, and returns citations", async () => {
    const calls: Array<{ query: string; limit: number; label: string }> = [];
    const listA: SearchListFn = async (query, limit) => {
      calls.push({ query, limit, label: "a" });
      return [
        { id: "doc-a", citation: citation({ excerpt: "from A", sourceKey: "a" }), score: 0.9 },
        { id: "doc-shared", citation: citation({ excerpt: "shared A", sourceKey: "shared-a" }), score: 0.5 },
      ];
    };
    const listB: SearchListFn = async (query, limit) => {
      calls.push({ query, limit, label: "b" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [
        { id: "doc-shared", citation: citation({ excerpt: "shared B", sourceKey: "shared-b" }), score: 0.95 },
        { id: "doc-b", citation: citation({ excerpt: "from B", sourceKey: "b" }), score: 0.4 },
      ];
    };

    const results = await unifiedKnowledgeSearch({
      query: "deploy",
      lists: [listA, listB],
      perListLimit: 5,
      finalLimit: 10,
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.query === "deploy" && call.limit === 5)).toBe(true);
    expect(results[0]?.excerpt).toMatch(/shared/);
    // First list's item wins on RRF dedupe.
    expect(results[0]?.sourceKey).toBe("shared-a");
    expect(results.map((item) => item.excerpt)).toEqual(
      expect.arrayContaining(["from A", "from B", "shared A"]),
    );
  });

  it("optionally reranks fused candidates", async () => {
    const list: SearchListFn = async () => [
      { id: "1", citation: citation({ excerpt: "first" }), score: 1 },
      { id: "2", citation: citation({ excerpt: "second" }), score: 0.5 },
    ];
    const rerank = vi.fn(async () => [
      { id: "2", score: 10 },
      { id: "1", score: 1 },
    ]);
    const results = await unifiedKnowledgeSearch({
      query: "q",
      lists: [list],
      rerank,
      finalLimit: 2,
    });
    expect(rerank).toHaveBeenCalledOnce();
    expect(results.map((item) => item.excerpt)).toEqual(["second", "first"]);
  });

  it("falls back to RRF order when rerank fails", async () => {
    const list: SearchListFn = async () => [
      { id: "1", citation: citation({ excerpt: "keep" }), score: 1 },
      { id: "2", citation: citation({ excerpt: "also" }), score: 0.2 },
    ];
    const results = await unifiedKnowledgeSearch({
      query: "q",
      lists: [list],
      finalLimit: 1,
      rerank: async () => {
        throw new Error("nope");
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.excerpt).toBe("keep");
  });
});

describe("context expand", () => {
  it("expands wiki neighbors within radius", () => {
    const sections = ["s0", "s1", "s2", "s3", "s4"];
    expect(expandWikiNeighbors(sections, 2, 1)).toBe("s1\n\ns2\n\ns3");
    expect(expandWikiNeighbors(sections, 0, 1)).toBe("s0\n\ns1");
    expect(expandWikiNeighbors(sections, 4, 2)).toBe("s2\n\ns3\n\ns4");
    expect(expandWikiNeighbors([], 0)).toBe("");
  });

  it("expands code windows within radius", () => {
    const lines = ["L0", "L1", "L2", "L3", "L4"];
    expect(expandCodeWindow(lines, 2, 2, 1)).toBe("L1\nL2\nL3");
    expect(expandCodeWindow(lines, 1, 2, 1)).toBe("L0\nL1\nL2\nL3");
    expect(expandCodeWindow(lines, 0, 0, 0)).toBe("L0");
    expect(expandCodeWindow([], 0, 0)).toBe("");
  });
});
