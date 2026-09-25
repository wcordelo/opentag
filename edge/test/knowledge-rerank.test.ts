import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCitationBase } from "../src/memory/knowledge-contract.js";
import { createJevCandidateRerank } from "../src/memory/retrieval/jev-rerank.js";
import { parseKnowledgeRerankMode, resolveKnowledgeCandidateRerank } from "../src/memory/retrieval/knowledge-rerank.js";
import {
  unifiedKnowledgeSearch,
  type SearchListFn,
} from "../src/memory/retrieval/unified-search.js";

function citation(partial: Partial<KnowledgeCitationBase> & { excerpt: string }): KnowledgeCitationBase {
  return {
    sourceKey: partial.sourceKey ?? "slack:T1:C1:1_0",
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

describe("knowledge rerank integration", () => {
  it("keeps RRF order when KNOWLEDGE_RERANK_MODE is off", async () => {
    const list: SearchListFn = async () => [
      { id: "a", citation: citation({ excerpt: "alpha", sourceKey: "a" }), score: 1 },
      { id: "b", citation: citation({ excerpt: "beta", sourceKey: "b" }), score: 0.5 },
      { id: "c", citation: citation({ excerpt: "gamma", sourceKey: "c" }), score: 0.2 },
    ];
    const withoutRerank = await unifiedKnowledgeSearch({
      query: "deploy",
      lists: [list],
      finalLimit: 3,
    });
    const withOffFlag = await unifiedKnowledgeSearch({
      query: "deploy",
      lists: [list],
      candidateRerank: resolveKnowledgeCandidateRerank({ KNOWLEDGE_RERANK_MODE: "off" }),
      finalLimit: 3,
    });
    expect(withOffFlag.map((row) => row.sourceKey)).toEqual(withoutRerank.map((row) => row.sourceKey));
  });

  it("falls back to RRF order when Jev API fails or times out", async () => {
    const list: SearchListFn = async () => [
      { id: "first", citation: citation({ excerpt: "first hit", sourceKey: "first" }), score: 1 },
      { id: "second", citation: citation({ excerpt: "second hit", sourceKey: "second" }), score: 0.4 },
    ];
    const fetchImpl = vi.fn(async () => new Response("upstream down", { status: 503 }));
    const rerank = createJevCandidateRerank({
      apiKey: "test-key",
      mode: "jev-score",
      timeoutMs: 50,
      fetchImpl,
    });
    const results = await unifiedKnowledgeSearch({
      query: "q",
      lists: [list],
      candidateRerank: rerank,
      finalLimit: 2,
    });
    expect(results.map((row) => row.sourceKey)).toEqual(["first", "second"]);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("reorders with mocked Jev scores and never drops candidates", async () => {
    const list: SearchListFn = async () => [
      { id: "low", citation: citation({ excerpt: "low", sourceKey: "low" }), score: 1 },
      { id: "mid", citation: citation({ excerpt: "mid", sourceKey: "mid" }), score: 0.7 },
      { id: "high", citation: citation({ excerpt: "high", sourceKey: "high" }), score: 0.3 },
    ];
    const scores = new Map([
      ["low", 1],
      ["mid", 5],
      ["high", 9],
    ]);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state?: { candidate?: string } };
      const candidate = body.state?.candidate ?? "";
      const id = candidate.includes("high") ? "high" : candidate.includes("mid") ? "mid" : "low";
      const score = scores.get(id) ?? 0;
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          relevance: { type: "score", score },
        },
      });
    });
    const rerank = createJevCandidateRerank({
      apiKey: "test-key",
      mode: "jev-score",
      fetchImpl,
    });
    const results = await unifiedKnowledgeSearch({
      query: "find high",
      lists: [list],
      candidateRerank: rerank,
      finalLimit: 3,
    });
    expect(results.map((row) => row.sourceKey)).toEqual(["high", "mid", "low"]);
    expect(results).toHaveLength(3);
  });

  it("parses rerank mode flag values", () => {
    expect(parseKnowledgeRerankMode(undefined)).toBe("off");
    expect(parseKnowledgeRerankMode("jev-noul")).toBe("jev-noul");
    expect(parseKnowledgeRerankMode("bogus")).toBe("off");
  });
});
