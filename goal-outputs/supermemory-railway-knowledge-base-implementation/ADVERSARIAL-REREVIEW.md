BLOCKING

# Fresh independent adversarial rereview — Supermemory Local B0–B4

> **Historical review note (2026-08-02).** This review and its validator
> references target the former Railway/B0–B4 contract. They are retained for
> historical findings; the current Cloudflare-only architecture and live gaps
> are authoritative in [`docs/current-state.md`](../../docs/current-state.md)
> and the [knowledge contract audit](../knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md).

Date: 2026-07-25

Scope: the current dirty working tree in `/Users/will/Documents/opentag`

Verdict: **6 BLOCKING findings, 6 NONBLOCKING findings, and 6 external gates.**

This rereview did not trust the prior adversarial review, correction report, implementation report, or their validators as evidence of correctness. I traced the combined runtime from Slack callback through configuration, descriptor/outbox, Queue dispatch, Local mutation/polling, ledger outcomes, retrieval authorization, reconciliation, DLQ, and backfill. I then compared those paths to the canonical `KNOWLEDGE-BASE-SPEC.md` invariants and the seven original blockers.

The corrections materially improved the implementation. In particular, revision-bound Local IDs, exact-turn retrieval revalidation, effect fencing, bounded Slack pagination, and Docker argv behavior are now represented by coherent source paths and tests. They do not, however, make B0–B4 operable or approval-safe as a whole. The six findings below must be corrected before C1/S1 staging enablement or any P1 production/backfill action.

## BLOCKING findings

### 1. BLOCKING — there is no authorized source lifecycle path

**Evidence**

- The canonical contract requires tracked-source configuration to be exposed through an explicit administration/configuration path, with requesting-workspace and exact project/channel authorization (`KNOWLEDGE-BASE-SPEC.md:71-73`).
- The internal `WorkspaceConfigDO` RPC exists at `edge/src/config/workspace-config-do.ts:489-598`.
- Its own comment says it is deliberately not exposed because project authorization has no authoritative implementation (`edge/src/config/workspace-config-do.ts:549-551`).
- `edge/src/worker.ts` has no caller or route for `putTrackedKnowledgeSource`.
- The implementation validator actively requires the route to remain absent (`goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py:233-235`).
- B7 requires an operator to configure one source disabled first and then enable that exact test source (`KNOWLEDGE-BASE-SPEC.md:282-290`). No product/control-plane path can perform either transition.

**Impact**

The lifecycle behavior is testable only by direct DO invocation. An operator cannot create a disabled source, inspect it, enable it, disable it, or prove exact team/project/channel authorization through the runtime surface. The original lifecycle blocker therefore remains open. Adding Queue bindings would not make the feature operable; bypassing the missing path through direct DO manipulation would bypass the required authorization and audit boundary.

**Required correction**

Implement an authenticated source CRUD/transition surface whose authenticated actor identity is durably recorded and whose authority is checked against the exact workspace, project, and channel before persistence. Separate staged creation from first enable and later disable. Keep re-enable fail-closed until the Local deletion/reindex contract is proven. Add route-level negative tests for cross-workspace, cross-project, cross-channel, wildcard, conflicting-project, stale-config, and concurrent-effect cases. Replace the validator's “route must be absent” assertion with validation of the authorized lifecycle.

### 2. BLOCKING — reconciliation is manual one-page work, not periodic convergence

**Evidence**

- The canonical contract says reconciliation **periodically** enumerates configured sources/known threads with a bounded cursor and requeues drift (`KNOWLEDGE-BASE-SPEC.md:152-156`).
- `runKnowledgeReconciliationPage` correctly claims and commits one restart-safe page, then returns (`edge/src/memory/knowledge-reconcile.ts:164-261`).
- Its only runtime caller is the manually invoked `POST /admin/knowledge/reconcile` route (`edge/src/worker.ts:456-476`).
- A repository-wide caller scan found no scheduled handler, cron trigger, DO alarm continuation, or other cadence that invokes `runKnowledgeReconciliationPage`; the only other caller is a test.
- Neither the route nor the function loops/continues until the durable run reaches `complete`.

