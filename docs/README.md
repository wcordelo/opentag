# OpenTag documentation

This index separates current implementation truth from historical design
records. When documents disagree, use this precedence order:

1. [PRODUCT.md](../PRODUCT.md) — active product contract
2. [ARCHITECTURE.md](../ARCHITECTURE.md) — current code topology and lifecycle
3. [DECISIONS.md](../DECISIONS.md) — locked technical decisions
4. [operations.md](./operations.md) — runnable validation and deployment
5. source code and tests

## Current guides

| Document | Purpose |
| --- | --- |
| [README.md](../README.md) | Overview, quick start, features, deployment units |
| [PRODUCT.md](../PRODUCT.md) | Product promise, surfaces, reliability and security contracts |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Topology, sequence diagrams, state machines, ownership, recovery |
| [centaur-port.md](./centaur-port.md) | What was ported, adapted, strengthened, or intentionally omitted |
| [extending.md](./extending.md) | How to add commands, tools, tasks, cards, runtimes, state, and egress |
| [operations.md](./operations.md) | Local validation, Container builds, deploy order, metrics, troubleshooting |
| [../setup.md](../setup.md) | Slack, Cloudflare, runtime, harness, and research setup |
| [../edge/README.md](../edge/README.md) | Testable Cloudflare target and package layout |
| [research-actors.md](./research-actors.md) | Optional research actor contracts and cancellation |
| [evaluation.md](./evaluation.md) | Research evaluation and smoke commands |
| [../e2e/README.md](../e2e/README.md) | Live-surface probes beyond automated lifecycle coverage |
| [../edge/workers/agent-runtime/README.md](../edge/workers/agent-runtime/README.md) | Production AG-UI Container |
| [../edge/wasm-core/README.md](../edge/wasm-core/README.md) | Optional research WASM dispatcher |

## Historical records

These remain useful for rationale and acceptance criteria, but their planned
file lists and gap statements are not current status:

| Document | Historical role |
| --- | --- |
| [../ARCHITECTURE-ANALYSIS.md](../ARCHITECTURE-ANALYSIS.md) | Pre-implementation architecture analysis |
| [../SPEC.md](../SPEC.md) | A1–A5 implementation specification |
| [../GOAL.md](../GOAL.md) | Autonomous implementation plan |
| [../implementation-notes.md](../implementation-notes.md) | Chronological phase log and later corrections |
| [../ANALYSIS-SUMMARY.txt](../ANALYSIS-SUMMARY.txt) | Original migration decision summary |

Slack app manifest: [slack-app-manifest.yaml](../slack-app-manifest.yaml).
It includes `users:read.email`; reinstall after scope changes and refresh the
bot token when Slack issues one.
