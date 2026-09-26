#!/usr/bin/env node
/**
 * P2 offline combination analysis: current router + Jev shadow judgments (no network, no deps).
 *
 * Reads fixtures.json (gold), current-router.json, jev-results.json from the P2 eval dir and
 * evaluates a small, pre-declared set of respond/observe combination rules.
 *
 * Usage: node combo.mjs [--dir <p2 eval dir>]
 *   Default dir: the parent directory if it contains fixtures.json (e.g. edge/eval/p2/combo/),
 *   otherwise ../edge/eval/p2 relative to this script.
 * Writes combo-results.json and combo-results.md next to this script.
 *
 * Honesty notes:
 * - "principled" rules use no thresholds, or only Jev's native 0.5 decision boundary.
 * - "tuned" rules use thresholds suggested AFTER looking at this data's disagreement cases
 *   (T=0.2/0.3 veto, memoryNeeded>=0.8 from the eval's threshold sweep, 0.2-0.6 band).
 *   Their in-sample numbers are optimistic; a leave-one-out (LOO) estimate is reported,
 *   where the threshold is re-selected on the other 57 fixtures from a small pre-declared grid.
 * - If a Jev call errored / is missing a route, every rule falls back to the current router.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argDir = process.argv.indexOf("--dir");
const dir = argDir >= 0 ? process.argv[argDir + 1]
  : existsSync(join(here, "..", "fixtures.json")) ? join(here, "..") : join(here, "..", "edge", "eval", "p2");
const load = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const fixtures = load("fixtures.json");
const router = new Map(load("current-router.json").items.map((row) => [row.id, row]));
const jevResults = new Map(load("jev-results.json").results.map((row) => [row.id, row]));

const rows = fixtures.items.map((item) => {
  const jev = jevResults.get(item.id)?.jev;
  const hasJev = Boolean(jev && !jev.error && jev.route);
  return {
    id: item.id,
    gold: item.gold.route === "respond",
    router: router.get(item.id)?.route === "respond",
    hasJev,
    jevRespond: hasJev ? jev.route.choice === "respond" : null,
    pRespond: hasJev ? Number(jev.route.probabilities?.respond ?? (jev.route.choice === "respond" ? 1 : 0)) : null,
    memory: hasJev ? Number(jev.memoryNeeded?.noul ?? 0) : null, // post opt-out override
    botMentioned: Boolean(jev?.state?.botMentioned),
  };
});

// Each rule: (row, params) => boolean respond. Missing Jev => router.
const withJev = (fn) => (row, params) => (row.hasJev ? fn(row, params) : row.router);
const RULES = [
  { id: "router", label: "Current router (baseline)", kind: "baseline", fn: (r) => r.router },
  { id: "jev", label: "Jev alone (baseline)", kind: "baseline", fn: withJev((r) => r.jevRespond) },
  { id: "and", label: "AND: respond only if both respond", kind: "principled", fn: withJev((r) => r.router && r.jevRespond) },
  { id: "or", label: "OR: respond if either responds", kind: "principled", fn: withJev((r) => r.router || r.jevRespond) },
  { id: "veto-0.2", label: "Router, Jev vetoes respond if p(respond) < 0.2", kind: "tuned", family: "veto", params: { t: 0.2 },
    fn: withJev((r, p) => r.router && !(r.pRespond < p.t)) },
  { id: "veto-0.3", label: "Router, Jev vetoes respond if p(respond) < 0.3", kind: "tuned", family: "veto", params: { t: 0.3 },
    fn: withJev((r, p) => r.router && !(r.pRespond < p.t)) },
  { id: "jev+mem-0.5", label: "Jev, plus respond if router responds AND memoryNeeded >= 0.5", kind: "principled", family: "mem", params: { m: 0.5 },
    fn: withJev((r, p) => r.jevRespond || (r.router && r.memory >= p.m)) },
  { id: "jev+mem-0.8", label: "Jev, plus respond if router responds AND memoryNeeded >= 0.8", kind: "tuned", family: "mem", params: { m: 0.8 },
    fn: withJev((r, p) => r.jevRespond || (r.router && r.memory >= p.m)) },
  { id: "band-0.2-0.6", label: "Jev, but router decides when 0.2 <= p(respond) <= 0.6", kind: "tuned", family: "band", params: { lo: 0.2, hi: 0.6 },
    fn: withJev((r, p) => (r.pRespond >= p.lo && r.pRespond <= p.hi ? r.router : r.jevRespond)) },
];
const FAMILY_GRID = {
  veto: [0.1, 0.2, 0.3, 0.4, 0.5].map((t) => ({ t })),
  mem: [0.5, 0.6, 0.7, 0.8, 0.9].map((m) => ({ m })),
  band: [0.1, 0.2, 0.3].flatMap((lo) => [0.5, 0.6, 0.7].map((hi) => ({ lo, hi }))),
};

function metrics(pred, subset = rows) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  subset.forEach((row, i) => {
    const p = pred[i];
    if (p && row.gold) tp++; else if (p) fp++; else if (row.gold) fn++; else tn++;
  });
  const n = subset.length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    n, tp, fp, fn, tn,
    accuracy: (tp + tn) / n,
    precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    falseRespondRate: fp / n,
    falseRespondCount: fp,
    missedRespondCount: fn,
  };
}

// Exact two-sided McNemar (binomial on discordant pairs) vs a baseline prediction.
function mcnemar(pred, base) {
  let b = 0, c = 0; // b: rule right & base wrong; c: rule wrong & base right
  rows.forEach((row, i) => {
    const ruleOk = pred[i] === row.gold, baseOk = base[i] === row.gold;
    if (ruleOk && !baseOk) b++; else if (!ruleOk && baseOk) c++;
  });
  const n = b + c, k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i) / 2 ** n;
  return { ruleBetter: b, ruleWorse: c, pExact: n === 0 ? 1 : Math.min(1, 2 * tail) };
}
function binom(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }

function flips(pred, base) {
  return rows.flatMap((row, i) => (pred[i] === base[i] ? [] : [{
    id: row.id, gold: row.gold ? "respond" : "observe",
    from: base[i] ? "respond" : "observe", to: pred[i] ? "respond" : "observe",
    fixed: pred[i] === row.gold,
  }]));
}

// LOO: for fixture i, choose the family param maximizing accuracy on the other 57
// (tie-break: fewer false responds, then earlier grid entry), then predict fixture i.
function looPredictions(rule) {
  const grid = FAMILY_GRID[rule.family];
  const chosen = [];
  const pred = rows.map((row, i) => {
    const train = rows.filter((_, j) => j !== i);
    let best = null;
    for (const params of grid) {
      const m = metrics(train.map((r) => rule.fn(r, params)), train);
      if (!best || m.accuracy > best.m.accuracy || (m.accuracy === best.m.accuracy && m.fp < best.m.fp)) best = { params, m };
    }
    chosen.push(JSON.stringify(best.params));
    return rule.fn(row, best.params);
  });
  const counts = {};
  chosen.forEach((c) => { counts[c] = (counts[c] ?? 0) + 1; });
  return { pred, chosenParams: counts };
}

const routerPred = rows.map((r) => RULES[0].fn(r));
const jevPred = rows.map((r) => RULES[1].fn(r));
const out = RULES.map((rule) => {
  const pred = rows.map((r) => rule.fn(r, rule.params));
  const entry = {
    id: rule.id, label: rule.label, kind: rule.kind, params: rule.params ?? null,
    inSample: metrics(pred),
    vsRouter: { mcnemar: mcnemar(pred, routerPred), flips: flips(pred, routerPred) },
    vsJev: { mcnemar: mcnemar(pred, jevPred), flips: flips(pred, jevPred) },
  };
  if (rule.family && rule.kind === "tuned") {
    const loo = looPredictions(rule);
    entry.leaveOneOut = { grid: FAMILY_GRID[rule.family], chosenParams: loo.chosenParams, ...metrics(loo.pred) };
  }
  return entry;
});

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmtFlips = (list) => list.length ? list.map((f) => `${f.id} (${f.from}→${f.to}${f.fixed ? " ✓" : " ✗"})`).join("; ") : "—";
const md = [
  "# P2 router + Jev combination analysis (offline)",
  "",
  `Inputs: \`${dir}\` — ${rows.length} fixtures (gold respond ${rows.filter((r) => r.gold).length}, observe ${rows.filter((r) => !r.gold).length}); Jev judgments present for ${rows.filter((r) => r.hasJev).length}/${rows.length}. Generated by \`combo.mjs\` (no network).`,
  "",
  "**kind**: *principled* = no data-chosen threshold (uses Jev's native choice / 0.5 boundary); *tuned* = threshold picked after inspecting this data — in-sample numbers are optimistic, see LOO column (LOO is per rule *family*: the threshold is re-picked from the family grid on 57 fixtures and applied to the held-out one, so both veto rows share one LOO result). McNemar p is exact two-sided vs the current router (discordant fixtures: rule-better/rule-worse).",
  "",
  "| Rule | Kind | Acc | Resp P | Resp R | Resp F1 | False-resp | Missed | vs router (better/worse, p) | Family LOO acc / FR / missed |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ...out.map((e) => {
    const m = e.inSample, mc = e.vsRouter.mcnemar;
    const loo = e.leaveOneOut ? `${pct(e.leaveOneOut.accuracy)} / ${pct(e.leaveOneOut.falseRespondRate)} / ${e.leaveOneOut.missedRespondCount}` : "n/a";
    return `| ${e.label} | ${e.kind} | ${pct(m.accuracy)} | ${m.precision.toFixed(3)} | ${m.recall.toFixed(3)} | ${m.f1.toFixed(3)} | ${pct(m.falseRespondRate)} (${m.fp}) | ${m.fn} | ${mc.ruleBetter}/${mc.ruleWorse}, p=${mc.pExact.toFixed(3)} | ${loo} |`;
  }),
  "",
  "## Flips",
  "",
  "✓ = flip agrees with gold, ✗ = flip introduces an error.",
  "",
  ...out.filter((e) => e.kind !== "baseline").flatMap((e) => [
    `### ${e.label}`,
    `- vs router: ${fmtFlips(e.vsRouter.flips)}`,
    `- vs Jev: ${fmtFlips(e.vsJev.flips)}`,
    ...(e.leaveOneOut ? [`- LOO chosen params (count of 58 folds): ${Object.entries(e.leaveOneOut.chosenParams).map(([k, v]) => `${k}×${v}`).join(", ")}`] : []),
    "",
  ]),
].join("\n");

writeFileSync(join(here, "combo-results.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), inputsDir: dir, fixtureCount: rows.length, rules: out }, null, 2)}\n`);
writeFileSync(join(here, "combo-results.md"), `${md}\n`);
console.log(md);