**Impact**

Stale leases, `processing_unconfirmed`, failed jobs, Local/ledger drift, and rows missed by an interrupted operator session do not converge without repeated manual calls carrying the correct run ID. This violates the periodic recovery contract and leaves the system dependent on operator diligence precisely when normal ingestion has failed.

**Required correction**

Add a durable scheduled coordinator behind C1 that starts runs on a defined cadence, holds a single-run fence, continues bounded pages until completion, applies backoff, and emits run/page/lag/error metrics. Preserve the existing restart-safe page claim/commit logic. Test scheduler restart, overlapping invocations, cursor continuation, partial-page failure, config drift, and completion without operator calls. Keep the manual route as an exact-scoped diagnostic/repair control, not the convergence engine.

### 3. BLOCKING — the P1 “approval” is caller-controlled self-attestation

**Evidence**

- Explicit user approval is a hard invariant (`KNOWLEDGE-BASE-SPEC.md:26-34`), and B8 requires a named P1 approval over exact identities, scope, dates, budgets, release IDs, and rollback owner (`KNOWLEDGE-BASE-SPEC.md:293-300`). Deterministic acceptance says canary/backfill cannot proceed without those approvals (`KNOWLEDGE-BASE-SPEC.md:327`).
- Both approval and execution routes are guarded by the same global `ADMIN_SECRET` bearer (`edge/src/worker.ts:544-594`; `edge/src/admin-auth.ts:7-22`).
- The approval route accepts `approvalReference`, `approvedBy`, and `approvedAt` directly from that caller (`edge/src/worker.ts:544-563`).
- `KnowledgeDO` forwards the values without independent identity/evidence verification (`edge/src/memory/knowledge-do.ts:419-442`).
- The ledger checks only the literal `P1`, bounded non-empty strings, and a parseable timestamp, then persists the record (`edge/src/memory/knowledge-ledger.ts:1180-1218`).
- Execution requires only the persisted literal/reference (`edge/src/memory/knowledge-ledger.ts:1221-1247`). The same credential can mint the attestation and immediately execute it.

**Impact**

The code proves that a caller supplied strings, not that the named user approved the exact manifest. It cannot distinguish a real P1 decision from a forged approver/time/reference, cannot impose approval expiry, and cannot prevent the executor from self-approving. The audit record is not an enforceable stop gate.

**Required correction**

Use an independently trusted approval artifact or approval authority. Bind it cryptographically or through an authoritative workflow record to the manifest digest, team/project/channels, date range, maximum count/rate/error budget, release IDs, approver identity, issued time, expiry, and rollback owner. Separate approval authority from execution authority, and reject replayed, expired, mismatched, or self-minted approvals. Until that exists, keep approve/execute unavailable and treat P1 as an external blocking gate.

### 4. BLOCKING — Queue-name routing fails open and cannot guarantee DLQ capture

**Evidence**

- `Env` defines an optional producer binding and only an optional DLQ name; there is no required primary Queue name (`edge/src/env.ts:23-25`).
- The worker checks whether the optional DLQ name matches and routes that batch to `handleKnowledgeDlq`; every other Queue name falls through to `handleKnowledgeQueue` (`edge/src/worker.ts:1021-1032`).
- Production Queue/DLQ bindings are intentionally absent pending C1 (`edge/wrangler.bot.toml:64-69`), so this defect is dormant but would become active at the exact activation gate.
- The validator explicitly blesses this fail-open shape (`goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py:262-267`).

**Impact**

A missing, mistyped, or stale `KNOWLEDGE_DLQ_NAME` routes actual DLQ deliveries back into normal ingestion instead of durable DLQ capture. An unrelated Queue bound to the Worker is also interpreted as a knowledge-ingestion Queue. The runtime therefore cannot prove that terminal failures reach the operator ledger or that only the approved primary Queue can drive Local effects.

**Required correction**

Require exact primary and DLQ Queue names whenever any knowledge Queue consumer is enabled. Route only exact primary to ingestion and exact DLQ to capture; reject/explicitly retry every unknown queue without parsing it as a knowledge job. Validate the names and consumer bindings together at C1. Add worker-entry tests for primary, DLQ, missing configuration, swapped names, and arbitrary names. Change the validator to reject, not require, the current fallthrough.

