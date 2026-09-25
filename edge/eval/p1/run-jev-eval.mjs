#!/usr/bin/env node
/**
 * Self-contained Jev eval bundle (Node 20+, no npm deps).
 * Question wording must stay in sync with edge/src/memory/retrieval/jev-questions.ts.
 * Reads TYPESAFE_API_KEY from the environment.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... node run-jev-eval.mjs [frozen-candidates.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frozenPath = process.argv[2] ?? join(__dirname, "frozen-candidates.json");
const frozen = JSON.parse(readFileSync(frozenPath, "utf8"));

const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL_DEFAULT = "jev-latest";
const MAX_CANDIDATES = 20;
const CONCURRENCY = 10;
const TIMEOUT_MS = 8000;

const JEV_SCORE_CRITERIA = [
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
];

const JEV_SCORE_INSTRUCTIONS =
  "How relevant is the candidate passage to answering the user's knowledge search query?";

const JEV_NOUL_INSTRUCTIONS =
  "Does this candidate passage help answer the user's knowledge search query?";

const JEV_NOUL_CRITERIA = {
  true:
    "The passage contains information that directly helps answer the query or provides the specific fact, procedure, or definition the query asks about.",
  false:
    "The passage is off-topic, only tangentially related, or does not contain information that helps answer the query.",
};

function buildState(query, excerpt) {
  return { query: query.trim(), candidate: excerpt.trim() };
}

function buildQuestion(mode) {
  if (mode === "jev-score") {
    return {
      type: "score",
      instructions: JEV_SCORE_INSTRUCTIONS,
      criteria: JEV_SCORE_CRITERIA,
    };
  }
  return {
    type: "noul",
    instructions: JEV_NOUL_INSTRUCTIONS,
    criteria: JEV_NOUL_CRITERIA,
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function scoreCandidate(apiKey, mode, model, query, excerpt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(TYPESAFE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: buildState(query, excerpt),
        model,
        questions: { relevance: buildQuestion(mode) },
      }),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) throw new Error(`typesafe_http_${response.status}`);
    const body = await response.json();
    const answer = body.answers?.relevance;
    const score = answer?.type === "score" ? answer.score : answer?.noul;
    if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("missing_score");
    return { score, model: body.model ?? model, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

async function rerankQuery(apiKey, mode, model, query) {
  const started = performance.now();
  const pool = query.rrfCandidates.slice(0, MAX_CANDIDATES);
  const scored = await mapWithConcurrency(pool, CONCURRENCY, async (candidate) => {
    const result = await scoreCandidate(apiKey, mode, model, query.query, candidate.excerpt);
    return { id: candidate.id, score: result.score, model: result.model, latencyMs: result.latencyMs };
  });
  const ranked = [...scored].sort((left, right) => right.score - left.score);
  const seen = new Set();
  const order = [];
  for (const entry of ranked) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    order.push(entry.id);
  }
  for (const candidate of query.rrfCandidates) {
    if (!seen.has(candidate.id)) order.push(candidate.id);
  }
  return {
    order,
    model: scored.find((entry) => entry.model)?.model ?? model,
    latencyMs: performance.now() - started,
    candidateScores: scored,
  };
}

function mrrAtK(ranks, k = 5) {
  const valid = ranks.filter((rank) => rank > 0 && rank <= k);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, rank) => sum + 1 / rank, 0) / ranks.length;
}

function topRecall(ranks, k = 3) {
  return ranks.filter((rank) => rank > 0 && rank <= k).length / ranks.length;
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function rankOfGold(order, gold) {
  const index = order.findIndex((id) => id === gold);
  return index >= 0 ? index + 1 : -1;
}

async function runMode(apiKey, mode) {
  const model = process.env.KNOWLEDGE_RERANK_MODEL?.trim() || JEV_MODEL_DEFAULT;
  const ranks = [];
  const latencies = [];
  const perQuery = [];
  let resolvedModel = model;
  for (const query of frozen.queries) {
    const result = await rerankQuery(apiKey, mode, model, query);
    resolvedModel = result.model ?? resolvedModel;
    const rank = rankOfGold(result.order, query.goldSourceKey);
    ranks.push(rank);
    latencies.push(result.latencyMs);
    perQuery.push({
      queryId: query.id,
      goldSourceKey: query.goldSourceKey,
      rank,
      order: result.order,
      latencyMs: result.latencyMs,
      candidateScores: result.candidateScores,
    });
  }
  return {
    arm: mode,
    model: resolvedModel,
    queryCount: frozen.queries.length,
    mrrAt5: mrrAtK(ranks, 5),
    top3Recall: topRecall(ranks, 3),
    p95LatencyMs: p95(latencies),
    perQuery,
  };
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is required");
  process.exit(1);
}

const jevScore = await runMode(apiKey, "jev-score");
const jevNoul = await runMode(apiKey, "jev-noul");

const output = {
  generatedAt: new Date().toISOString(),
  frozenPath,
  provenance: frozen.provenance,
  arms: {
    "jev-score": jevScore,
    "jev-noul": jevNoul,
  },
};

const outPath = join(__dirname, "jev-results.json");
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  "jev-score": {
    model: jevScore.model,
    mrrAt5: jevScore.mrrAt5,
    top3Recall: jevScore.top3Recall,
    p95LatencyMs: jevScore.p95LatencyMs,
  },
  "jev-noul": {
    model: jevNoul.model,
    mrrAt5: jevNoul.mrrAt5,
    top3Recall: jevNoul.top3Recall,
    p95LatencyMs: jevNoul.p95LatencyMs,
  },
  outPath,
}, null, 2));
