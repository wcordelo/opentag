/**
 * Shared Jev rerank question wording for knowledge search.
 * Keep in sync with edge/eval/p1/run-jev-eval.mjs (generated from this module).
 */

/** Default model alias; pin to jev-1.13.0 after threshold tuning. */
export const JEV_RERANK_MODEL_DEFAULT = "jev-latest";

/** Maximum RRF-fused candidates kept for retrieval (spec §9.5; raised for recall). */
export const JEV_RERANK_MAX_CANDIDATES = 40;

/** Default number of top RRF candidates Jev reorders (tail keeps RRF order). */
export const JEV_RERANK_TOP_N_DEFAULT = 20;

/** Default excerpt length sent to Jev per candidate (TypeSafe rejects ~64k+ char payloads). */
export const JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT = 8_000;

/** Hard cap for `JEV_RERANK_MAX_EXCERPT_CHARS` env override. */
export const JEV_RERANK_MAX_EXCERPT_CHARS_CAP = 64_000;

export const JEV_EXCERPT_TRUNCATION_MARKER = "\n[... excerpt truncated for rerank ...]\n";

/** Blend Jev score with RRF rank instead of replacing order entirely. */
export type JevRerankBlendMode = "jev-only" | "rrf-blend";

/** Default weight on Jev score when `blendMode` is `rrf-blend` (remainder is RRF rank). */
export const JEV_RERANK_BLEND_WEIGHT_DEFAULT = 0.7;

/**
 * Truncate an excerpt for Jev scoring at a line boundary when possible.
 * Keep in sync with edge/eval/p1/jev-excerpt.mjs.
 */
export function truncateJevExcerpt(excerpt: string, maxChars: number): string {
  const capped = Math.max(1, Math.min(maxChars, JEV_RERANK_MAX_EXCERPT_CHARS_CAP));
  const trimmed = excerpt.trim();
  if (trimmed.length <= capped) return trimmed;

  const marker = JEV_EXCERPT_TRUNCATION_MARKER;
  const budget = capped - marker.length;
  if (budget <= 0) return trimmed.slice(0, capped);

  const lineBreak = trimmed.lastIndexOf("\n", budget);
  const cut = lineBreak >= Math.floor(budget * 0.5) ? lineBreak : budget;
  return `${trimmed.slice(0, cut)}${marker}`;
}

export function parseJevRerankBlendMode(value?: string): JevRerankBlendMode {
  if (value === "rrf-blend") return "rrf-blend";
  return "jev-only";
}

export function parseBoundedPositiveInt(
  value: string | undefined,
  fallback: number,
  cap?: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (cap !== undefined) return Math.min(parsed, cap);
  return parsed;
}

export function parseBlendWeight(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Combine a Jev score (0–10 for score mode, 0–1 for noul) with RRF rank (1-based).
 * Higher is better for sorting.
 */
export function blendJevWithRrfRank(input: {
  jevScore: number;
  rrfRank: number;
  mode: JevRerankMode;
  blendWeight: number;
}): number {
  const normalizedJev = input.mode === "jev-score"
    ? input.jevScore / 10
    : input.jevScore;
  const normalizedRrf = 1 / input.rrfRank;
  const weight = input.blendWeight;
  return weight * normalizedJev + (1 - weight) * normalizedRrf;
}

/** 10-level relevance rubric for Score reranking. */
export const JEV_SCORE_RELEVANCE_CRITERIA = [
  "Completely irrelevant to the query",
  "Barely related topic, no useful information",
  "Same general domain but does not help answer the query",
  "Mentions a related concept without answering",
  "Partially relevant background only",
  "Somewhat relevant but missing key details",
  "Relevant with useful but incomplete information",
  "Clearly relevant and mostly answers the query",
  "Highly relevant with direct supporting details",
  "Directly and completely answers the query",
] as const;

export const JEV_SCORE_INSTRUCTIONS =
  "How relevant is the candidate passage to answering the user's knowledge search query?";

export const JEV_NOUL_INSTRUCTIONS =
  "Does this candidate passage help answer the user's knowledge search query?";

export const JEV_NOUL_CRITERIA = {
  true:
    "The passage contains information that directly helps answer the query or provides the specific fact, procedure, or definition the query asks about.",
  false:
    "The passage is off-topic, only tangentially related, or does not contain information that helps answer the query.",
} as const;

export type JevRerankMode = "jev-score" | "jev-noul";

export function buildJevRerankState(query: string, excerpt: string): {
  query: string;
  candidate: string;
} {
  return {
    query: query.trim(),
    candidate: excerpt.trim(),
  };
}

export function buildJevScoreQuestion(): {
  type: "score";
  instructions: string;
  criteria: readonly string[];
} {
  return {
    type: "score",
    instructions: JEV_SCORE_INSTRUCTIONS,
    criteria: JEV_SCORE_RELEVANCE_CRITERIA,
  };
}

export function buildJevNoulQuestion(): {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
} {
  return {
    type: "noul",
    instructions: JEV_NOUL_INSTRUCTIONS,
    criteria: JEV_NOUL_CRITERIA,
  };
}