### 5. BLOCKING — a truncated backfill discovery can be approved and executed as if complete

**Evidence**

- Discovery shares one global candidate/page budget across all requested channels (`edge/src/memory/knowledge-backfill.ts:275-320`).
- When the limit is reached in one channel, later unvisited channels are omitted. `nextCursors` records only a non-empty cursor for the current channel; there is no durable “unvisited channel” continuation marker (`edge/src/memory/knowledge-backfill.ts:280-320`).
- `discoverAndStoreKnowledgeBackfill` persists the manifest even when discovery reports `truncated: true` (`edge/src/memory/knowledge-backfill.ts:422-455`).
- Approval does not reject a truncated manifest (`edge/src/memory/knowledge-backfill.ts:458-477`; `edge/src/memory/knowledge-ledger.ts:1180-1218`).
- Execution verifies digest and config versions but does not require discovery completeness (`edge/src/memory/knowledge-backfill.ts:481-592`).
- A later discovery request creates a new manifest; there is no durable merge/resume operation that completes the first manifest.

**Impact**

An operator can approve and fully execute an undercounted manifest that silently omits later pages or entire requested channels. The result can be marked `complete` even though the approved explicit range/channel set was never completely discovered. This defeats dry-run count review and makes the approval digest misleading.

**Required correction**

Persist discovery as a restart-safe state machine with a per-channel cursor plus explicit pending/unvisited state. Resume and merge into one canonical manifest until every requested channel is exhausted. Do not allow approval or execution while `truncated` or incomplete. Make completion and count derivable from the persisted discovery state. Add multi-channel tests where the first channel consumes the candidate limit, pages exhaust at the global page cap, empty cursors coexist with unvisited channels, execution restarts, and config drift occurs between discovery pages.

### 6. BLOCKING — durable operations treat application-level descriptor rejection as success

**Evidence**

- `KnowledgeDO /descriptor` returns HTTP 200 for the ledger result even when `result.accepted` is false (`edge/src/memory/knowledge-do.ts:133-142`). The same pattern exists for approved backfill enqueue (`edge/src/memory/knowledge-do.ts:478-510`).
- `replayDurableKnowledgeDlqRecord` ignores the response body, completes the DLQ record, and reports `replayed: true` after any HTTP-200 response (`edge/src/memory/knowledge-reconcile.ts:368-427`).
- A newer descriptor can win after the replay claim/source check but before the replay descriptor write. The replay then receives an `out_of_order` rejection yet permanently records the DLQ item as replayed.
- Reconciliation likewise increments `enqueued` without inspecting the descriptor acceptance result (`edge/src/memory/knowledge-reconcile.ts:241-261`).
- Backfill ignores the enqueue result for each exact manifest job, commits the page, and reports the full pending-job count as enqueued (`edge/src/memory/knowledge-backfill.ts:551-592`).

**Impact**

The DLQ audit can claim exact recovery that did not occur. Reconciliation and backfill can advance durable cursors/manifests and report successful enqueue for exact work the ledger rejected. A newer descriptor may be a valid superseding state, but the current callers neither prove convergence nor distinguish “accepted,” “already durably equivalent,” and “superseded.” That is a false-success durability boundary.

**Required correction**

Parse and classify `{ accepted, reason }` at every descriptor/enqueue call. Complete or advance only when the exact descriptor was accepted, was already durably present, or an authoritative ledger read proves a safe superseding/converged state. Otherwise release/retry or record an explicit operator-visible superseded disposition; never label it replayed/enqueued. Add deterministic race tests for a newer event between claim and descriptor, duplicate retry, config drift, accepted-but-response-lost, and backfill page partial acceptance.

## Disposition of the seven original blockers

