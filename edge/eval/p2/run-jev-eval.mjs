#!/usr/bin/env node
/**
 * Standalone P2 Jev router eval (Node 20+, no npm deps, no repo imports).
 * Question wording must match edge/eval/p2/question-definitions.json.
 *
 * Usage:
 *   node edge/eval/p2/run-jev-eval.mjs
 *   node edge/eval/p2/run-jev-eval.mjs --dry-run
 *   TYPESAFE_API_KEY=... node edge/eval/p2/run-jev-eval.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

const fixtures = JSON.parse(readFileSync(join(__dirname, "fixtures.json"), "utf8"));
const currentRouter = JSON.parse(readFileSync(join(__dirname, "current-router.json"), "utf8"));
const questionDefs = JSON.parse(readFileSync(join(__dirname, "question-definitions.json"), "utf8"));

const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = questionDefs.timeoutMsDefault ?? 1500;
const MODEL_DEFAULT = questionDefs.modelDefault ?? "jev-latest";
const MEMORY_OPT_OUT = new RegExp(questionDefs.memoryOptOutPattern, "i");

function buildState(item) {
  const message = item.input.message.trim();
  const source = item.input.source;
  const botMentioned = item.input.botMentioned === true ||
    source === "app_mention" ||
    source === "direct_message" ||
    source === "trusted_rich_mention";
  return {
    message,
    source,
    channelType: item.input.channelType ?? "unknown",
    botMentioned,
    hasFiles: item.input.hasFiles === true,
    threadContext: (item.input.threadContext ?? []).map((line) => String(line).trim()).filter(Boolean),
    memoryOptOut: MEMORY_OPT_OUT.test(message),
  };
}

function buildRequestBody(item, model = MODEL_DEFAULT) {
  return {
    state: buildState(item),
    model,
    questions: questionDefs.questions,
  };
}

function applyMemoryOverride(noul, state) {
  if (state.memoryOptOut) return { noul: 0, overriddenByOptOut: true };
  return { noul };
}

function parseJudgment(body, state) {
  const answers = body.answers ?? {};
  const routeEntry = answers.route;
  const route = routeEntry?.type === "choice" && (routeEntry.choice === "respond" || routeEntry.choice === "observe")
    ? {
      choice: routeEntry.choice,
      probabilities: routeEntry.probabilities ?? {},
      ...(typeof routeEntry.confidence === "number" ? { confidence: routeEntry.confidence } : {}),
    }
    : undefined;
  const needsHuman = typeof answers.needsHuman?.noul === "number"
    ? { noul: answers.needsHuman.noul }
    : undefined;
  const memoryNeeded = typeof answers.memoryNeeded?.noul === "number"
    ? applyMemoryOverride(answers.memoryNeeded.noul, state)
    : undefined;
  return { route, needsHuman, memoryNeeded, model: body.model ?? MODEL_DEFAULT };
}

function confusion(actual, gold, positive) {
  const tp = actual.filter((row, index) => row === positive && gold[index] === positive).length;
  const fp = actual.filter((row, index) => row === positive && gold[index] !== positive).length;
  const fn = actual.filter((row, index) => row !== positive && gold[index] === positive).length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function accuracy(actual, gold) {
  const correct = actual.filter((value, index) => value === gold[index]).length;
  return correct / Math.max(1, actual.length);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function thresholdSweep(scores, gold, thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  return thresholds.map((threshold) => {
    const predicted = scores.map((score) => score >= threshold);
    const stats = confusion(predicted, gold, true);
    return { threshold, ...stats };
  });
}

async function callJev(item, apiKey, model) {
  const state = buildState(item);
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
      body: JSON.stringify(buildRequestBody(item, model)),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) {
      return { error: `typesafe_http_${response.status}`, latencyMs, state };
    }
    const body = await response.json();
    const judgment = parseJudgment(body, state);
    if (!judgment.route) {
      return { error: "typesafe_missing_route", latencyMs, state };
    }
    return { ...judgment, latencyMs, state };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "unknown",
      latencyMs: performance.now() - started,
      state,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(results) {
  const errorCount = results.filter((row) => row.jev.error).length;
  const scored = results.filter((row) => !row.jev.error);
  const goldRoute = scored.map((row) => row.gold.route);
  const goldMemory = scored.map((row) => row.gold.memoryNeeded);
  const goldHuman = scored.map((row) => row.gold.needsHuman);
  const currentRoute = scored.map((row) => row.currentRouter.route);
  const jevRoute = scored.map((row) => row.jev.route.choice);
  const jevMemoryScores = scored.map((row) => row.jev.memoryNeeded?.noul ?? 0);
  const jevMemory = jevMemoryScores.map((score) => score >= 0.5);
  const jevHumanScores = scored.map((row) => row.jev.needsHuman?.noul ?? 0);
  const jevHuman = jevHumanScores.map((score) => score >= 0.5);
  const latencies = results.map((row) => row.jev.latencyMs).filter((value) => typeof value === "number");

  const currentRespond = confusion(currentRoute, goldRoute, "respond");
  const jevRespond = confusion(jevRoute, goldRoute, "respond");
  const currentFalseRespondRate = currentRoute.filter((value, index) => value === "respond" && goldRoute[index] === "observe").length / Math.max(1, currentRoute.length);
  const jevFalseRespondRate = jevRoute.filter((value, index) => value === "respond" && goldRoute[index] === "observe").length / Math.max(1, jevRoute.length);

  return {
    itemCount: results.length,
    scoredItemCount: scored.length,
    errorCount,
    callsPerMessage: 1,
    agreementWithCurrentRouter: accuracy(jevRoute, currentRoute),
    agreementWithGoldRoute: accuracy(jevRoute, goldRoute),
    currentRouterVsGold: {
      routeAccuracy: accuracy(currentRoute, goldRoute),
      respond: currentRespond,
      falseRespondRate: currentFalseRespondRate,
    },
    jevVsGold: {
      routeAccuracy: accuracy(jevRoute, goldRoute),
      respond: jevRespond,
      falseRespondRate: jevFalseRespondRate,
      falseRespondDeltaVsCurrent: jevFalseRespondRate - currentFalseRespondRate,
      memoryNeededAccuracy: accuracy(jevMemory, goldMemory),
      memoryNeededF1: confusion(jevMemory, goldMemory, true).f1,
      memoryNeededThresholdSweep: thresholdSweep(jevMemoryScores, goldMemory),
      needsHumanAccuracy: accuracy(jevHuman, goldHuman),
    },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    models: [...new Set(results.map((row) => row.jev.model).filter(Boolean))],
  };
}

function markdownTable(summary) {
  return [
    "| Metric | Current router | Jev shadow |",
    "| --- | ---: | ---: |",
    `| Route accuracy vs gold | ${(summary.currentRouterVsGold.routeAccuracy * 100).toFixed(1)}% | ${(summary.jevVsGold.routeAccuracy * 100).toFixed(1)}% |`,
    `| Respond F1 vs gold | ${summary.currentRouterVsGold.respond.f1.toFixed(3)} | ${summary.jevVsGold.respond.f1.toFixed(3)} |`,
    `| False respond rate vs gold | ${(summary.currentRouterVsGold.falseRespondRate * 100).toFixed(1)}% | ${(summary.jevVsGold.falseRespondRate * 100).toFixed(1)}% |`,
    `| False respond delta (Jev − current) | — | ${(summary.jevVsGold.falseRespondDeltaVsCurrent * 100).toFixed(1)}% |`,
    `| Agreement with current router | — | ${(summary.agreementWithCurrentRouter * 100).toFixed(1)}% |`,
    `| memoryNeeded accuracy | — | ${(summary.jevVsGold.memoryNeededAccuracy * 100).toFixed(1)}% |`,
    `| memoryNeeded F1 | — | ${summary.jevVsGold.memoryNeededF1.toFixed(3)} |`,
    `| needsHuman accuracy | — | ${(summary.jevVsGold.needsHumanAccuracy * 100).toFixed(1)}% |`,
    `| p50 latency (ms) | — | ${summary.latencyMs.p50.toFixed(0)} |`,
    `| p95 latency (ms) | — | ${summary.latencyMs.p95.toFixed(0)} |`,
    `| Calls per message | — | ${summary.callsPerMessage} |`,
    `| Model version(s) | — | ${summary.models.join(", ") || "n/a"} |`,
    `| Errored calls (excluded from accuracy) | — | ${summary.errorCount} |`,
  ].join("\n");
}

if (dryRun) {
  const example = fixtures.items[0];
  console.log(JSON.stringify(buildRequestBody(example), null, 2));
  process.exit(0);
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is required unless --dry-run is set");
  process.exit(1);
}

const routerById = new Map(currentRouter.items.map((row) => [row.id, row]));
const results = [];
for (const item of fixtures.items) {
  const current = routerById.get(item.id);
  const jev = await callJev(item, apiKey, MODEL_DEFAULT);
  results.push({
    id: item.id,
    gold: item.gold,
    currentRouter: current ?? { route: "observe", reason: "missing" },
    jev,
  });
}

const summary = summarize(results);
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  summary,
  results,
};
writeFileSync(join(__dirname, "jev-results.json"), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(join(__dirname, "jev-results.md"), `${markdownTable(summary)}\n`);
console.log(markdownTable(summary));
