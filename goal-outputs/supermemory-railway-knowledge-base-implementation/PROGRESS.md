> **Historical snapshot.** This ledger records B0–B4/R1 work and its earlier
> gates. Its `waitUntil -> KnowledgeDO -> Queue` wording predates the current
> durable `DeferredIngressDO` ownership fence. Do not infer current source
> enablement from it; use [docs/current-state.md](../../docs/current-state.md)
> and [goal-output status](../DOC-STATUS-RECONCILIATION.md).
>
> The Python validator results recorded in this historical ledger are retained
> as snapshot evidence, not as current-tree gates. They target the former
> Railway/B0–B4 contract and are expected to fail against the current
> Cloudflare-only specification and source. Current acceptance is recorded in
> `goal-outputs/knowledge-contract-validation/`.

# PROGRESS — supermemory-railway-knowledge-base-implementation

**Goal:** Implement the approved OpenTag Supermemory Local on Railway knowledge-base SPEC end to end: complete and independently validate B0-B4 source/tests locally, then stage and execute B5-B9 only through their explicit Railway, Cloudflare, Slack, canary, backfill, and cleanup approval gates, preserving repository invariants and unrelated work.
**Started:** 2026-07-19T09:23:00Z
**Last updated:** 2026-07-28T03:32:08Z
**Status:** in_progress
**Subagent calls used:** 21/30
**Fable advisor calls used:** 0/2

## Completed tasks
- [x] Approved planning SPEC and Railway readiness audit exist and pass `goal-outputs/supermemory-railway-knowledge-base/validate.py`.
- [x] Baseline working tree recorded; unrelated changes remain owned by the user.
- [x] Task A — repository B0-B2 integration audit: `b0-b2-repository-audit.md` (21,440 bytes).
- [x] Task B — current Local/SDK/release contract audit: `supermemory-contract-audit.md` (21,789 bytes).
- [x] Task C — B0 fail-closed source configuration, contracts, exact SDK pin, tests, and inert Railway image assets.
- [x] Task D — B1-B2 durable ledger/outbox/lease, fail-closed Queue seams, exact source scheduling, Slack pagination, and canonical normalization.
- [x] Task E — B3-B4 exact-tag Supermemory adapter, authorized `search_slack`, async-ID ledger convergence, tombstone/unsupported mutation states, and bounded reconcile/backfill operations.
- [x] Task F — deterministic implementation validator/report, six narrow integration fixes, and full local matrix (746 unit, 27 workerd E2E).

## In progress
- [x] Task H / R1 — Railway project/service/volume/domain deployed and authenticated Local smoke passed (2026-07-28).
- [ ] Task G third fresh rereview — still owed for source completeness; user overrode the review gate to execute R1 for connected-system testing.

## Blocked
- C1/S1 Worker secrets + Queue/source enablement await explicit approval.
- R2 backup/restore and mutation-contract enablement await separate approvals.
- Harness Container smoke remains blocked: Docker.app present but daemon not ready.

## Queued
- [ ] C1 — set Cloudflare `SUPERMEMORY_URL`/`SUPERMEMORY_API_KEY`, deploy bot only with approval.
- [ ] Tasks B6-B9 — canary/backfill/cleanup only after their exact gates.

## Confirm on return
- R1 approval will be requested only after the exact new Railway targets, version/checksum, variables/secrets, cost cap, downtime, and rollback plan are known.
- C1/S1, R2, P1, each backfill manifest, and D1 cleanup remain separate later approvals; R1 does not authorize them.

## SPEC

[GOAL]: Implement the approved OpenTag Supermemory Local on Railway knowledge-base SPEC end to end: complete and independently validate B0-B4 source/tests locally, then stage and execute B5-B9 only through their explicit Railway, Cloudflare, Slack, canary, backfill, and cleanup approval gates, preserving repository invariants and unrelated work.

