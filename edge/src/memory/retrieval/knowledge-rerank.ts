/**
 * Knowledge search rerank configuration and factory.
 */

import type { Env } from "../../env.js";
import { createJevCandidateRerank } from "./jev-rerank.js";
import { JEV_RERANK_MAX_CANDIDATES, JEV_RERANK_MODEL_DEFAULT } from "./jev-questions.js";

export type KnowledgeRerankMode = "off" | "jev-score" | "jev-noul";

export type CandidateRerankFn = <T extends { id: string; excerpt: string }>(input: {
  query: string;
  candidates: T[];
  topN: number;
}) => Promise<T[]>;

const DEFAULT_TIMEOUT_MS = 8_000;

export function parseKnowledgeRerankMode(value?: string): KnowledgeRerankMode {
  if (value === "jev-score" || value === "jev-noul") return value;
  return "off";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve a candidate reranker from Worker env. Returns undefined when mode is off,
 * the API key is missing, or mode is unrecognized — callers keep RRF order.
 */
export function resolveKnowledgeCandidateRerank(env: Pick<
  Env,
  "KNOWLEDGE_RERANK_MODE" | "TYPESAFE_API_KEY" | "KNOWLEDGE_RERANK_MODEL" | "KNOWLEDGE_RERANK_TIMEOUT_MS"
>): CandidateRerankFn | undefined {
  const mode = parseKnowledgeRerankMode(env.KNOWLEDGE_RERANK_MODE);
  if (mode === "off") return undefined;
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;
  return createJevCandidateRerank({
    apiKey,
    mode,
    model: env.KNOWLEDGE_RERANK_MODEL?.trim() || JEV_RERANK_MODEL_DEFAULT,
    timeoutMs: parsePositiveInt(env.KNOWLEDGE_RERANK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxCandidates: JEV_RERANK_MAX_CANDIDATES,
  });
}
