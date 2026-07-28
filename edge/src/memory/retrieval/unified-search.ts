/** Parallel multi-list search fused with RRF and optional LLM rerank. */

import type { KnowledgeCitationBase } from "../knowledge-contract.js";
import { llmRerank, type RerankLlm } from "./rerank.js";
import { reciprocalRankFusion, type RankedItem } from "./rrf.js";

export type SearchListHit = {
  id: string;
  citation: KnowledgeCitationBase;
  score?: number;
};

export type SearchListFn = (
  query: string,
  limit: number,
) => Promise<SearchListHit[]>;

type RerankCandidate = KnowledgeCitationBase & { id: string; excerpt: string };

const DEFAULT_PER_LIST_LIMIT = 10;
const DEFAULT_FINAL_LIMIT = 10;
const DEFAULT_RRF_K = 60;

function toRankedList(hits: SearchListHit[]): RankedItem<SearchListHit>[] {
  // Prefer explicit scores when present; otherwise preserve list order.
  const ordered = hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => {
      const leftScore = left.hit.score;
      const rightScore = right.hit.score;
      const leftHas = typeof leftScore === "number" && Number.isFinite(leftScore);
      const rightHas = typeof rightScore === "number" && Number.isFinite(rightScore);
      if (leftHas && rightHas && leftScore !== rightScore) {
        return (rightScore as number) - (leftScore as number);
      }
      if (leftHas !== rightHas) return leftHas ? -1 : 1;
      return left.index - right.index;
    });

  return ordered.map((entry, index) => ({
    id: entry.hit.id,
    item: entry.hit,
    rank: index + 1,
  }));
}

/**
 * Fan out `query` across `lists` in parallel, fuse with RRF, optionally rerank,
 * and return citation bases capped at `finalLimit`.
 */
export async function unifiedKnowledgeSearch(input: {
  query: string;
  lists: SearchListFn[];
  perListLimit?: number;
  rrfK?: number;
  rerank?: RerankLlm;
  finalLimit?: number;
}): Promise<KnowledgeCitationBase[]> {
  const perListLimit = input.perListLimit ?? DEFAULT_PER_LIST_LIMIT;
  const finalLimit = input.finalLimit ?? DEFAULT_FINAL_LIMIT;
  const rrfK = input.rrfK ?? DEFAULT_RRF_K;

  if (!input.query) return [];
  if (!Array.isArray(input.lists) || input.lists.length === 0) return [];

  const listResults = await Promise.all(
    input.lists.map((list) => list(input.query, perListLimit)),
  );
  const rankedLists = listResults.map((hits) => toRankedList(hits));
  const fused = reciprocalRankFusion(rankedLists, { k: rrfK });

  const candidates: RerankCandidate[] = fused.map((entry) => ({
    ...entry.item.citation,
    id: entry.id,
    excerpt: entry.item.citation.excerpt,
    score: entry.score,
  }));

  if (input.rerank) {
    const reranked = await llmRerank({
      query: input.query,
      candidates,
      llm: input.rerank,
      topN: finalLimit,
    });
    return reranked.map(({ id: _id, ...citation }) => citation);
  }

  return candidates.slice(0, finalLimit).map(({ id: _id, ...citation }) => citation);
}
