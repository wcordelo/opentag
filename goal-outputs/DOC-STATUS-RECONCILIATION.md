# OpenTag goal-output document status

Updated: **2026-08-02 21:13 PDT**

The goal-output folders contain several independent historical audits and
implementation ledgers. They are intentionally not rewritten line by line:
their evidence describes the code and authorization boundary at the time of
each run. The current implementation and live rollout authority is
[docs/current-state.md](../docs/current-state.md), and the four-repository
reports have the more detailed
[backfill reconciliation](./multi-repo-parent-sync-architecture-backfill/CURRENT-STATE-RECONCILIATION.md).

The 20:59 PDT read-only sweep supersedes the immediately older live counts:
the tenant now reads 83 rows (55 indexed, 2 pending, 26 permanent failures),
while the exact fresh unmentioned marker still has zero authenticated
knowledge citations despite a queue `indexed` outcome. The harness reports
seven healthy instances on deployed image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`,
but the dirty local source manifest does not match it. Buzz remains at the
empty-body HTTP 400 schema boundary, and strict rollout still fails both
derived-index query Container health aggregates. No deployment, replay,
provider/Queue mutation, credential removal, commit, push, or publication
occurred.

The 21:06 PDT local stability rerun passes 8 affected test files / 95 tests,
typecheck, and staged/unstaged diff checks. It validates the local routing,
Slack lifecycle, knowledge observation, and canonical normalization contracts;
it is not a deployed or installed-scope receipt.
The follow-up queue/normalization/Web API rerun passed 3 files and 70 tests,
including the explicit bot-message Events API indexing contract.
The full edge unit suite then passed 145 files / 1,372 tests and the bot Worker
e2e suite passed 8 files / 67 tests; typecheck and diff checks also passed.
The focused failure/recovery slice passes 9 files / 140 tests; live isolate,
Queue/DLQ, provider, and Container restart gates remain open.
Deploy-config validation, Graphify e2e/policy tests, and static rollout checks
also pass; the strict live query-container health gate remains open.
The 21:13 PDT strict read-only rerun passed every static/resource/deployment
check and failed only the two query-container health aggregates.

The fresh 20:31 PDT readback supersedes older live counts in the historical
artifacts: tenant knowledge is 80 rows (53 indexed, 2 pending, 25 permanent),
while the separate operator Queue/DLQ endpoint has 100 pending records. The
deployed explicit Slack search canary succeeds for a fresh marker, but the
installed bot token lacks reaction/profile/manifest-read scopes and only four
visible public channels are confirmed. The strict derived-index check still
fails aggregate health, and the current dirty source manifest cannot be
matched to the deployed harness image. No replay, deployment, commit, push,
or external publication occurred in this reconciliation.

The latest local Supermemory hardening requires `/v3/openapi` to return a
successful `2xx` before the provider-ready sentinel or Container health gate
is released. The strict live check still reports both query Containers as
`active=1`, `assigned=0`, `healthy=0`, `failed=0`; this correction remains
local-only and no deployment or external mutation was performed.

| Artifact family | Historical conclusion | Current reconciliation |
| --- | --- | --- |
| `centaur-gap-implementation/` | Permission snapshots, runtime defaults, and trusted-rich-trigger work was source-only and no deployment was authorized. | Source remains merged. Current bot health/live Slack evidence is in `docs/current-state.md`; the old validator is a point-in-time source guard. |
| `centaur-p0-p1-e2e/` | Progress, attachments, prompt overlays, and harness lifecycle were locally validated with deployment gated. | Harness is now deployed and Claudex/Nanocodex markers are live-verified; live attachments, Stop, and remote-git still need targeted canaries. |
| `opentag-2-gap-audit/` | Skeptical audit recorded gaps in the pre-connector-foundation production line. | Treat its findings as historical baseline; the current matrix explicitly marks what PR #27/PR #28 closed and what remains open. |
| `opentag-2-gap-remediation/` | Remediation ledger remained `in_progress` and prohibited deployment at its review point. | The implementation was later merged and deployed. The current branch fixes the newly found identity-read defect and records its live verification. |
| `supermemory-railway-knowledge-base/` | Planning/readiness artifacts required explicit Railway, backup, source, and canary gates. | The current Cloudflare-only path has source-side retrieval/actor/ledger foundations, authenticated knowledge readiness, and a bounded live Supermemory write/poll/search receipt. The latest tenant readback is 32 indexed, 19 leased, 2 pending, and 24 permanent rows; 30 old local-add rows were reopened, while broad ingestion, parity, restart/update/delete receipts, and backup/restore remain gated. Its recorded `validate.py` PASS is historical and is not a current-tree gate after the Cloudflare-only migration. |
| `supermemory-railway-knowledge-base-implementation/` | B0–B4 and local sidecar work were validated while C1/S1/R2 gates were open. | Do not infer current production source enablement from the historical R1 notes or Python validator PASS rows; those validators target the superseded Railway/B0–B4 snapshot. Use current health, the edge/Worker test matrix, and `docs/current-state.md`. |
| `multi-repo-parent-sync-architecture-backfill/` | Complete-history qm/Nanocodex/Buzz/Centaur sync and architecture review. | Each report now has a current-state addendum; the canonical table is in `CURRENT-STATE-RECONCILIATION.md`. |

The terms **Defer** and **Not Applicable** remain visible in the historical
reports. Portable durability, tenancy, provenance, readiness, and audit
contracts were retained where they fit OpenTag. Kubernetes/Rails/Postgres
product infrastructure, Socket Mode, and unrelated client/media surfaces were
not silently omitted; they remain explicit stack decisions.

The 2026-08-02 20:16 local reconciliation adds the exact Slack observation
inclusion fence to the current source evidence: non-delete observations carry
the triggering message timestamp, and derived indexing retries a complete but
stale thread until that timestamp is present. This is documented as
source/test-complete and deployment/live-receipt open; see
[`docs/current-state.md`](../docs/current-state.md) and the knowledge contract
gap audit for the authoritative distinction.
