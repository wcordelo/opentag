# P1 Jev reranker eval

Offline evaluation for the knowledge-search rerank prototype.

## Corpus and queries (26 pairs)

| Source family | Provenance |
| --- | --- |
| `wiki` | Real `docs/*.md` pages chunked on `##` headings (`wiki:T_eval:docs:*`) |
| `code` | Real `edge/src` files chunked on `export function` boundaries |
| `custom_db` | Fixture rows themed on `edge/test/connectors-phase2.test.ts` (not production DB) |

Retriever: offline BM25 per source family (windowed passages + page-title boost; Supermemory unavailable offline), fused with RRF k=60, top 40 frozen per query in `frozen-candidates.json` (per-list limit 15). Production uses the same query expansion and pool sizes via `unifiedKnowledgeSearch` + `JEV_RERANK_MAX_CANDIDATES=40`.

**Limitations:** no live Slack canary threads or Supermemory index; custom_db rows are fixture-derived.

## Rebuild frozen candidates

```bash
node edge/eval/p1/build-frozen-eval.mjs
```

## Run baseline arms (RRF + bge-reranker)

```bash
cd edge/eval/p1 && npm install && node run-eval.mjs
```

Writes `baseline-results.json`. The `bge-reranker-base` arm uses `AutoTokenizer` +
`AutoModelForSequenceClassification` with `text_pair` (cross-encoder logits), not the
text-classification pipeline.

## Run Jev arms (requires `TYPESAFE_API_KEY`)

Self-contained bundle (no npm deps):

```bash
TYPESAFE_API_KEY=... node edge/eval/p1/run-jev-eval.mjs
```

Or from the artifact copy:

```bash
TYPESAFE_API_KEY=... node /opt/cursor/artifacts/p1-eval/run-jev-eval.mjs
```

## Metrics

- MRR@5
- Top-3 recall (gold `sourceKey` in top 3)
- p95 latency per arm
