> **Historical snapshot.** This planning goal remains useful for its gates, but current knowledge deployment/retrieval evidence is in [docs/current-state.md](../../docs/current-state.md).
>
> The `validate.py` result recorded below validates the historical Railway/B0–B4
> snapshot. It is not a current-tree gate: the canonical contract and runtime
> have since moved to the Cloudflare-only architecture, so a fresh run is
> expected to fail on those superseded assumptions. Use the current rollout
> preflight and the knowledge contract audit for present acceptance.

# PROGRESS — supermemory-railway-knowledge-base

**Goal:** Produce and independently validate an implementation-ready, end-to-end OpenTag Supermemory Local on Railway knowledge-base SPEC, with corrected platform limitations, resumable goal state, verified Railway access/resource inventory, explicit deployment and cleanup gates, dependencies, and deterministic acceptance criteria; do not deploy or delete external resources during this planning phase.
**Started:** 2026-07-19T04:03:34Z
**Last updated:** 2026-07-19T04:42:20Z
**Status:** completed
**Subagent calls used:** 7/30
**Fable advisor calls used:** 0/2

## Completed tasks
- [x] Resolve goal output path and verify current Railway CLI authentication read-only.
- [x] Task A — audit Railway projects, environments, services, volumes, domains, usage, and access without mutation; wrote `RAILWAY-READINESS.md` (14,752 bytes).
- [x] Task B — audit the current KB SPEC, canonical decisions, repository code, and implementation gaps; wrote `repo-architecture-audit.md` (28,731 bytes).
- [x] Task C — replace the obsolete hybrid KB document with the canonical Supermemory Local on Railway end-to-end execution SPEC.
- [x] Task D — create and pass deterministic `validate.py`; `git diff --check` passes for goal deliverables.
- [x] Task E — complete fresh independent SPEC and Railway reviews, correct all BLOCKING findings, and pass the mandatory fresh SPEC re-review with no blocking findings.

## In progress
(none)

## Blocked
(none)

## Queued
(none)

## Confirm on return
- The execution goal must pause for explicit approval after showing the exact Railway project/service/volume/domain creation or mutation plan.
- The execution goal must pause separately before any Cloudflare Worker/Container deployment or production secret mutation.
- No Railway project, service, volume, deployment, or domain may be deleted merely because it looks stale; deletion requires usage evidence, a backup/rollback assessment, the exact resource IDs, and explicit execution-time approval.

## SPEC

[GOAL]: Produce and independently validate an implementation-ready, end-to-end OpenTag Supermemory Local on Railway knowledge-base SPEC, with corrected platform limitations, resumable goal state, verified Railway access/resource inventory, explicit deployment and cleanup gates, dependencies, and deterministic acceptance criteria; do not deploy or delete external resources during this planning phase.

