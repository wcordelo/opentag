#!/usr/bin/env node
/**
 * Run offline P1 eval arms: rrf baseline and optional cross-encoder reranker.
 * Usage: node edge/eval/p1/run-eval.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frozen = JSON.parse(readFileSync(join(__dirname, "frozen-candidates.json"), "utf8"));

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

function rrfArm(query) {
  const started = performance.now();
  const order = query.rrfCandidates.map((candidate) => candidate.id);
  return { order, latencyMs: performance.now() - started };
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

function lexicalRerank(query, candidates) {
  const started = performance.now();
  const queryTokens = new Set(tokenize(query.query));
  const scored = candidates.map((candidate) => {
    const docTokens = tokenize(candidate.excerpt);
    let overlap = 0;
    for (const token of docTokens) if (queryTokens.has(token)) overlap += 1;
    const score = overlap / Math.sqrt(Math.max(1, docTokens.length));
    return { id: candidate.id, score };
  });
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
  return { order, latencyMs: performance.now() - started };
}

async function crossEncoderArm(query) {
  try {
    const { pipeline } = await import("@xenova/transformers");
    const started = performance.now();
    const reranker = await pipeline("text-classification", "Xenova/bge-reranker-base", { quantized: true });
    const pairs = query.rrfCandidates.map((candidate) => ({
      id: candidate.id,
      text: `${query.query} [SEP] ${candidate.excerpt.slice(0, 512)}`,
    }));
    const scored = [];
    for (const pair of pairs) {
      const output = await reranker(pair.text);
      const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
      scored.push({ id: pair.id, score });
    }
    const ranked = scored.sort((left, right) => right.score - left.score);
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
      latencyMs: performance.now() - started,
      model: "Xenova/bge-reranker-base",
    };
  } catch (error) {
    const fallback = lexicalRerank(query, query.rrfCandidates);
    return {
      ...fallback,
      model: "lexical-overlap-fallback",
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
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
      goldSourceKey: query.goldSourceKey,
      rank,
      order: result.order,
      latencyMs: result.latencyMs,
      model: result.model,
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
const dedicated = await runArm("bge-reranker-base", crossEncoderArm);

const results = {
  generatedAt: new Date().toISOString(),
  provenance: frozen.provenance,
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
    fallbackReason: dedicated.perQuery[0]?.model === "lexical-overlap-fallback"
      ? dedicated.model
      : undefined,
  },
}, null, 2));
