#!/usr/bin/env node
/**
 * Build frozen P1 eval candidates from real repo corpora (docs, code, connector fixtures).
 * Run: node edge/eval/p1/build-frozen-eval.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const TEAM = "T_eval";
const PROJECT = "P_eval";
const RRF_K = 60;
const PER_LIST_LIMIT = 15;
const FINAL_POOL = 40;

// Keep in sync with edge/src/memory/retrieval/knowledge-query-normalize.ts
const CAMEL_BOUNDARY_RE = /([a-z])([A-Z])|([A-Z]+)([A-Z][a-z])/g;
const LEXICAL_TOKEN_RE = /[a-z0-9_]+/g;

function splitIdentifierBoundaries(text) {
  return text.replace(CAMEL_BOUNDARY_RE, (_match, lower, upper, acronym, word) => {
    if (lower && upper) return `${lower} ${upper}`;
    if (acronym && word) return `${acronym} ${word}`;
    return _match;
  });
}

function expandKnowledgeSearchQuery(query) {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  const expanded = splitIdentifierBoundaries(trimmed);
  if (expanded === trimmed) return trimmed;
  return `${trimmed} ${expanded}`;
}

function tokenize(text) {
  const expanded = splitIdentifierBoundaries(text).toLowerCase();
  const raw = expanded.match(LEXICAL_TOKEN_RE) ?? [];
  const tokens = new Set();
  for (const token of raw) {
    tokens.add(token);
    if (token.includes("_")) {
      for (const part of token.split("_")) {
        if (part) tokens.add(part);
      }
    }
  }
  return [...tokens];
}

const LEXICAL_WINDOW_CHARS = 1_200;
const LEXICAL_WINDOW_STRIDE = 600;

function bm25Score(queryTokens, docTokens, avgLen, docFreq, totalDocs) {
  const k1 = 1.2;
  const b = 0.75;
  const tf = new Map();
  for (const token of docTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  let score = 0;
  for (const term of queryTokens) {
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    const df = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const denom = freq + k1 * (1 - b + b * (docTokens.length / avgLen));
    score += idf * ((freq * (k1 + 1)) / denom);
  }
  return score;
}

function excerptWindows(excerpt) {
  if (excerpt.length <= LEXICAL_WINDOW_CHARS) return [excerpt];
  const windows = [];
  for (let start = 0; start < excerpt.length; start += LEXICAL_WINDOW_STRIDE) {
    windows.push(excerpt.slice(start, start + LEXICAL_WINDOW_CHARS));
    if (start + LEXICAL_WINDOW_CHARS >= excerpt.length) break;
  }
  return windows;
}

const TITLE_FIELD_WEIGHT = 2;

function bestWindowBm25Score(queryTokens, excerpt, avgLen, docFreq, totalDocs) {
  const firstLine = excerpt.split("\n")[0] ?? "";
  const titleLine = firstLine.startsWith("# ") && !firstLine.startsWith("## ") ? firstLine : "";
  const titleScore = titleLine
    ? bm25Score(queryTokens, tokenize(titleLine), avgLen, docFreq, totalDocs) * TITLE_FIELD_WEIGHT
    : 0;
  let bodyBest = 0;
  for (const window of excerptWindows(excerpt)) {
    const score = bm25Score(queryTokens, tokenize(window), avgLen, docFreq, totalDocs);
    if (score > bodyBest) bodyBest = score;
  }
  return titleScore + bodyBest;
}

function lexicalRank(query, docs, limit) {
  const queryTokens = tokenize(expandKnowledgeSearchQuery(query));
  const windowTokenLengths = docs.flatMap((doc) =>
    excerptWindows(doc.excerpt).map((window) => tokenize(window).length),
  );
  const avgLen = windowTokenLengths.reduce((sum, len) => sum + len, 0) / Math.max(1, windowTokenLengths.length);
  const docFreq = new Map();
  for (const doc of docs) {
    const seen = new Set();
    for (const window of excerptWindows(doc.excerpt)) {
      for (const term of tokenize(window)) seen.add(term);
    }
    for (const term of seen) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  const scored = docs.map((doc) => ({
    ...doc,
    score: bestWindowBm25Score(queryTokens, doc.excerpt, avgLen, docFreq, docs.length),
  }));
  return scored.sort((left, right) => right.score - left.score).slice(0, limit);
}

function reciprocalRankFusion(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((hit, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = scores.get(hit.id);
      if (existing) existing.score += contribution;
      else scores.set(hit.id, { id: hit.id, excerpt: hit.excerpt, sourceFamily: hit.sourceFamily, score: contribution });
    });
  }
  return [...scores.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function wikiDocsFromMarkdown(filePath, pageId) {
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? pageId;
  const body = raw.trim();
  const pageKey = `wiki:${TEAM}:docs:${pageId}`;
  const docs = [{ id: pageKey, excerpt: `# ${title}\n\n${body}`, sourceFamily: "wiki" }];
  const sections = body.split(/\n(?=##\s+)/);
  for (const section of sections) {
    const heading = section.match(/^##\s+(.+)/)?.[1]?.trim();
    if (!heading) continue;
    const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "section";
    docs.push({
      id: `${pageKey}#${slug}`,
      excerpt: section.trim(),
      sourceFamily: "wiki",
    });
  }
  return docs;
}

function codeDocsFromFile(repoPath, filePath) {
  const content = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const rel = relative(join(REPO_ROOT, "edge"), filePath).replace(/\\/g, "/");
  const lines = content.split("\n");
  const chunks = [];
  const fnRegex = /^(export\s+)?(async\s+)?function\s+(\w+)/;
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fnRegex.test(lines[i] ?? "")) starts.push(i);
  }
  if (starts.length === 0) {
    chunks.push({ start: 0, end: Math.min(lines.length - 1, 80) });
  } else {
    if (starts[0] > 0) chunks.push({ start: 0, end: starts[0] - 1 });
    for (let i = 0; i < starts.length; i += 1) {
      chunks.push({ start: starts[i], end: (starts[i + 1] ?? lines.length) - 1 });
    }
  }
  return chunks.map((chunk) => {
    const slice = lines.slice(chunk.start, chunk.end + 1).join("\n");
    const chunkId = `${rel}:${chunk.start + 1}-${chunk.end + 1}`;
    return {
      id: `code:${TEAM}:${repoPath}:${chunkId}`,
      excerpt: slice,
      sourceFamily: "code",
    };
  });
}

function customDbFixtureDocs() {
  const rows = [
    { rowId: "arr_kpi", title: "ARR", content: "Annual recurring revenue is tracked in the sales_kpi connector." },
    { rowId: "nps_kpi", title: "NPS", content: "Net promoter score quarterly benchmark for customer satisfaction." },
    { rowId: "deploy_gate", title: "Deploy gate", content: "OPENTAG_KNOWLEDGE_DEPLOY_APPROVED must be true before knowledge service deploy." },
    { rowId: "slack_acl", title: "Slack ACL", content: "Slack knowledge search requires a fresh ACL lease from KnowledgeDO authorize endpoint." },
    { rowId: "supermemory_mode", title: "Supermemory mode", content: "SUPERMEMORY_CONSUMER_MODE paused holds queue deliveries during index migration." },
  ];
  return rows.map((row) => ({
    id: `custom_db:${TEAM}:sales_kpi:${row.rowId}`,
    excerpt: `${row.title}: ${row.content}`,
    sourceFamily: "custom_db",
  }));
}

function loadCorpus() {
  const wiki = [];
  const docsDir = join(REPO_ROOT, "docs");
  for (const name of readdirSync(docsDir).filter((entry) => entry.endsWith(".md")).sort()) {
    wiki.push(...wikiDocsFromMarkdown(join(docsDir, name), name.replace(/\.md$/, "")));
  }
  const codePaths = [
    "src/memory/retrieval/unified-search.ts",
    "src/memory/retrieval/rerank.ts",
    "src/memory/retrieval/rrf.ts",
    "src/memory/retrieval/jev-rerank.ts",
    "src/memory/retrieval/knowledge-rerank.ts",
    "src/memory/knowledge-contract.ts",
    "src/tools/search-knowledge.ts",
    "src/tools/search-slack.ts",
    "src/mcp/knowledge-mcp.ts",
    "src/memory/knowledge-ledger.ts",
    "src/memory/supermemory-adapter.ts",
  ].map((path) => join(REPO_ROOT, "edge", path));
  const code = codePaths.flatMap((path) => codeDocsFromFile("opentag", path));
  const customDb = customDbFixtureDocs();
  return { wiki, code, customDb };
}

const QUERY_SPECS = [
  { query: "reciprocal rank fusion k=60 dedupe", gold: "code:T_eval:opentag:src/memory/retrieval/rrf.ts:23-54", family: "code" },
  { query: "optional LLM rerank of search candidates", gold: "code:T_eval:opentag:src/memory/retrieval/rerank.ts:28-76", family: "code" },
  { query: "parallel multi-list search fused with RRF", gold: "code:T_eval:opentag:src/memory/retrieval/unified-search.ts:55-110", family: "code" },
  { query: "KNOWLEDGE_RERANK_MODE jev-score jev-noul", gold: "code:T_eval:opentag:src/memory/retrieval/knowledge-rerank.ts:34-50", family: "code" },
  { query: "TypeSafe Jev reranker fetch systemone", gold: "code:T_eval:opentag:src/memory/retrieval/jev-rerank.ts:132-205", family: "code" },
  { query: "unified knowledge search tool RRF k=60", gold: "code:T_eval:opentag:src/tools/search-knowledge.ts:1-42", family: "code" },
  { query: "search_slack ACL lease authorize", gold: "code:T_eval:opentag:src/tools/search-slack.ts:239-265", family: "code" },
  { query: "MCP retrieval primitives knowledge base", gold: "code:T_eval:opentag:src/mcp/knowledge-mcp.ts:1-95", family: "code" },
  { query: "KnowledgeCitationBase excerpt contentRevision", gold: "code:T_eval:opentag:src/memory/knowledge-contract.ts:29-187", family: "code" },
  { query: "SupermemoryAdapter searchSlack hybrid", gold: "code:T_eval:opentag:src/memory/supermemory-adapter.ts:123-430", family: "code" },
  { query: "Durable Object naming ConversationStateDO", gold: "wiki:T_eval:docs:DECISIONS#1-durable-object-naming", family: "wiki" },
  { query: "No Socket Mode Slack Events API", gold: "wiki:T_eval:docs:DECISIONS#3-slack-events-api", family: "wiki" },
  { query: "AGENT_RUNTIME service binding 1042", gold: "wiki:T_eval:docs:DECISIONS#4-triage-ag-ui-on-cloudflare-containers", family: "wiki" },
  { query: "GET /ready profile=knowledge blockers", gold: "wiki:T_eval:docs:operations#2026-08-05-recovery-and-rollout-checkpoint", family: "wiki" },
  { query: "Supermemory R2 Worker Secrets tigrisfs", gold: "wiki:T_eval:docs:operations#2026-08-05-recovery-and-rollout-checkpoint", family: "wiki" },
  { query: "local validation deployment units health checks", gold: "wiki:T_eval:docs:operations", family: "wiki" },
  { query: "Cloudflare edge bot spine architecture", gold: "wiki:T_eval:docs:ARCHITECTURE", family: "wiki" },
  { query: "knowledge base reranker top 20 candidates", gold: "wiki:T_eval:docs:knowledge-base-implementation-spec", family: "wiki" },
  { query: "model reranking strict schema 0 to 10", gold: "wiki:T_eval:docs:knowledge-base-implementation-spec", family: "wiki" },
  { query: "router tier 1 retrieval relevance floor", gold: "wiki:T_eval:docs:ROUTER-SPEC", family: "wiki" },
  { query: "research task plane OrchestratorDO", gold: "wiki:T_eval:docs:research-actors", family: "wiki" },
  { query: "Graphify local MCP stdio", gold: "wiki:T_eval:docs:graphify-local-mcp", family: "wiki" },
  { query: "OPENTAG_KNOWLEDGE_DEPLOY_APPROVED deploy gate", gold: "custom_db:T_eval:sales_kpi:deploy_gate", family: "custom_db" },
  { query: "annual recurring revenue sales_kpi", gold: "custom_db:T_eval:sales_kpi:arr_kpi", family: "custom_db" },
  { query: "Slack ACL lease KnowledgeDO authorize", gold: "custom_db:T_eval:sales_kpi:slack_acl", family: "custom_db" },
  { query: "SUPERMEMORY_CONSUMER_MODE paused queue", gold: "custom_db:T_eval:sales_kpi:supermemory_mode", family: "custom_db" },
];

function buildFrozenEval() {
  const corpus = loadCorpus();
  const allIds = new Set([...corpus.wiki, ...corpus.code, ...corpus.customDb].map((doc) => doc.id));
  const queries = QUERY_SPECS.map((spec, index) => {
    if (!allIds.has(spec.gold)) {
      throw new Error(`missing gold sourceKey for ${spec.query}: ${spec.gold}`);
    }
    const wikiHits = lexicalRank(spec.query, corpus.wiki, PER_LIST_LIMIT);
    const codeHits = lexicalRank(spec.query, corpus.code, PER_LIST_LIMIT);
    const customHits = lexicalRank(spec.query, corpus.customDb, PER_LIST_LIMIT);
    const fused = reciprocalRankFusion([wikiHits, codeHits, customHits]).slice(0, FINAL_POOL);
    return {
      id: `q${String(index + 1).padStart(2, "0")}`,
      query: spec.query,
      goldSourceKey: spec.gold,
      sourceFamily: spec.family,
      lists: [
        { family: "wiki", hits: wikiHits },
        { family: "code", hits: codeHits },
        { family: "custom_db", hits: customHits },
      ],
      rrfCandidates: fused,
    };
  });
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    provenance: {
      wiki: "Real docs/*.md in repo root indexed as wiki:T_eval:docs:{pageId} with ## section chunks",
      code: "Real edge/src files chunked by export function boundaries (see build-frozen-eval.mjs codePaths)",
      custom_db: "Connector-style fixture rows from edge/test/connectors-phase2.test.ts themes (not live DB)",
      retriever: "Offline BM25 lexical search per source family; Supermemory unavailable offline",
      queryCount: queries.length,
      limitations: "No live Slack canary threads or Supermemory index; custom_db rows are fixture-derived, not production data",
    },
    corpusStats: {
      wikiDocs: corpus.wiki.length,
      codeDocs: corpus.code.length,
      customDbDocs: corpus.customDb.length,
    },
    queries,
  };
}

const frozen = buildFrozenEval();
const outPath = join(__dirname, "frozen-candidates.json");
writeFileSync(outPath, JSON.stringify(frozen, null, 2));
console.log(`Wrote ${outPath} with ${frozen.queries.length} queries`);