DELIVERABLES:
- `/Users/will/Documents/opentag/KNOWLEDGE-BASE-SPEC.md` — canonical end-to-end implementation plan, updated in place as explicitly requested.
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base/RAILWAY-READINESS.md` — dated, evidence-backed Railway access and resource inventory with cleanup candidates classified but not mutated.

WORKING FILES:
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base/PROGRESS.md` — resumable goal state.
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base/repo-architecture-audit.md` — repository/spec gap analysis.
- `/Users/will/Documents/opentag/goal-outputs/supermemory-railway-knowledge-base/validate.py` — deterministic validation.

BUDGET: approximately 6 subagent calls, including one corrective cycle and its mandatory fresh re-review (hard cap: 30; the final permitted call remains reserved while Tier 2 review is owed).

SUCCESS CRITERIA:
1. `KNOWLEDGE-BASE-SPEC.md` explicitly replaces Supabase/Postgres and Cloudflare Container persistence claims with Supermemory Local's encrypted embedded store on one Railway service plus one persistent Railway volume.
2. The SPEC states that the current Supermemory Local process reads Railway `PORT`, listens on `0.0.0.0`, persists all state under `SUPERMEMORY_DATA_DIR`, ignores/removes `DATABASE_URL`, uses one process/one machine, cannot use Railway replicas with a volume, and has brief deployment downtime.
3. The SPEC corrects container-tag logic: tags are exact opaque namespaces, not prefix filters; B1 uses one exact `workspace:{teamId}` tag with project/channel metadata, and later project isolation requires exact-tag fan-out/merge or deliberate duplication.
4. The SPEC preserves all OpenTag invariants: Slack terminates only at `opentag-bot`; ingestion is `waitUntil -> KnowledgeDO -> Queue`; Supermemory remains outside the turn path and outside the product state spine; no Worker or Container deploy occurs without explicit approval.
5. The SPEC resolves current dependency inversions by placing tracked-channel/project configuration before automatic ingestion and by defining the actual queue consumer, full-thread fetch, idempotent `customId`, retry, reconciliation, backfill, deletion/edit convergence, citation, ACL, and failure behavior.
6. Every implementation work package has an owner surface, concrete deliverables/paths, dependencies, acceptance criteria, validation commands, rollback behavior, and an autonomy classification (`file-only`, `read-only external`, or `external mutation`).
7. The SPEC includes an execution-ready Railway deployment contract: pinned Supermemory release, Dockerfile/build context, runtime variables/secrets, `/var/lib/supermemory` volume, region and sizing decision, domain/TLS, health/readiness probe, backup schedule, deploy/upgrade/rollback procedure, one-time API-key capture and rotation handling, observability, and cost guardrails.
8. The SPEC includes staged validation from local contract tests through Railway smoke tests, OpenTag staging, limited tracked-channel canary, backfill, production activation, rollback, and post-deploy monitoring; live ingestion cannot begin before restore testing and exact-scope authorization checks pass.
9. `RAILWAY-READINESS.md` records the verified CLI package/version, authenticated identity/workspace, current project/environment/service inventory, whether the repo is linked, the permissions proven by read-only checks, capabilities still unproven, and cleanup candidates with evidence requirements; it contains no secret values.
10. Resource cleanup is a separate execution work package that defaults to retain; it requires exact IDs, current usage/deployment/domain/volume evidence, owner confirmation, backup/rollback assessment, and explicit approval before deletion.
11. `validate.py` deterministically checks the two deliverables, all required sections/phrases/work-package fields, absence of superseded architecture claims presented as current, and the Railway readiness evidence fields; it exits zero.
12. A fresh independent reviewer reports no BLOCKING findings against these criteria; advisory findings may remain documented.

TASKS:
- [ ] Task A (parallel-safe, read-only external, research tier) — audit Railway access and inventory; write `RAILWAY-READINESS.md`. DONE WHEN criteria 9 and 10 are satisfied without any Railway mutation.
- [ ] Task B (parallel-safe, file-only plus public-doc research, research tier) — audit existing SPEC/canonical docs/code and current Supermemory/Railway contracts; write `repo-architecture-audit.md`. DONE WHEN it enumerates every correction and dependency needed to satisfy criteria 1–8.
- [ ] Task C (depends on A+B, file-only, drafting tier) — revise `KNOWLEDGE-BASE-SPEC.md` in place. DONE WHEN criteria 1–10 are traceable to named sections and every work package has the required execution fields.
- [ ] Task D (depends on C, file-only, deterministic inline) — create and run `validate.py`. DONE WHEN criterion 11 passes and `git diff --check` reports no whitespace errors for modified goal files.
- [ ] Task E (depends on D, read-only reviewer tier) — fresh adversarial review. DONE WHEN criterion 12 passes; BLOCKING findings trigger correction plus a fresh re-review.

EXTERNAL-ACTION GATES FOR THE FUTURE EXECUTION GOAL:
- Gate R1 — create/link/configure a Railway project, service, volume, variables, domain, backups, or deployment only after presenting exact targets and receiving explicit approval.
- Gate C1 — set or rotate Cloudflare production secrets and deploy Workers only after presenting exact targets and receiving explicit approval.
- Gate S1 — change Slack scopes/subscriptions or reinstall the app only after presenting exact changes and receiving explicit approval.
- Gate D1 — delete any Railway resource only after criteria 10 are met and the user approves the exact IDs.

## Iteration log
| # | Task | Model | Result | Notes |
|---|------|-------|--------|-------|
| — | Goal initialization | (inline) | ✅ | Railway CLI package drift identified; authenticated read-only with `@railway/cli` 5.27.0; no project linked; no external mutations. |
| — | Probe cleanup | (inline) | ✅ | Moved the generated 368 MB `.supermemory` probe directory to macOS Trash; user files untouched. |
| 1 | Railway readiness audit | research tier | ✅ | `RAILWAY-READINESS.md`; 4 projects, 15 services, 10 active public domains, 3 volumes (domain count rechecked across all service IDs); all cleanup candidates retain pending evidence and approval. |
| 2 | Repository architecture audit | research tier | ✅ | `repo-architecture-audit.md` (28,731 bytes); documented obsolete hybrid architecture, missing queues/consumer/config, and dependency-ordered corrections. |
| 3 | Canonical SPEC rewrite | drafting tier | ✅ | Replaced the 49,744-byte hybrid draft with a 41 KB canonical Railway/Local plan; corrected retrieval turn semantics, `search_slack`, generated-key handling, and public Railway networking. |
| 4 | Fresh SPEC adversarial review | reviewer tier | ⚠️ | Found 5 BLOCKING issues: missing LLM runtime, bootstrap log leak, invalid isolated restore, async completion gap, and validator discoverability. |
| 5 | Fresh Railway/cleanup review | reviewer tier | ✅ | NO BLOCKING FINDINGS; inventory arithmetic and retain-first cleanup gates passed. Advisory CLI pin was adopted. |
| 6 | Canonical SPEC corrective pass | drafting tier | ✅ | Corrected all 5 blockers; validator expanded to assert the new runtime, redaction, restore, async polling, and discoverability contracts. |
| 7 | Mandatory fresh SPEC re-review | reviewer tier | ✅ | NO BLOCKING FINDINGS; all criteria passed. Encryption-boundary and CLI-drift advisories were adopted. |
