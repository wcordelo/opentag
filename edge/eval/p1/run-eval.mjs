#!/usr/bin/env node
/**
 * Run offline P1 eval arms: rrf baseline and bge-reranker cross-encoder.
 * Usage: node edge/eval/p1/run-eval.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frozen = JSON.parse(readFileSync(join(__dirname, "frozen-candidates.json"), "utf8"));
const BGE_MODEL_ID = "Xenova/bge-reranker-base";

function mrrAtK(ranks, k = 5) {
  const valid = ranks.filter((rank) => rank > 0 && rank <= k);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, rank) => sum + 1 / rank, 0) / ranks.length;
}

function topRecall(ranks, k = 3) {
  const hits = ranks.filter((rank) => rank > 0 && rank <= k).length;
  return hits / ranks.length;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function rankOfGold(order, gold) {
  const index = order.findIndex((id) => id === gold);
  return index >= 0 ? index + 1 : -1;
}

function ordersEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rrfArm(query) {
  const started = performance.now();
  const order = query.rrfCandidates.map((candidate) => candidate.id);
  return { order, latencyMs: performance.now() - started };
}

function reorderByScores(candidates, scored) {
  const ranked = [...scored].sort((left, right) => right.score - left.score);
  const seen = new Set();
  const order = [];
  for (const entry of ranked) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    order.push(entry.id);
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) order.push(candidate.id);
  }
  return order;
}

function logitsForPairs(logits, pairCount) {
  const values = Array.from(logits.data);
  const width = logits.dims?.[1] ?? 1;
  if (width === 1) {
    return values.slice(0, pairCount);
  }
  const scores = [];
  for (let index = 0; index < pairCount; index += 1) {
    scores.push(values[index * width]);
  }
  return scores;
}

async function createCrossEncoderRunner() {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@xenova/transformers");
  const tokenizer = await AutoTokenizer.from_pretrained(BGE_MODEL_ID);
  const model = await AutoModelForSequenceClassification.from_pretrained(BGE_MODEL_ID);

  return async function crossEncoderArm(query) {
    const started = performance.now();
    const candidates = query.rrfCandidates;
    const texts = candidates.map(() => query.query);
    const pairs = candidates.map((candidate) => candidate.excerpt.slice(0, 512));
    const inputs = tokenizer(texts, {
      text_pair: pairs,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const scores = logitsForPairs(logits, candidates.length);
    const scored = candidates.map((candidate, index) => ({
      id: candidate.id,
      score: scores[index] ?? Number.NEGATIVE_INFINITY,
    }));
    const order = reorderByScores(candidates, scored);
    return {
      order,
      latencyMs: performance.now() - started,
      model: BGE_MODEL_ID,
      scores: scored,
    };
  };
}

async function runArm(name, runner) {
  const ranks = [];
  const latencies = [];
  const perQuery = [];
  for (const query of frozen.queries) {
    const result = await runner(query);
    const rank = rankOfGold(result.order, query.goldSourceKey);
    ranks.push(rank);
    latencies.push(result.latencyMs);
    perQuery.push({
      queryId: query.id,
      query: query.query,
      goldSourceKey: query.goldSourceKey,
      rank,
      order: result.order,
      latencyMs: result.latencyMs,
      model: result.model,
      scores: result.scores,
    });
  }
  return {
    arm: name,
    model: perQuery.find((row) => row.model)?.model ?? name,
    queryCount: frozen.queries.length,
    mrrAt5: mrrAtK(ranks, 5),
    top3Recall: topRecall(ranks, 3),
    p95LatencyMs: p95(latencies),
    perQuery,
  };
}

const rrf = await runArm("rrf", rrfArm);
const crossEncoder = await createCrossEncoderRunner();
const dedicated = await runArm("bge-reranker-base", crossEncoder);

const reorderedQueries = dedicated.perQuery.filter((row, index) => {
  const baseline = rrf.perQuery[index];
  return baseline && !ordersEqual(row.order, baseline.order);
});

if (reorderedQueries.length === 0) {
  console.error("bge-reranker-base produced identical ordering to RRF for every query");
  process.exit(1);
}

const example = reorderedQueries[0];
const exampleBaseline = rrf.perQuery.find((row) => row.queryId === example.queryId);
const reorderEvidence = {
  queryId: example.queryId,
  query: example.query,
  goldSourceKey: example.goldSourceKey,
  rrfTop5: exampleBaseline?.order.slice(0, 5) ?? [],
  bgeTop5: example.order.slice(0, 5),
};

const results = {
  generatedAt: new Date().toISOString(),
  provenance: frozen.provenance,
  reorderEvidence,
  reorderedQueryCount: reorderedQueries.length,
  arms: {
    rrf,
    "bge-reranker-base": dedicated,
  },
};

const outPath = join(__dirname, "baseline-results.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({
  rrf: { mrrAt5: rrf.mrrAt5, top3Recall: rrf.top3Recall, p95LatencyMs: rrf.p95LatencyMs },
  dedicated: {
    model: dedicated.model,
    mrrAt5: dedicated.mrrAt5,
    top3Recall: dedicated.top3Recall,
    p95LatencyMs: dedicated.p95LatencyMs,
    reorderedQueryCount: reorderedQueries.length,
  },
  reorderEvidence,
}, null, 2));
