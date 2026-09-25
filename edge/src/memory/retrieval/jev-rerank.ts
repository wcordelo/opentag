/**
 * TypeSafe Jev reranker for knowledge search candidates.
 * Uses fetch against the SystemOne API (Workers-compatible; no Node SDK).
 */

import {
  buildJevNoulQuestion,
  buildJevRerankState,
  buildJevScoreQuestion,
  JEV_RERANK_MAX_CANDIDATES,
  JEV_RERANK_MODEL_DEFAULT,
  type JevRerankMode,
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
  maxCandidates?: number;
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
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ score: number; model: string; latencyMs: number }> {
  const state = buildJevRerankState(input.query, input.excerpt);
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
 * Reorder candidates with Jev; never drops — only sorts, then slices to topN.
 * On any error, returns the original RRF order sliced to topN.
 */
export function createJevCandidateRerank(options: JevRerankOptions): CandidateRerankFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? JEV_RERANK_MODEL_DEFAULT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCandidates = options.maxCandidates ?? JEV_RERANK_MAX_CANDIDATES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  return async ({ query, candidates, topN }) => {
    const limit = Math.max(0, Math.min(topN, candidates.length));
    const fallback = candidates.slice(0, limit);
    if (limit === 0 || !options.apiKey) return fallback;

    const pool = candidates.slice(0, Math.min(maxCandidates, candidates.length));
    const started = Date.now();
    try {
      const scored = await mapWithConcurrency(pool, concurrency, async (candidate) => {
        const result = await scoreJevCandidate({
          apiKey: options.apiKey,
          mode: options.mode,
          model,
          query,
          excerpt: candidate.excerpt,
          timeoutMs,
          fetchImpl,
        });
        return { id: candidate.id, score: result.score, model: result.model };
      });

      const resolvedModel = scored.find((entry) => entry.model)?.model ?? model;
      const latencyMs = Date.now() - started;
      console.log(
        JSON.stringify({
          event: "jev_rerank",
          mode: options.mode,
          model: resolvedModel,
          candidateCount: pool.length,
          latencyMs,
        }),
      );

      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const seen = new Set<string>();
      const ordered: typeof candidates = [];

      const ranked = [...scored].sort((left, right) => right.score - left.score);
      for (const entry of ranked) {
        if (seen.has(entry.id)) continue;
        const candidate = byId.get(entry.id);
        if (!candidate) continue;
        seen.add(entry.id);
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
          candidateCount: pool.length,
          latencyMs,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return fallback;
    }
  };
}
