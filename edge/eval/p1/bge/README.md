# BGE reranker baselines (local only, not CI)

CPU cross-encoder baselines using `sentence-transformers` (`BAAI/bge-reranker-base`, fp32).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install sentence-transformers

python edge/eval/p1/bge/run_bge_8k.py
python edge/eval/p1/bge/run_bge_first512.py
```

Writes `edge/eval/p1/results/bge-results-8k-excerpt.json` and
`bge-results-first512.json`. Expect ~3s CPU per query for the 8k run.
