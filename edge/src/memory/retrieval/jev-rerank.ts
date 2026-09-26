/**
 * TypeSafe Jev reranker for knowledge search candidates.
 * Uses fetch against the SystemOne API (Workers-compatible; no Node SDK).
 */

import {
  blendJevWithRrfRank,
  buildJevNoulQuestion,
  buildJevRerankState,
  buildJevScoreQuestion,
  JEV_RERANK_MAX_CANDIDATES,
  JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT,
  JEV_RERANK_MODEL_DEFAULT,
  JEV_RERANK_TOP_N_DEFAULT,
  type JevRerankBlendMode,
  type JevRerankMode,
  truncateJevExcerpt,
} from "./jev-questions.js";
import type { CandidateRerankFn } from "./knowledge-rerank.js";

const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CONCURRENCY = 10;

export type JevRerankOptions = {
  apiKey: string;
  mode: JevRerankMode;
  model?: string;
  timeoutMs?: number;
  /** RRF pool size sent to retrieval (defaults to JEV_RERANK_MAX_CANDIDATES). */
  maxCandidates?: number;
  /** Top-N RRF candidates Jev reorders; tail keeps RRF order (defaults to 20). */
  rerankTopN?: number;
  maxExcerptChars?: number;
  blendMode?: JevRerankBlendMode;
  blendWeight?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
};

type SystemOneResponse = {
  model?: string;
  answers?: Record<string, {
    type?: string;
    score?: number;
    noul?: number;
  }>;
};

export type JevCallMetrics = {
  model: string;
  latencyMs: number;
  candidateCount: number;
};

type ScoredEntry = {
  id: string;
  score: number;
  model: string;
  rrfRank: number;
  failed: boolean;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function extractScore(answer: SystemOneResponse["answers"] | undefined): number | undefined {
  const entry = answer?.relevance;
  if (!entry) return undefined;
  if (entry.type === "score" && typeof entry.score === "number" && Number.isFinite(entry.score)) {
    return entry.score;
  }
  if (entry.type === "noul" && typeof entry.noul === "number" && Number.isFinite(entry.noul)) {
    return entry.noul;
  }
  return undefined;
}

export async function scoreJevCandidate(input: {
  apiKey: string;
  mode: JevRerankMode;
  model: string;
  query: string;
  excerpt: string;
  maxExcerptChars: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ score: number; model: string; latencyMs: number }> {
  const truncatedExcerpt = truncateJevExcerpt(input.excerpt, input.maxExcerptChars);
  const state = buildJevRerankState(input.query, truncatedExcerpt);
  const question = input.mode === "jev-score"
    ? buildJevScoreQuestion()
    : buildJevNoulQuestion();

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(TYPESAFE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        model: input.model,
        questions: { relevance: question },
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      throw new Error(`typesafe_http_${response.status}`);
    }
    const body = await response.json() as SystemOneResponse;
    const score = extractScore(body.answers);
    if (score === undefined) throw new Error("typesafe_missing_score");
    return {
      score,
      model: typeof body.model === "string" ? body.model : input.model,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Order rerank-window candidates:
 * - Scored: by blended or Jev-only score (desc).
 * - Per-call failures: after scored block, preserving relative RRF order.
 */
export function orderJevScoredCandidates(
  entries: ScoredEntry[],
  mode: JevRerankMode,
  blendMode: JevRerankBlendMode,
  blendWeight: number,
): ScoredEntry[] {
  const scored = entries.filter((entry) => !entry.failed);
  const failed = entries.filter((entry) => entry.failed);

  const sortKey = (entry: ScoredEntry): number => {
    if (blendMode === "rrf-blend") {
      return blendJevWithRrfRank({
        jevScore: entry.score,
        rrfRank: entry.rrfRank,
        mode,
        blendWeight,
      });
    }
    return entry.score;
  };

  scored.sort((left, right) => sortKey(right) - sortKey(left));
  failed.sort((left, right) => left.rrfRank - right.rrfRank);
  return [...scored, ...failed];
}

/**
 * Reorder candidates with Jev; never drops — only sorts, then slices to topN.
 * Per-candidate Jev errors degrade that candidate (RRF tail after scored block).
 * On total failure (no scores or outer error), returns original RRF order sliced to topN.
 */
export function createJevCandidateRerank(options: JevRerankOptions): CandidateRerankFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? JEV_RERANK_MODEL_DEFAULT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCandidates = options.maxCandidates ?? JEV_RERANK_MAX_CANDIDATES;
  const rerankTopN = options.rerankTopN ?? JEV_RERANK_TOP_N_DEFAULT;
  const maxExcerptChars = options.maxExcerptChars ?? JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT;
  const blendMode = options.blendMode ?? "jev-only";
  const blendWeight = options.blendWeight ?? 0.7;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  return async ({ query, candidates, topN }) => {
    const limit = Math.max(0, Math.min(topN, candidates.length));
    const fallback = candidates.slice(0, limit);
    if (limit === 0 || !options.apiKey) return fallback;

    const pool = candidates.slice(0, Math.min(maxCandidates, candidates.length));
    const rerankWindow = pool.slice(0, Math.min(rerankTopN, pool.length));
    const poolTail = pool.slice(rerankWindow.length);
    const beyondPool = candidates.slice(pool.length);

    const started = Date.now();
    try {
      const scored = await mapWithConcurrency(rerankWindow, concurrency, async (candidate, index) => {
        const rrfRank = index + 1;
        try {
          const result = await scoreJevCandidate({
            apiKey: options.apiKey,
            mode: options.mode,
            model,
            query,
            excerpt: candidate.excerpt,
            maxExcerptChars,
            timeoutMs,
            fetchImpl,
          });
          return {
            id: candidate.id,
            score: result.score,
            model: result.model,
            rrfRank,
            failed: false,
          } satisfies ScoredEntry;
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "jev_rerank_candidate_fallback",
              mode: options.mode,
              candidateId: candidate.id,
              rrfRank,
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
          return {
            id: candidate.id,
            score: 0,
            model,
            rrfRank,
            failed: true,
          } satisfies ScoredEntry;
        }
      });

      const successfulScores = scored.filter((entry) => !entry.failed);
      if (successfulScores.length === 0) {
        throw new Error("jev_all_candidates_failed");
      }

      const resolvedModel = successfulScores.find((entry) => entry.model)?.model ?? model;
      const latencyMs = Date.now() - started;
      console.log(
        JSON.stringify({
          event: "jev_rerank",
          mode: options.mode,
          blendMode,
          model: resolvedModel,
          candidateCount: rerankWindow.length,
          scoredCount: successfulScores.length,
          failedCount: scored.length - successfulScores.length,
          latencyMs,
        }),
      );

      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const seen = new Set<string>();
      const ordered: typeof candidates = [];

      const ranked = orderJevScoredCandidates(scored, options.mode, blendMode, blendWeight);
      for (const entry of ranked) {
        if (seen.has(entry.id)) continue;
        const candidate = byId.get(entry.id);
        if (!candidate) continue;
        seen.add(entry.id);
        ordered.push(candidate);
      }
      for (const candidate of [...poolTail, ...beyondPool]) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        ordered.push(candidate);
      }
      for (const candidate of candidates) {
        if (seen.has(candidate.id)) continue;
        ordered.push(candidate);
      }
      return ordered.slice(0, limit);
    } catch (error) {
      const latencyMs = Date.now() - started;
      console.log(
        JSON.stringify({
          event: "jev_rerank_fallback",
          mode: options.mode,
          model,
          candidateCount: rerankWindow.length,
          latencyMs,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return fallback;
    }
  };
}