| Original blocker | Rereview disposition | Reason |
| --- | --- | --- |
| Revision-bound Local IDs | Cleared in the repository path | `localDocumentRevision` and `addAttemptRevision` bind acceptance/outcomes to the intended revision; stale terminal outcomes fail closed. Update/delete remains an external Local-contract gate. |
| B4 planners disconnected | **Not cleared** | Admin routes now call B4 functions, but reconciliation is operator-only, truncated discovery is executable, Queue routing is fail-open, and enqueue/replay false-success remains. |
| Reader-policy/exact-turn authorization | Cleared | The tool freezes the human turn snapshot, reloads current source/bundle before and after Local search, checks each citation against current ledger state, then revalidates again before release. |
| Config version/effect fence | Cleared locally | The effect lease blocks config writes and source/config is revalidated around external effects. Residual timing hardening is NONBLOCKING below. |
| Slack fetch timeout and ignored abort | Cleared | Per-attempt and overall bounds plus signal handling prevent a timed-out reader from winning the result race; tests cover the late-resolution case. |
| Disabled-first lifecycle/enabling | **Not cleared** | The internal transition is corrected, but no authorized runtime path can create disabled, enable, or disable a source. |
| Docker argv/entrypoint | Cleared in repository fixtures | Wrapper `ENTRYPOINT` plus empty `CMD` preserves the executable and appends runtime command arguments. A real pinned-image R1 proof remains external. |

Result: **5 of 7 original blockers are cleared in the repository implementation; 2 remain open.** Findings 3–6 above are additional whole-system blockers exposed by the fresh combined-runtime trace.

## NONBLOCKING findings

### N1. The validators can produce a structurally false green

The implementation validator requires the live source route to be absent and requires the current DLQ-name fallthrough sequence (`validate.py:233-267`). It also validates that manual routes exist, not that reconciliation is periodic, P1 is independently authorized, discovery is complete, or application-level enqueue acceptance is consumed. The validator is useful as a file/contract regression check, but its “all seven original blocker correction paths” success line must not be treated as a fresh security/correctness review.

**Correction:** add negative semantic assertions and behavior tests for the six blocking findings; change the validator summary to state exactly which static contracts it proves.

### N2. The operational administration model is one global bearer

`requireAdminAuth` grants the holder of one `ADMIN_SECRET` authority over caller-supplied team IDs. The global DLQ operator DO lists records from every team (`edge/src/memory/knowledge-ledger.ts:71-88,1046-1064`). This is consistent with an internal global-operator model and therefore is not independently classified as a cross-tenant leak, contrary to the companion review's stronger interpretation. It is still incompatible with the spec's requested-workspace/exact-project/channel administration requirement if these routes are ever exposed to workspace-scoped administrators.

**Correction:** define whether this is a global break-glass plane or a tenant administration plane. For the latter, authenticate an actor, scope every list/action to authorized team/project/channel, and audit it.

### N3. Lease budgets are constants, not an enforced end-to-end deadline

The declared 25s Slack, 5s Local request, 20s poll, 70s ledger lease, and 80s effect lease budgets are internally ordered (`edge/src/memory/knowledge-contract.ts:15-29`). The HTTP portions are bounded. Control-plane RPC time, scheduling stalls, normalization, and event-loop suspension are represented only by a 10s margin rather than an end-to-end abort/deadline check.

**Correction:** carry one monotonic operation deadline through every phase, refuse to start an external effect without sufficient remaining lease, and renew or stop before either fence can expire.

### N4. Slack event timestamp conversion loses sub-millisecond precision

The stable descriptor timestamp is computed by parsing Slack's decimal timestamp into a JavaScript number and then converting to milliseconds (`edge/src/memory/knowledge-jobs.ts:109-116`). This rounds the original decimal identity; malformed inputs fall back to call time later in scheduling. Normal Slack redelivery is likely stable, but preserving the original timestamp string would make the dedupe contract exact.

**Correction:** parse seconds/fraction as strings or derive a deterministic descriptor key directly from the original Slack event identity.

### N5. Retrieval authorization is correctness-heavy but RPC-heavy

A successful search performs current source/bundle reads before search, after search, and after per-citation ledger checks, plus one sequential ledger check per citation (`edge/src/tools/search-slack.ts:245-316`). This closes important races, but at the maximum result count it can add more than a dozen DO calls to one bounded tool invocation.