SOURCE OF TRUTH:
- `/Users/will/Documents/opentag/KNOWLEDGE-BASE-SPEC.md`
- `/Users/will/Documents/opentag/DECISIONS.md`
- `/Users/will/Documents/opentag/AGENTS.md`
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base/RAILWAY-READINESS.md`

DELIVERABLES:
- B0-B4 implementation in the repository paths named below, with regression/contract tests.
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base-implementation/IMPLEMENTATION-REPORT.md` — source/test evidence, known limitations, exact external gates, and rollback state.
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base-implementation/R1-DEPLOYMENT-PLAN.md` — exact Railway provisioning proposal, produced but not executed until approval.

WORKING FILES:
- `goal-outputs/supermemory-railway-knowledge-base-implementation/b0-b2-repository-audit.md`
- `goal-outputs/supermemory-railway-knowledge-base-implementation/supermemory-contract-audit.md`
- `goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py`

BUDGET: approximately 9 subagent calls, including one corrective cycle and its mandatory fresh re-review (hard cap 30; final permitted call remains reserved while Tier 2 review is owed).

INVARIANTS:
1. Slack Events, commands, and interactions terminate only at `opentag-bot`; acknowledge Slack promptly and use `waitUntil` for subsequent scheduling.
2. Automatic ingestion is exactly `waitUntil -> KnowledgeDO -> Cloudflare Queue -> opentag-bot queue() consumer -> Supermemory Local`. Slack acknowledgement and non-retrieval turn work never call Supermemory; only the explicitly selected, bounded `search_slack` tool may call it during a turn.
3. Supermemory is a sidecar retrieval index. `ConversationStateDO`, `SessionEventDO`, `WorkspaceConfigDO`, and OpenTag's durable fences remain authoritative product state.
4. Configuration and exact authorization precede automatic ingestion. Unconfigured channels enqueue nothing.
5. No Cloudflare Worker/Container deployment, Railway mutation, Slack scope change, secret mutation, or resource deletion occurs without a named stop gate and explicit user approval.
6. B1 treats tags as exact opaque namespaces, never prefixes. All B1 writes and searches use exactly `workspace:{teamId}`.
7. No live ingestion, canary, or backfill begins until backup restoration and cross-workspace authorization tests pass.
8. Preserve existing manual `memory_write`/`memory_search` behavior and existing KnowledgeDO rows; ledger migrations are additive.
9. Preserve unrelated working-tree changes; do not deploy, commit, push, create a branch/PR, reinstall Slack, set secrets, or mutate external resources without explicit approval.

B0 — PIN CONTRACTS AND CONFIGURATION FOUNDATION
- Deliverables: `edge/src/config/workspace-config-do.ts`; `edge/src/config/knowledge-config.ts`; `edge/src/memory/knowledge-contract.ts`; `edge/test/knowledge-config.test.ts`; `edge/test/supermemory-contract.test.ts`; `edge/package.json`; `edge/package-lock.json`; `infra/supermemory/README.md`; `infra/supermemory/Dockerfile`; `infra/supermemory/entrypoint.sh`.
- Done when: a disabled/unconfigured source cannot enqueue; `workspace:{teamId}` is the sole B1 tag; `customId` equals stable source key; `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, and `OPENAI_TEXT_MODEL` resolve to available `gpt-5.1`; local `Xenova/bge-base-en-v1.5` is pinned at 768d; first boot leaks neither generated key nor secret patterns; all pinned API assumptions have tests or an explicit stop.
- Validation: `cd edge && npm run typecheck && npm test`; planning validator; `git diff --check`.

B1 — DURABLE DESCRIPTOR, LEDGER, AND QUEUE WIRING
- Deliverables: `edge/src/memory/knowledge-do.ts`; `edge/src/memory/knowledge-ledger.ts`; `edge/src/memory/knowledge-jobs.ts`; `edge/src/worker.ts`; `edge/src/env.ts`; `edge/wrangler.bot.toml`; `edge/test/knowledge-ledger.test.ts`; `edge/test/knowledge-queue.test.ts`.
- Done when: duplicate/out-of-order descriptors converge, configuration version drift is no-op, a failed send remains recoverable, and consumer work is outside acknowledgement/turn paths.
- Validation: `cd edge && npm run typecheck && npm test && npm run test:e2e`; targeted Queue/DO tests; `git diff --check`.

