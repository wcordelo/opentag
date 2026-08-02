# OpenTag goal-output document status

Updated: **2026-08-01 Pacific**

The goal-output folders contain several independent historical audits and
implementation ledgers. They are intentionally not rewritten line by line:
their evidence describes the code and authorization boundary at the time of
each run. The current implementation and live rollout authority is
[docs/current-state.md](../docs/current-state.md), and the four-repository
reports have the more detailed
[backfill reconciliation](./multi-repo-parent-sync-architecture-backfill/CURRENT-STATE-RECONCILIATION.md).

| Artifact family | Historical conclusion | Current reconciliation |
| --- | --- | --- |
| `centaur-gap-implementation/` | Permission snapshots, runtime defaults, and trusted-rich-trigger work was source-only and no deployment was authorized. | Source remains merged. Current bot health/live Slack evidence is in `docs/current-state.md`; the old validator is a point-in-time source guard. |
| `centaur-p0-p1-e2e/` | Progress, attachments, prompt overlays, and harness lifecycle were locally validated with deployment gated. | Harness is now deployed and Claudex/Nanocodex markers are live-verified; live attachments, Stop, and remote-git still need targeted canaries. |
| `opentag-2-gap-audit/` | Skeptical audit recorded gaps in the pre-connector-foundation production line. | Treat its findings as historical baseline; the current matrix explicitly marks what PR #27/PR #28 closed and what remains open. |
| `opentag-2-gap-remediation/` | Remediation ledger remained `in_progress` and prohibited deployment at its review point. | The implementation was later merged and deployed. The current branch fixes the newly found identity-read defect and records its live verification. |
| `supermemory-railway-knowledge-base/` | Planning/readiness artifacts required explicit Railway, backup, source, and canary gates. | The current knowledge path has source-side retrieval/actor/ledger foundations and a live Slack retrieval; reconciliation, broad ingestion, and backup/restore remain gated. |
| `supermemory-railway-knowledge-base-implementation/` | B0–B4 and local sidecar work were validated while C1/S1/R2 gates were open. | Do not infer current production source enablement from the historical R1 notes; use current health and `docs/current-state.md`. |
| `multi-repo-parent-sync-architecture-backfill/` | Complete-history qm/Nanocodex/Buzz/Centaur sync and architecture review. | Each report now has a current-state addendum; the canonical table is in `CURRENT-STATE-RECONCILIATION.md`. |

The terms **Defer** and **Not Applicable** remain visible in the historical
reports. Portable durability, tenancy, provenance, readiness, and audit
contracts were retained where they fit OpenTag. Kubernetes/Rails/Postgres
product infrastructure, Socket Mode, and unrelated client/media surfaces were
not silently omitted; they remain explicit stack decisions.
