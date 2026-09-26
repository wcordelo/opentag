# P1 recall diagnosis (26-query frozen eval)

Generated during recall improvements on branch `cursor/p1-recall-improvements-aee8`.
Baseline numbers are from `frozen-candidates.json` / `baseline-results.json` on
`cursor/p1-jev-reranker-6d4e` before this work (pool 20, per-list 10, truncated
excerpts, no query expansion).

## Summary

| Metric | Before | After |
| --- | ---: | ---: |
| Recall@20 (gold in RRF top 20) | 19/26 (73.1%) | **25/26 (96.2%)** |
| Recall@40 (gold in rerank pool) | 19/26* | **26/26 (100%)** |
| RRF MRR@5 | 0.247 | **0.356** |
| RRF top-3 recall | 0.423 | **0.654** |
| bge-reranker-base MRR@5 | 0.458 | **0.533** |
| bge-reranker-base top-3 | 0.577 | **0.692** |

\*Before: pool capped at 20, so recall@20 = recall@pool.

**Latency / cost impact (production):**

- Per-source fetch: 8→15 hits (`maxRetrievalListLimit`), ~1.9× Supermemory list calls per source.
- Jev rerank pool: 20→40 candidates → **2× TypeSafe API calls** when `KNOWLEDGE_RERANK_MODE` is enabled (~8s timeout each, concurrent).
- `KNOWLEDGE_RERANK_MODE` still defaults to `off`; no added cost until explicitly enabled.

**Eval caveat:** Offline BM25 over repo docs/code/fixtures — not live Slack or Supermemory hybrid traffic.

## Per-query diagnosis (7 original misses)

### q09 — `KnowledgeCitationBase excerpt contentRevision`

| Stage | Before | After |
| --- | --- | --- |
| Gold | `code:…:knowledge-contract.ts:26-184` | `code:…:knowledge-contract.ts:29-187`* |
| Code list rank | not in top 10 | **1** |
| RRF pool | miss | **in pool** |

**Cause:** Eval indexed only the first 1,200 characters of each code chunk. `KnowledgeCitationBase` appears at char ~3,228 in the gold chunk, so BM25 saw zero overlap. Production indexes full chunk `embedContent`.

**Fix:** Index/search full chunk text in eval; query expansion for camelCase identifiers (production `expandKnowledgeSearchQuery`).

\*Gold line range shifted +3 after adding `maxRetrievalListLimit` to `knowledge-contract.ts` (documented label update, not semantic change).

---

### q10 — `SupermemoryAdapter searchSlack hybrid`

| Stage | Before | After |
| --- | --- | --- |
| Code list rank | not in top 10 | **1** |
| RRF pool | miss | **in pool** |

**Cause:** Same 1,200-char excerpt truncation; `searchSlack` is at char ~10,310 in the gold chunk.

**Fix:** Full-chunk excerpts in eval; camelCase query expansion (`searchSlack` → `search Slack`).

---

### q15 — `Supermemory R2 Worker Secrets tigrisfs`

| Stage | Before | After |
| --- | --- | --- |
| Wiki list rank | 12 (outside top 10) | **14** |
| RRF pool @20 | miss | miss |
| RRF pool @40 | miss | **rank 33** |

**Cause:** Per-source cap (10) dropped the gold section before RRF; section competes with many operations.md siblings.

**Fix:** Per-list limit 15 + pool 40. Gold reaches rerank pool (rank 33) but not always top 20 — reranker-dependent.

---

### q17 — `Cloudflare edge bot spine architecture`

| Stage | Before | After |
| --- | --- | --- |
| Wiki list rank | 10 (borderline) | **5** (page-level title boost) |
| RRF pool | miss | **in pool** |

**Cause:** Gold is the full `ARCHITECTURE` page; broad query terms score higher on other docs' sections. Page title ("OpenTag architecture") is the strongest signal.

**Fix:** Page-level title field boost in eval BM25; query expansion; larger pool. Production relies on Supermemory hybrid (not BM25) — title semantics are embedding-native.

---

### q19 — `model reranking strict schema 0 to 10`

| Stage | Before | After |
| --- | --- | --- |
| Wiki list rank | not in top 10 | **in top 15** |
| RRF pool | miss | **in pool** |

**Cause:** Tokenizer dropped single-digit `0` (`{2,}` min length); query/terms in spec section ("score from 0 to 10") partially mismatched.

**Fix:** Allow single-character numeric tokens; windowed BM25 over long spec sections.

---

### q20 — `router tier 1 retrieval relevance floor`

| Stage | Before | After |
| --- | --- | --- |
| Wiki list rank | 8 | **in top 15** |
| RRF pool | miss (crowded fusion) | **in pool** |

**Cause:** Gold in wiki top 10 but displaced by competing wiki/code chunks in 20-slot RRF pool.

**Fix:** Pool 40; per-list 15; improved lexical scoring.

---

### q21 — `research task plane OrchestratorDO`

| Stage | Before | After |
| --- | --- | --- |
| Wiki list rank | 9 | **in top 15** |
| RRF pool | miss | **in pool** |

**Cause:** Same RRF pool crowding as q20; `OrchestratorDO` benefits from identifier boundary splitting.

**Fix:** Pool 40 + query expansion + per-list 15.

## Remaining gap

- **q15 @20:** Gold at RRF rank 33 — in the 40-candidate Jev pool but not top 20. Further gains likely need dense retrieval or live Supermemory eval, not more lexical tuning.

## Eval label notes

- **q03** gold chunk updated to `unified-search.ts:55-110` (line shift from imports added in this branch).
- **q09** gold chunk updated to `knowledge-contract.ts:29-187` (line shift from `maxRetrievalListLimit` comment block).
