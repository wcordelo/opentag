/**
 * Shared Jev rerank question wording for knowledge search.
 * Keep in sync with edge/eval/p1/run-jev-eval.mjs (generated from this module).
 */

/** Default model alias; pin to jev-1.13.0 after threshold tuning. */
export const JEV_RERANK_MODEL_DEFAULT = "jev-latest";

/** Maximum candidates sent to Jev after RRF (spec §9.5; raised for recall). */
export const JEV_RERANK_MAX_CANDIDATES = 40;

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