B2 — PAGINATION-AWARE SLACK FETCH AND CANONICAL NORMALIZATION
- Deliverables: `edge/src/slack/knowledge-thread-fetcher.ts`; `edge/src/memory/normalize-slack-thread.ts`; `edge/test/knowledge-thread-fetcher.test.ts`; `edge/test/normalize-slack-thread.test.ts`.
- Done when: a >100-message fixture fetches all permitted pages; cursor/retry/cap failures never become a complete write; equivalent payload order/whitespace hashes identically; edits change revision.
- Validation: focused fetch/normalization tests and `npm run typecheck`.

B3 — SUPERMEMORY ADAPTER AND RETRIEVAL TOOL
- Deliverables: `edge/src/memory/supermemory-client.ts`; `edge/src/memory/supermemory-adapter.ts`; `edge/src/tools/search-slack.ts`; registration in `edge/src/tools/index.ts`; `edge/test/supermemory-adapter.test.ts`; `edge/test/search-slack.test.ts`.
- Done when: no caller controls a tag; unavailable Local yields structured degraded result; no ingestion call is reachable from an ordinary turn; citations are revision/scoped; a queued/extracting/chunking/embedding/processing document is never searchable/`indexed_revision`; a poll timeout resumes the same ID; unsupported mutation capability blocks rather than guesses.
- Validation: focused adapter/tool tests, mock contract suite, and `npm run typecheck`.

B4 — RECONCILE, DELETION, BACKFILL, AND FAILURE OPERATIONS
- Deliverables: `edge/src/memory/knowledge-reconcile.ts`; `edge/src/memory/knowledge-backfill.ts`; `edge/test/knowledge-reconcile.test.ts`; `edge/test/knowledge-backfill.test.ts`; `docs/operations.md`.
- Done when: delete/disable cannot resurrect; edit converges; incomplete threads retry safely; backfill cannot target all workspaces accidentally; DLQ is observable and replay is explicit.
- Validation: focused reconcile/backfill tests, `npm run test:e2e`, and dry-run fixture manifest.

LOCAL ACCEPTANCE:
- `cd edge && npm run typecheck && npm test && npm run test:e2e` passes.
- `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` passes.
- Implementation `validate.py` proves all required B0-B4 files/tests/config exist, exact SDK pin and tag contract exist, no production ingestion is enabled, and forbidden Supabase/Postgres/current-prefix claims are absent.
- A fresh independent reviewer reports no BLOCKING source, security, durability, or invariant findings. BLOCKING findings trigger correction plus a fresh re-review.

EXTERNAL STOP GATES:
- R1: create/link/configure/deploy the exact new Railway project/service/volume/domain and runtime variables only after presenting exact targets and receiving explicit approval.
- R2: backup/native same-service restore/key-rotation rehearsal only after presenting exact original/restored volume plan and receiving explicit approval.
- C1/S1: Cloudflare deployment/secrets and Slack scopes/subscriptions only after exact targets and changes receive explicit approval.
- P1: exact production team/project/channel canary and each backfill manifest require approval.
- D1: cleanup defaults to RETAIN and requires refreshed IDs/usage/deployment/domain/volume/backup/dependency evidence, owner confirmation, rollback proof, and exact deletion approval.

