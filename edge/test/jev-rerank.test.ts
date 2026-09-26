import { describe, expect, it, vi } from "vitest";
import {
  JEV_EXCERPT_TRUNCATION_MARKER,
  truncateJevExcerpt,
} from "../src/memory/retrieval/jev-questions.js";
import {
  createJevCandidateRerank,
  scoreJevCandidate,
} from "../src/memory/retrieval/jev-rerank.js";

function candidate(id: string, excerpt: string) {
  return { id, excerpt };
}

describe("jev excerpt truncation", () => {
  it("truncates oversize excerpts at a line boundary and marks the cut", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index}:${"x".repeat(80)}`);
    const excerpt = lines.join("\n");
    const truncated = truncateJevExcerpt(excerpt, 500);

    expect(truncated.length).toBeLessThanOrEqual(500);
    expect(truncated).toContain(JEV_EXCERPT_TRUNCATION_MARKER);
    expect(truncated.endsWith(JEV_EXCERPT_TRUNCATION_MARKER)).toBe(true);
  });

  it("sends truncated excerpt to Jev, not the full oversize body", async () => {
    const longExcerpt = `${"A".repeat(20_000)}\nfinal-line`;
    const fetchImpl = vi.fn(async () => Response.json({
      model: "jev-1.13.0",
      answers: { relevance: { type: "score", score: 5 } },
    }));

    await scoreJevCandidate({
      apiKey: "test-key",
      mode: "jev-score",
      model: "jev-latest",
      query: "query",
      excerpt: longExcerpt,
      maxExcerptChars: 1_000,
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const firstCall = fetchImpl.mock.calls[0] as [unknown, { body?: string }] | undefined;
    const body = JSON.parse(String(firstCall?.[1]?.body)) as {
      state?: { candidate?: string };
    };
    expect(body.state?.candidate?.length).toBeLessThanOrEqual(1_000);
    expect(body.state?.candidate).toContain("[... excerpt truncated for rerank ...]");
    expect(body.state?.candidate).not.toContain("final-line");
  });
});

describe("jev rerank resilience", () => {
  it("keeps reranking other candidates when one Jev call fails", async () => {
    const candidates = [
      candidate("rrf-1", "first excerpt"),
      candidate("rrf-2", "second excerpt"),
      candidate("rrf-3", "third excerpt"),
    ];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state?: { candidate?: string } };
      const excerpt = body.state?.candidate ?? "";
      if (excerpt.includes("second")) {
        return new Response("max_tokens_exceeded", { status: 400 });
      }
      const score = excerpt.includes("third") ? 9 : 1;
      return Response.json({
        model: "jev-1.13.0",
        answers: { relevance: { type: "score", score } },
      });
    }) as typeof fetch;

    const rerank = createJevCandidateRerank({
      apiKey: "test-key",
      mode: "jev-score",
      fetchImpl,
    });
    const ordered = await rerank({
      query: "find third",
      candidates,
      topN: 3,
    });

    expect(ordered.map((row) => row.id)).toEqual(["rrf-3", "rrf-1", "rrf-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("only reranks the top-N window and preserves RRF tail order", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) =>
      candidate(`c-${index}`, `excerpt-${index}`));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state?: { candidate?: string } };
      const excerpt = body.state?.candidate ?? "";
      const index = Number.parseInt(excerpt.replace("excerpt-", ""), 10);
      const score = index === 0 ? 1 : index === 1 ? 9 : 5;
      return Response.json({
        model: "jev-1.13.0",
        answers: { relevance: { type: "score", score } },
      });
    }) as typeof fetch;

    const rerank = createJevCandidateRerank({
      apiKey: "test-key",
      mode: "jev-score",
      rerankTopN: 5,
      maxCandidates: 25,
      fetchImpl,
    });
    const ordered = await rerank({
      query: "q",
      candidates,
      topN: 10,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(ordered.slice(0, 5).map((row) => row.id)).toEqual([
      "c-1",
      "c-2",
      "c-3",
      "c-4",
      "c-0",
    ]);
    expect(ordered.slice(5, 10).map((row) => row.id)).toEqual([
      "c-5",
      "c-6",
      "c-7",
      "c-8",
      "c-9",
    ]);
  });

  it("falls back to full RRF order when every Jev call in the window fails", async () => {
    const candidates = [
      candidate("a", "alpha"),
      candidate("b", "beta"),
      candidate("c", "gamma"),
    ];
    const fetchImpl = vi.fn(async () => new Response("upstream down", { status: 503 }));
    const rerank = createJevCandidateRerank({
      apiKey: "test-key",
      mode: "jev-score",
      fetchImpl,
    });
    const ordered = await rerank({
      query: "q",
      candidates,
      topN: 3,
    });
    expect(ordered.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});