**Correction:** retain the final acceptance fence while batching ledger checks and returning a versioned authorization snapshot from one DO transaction where possible. Benchmark before staging.

### N6. Durable DLQ records have no retention or compaction policy

`knowledge_dlq_records` is append-only except for replay status transitions; inspection is cursor-bounded but there is no retention/cap/archival mechanism (`edge/src/memory/knowledge-ledger.ts:71-88,1024-1064`). This is not an immediate correctness blocker while Queue bindings are absent, but long-running failure storms can grow the global operator DO indefinitely.

**Correction:** define retention and evidence-preserving archival/compaction, with metrics and a non-destructive operator workflow.

## Independent companion perspective

The required companion pass independently corroborated the missing source lifecycle route, caller-controlled P1 fields, and fail-open Queue-name routing. It also raised the global DLQ/admin scope, revision/update wedging, unbound-Queue retry growth, and retrieval RPC count.

I did **not** adopt two of its stronger labels:

- A global DLQ table is not by itself a cross-tenant leak when the only credential is explicitly a global operator secret; it becomes an authorization defect if the plane is intended for tenant-scoped admins. It is therefore N2, not a seventh blocker.
- Halting a newer revision with `unsupported_update_contract` is the specified fail-closed behavior until Local update/delete semantics are proven. That is an external contract gate, not a regression in the revision-binding correction.

The companion process continued speculative re-checking after its findings had converged and was terminated rather than allowing an unbounded read-only pass. Every adopted finding above was independently verified against the cited source.

## Validation evidence

All commands were read-only with respect to source/config and no deploy or external mutation was performed.

| Validation | Result |
| --- | --- |
| `cd edge && npm run typecheck` | PASS |
| `cd edge && npm test` | PASS — 66 files, 800 tests |
| `cd edge && npm run test:e2e` | PASS — 3 files, 34 tests |
| Planning validator: `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` | PASS |
| Implementation validator: `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py` | PASS |
| Focused correction unit suite run by implementation validator | PASS — 9 files, 120 tests |
| Focused correction workerd suite run by implementation validator | PASS — 2 files, 9 tests |
| `git diff --check` before writing this report | PASS |

These results prove local syntax/types, the exercised unit/workerd paths, fixture contracts, and the validator's static assertions. They do not exercise a real Supermemory Local service, Cloudflare Queue/DLQ bindings, deployed Workers, Slack authorization, Railway persistence/restoration, or independent approval identity.

## External gates and runtime-only uncertainty

These are blocking for activation but are not counted among the six source-level findings:

1. **R1:** real pinned Supermemory Local image help/argv/entrypoint, readiness, auth, add → terminal `done`, exact tag/search, persistence, and negative-startup behavior remain unverified. The fake-image argv test is not R1.
2. **R2:** Railway native same-service backup/restore, original-volume reattachment rollback, persistence after restart, and supported key rotation remain unproved.
3. **C1/S1:** exact Cloudflare primary Queue and DLQ resources/bindings, retry/dead-letter settings, secrets, staging Worker target, Slack scopes/test channels, and deployment approval are absent by design.
4. **Local mutation contract:** update/replacement, delete/tombstone, retention, and re-enable semantics remain unsupported; the code correctly halts rather than guessing.
5. **Staging authorization matrix:** real cross-workspace/channel/project denial, exact-turn Slack identity, degraded search, Queue retry/DLQ capture, and citation evidence have not run against deployed services.
6. **P1:** no user-approved one-channel canary/backfill manifest exists, and the current in-code attestation cannot satisfy that gate.

## Final decision

B0–B4 are **not ready for staging activation, canary, or backfill**. Keep all tracked sources disabled/nonexistent and keep Queue/DLQ bindings absent. Correct the six BLOCKING findings, update tests and validators so they fail on the current shapes, rerun a fresh independent adversarial review, and only then present the external R1/R2/C1/S1/P1 gates for explicit approval.

Final counts:

- **BLOCKING:** 6
- **NONBLOCKING:** 6
- **Original blockers cleared:** 5 of 7
- **External gates/runtime-only uncertainties:** 6