TASKS:
- [ ] A (parallel-safe, research tier, file-only) — repository B0-B2 integration audit; write `b0-b2-repository-audit.md`.
- [ ] B (parallel-safe, research tier, read-only external) — verify current Local/SDK/release/Railway build contracts; write `supermemory-contract-audit.md` without secrets or mutation.
- [ ] C (depends A+B, implementation tier, file-only) — implement B0.
- [ ] D (depends C, implementation tier, file-only) — implement B1-B2.
- [ ] E (depends C+D, implementation tier, file-only) — implement B3-B4.
- [ ] F (depends C-E, implementation/integration tier, file-only) — run full validation, fix integration issues, create `validate.py` and `IMPLEMENTATION-REPORT.md`.
- [ ] G (depends F, fresh reviewer tier, read-only) — independent adversarial review; correct/re-review if needed.
- [ ] H (depends G, file-only plus read-only Railway refresh) — write `R1-DEPLOYMENT-PLAN.md`, then set status `awaiting_confirmation` and request R1 approval.

## Implementation contract clarifications — 2026-07-19

- The stable B1 `sourceKey`/`customId` and ledger key omit `projectId`, so configuration must fail closed if a second project is enabled for the same exact `(teamId, channelId)`; disabled historical rows may coexist. No last-row-wins convergence is permitted.
- The pinned SDK Local workflow status is `indexing`, not `processing`; internal `processing_unconfirmed` remains the name for a timed-out poll that must resume the same document ID.
- Local bind host, safe health endpoint, generated-key path, complete data path, inherited `DATABASE_URL` behavior, and non-root Railway volume behavior remain R1 runtime proofs, not B0 facts.

