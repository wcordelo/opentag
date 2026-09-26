/**
 * Knowledge search rerank configuration and factory.
 */

import type { Env } from "../../env.js";
import { createJevCandidateRerank } from "./jev-rerank.js";
import {
  JEV_RERANK_BLEND_WEIGHT_DEFAULT,
  JEV_RERANK_MAX_CANDIDATES,
  JEV_RERANK_MAX_EXCERPT_CHARS_CAP,
  JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT,
  JEV_RERANK_MODEL_DEFAULT,
  JEV_RERANK_TOP_N_DEFAULT,
  parseBlendWeight,
  parseBoundedPositiveInt,
  parseJevRerankBlendMode,
} from "./jev-questions.js";

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
  | "KNOWLEDGE_RERANK_MODE"
  | "TYPESAFE_API_KEY"
  | "KNOWLEDGE_RERANK_MODEL"
  | "KNOWLEDGE_RERANK_TIMEOUT_MS"
  | "JEV_RERANK_TOP_N"
  | "JEV_RERANK_MAX_EXCERPT_CHARS"
  | "JEV_RERANK_BLEND_MODE"
  | "JEV_RERANK_BLEND_WEIGHT"
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
    rerankTopN: parsePositiveInt(env.JEV_RERANK_TOP_N, JEV_RERANK_TOP_N_DEFAULT),
    maxExcerptChars: parseBoundedPositiveInt(
      env.JEV_RERANK_MAX_EXCERPT_CHARS,
      JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT,
      JEV_RERANK_MAX_EXCERPT_CHARS_CAP,
    ),
    blendMode: parseJevRerankBlendMode(env.JEV_RERANK_BLEND_MODE),
    blendWeight: parseBlendWeight(env.JEV_RERANK_BLEND_WEIGHT, JEV_RERANK_BLEND_WEIGHT_DEFAULT),
  });
}
