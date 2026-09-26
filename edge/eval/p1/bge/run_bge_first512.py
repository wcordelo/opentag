#!/usr/bin/env python3
"""BGE cross-encoder baseline with first-512-char excerpts (matches #61 run-eval.mjs)."""
import json
import time
from pathlib import Path

from sentence_transformers import CrossEncoder

ROOT = Path(__file__).resolve().parent.parent
FROZEN = ROOT / "frozen-candidates.json"
OUT = ROOT / "results" / "bge-results-first512.json"


def mrr(ranks):
    return sum(1 / rank for rank in ranks if 0 < rank <= 5) / len(ranks)


def top3(ranks):
    return sum(1 for rank in ranks if 0 < rank <= 3) / len(ranks)


def main():
    frozen = json.loads(FROZEN.read_text())
    t0 = time.time()
    model = CrossEncoder("BAAI/bge-reranker-base", max_length=512, device="cpu")

    scores = {}
    for query in frozen["queries"]:
        window = query["rrfCandidates"][:35]
        scores[query["id"]] = [
            float(value)
            for value in model.predict(
                [(query["query"], candidate["excerpt"][:512]) for candidate in window],
                batch_size=8,
                show_progress_bar=False,
            )
        ]

    result = {
        "model": "BAAI/bge-reranker-base (PyTorch fp32)",
        "excerpt": "first 512 chars (matches #61 run-eval.mjs)",
        "arms": {},
    }

    for top_n in (20, 35):
        ranks = []
        for query in frozen["queries"]:
            candidates = query["rrfCandidates"]
            window = list(range(min(top_n, len(candidates))))
            ids = [
                candidates[index]["id"]
                for index in sorted(window, key=lambda index: -scores[query["id"]][index])
            ]
            ids.extend(candidate["id"] for candidate in candidates[top_n:])
            ranks.append(ids.index(query["goldSourceKey"]) + 1)
        result["arms"][f"bge512-top{top_n}"] = {
            "mrrAt5": mrr(ranks),
            "top3Recall": top3(ranks),
            "ranks": ranks,
        }
        print(
            f"bge512-top{top_n}: MRR@5 {mrr(ranks):.3f} top3 {top3(ranks):.3f} ranks {ranks}",
            flush=True,
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2))
    print("wrote", OUT)
    print("total", time.time() - t0)


if __name__ == "__main__":
    main()
