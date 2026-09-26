#!/usr/bin/env python3
"""BGE cross-encoder baseline with 8k-char excerpts (matches Jev truncation cap)."""
import json
import statistics
import time
from pathlib import Path

from sentence_transformers import CrossEncoder

ROOT = Path(__file__).resolve().parent.parent
FROZEN = ROOT / "frozen-candidates.json"
OUT = ROOT / "results" / "bge-results-8k-excerpt.json"
EXCERPT_CHARS = 8000


def mrr(ranks):
    return sum(1 / rank for rank in ranks if 0 < rank <= 5) / len(ranks)


def top3(ranks):
    return sum(1 for rank in ranks if 0 < rank <= 3) / len(ranks)


def main():
    frozen = json.loads(FROZEN.read_text())
    t0 = time.time()
    model = CrossEncoder("BAAI/bge-reranker-base", max_length=512, device="cpu")
    load_s = time.time() - t0

    scores = {}
    qlat = {}
    for query in frozen["queries"]:
        started = time.time()
        pairs = [
            (query["query"], candidate["excerpt"][:EXCERPT_CHARS])
            for candidate in query["rrfCandidates"][:35]
        ]
        scores[query["id"]] = [
            float(value)
            for value in model.predict(pairs, batch_size=8, show_progress_bar=False)
        ]
        qlat[query["id"]] = time.time() - started
        print(query["id"], f"{qlat[query['id']]:.1f}s", flush=True)

    result = {
        "model": "BAAI/bge-reranker-base",
        "maxLength": 512,
        "excerptChars": EXCERPT_CHARS,
        "loadSeconds": load_s,
        "arms": {},
    }

    for top_n in (20, 35):
        ranks = []
        per_query = []
        for query in frozen["queries"]:
            candidates = query["rrfCandidates"]
            window = list(range(min(top_n, len(candidates))))
            order = sorted(window, key=lambda index: -scores[query["id"]][index])
            ids = [candidates[index]["id"] for index in order]
            ids.extend(candidate["id"] for candidate in candidates[top_n:])
            rank = ids.index(query["goldSourceKey"]) + 1
            ranks.append(rank)
            per_query.append({
                "queryId": query["id"],
                "rank": rank,
                "order": ids[:10],
            })
        result["arms"][f"bge-top{top_n}"] = {
            "topN": top_n,
            "mrrAt5": mrr(ranks),
            "top3Recall": top3(ranks),
            "ranks": ranks,
            "perQuery": per_query,
        }
        print(
            f"bge-top{top_n}: MRR@5 {mrr(ranks):.3f} top3 {top3(ranks):.3f} ranks {ranks}",
            flush=True,
        )

    result["cpuSecondsPerQueryTop35"] = {
        "p50": statistics.median(qlat.values()),
        "max": max(qlat.values()),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2))
    print("wrote", OUT)
    print("total", time.time() - t0)


if __name__ == "__main__":
    main()