## Iteration log
| # | Task | Model | Result | Notes |
|---|------|-------|--------|-------|
| — | Execution goal initialized | (inline) | ✅ | Planning validator passed; dirty worktree recorded; no external mutation. |
| 1 | B0-B2 repository audit | research tier | ✅ | 21,440 bytes; mapped disabled config, additive DO/outbox, Hono Queue export, Slack pagination/failure seams. |
| 2 | Supermemory contract audit | research tier | ✅ | 21,789 bytes; verified Local/SDK pins and exact-tag/search/poll contracts; recorded health/key/update/delete deploy blockers. |
| — | Baseline validation | (script) | ✅ | Edge typecheck, 691 unit tests, and 25 workerd E2E tests pass before KB edits. |
| 3 | B0 implementation | implementation tier | ✅ | Fail-closed tracked-source config/RPCs, exact SDK pin, server-derived contracts, Railway image/redactor assets, 698 unit and 26 workerd E2E tests; external and runtime-proof stops retained. |
| — | Canonical contract correction | (inline) | ✅ | SPEC now records one-enabled-project-per-channel, exact `indexing` status, and R1-only Local bind/health/key/data/DB/volume proofs; planning validator remains green. |
| 4 | B1-B2 implementation | implementation tier | ✅ | Additive ledger/outbox/leases, exact source scheduling, optional Queue consumer, independent pagination/normalization, 719 unit and 27 workerd E2E tests; production Queue binding remains gated. |
| 5 | B3-B4 implementation | implementation tier | ✅ | Exact-tag adapter/search, same-ID poll recovery, fail-closed ambiguous add/update/delete, bounded reconcile/DLQ/backfill, 738 unit and 27 workerd E2E tests; all external gates retained. |
| 6 | Integration validation/report | integration tier | ✅ | Added deterministic validator/report; fixed six bounded validation/security issues; 746 unit, 27 workerd, both validators, diff-check, and secret scan pass. |
| 7 | Fresh adversarial review | reviewer tier | ⚠️ | Interrupted before producing `ADVERSARIAL-REVIEW.md`; no review result is trusted and Task G remains open. |
| 8 | Fresh adversarial review retry | reviewer tier | ❌ | 19,484-byte review confirmed 7 blockers: revision/ID interleaving, disconnected B4 seams, unenforced reader policy, disable race, missing Slack timeout, disabled-first activation, and Docker argv. |
| 9 | Core blocker correction | correction tier | ✅ | Fixed blockers 1/4/5/6/7 plus malformed-add classification; revision-bound IDs, config effect leases, fetch deadlines, lifecycle enable state, and Docker argv; 782 unit/31 workerd pass. |
| 10 | Reader-policy correction | correction tier | ✅ | Canonical `bundle:{bundleId}` authorization, exact-turn snapshot and pre/post live access rechecks, automation/Stop denial; 792 unit/31 workerd pass. |
| 11 | B4 runtime correction | correction tier | ✅ | Connected durable cursor reconciliation, actual-DLQ capture/exact replay, and digest-bound per-source backfill manifests with persisted P1 enforcement; 800 unit/34 workerd, both validators, and diff-check pass. |
| 12 | Combined correction integration | integration tier | ✅ | `CORRECTION-REPORT.md` maps all 7 fixes to runtime/caller/test evidence; 800 unit/34 workerd, 120 focused unit/9 focused workerd, both validators, diff-check, and filename-only secret scan pass; 0 source blockers, with manual-reconcile and P1-attestation limits retained. |
| 13 | Fresh adversarial rereview | reviewer tier | ❌ | `ADVERSARIAL-REREVIEW.md` (22,947 bytes) found 6 blockers: no authorized lifecycle path, no periodic coordinator, self-attested P1, fail-open Queue routing, executable truncated backfill, and application-level descriptor rejection treated as success; 800 unit/34 workerd and validators pass but are insufficient. |
| 14 | Lifecycle authorization correction | correction tier | ✅ | Added externally issued Ed25519 one-use exact-scope grants, separate inspect/stage/update-disabled/first-enable/disable routes, atomic replay/config/effect/conflict checks, and durable redacted actor audit; 814 unit/39 workerd pass, with issuer/key and deployed auth matrix retained for C1/S1. |
| 15 | Scheduler, Queue, and replay correction | correction tier | ✅ | Added dormant C1-gated durable scheduled reconciliation, exact fail-closed primary/DLQ routing, authoritative descriptor acceptance/convergence classification, and explicit DLQ replay dispositions; 814 unit/39 workerd and both validators pass, with no live cron/binding/config. |
| 16 | Backfill and P1 correction | correction tier | ✅ | Added external Ed25519 one-use P1 verification, durable per-channel complete discovery/drift/budget states, and per-job enqueue dispositions that prevent partial-page false success; 814 unit/41 workerd, focused 43 unit/9 workerd, both validators, and safety scans pass. |
| 17 | Second combined correction integration | integration tier | ✅ | `SECOND-CORRECTION-REPORT.md` maps all 6 fixes; additionally required caller-known manifest IDs and moved test verifier values out of deployable TOML; 814 unit/42 workerd, focused 43 unit/10 workerd, both validators, dormancy and safety scans pass; 0 known source blockers. |
| 18 | Second fresh adversarial rereview | reviewer tier | ❌ | `SECOND-ADVERSARIAL-REREVIEW.md` (25,254 bytes) found 3 blockers: reply deletion tombstones the whole parent thread, P1 expiry can strand a pending page, and `deploy:bot-store` can publish a known admin credential; 814 unit/42 workerd and validators pass but lack these adversarial cases. |
| 19 | Third-cycle correction | correction tier | ✅ | Root-only tombstones and exact reply-delete mutation handling, signed P1 renewal preserving pending-page dispositions/budgets, and removal/validation of bot-store deploy/test credentials; 824 unit/42 workerd, focused 144 unit/17 workerd, both validators and safety scans pass. |
| 20 | Third combined correction integration | integration tier | ✅ | `THIRD-CORRECTION-REPORT.md` closes all 3 findings and fixes root-delete precedence, same-or-stricter renewal acceptance, and recursive deploy-config coverage; 825 unit/42 workerd, focused 145 unit/17 workerd, both validators and safety scans pass; 0 known source blockers. |
| 21 | Third fresh adversarial rereview | reviewer tier | ⚠️ | Reviewer hit its usage limit before analysis or `THIRD-ADVERSARIAL-REREVIEW.md`; no result is trusted, Task G remains open, and R1 stays blocked. |
