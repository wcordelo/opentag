#!/usr/bin/env node
/**
 * Self-contained Jev eval bundle (Node 20+, no npm deps).
 * Question wording must stay in sync with edge/src/memory/retrieval/jev-questions.ts.
 * Excerpt truncation must stay in sync with jev-excerpt.mjs / jev-questions.ts.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... node run-jev-eval.mjs [options] [frozen-candidates.json]
 *
 * Options:
 *   --dry-run              Print config and exit (no API calls)
 *   --top-n <n>            Jev rerank window (default 20; mirrors JEV_RERANK_TOP_N)
 *   --max-candidates <n>   RRF pool cap (default 40; mirrors JEV_RERANK_MAX_CANDIDATES)
 *   --max-excerpt <n>      Excerpt truncation limit (default 8000)
 *   --blend <mode>         jev-only | rrf-blend (default jev-only)
 *   --blend-weight <0-1>   Jev weight in rrf-blend mode (default 0.7)
 *   --mode <mode>          jev-score | jev-noul | both (default both)
 *   --out <path>           Results JSON path (default jev-results.json)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT,
  truncateJevExcerpt,
} from "./jev-excerpt.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL_DEFAULT = "jev-latest";
const JEV_RERANK_MAX_CANDIDATES_DEFAULT = 40;
const JEV_RERANK_TOP_N_DEFAULT = 20;
const JEV_RERANK_BLEND_WEIGHT_DEFAULT = 0.7;
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

function parseArgs(argv) {
  const config = {
    dryRun: false,
    topN: JEV_RERANK_TOP_N_DEFAULT,
    maxCandidates: JEV_RERANK_MAX_CANDIDATES_DEFAULT,
    maxExcerptChars: JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT,
    blendMode: "jev-only",
    blendWeight: JEV_RERANK_BLEND_WEIGHT_DEFAULT,
    mode: "both",
    frozenPath: join(__dirname, "frozen-candidates.json"),
    outPath: join(__dirname, "jev-results.json"),
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      config.dryRun = true;
      continue;
    }
    if (arg === "--top-n") {
      config.topN = Number.parseInt(argv[++index] ?? "", 10);
      continue;
    }
    if (arg === "--max-candidates") {
      config.maxCandidates = Number.parseInt(argv[++index] ?? "", 10);
      continue;
    }
    if (arg === "--max-excerpt") {
      config.maxExcerptChars = Number.parseInt(argv[++index] ?? "", 10);
      continue;
    }
    if (arg === "--blend") {
      config.blendMode = argv[++index] ?? config.blendMode;
      continue;
    }
    if (arg === "--blend-weight") {
      config.blendWeight = Number.parseFloat(argv[++index] ?? "");
      continue;
    }
    if (arg === "--mode") {
      config.mode = argv[++index] ?? config.mode;
      continue;
    }
    if (arg === "--out") {
      config.outPath = argv[++index] ?? config.outPath;
      continue;
    }
    positional.push(arg);
  }
  if (positional[0]) config.frozenPath = positional[0];
  return config;
}

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

function blendJevWithRrfRank({ jevScore, rrfRank, mode, blendWeight }) {
  const normalizedJev = mode === "jev-score" ? jevScore / 10 : jevScore;
  const normalizedRrf = 1 / rrfRank;
  return blendWeight * normalizedJev + (1 - blendWeight) * normalizedRrf;
}

function orderScoredCandidates(entries, mode, blendMode, blendWeight) {
  const scored = entries.filter((entry) => !entry.error);
  const failed = entries.filter((entry) => entry.error);
  const sortKey = (entry) => {
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

async function scoreCandidate(apiKey, mode, model, query, excerpt, maxExcerptChars) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const truncated = truncateJevExcerpt(excerpt, maxExcerptChars);
    const response = await fetch(TYPESAFE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: buildState(query, truncated),
        model,
        questions: { relevance: buildQuestion(mode) },
      }),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`typesafe_http_${response.status}:${detail.slice(0, 200)}`);
    }
    const body = await response.json();
    const answer = body.answers?.relevance;
    const score = answer?.type === "score" ? answer.score : answer?.noul;
    if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("missing_score");
    return { score, model: body.model ?? model, latencyMs, error: null };
  } catch (error) {
    const latencyMs = performance.now() - started;
    return {
      score: 0,
      model,
      latencyMs,
      error: error instanceof Error ? error.message : "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function rerankQuery(apiKey, mode, model, query, config) {
  const started = performance.now();
  const pool = query.rrfCandidates.slice(0, config.maxCandidates);
  const rerankWindow = pool.slice(0, Math.min(config.topN, pool.length));
  const poolTail = pool.slice(rerankWindow.length);

  const scored = await mapWithConcurrency(rerankWindow, CONCURRENCY, async (candidate, index) => {
    const result = await scoreCandidate(
      apiKey,
      mode,
      model,
      query.query,
      candidate.excerpt,
      config.maxExcerptChars,
    );
    return {
      id: candidate.id,
      score: result.score,
      model: result.model,
      latencyMs: result.latencyMs,
      error: result.error,
      rrfRank: index + 1,
    };
  });

  const successful = scored.filter((entry) => !entry.error);
  const ranked = orderScoredCandidates(scored, mode, config.blendMode, config.blendWeight);
  const seen = new Set();
  const order = [];
  for (const entry of ranked) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    order.push(entry.id);
  }
  for (const candidate of [...poolTail, ...query.rrfCandidates.slice(pool.length)]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    order.push(candidate.id);
  }
  for (const candidate of query.rrfCandidates) {
    if (!seen.has(candidate.id)) order.push(candidate.id);
  }

  const callLatencies = scored.map((entry) => entry.latencyMs);
  return {
    order,
    model: successful.find((entry) => entry.model)?.model ?? model,
    latencyMs: performance.now() - started,
    candidateScores: scored,
    callCount: scored.length,
    errorCount: scored.filter((entry) => entry.error).length,
    callLatencyMs: {
      p50: percentile(callLatencies, 50),
      p95: percentile(callLatencies, 95),
    },
    fallbackToRrf: successful.length === 0,
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

function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index];
}

function rankOfGold(order, gold) {
  const index = order.findIndex((id) => id === gold);
  return index >= 0 ? index + 1 : -1;
}

async function runMode(apiKey, mode, frozen, config) {
  const model = process.env.KNOWLEDGE_RERANK_MODEL?.trim() || JEV_MODEL_DEFAULT;
  const ranks = [];
  const queryLatencies = [];
  const callLatencies = [];
  const perQuery = [];
  let totalCalls = 0;
  let totalErrors = 0;
  let resolvedModel = model;

  for (const query of frozen.queries) {
    const result = await rerankQuery(apiKey, mode, model, query, config);
    resolvedModel = result.model ?? resolvedModel;
    const rank = result.fallbackToRrf
      ? rankOfGold(query.rrfCandidates.map((candidate) => candidate.id), query.goldSourceKey)
      : rankOfGold(result.order, query.goldSourceKey);
    ranks.push(rank);
    queryLatencies.push(result.latencyMs);
    callLatencies.push(...result.candidateScores.map((entry) => entry.latencyMs));
    totalCalls += result.callCount;
    totalErrors += result.errorCount;
    perQuery.push({
      queryId: query.id,
      goldSourceKey: query.goldSourceKey,
      rank,
      order: result.fallbackToRrf
        ? query.rrfCandidates.map((candidate) => candidate.id)
        : result.order,
      latencyMs: result.latencyMs,
      callCount: result.callCount,
      errorCount: result.errorCount,
      fallbackToRrf: result.fallbackToRrf,
      candidateScores: result.candidateScores,
    });
  }

  return {
    arm: mode,
    model: resolvedModel,
    config: {
      topN: config.topN,
      maxCandidates: config.maxCandidates,
      maxExcerptChars: config.maxExcerptChars,
      blendMode: config.blendMode,
      blendWeight: config.blendWeight,
    },
    queryCount: frozen.queries.length,
    mrrAt5: mrrAtK(ranks, 5),
    top3Recall: topRecall(ranks, 3),
    latencyMs: {
      perQuery: {
        p50: percentile(queryLatencies, 50),
        p95: percentile(queryLatencies, 95),
      },
      perCall: {
        p50: percentile(callLatencies, 50),
        p95: percentile(callLatencies, 95),
      },
    },
    callCount: totalCalls,
    errorCount: totalErrors,
    perQuery,
  };
}

const config = parseArgs(process.argv.slice(2));
const frozen = JSON.parse(readFileSync(config.frozenPath, "utf8"));

if (config.dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    frozenPath: config.frozenPath,
    queryCount: frozen.queries.length,
    config: {
      topN: config.topN,
      maxCandidates: config.maxCandidates,
      maxExcerptChars: config.maxExcerptChars,
      blendMode: config.blendMode,
      blendWeight: config.blendWeight,
      mode: config.mode,
      model: process.env.KNOWLEDGE_RERANK_MODEL?.trim() || JEV_MODEL_DEFAULT,
      concurrency: CONCURRENCY,
      timeoutMs: TIMEOUT_MS,
    },
    outPath: config.outPath,
    hasApiKey: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
  }, null, 2));
  process.exit(0);
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is required (or pass --dry-run)");
  process.exit(1);
}

const modes = config.mode === "both"
  ? ["jev-score", "jev-noul"]
  : [config.mode];

const arms = {};
for (const mode of modes) {
  arms[mode] = await runMode(apiKey, mode, frozen, config);
}

const output = {
  generatedAt: new Date().toISOString(),
  frozenPath: config.frozenPath,
  provenance: frozen.provenance,
  arms,
};

writeFileSync(config.outPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  arms: Object.fromEntries(
    Object.entries(arms).map(([name, arm]) => [name, {
      model: arm.model,
      mrrAt5: arm.mrrAt5,
      top3Recall: arm.top3Recall,
      callCount: arm.callCount,
      errorCount: arm.errorCount,
      latencyMs: arm.latencyMs,
    }]),
  ),
  outPath: config.outPath,
}, null, 2));
