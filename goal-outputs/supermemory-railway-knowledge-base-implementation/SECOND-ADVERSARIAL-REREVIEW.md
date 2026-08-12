# Second Fresh Adversarial Rereview

Review date: 2026-07-25

Scope: the current combined working tree in `/Users/will/Documents/opentag`

Decision: **B0-B4 is not source-ready. Keep C1/S1/P1 closed.**

This rereview started from `AGENTS.md`, `DECISIONS.md`, and
`KNOWLEDGE-BASE-SPEC.md`, then traced the current source, callers, tests, and
configuration. It did not use an earlier review report, progress claim, or
validator conclusion as evidence of correctness. No source/configuration,
external resource, secret, deployment, Git state, or prior artifact was
modified.

> **Historical validator note (2026-08-02).** The validator PASS rows below
> target the former Railway/B0–B4 contract and are not current-tree gates.
> Current Cloudflare-only source and live status are authoritative in
> [`docs/current-state.md`](../../docs/current-state.md) and the
> [knowledge contract audit](../knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md).

> **Historical review note (2026-08-02).** This rereview predates the current
> `DeferredIngressDO` pre-ack knowledge-event owner and durable outbound
> observation owner. Retain it as a record of the earlier finding, but use
> [`docs/current-state.md`](../../docs/current-state.md) and the
> [current knowledge audit](../knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md)
> for present source and deployment status.

# BLOCKING

## B-01 — A channel member can permanently tombstone an indexed thread by deleting one reply

Severity: high

Affected stage: B1/B3/B4 source readiness

### Exact evidence

1. The Slack manifest subscribes to all four message event families:
   `slack-app-manifest.yaml:77-87`.
2. Every verified, non-Stop Slack callback is sent to knowledge scheduling from
   `ctx.waitUntil`: `edge/src/worker.ts:876-907`.
3. A `message_deleted` event uses
   `previous_message.thread_ts` before the deleted reply's own timestamp and
   emits `reason: "delete"`:
   `edge/src/memory/knowledge-jobs.ts:100-127`. For a deleted reply, this
   deliberately selects the parent thread.
4. The descriptor route permits `delete`; it rejects only unapproved
   `backfill`: `edge/src/memory/knowledge-do.ts:143-158`.
5. Queue dispatch maps every `reason === "delete"` to a source-level tombstone,
   without distinguishing root deletion from reply deletion:
   `edge/src/memory/supermemory-adapter.ts:299-316`.
6. The ledger persists `status = 'tombstoned'` and `tombstoned_at`:
   `edge/src/memory/knowledge-ledger.ts:1021-1028`.
7. A newer descriptor does not clear `tombstoned_at`; later normalization is
   permanently blocked by `prepareRevision`:
   `edge/src/memory/knowledge-ledger.ts:781-830,1050-1055`.
8. Retrieval suppresses any citation whose ledger is not currently indexed or
   has `tombstonedAt`:
   `edge/src/tools/search-slack.ts:204-231`.
9. The unit suite explicitly locks this behavior in:
   `edge/test/knowledge-ledger.test.ts:845-862` asserts that a newer descriptor
   remains blocked by the earlier tombstone.

### Attack

In an enabled channel, a member posts a reply in an indexed thread and then
deletes that reply. Slack emits `message_deleted`. OpenTag converts the reply
deletion into a delete of the parent `sourceKey`, permanently tombstones the
whole thread, and suppresses all of its otherwise valid content from search.
Posting or editing later messages cannot recover it.

This is not merely a stale-content tradeoff. It gives an ordinary channel
member a durable source-availability control over every thread to which they
can add and delete a reply. Recovery requires implementation change or direct
Durable Object data surgery.

### Impact

- One reply deletion removes an entire thread from the knowledge surface.
- The effect survives later Slack events, reconciliation, Queue retries, and
  process restarts.
- The canonical normalization policy says deleted messages are excluded under
  an explicit policy and may leave a deterministic marker
  (`KNOWLEDGE-BASE-SPEC.md:106-110`); it does not grant a reply deletion
  irreversible authority over all other messages in the thread.
- Enabling a source before this is corrected exposes a cheap, non-admin denial
  of knowledge.

### Required correction

1. Distinguish a deleted root from a deleted reply before creating a descriptor.
2. A root deletion may create a source tombstone. A reply deletion must not
   directly create an irreversible source tombstone.
3. Until the pinned Local replacement/delete contract is proved, a reply
   deletion should put the source in an explicit non-searchable
   `redaction_pending`/equivalent state, preserve a recoverable reconciliation
   intent, and fail closed without pretending Local was updated.
4. After the Local mutation contract is proved, refetch the complete thread,
   preserve the deterministic deleted-message marker policy, replace/reindex
   the same stable source safely, and restore search only at terminal `done`.
5. Add behavioral tests for root deletion, reply deletion, malicious
   post/delete, immediate retrieval suppression, restart, reconciliation,
   recovery, later edits, and no cross-thread/channel effect.

No channel should be enabled until a safe deletion/replacement state machine is
implemented and tested. Silently ignoring a reply deletion would leave deleted
content searchable and is not an acceptable correction.

## B-02 — P1 expiry after a page claim can permanently soft-lock a backfill manifest

Severity: high

Affected stage: B4 source readiness and P1 execution safety

### Exact evidence

1. P1 artifacts may be valid for up to 24 hours and need only be unexpired when
   verified: `edge/src/memory/knowledge-backfill-authorization.ts:3-8,374-405`.
   There is no minimum remaining lifetime for a page claim.
2. `claimBackfillPage` validates the stored approval, then creates and persists
   `pending_page_token`, `pending_page_json`, `pending_end_index`, and reserved
   rate budget: `edge/src/memory/knowledge-ledger.ts:2214-2316`.
3. Every job enqueue rechecks the approval against the current wall clock:
   `edge/src/memory/knowledge-do.ts:705-748` and
   `edge/src/memory/knowledge-ledger.ts:2086-2115`.
4. The executor claims first, then processes pending jobs sequentially:
   `edge/src/memory/knowledge-backfill.ts:960-1036`. Expiry can therefore occur
   after durable claim and before any later enqueue.
5. On enqueue failure, the executor records `/backfill/fail` and returns a
   partial page: `edge/src/memory/knowledge-backfill.ts:1037-1068`.
6. `recordBackfillPageFailure` increments the error count but does not clear the
   pending page, release the reserved page, or classify the failed job:
   `edge/src/memory/knowledge-ledger.ts:2382-2432`.
7. Commit requires a disposition for every job:
   `edge/src/memory/knowledge-ledger.ts:2434-2483`.
8. A later claim checks the expired approval before it returns an existing
   pending page: `edge/src/memory/knowledge-ledger.ts:2240-2266`. It therefore
   rejects rather than resuming.
9. A fresh approval cannot recover the same running manifest:
   `approveBackfillManifest` permits only `status === "dry_run"`:
   `edge/src/memory/knowledge-ledger.ts:2117-2137`.
10. There is no backfill abort, release, reauthorization, or pending-page reset
    route. The available paths are get, claim, enqueue, result, fail, and
    commit: `edge/src/memory/knowledge-do.ts:632-790`.

### Attack/failure sequence

1. A correctly signed, exact-scope P1 approval is near expiry.
2. `/backfill/claim` succeeds and durably reserves a page.
3. The approval expires before the first or a later `/backfill/enqueue`.
4. Enqueue fails; `/backfill/fail` leaves the page pending.
5. Commit cannot run because one or more jobs are unclassified.
6. All later claims fail the expired-approval check.
7. A new independently signed P1 artifact cannot be attached because the
   manifest is already `running`.

The manifest and its reserved page are now unrecoverable through supported
operator APIs. This can happen without an attacker; timing near the valid P1
boundary is sufficient.

### Impact

- A signed and otherwise valid production backfill can become permanently
  stuck.
- Already accepted jobs may exist alongside unclassified jobs, so deleting or
  recreating the manifest naively risks duplicate effects.
- Error and rate reservations no longer describe actionable work.
- Recovery requires direct Durable Object data manipulation, which is outside
  the documented operator contract.

### Required correction

1. Reject a new page claim unless the approval has a bounded minimum remaining
   execution window, or persist an explicit signed page-execution deadline.
2. Add a transactionally safe recovery state for an expired/aborted pending
   page. Preserve already recorded dispositions and never re-enqueue them.
3. Permit a fresh, one-use, independently signed P1 artifact to reauthorize the
   exact unchanged manifest and exact remaining page after the former approval
   expires. Keep the old approval immutable in the audit ledger.
4. Release or recompute only the unconsumed rate reservation; do not advance
   `next_job_index` until every exact job has a safe disposition.
5. Add tests for expiry immediately after claim, expiry after partial
   acceptance, restart, fresh exact reauthorization, replayed/wrong-scope
   reauthorization, error/rate budget accounting, and proof that classified
   jobs are not duplicated.

Simply skipping the expiry check after claim is insufficient unless the signed
artifact explicitly authorizes a bounded page-execution lease that can outlive
artifact verification.

## B-03 — A known admin bearer token is committed in a configuration with an explicit deploy command

Severity: high

Affected stage: B0/B1 configuration and secret safety

### Exact evidence

1. `edge/package.json:15` exposes:
   `deploy:bot-store = wrangler deploy --config wrangler.bot-store.toml`.
2. That exact Wrangler configuration sets
   `ENVIRONMENT = "development"` and
   `ADMIN_SECRET = "test-admin-secret"` in deployable `[vars]`:
   `edge/wrangler.bot-store.toml:28-31`.
3. Admin middleware accepts the exact bearer value whenever `ADMIN_SECRET` is
   present: `edge/src/admin-auth.ts:7-22`.
4. The same Worker entrypoint exposes admin configuration and bundle writes,
   knowledge reconciliation/DLQ/backfill operations, debug state, deferred
   ingress, and task start behind this bearer:
   `edge/src/worker.ts:256-287,329-407,472-767`.
5. `ENVIRONMENT = "development"` is not a deploy guard. It only makes missing
   `ADMIN_SECRET` permissive; here the known secret is present.
6. The production config correctly omits knowledge signing keys and private
   material pending external gates:
   `edge/wrangler.bot.toml:86-108`. Test Ed25519 private keys otherwise remain
   under `edge/test/helpers/`, and test verifier bindings are supplied by
   `edge/vitest.workers.bot-store.config.ts`. The deployable admin bearer is the
   exception.

### Impact

Running a repository-provided deploy script publishes a Worker that accepts a
publicly known admin credential. The signed lifecycle and P1 gates still reject
missing signatures, but the known bearer protects many other mutating or
sensitive routes and can be used for admin config/bundle mutation, DLQ
inspection/replay attempts, discovery, debug writes, deferred ingress, and task
starts in that deployment.

Calling the file “debug-only” does not make it nondeployable while the package
offers a direct deploy command for it.

### Required correction

1. Remove `deploy:bot-store`.
2. Remove `ADMIN_SECRET` from every tracked Wrangler `[vars]` block.
3. Supply local/test credentials only through the ignored `.dev.vars` path or
   Miniflare/Vitest bindings.
4. Add a deterministic repository check that fails if a Wrangler TOML embeds an
   admin/test bearer or if a deploy script targets a test/debug alias.
5. If this alias was ever deployed, treat credential rotation/removal as a
   separately approved external mutation; this rereview does not claim that it
   was deployed.

# NONBLOCKING

## N-01 — Direct Durable Object RPCs trust caller-asserted “verified” objects

Severity: medium defense-in-depth

Current reachability: no public Worker route or production source caller was
found

`WorkspaceConfigDO` accepts a structurally valid
`VerifiedKnowledgeSourceGrant` at
`/authorizedTrackedKnowledgeSourceAction` without re-verifying the compact
signature (`edge/src/config/workspace-config-do.ts:557-845`), and retains a
legacy unsigned `/putTrackedKnowledgeSource` mutation RPC
(`edge/src/config/workspace-config-do.ts:847-930`). `KnowledgeDO` similarly
accepts a structurally valid `VerifiedKnowledgeBackfillApproval` at
`/backfill/approve` (`edge/src/memory/knowledge-do.ts:641-675`).

Direct workerd calls can therefore fabricate the post-verification objects and
mutate source state or approve P1 without a signature. The workerd backfill
test does exactly this as setup after separately verifying a test artifact:
`edge/test/knowledge-ledger.workers.test.ts:798-814`.

This is not counted as blocking because the current public Worker routes verify
the compact artifacts before making these calls
(`edge/src/worker.ts:472-559,677-715`), the DO namespaces are not HTTP routes,
and no production source caller uses the unsigned legacy mutation. It is still
a brittle trust seam.

Correction: delete the legacy mutation RPC, drive workerd setup through the
signed route or a nondeployable fixture, and either verify the compact artifact
inside the owning DO or pass an unforgeable, short-lived internal capability
bound to the exact digest/action. Do not make “TypeScript says verified” the
only internal authority boundary.

## N-02 — Automatic Slack scheduling has a pre-descriptor loss window and treats every 2xx as “scheduled”

Severity: medium resilience/observability

Current impact: dormant because no source can be enabled through the public
authority and no production Queue is bound

The Events route acknowledges after putting
`scheduleKnowledgeFromSlackEvent` in `waitUntil`
(`edge/src/worker.ts:894-907`). Unlike file-turn/late-file ingress, it does not
persist a `DeferredIngressDO` owner before returning 200. Isolate loss before
`KnowledgeDO /descriptor` commits therefore leaves no durable intent for Slack
to redeliver. Reconciliation can recover authoritative Slack state later, but
the production cron is deliberately absent pending C1
(`edge/wrangler.bot.toml:64-71`).

The scheduler also increments `scheduled` for any HTTP 2xx without validating
the `{accepted, reason, descriptorKey}` body:
`edge/src/memory/knowledge-jobs.ts:162-189`. Duplicate/out-of-order 2xx results
are safe because an equal/newer durable ledger row exists, but the metric is
semantically false and a malformed 2xx would be accepted as success. The
reconciliation/backfill helper is stronger: it validates application
disposition and proves response loss from authoritative ledger/outbox state
(`edge/src/memory/knowledge-reconcile.ts:180-279`).

Correction: persist an exact Slack knowledge-ingress intent before ack using
the existing deferred-ingress pattern, or explicitly accept the bounded
waitUntil risk only after a live reconciliation SLA exists. Parse the
descriptor result and report accepted/duplicate/superseded separately.

## N-03 — Final retrieval rechecks source/access state but not every citation ledger state

Severity: low, narrow concurrent race

Search checks each citation's indexed revision/tombstone sequentially
(`edge/src/tools/search-slack.ts:204-231,303-306`), then performs a final
source/access check only (`edge/src/tools/search-slack.ts:307-316`). A citation
can be tombstoned or replaced after its individual ledger read while source
configuration and access remain unchanged; the final check does not detect
that ledger-only change.

Correction: add one bounded, final batch ledger endpoint in the team
`KnowledgeDO` and validate all selected `(sourceKey, contentRevision)` pairs at
one serialized acceptance point. Add a deletion/update race test. A change
after that acceptance point remains a normal distributed-systems boundary, but
the current avoidable per-citation window should be closed before broad
activation.

## N-04 — All teams share one operator Durable Object for reconciliation coordination and DLQ records

Severity: low operational isolation/scalability

The constant operator key is shared across all teams, and DLQ capture, list,
and replay use it:
`edge/src/memory/knowledge-reconcile.ts:458-675,720-861`. DLQ listing is global
and unfiltered by team:
`edge/src/memory/knowledge-ledger.ts:1535-1595`.

This is not an authorization leak under the current trusted global-admin model,
but it creates one cross-tenant serialization/hot-spot and makes every
ADMIN_SECRET holder a global DLQ reader.

Correction: document the global operator boundary and size limit explicitly,
or shard DLQ storage by exact `teamId` and require an exact team filter for
inspection/replay. Keep the scheduler coordinator global only if single-cycle
serialization is intentional.

# Explicit bypass matrix

| Attempt | Result | Evidence / decision |
| --- | --- | --- |
| `ADMIN_SECRET` without a source lifecycle grant | **Rejected** on public lifecycle routes | Public route requires admin bearer and Ed25519 artifact; absent verifier is 503 and absent artifact is 403 (`worker.ts:472-559`; `knowledge-source-authorization.ts:255-271`). |
| Lifecycle grant replay | **Rejected** | One-use `grant_id` is checked and the decision/audit is written in the same DO transaction (`workspace-config-do.ts:614-833`); workerd replay test passes (`knowledge-source-admin.workers.test.ts:53-77`). |
| Lifecycle scope/action/config/content mismatch | **Rejected** | Exact team/project/channel/action/config and request digest checks (`knowledge-source-authorization.ts:335-419`); CAS recheck and active-effect fence in the DO (`workspace-config-do.ts:630-676`). |
| Expired lifecycle grant | **Rejected** | Verifier and consume-time expiry checks (`knowledge-source-authorization.ts:402-411`; `workspace-config-do.ts:643-646`). |
| P1 self-mint through public admin body | **Rejected** | Body allows only team/digest and external Ed25519 verifier is mandatory (`worker.ts:677-715`; `knowledge-backfill.ts:783-827`). Workerd test rejects caller-controlled approval fields and an absent verifier (`knowledge-ledger.workers.test.ts:762-796`). |
| P1 replay | **Rejected** | Approval ID uniqueness and exact dry-run state (`knowledge-ledger.ts:2117-2206`). |
| P1 scope/count/rate/error/release/rollback mismatch | **Rejected** | Exact signed match in `knowledge-backfill-authorization.ts:265-405` and storage-time recheck in `knowledge-ledger.ts:2138-2163`. |
| P1 expiry before verification/claim | **Rejected** | External verifier and ledger claim both fail closed. |
| P1 expiry after claim | **FAIL — B-02** | Pending page becomes unrecoverable through supported routes. |
| Direct DO fabricated lifecycle/P1 object | **Internally succeeds — N-01** | No public route/caller found, but the DO itself does not possess cryptographic proof. |
| Scheduled overlap | **Rejected as busy** | Coordinator lease/fence and overlap test (`knowledge-ledger.ts:1292-1533`; `knowledge-ledger.test.ts:481-516`). |
| Scheduled restart/continuation | **Resumes same cycle/page** | Durable coordinator and uncommitted page tests (`knowledge-ledger.workers.test.ts:478-509,522-575`). |
| Schedule without live enablement/Queue | **Fails closed / disabled** | Exact `"true"` enable flag, Queue requirement, exact queue names, and bounded team scope (`knowledge-reconcile.ts:458-518`). No production trigger/binding exists. |
| Queue names missing, identical, swapped, or unknown | **Rejected; batch retried before parsing** | `knowledge-queue-routing.ts:10-49`, `worker.ts:1175-1194`, and `knowledge-queue.test.ts:171-206`. |
| Reconcile descriptor false-success/response loss | **Recovered only with authoritative proof** | Response body validation and ledger/outbox proof (`knowledge-reconcile.ts:180-279`); focused tests cover duplicate and accepted-response-lost (`knowledge-reconcile.test.ts:266-341`). |
| Automatic event descriptor false-success/precommit loss | **Residual — N-02** | Event scheduler checks HTTP status only and has no pre-ack durable owner. |
| First-page discovery failure | **Restart-safe** | No merge occurs until Slack page success; initial channel remains `unvisited` (`knowledge-backfill.ts:662-699`; `knowledge-ledger.test.ts:68-168`). |
| Per-channel unvisited state hidden/skipped | **Rejected** | Discovery always selects the first non-exhausted channel and manifests require every channel exhausted (`knowledge-backfill.ts:669-738`). |
| Incomplete discovery approval | **Rejected** | Approval requires durable complete discovery, all exhausted channels, exact candidate count, and recomputed digest (`knowledge-backfill.ts:701-827`). |
| Partial page restart | **Resumes exact page/results** | Pending token/jobs/results are durable; classified jobs are skipped (`knowledge-backfill.ts:960-1076`; focused partial-page test passes). |
| Backfill cursor/status CAS or source config drift | **Rejected/blocked** | Expected status/cursor merge and immutable scope/config versions (`knowledge-backfill.ts:546-753`; `knowledge-ledger.workers.test.ts:198-269`). |
| Slack reply deletion as source delete | **FAIL — B-01** | Ordinary reply deletion permanently tombstones parent thread. |
| Test/private key in production config | **No Ed25519 private signing key found** | Test signing bytes remain in `edge/test/helpers`; production verifier tuples are absent pending gates. |
| Test admin bearer in deployable config | **FAIL — B-03** | Explicit deploy script targets a TOML with a known `ADMIN_SECRET`. |

# Validation

All commands ran against the same dirty combined working tree. Green results
prove the tested contracts; they do not negate source-traced, untested attacks.

| Command | Result |
| --- | --- |
| Focused unit behaviors: `npx vitest run` over backfill, config, ledger, Queue, reconcile, source-admin, thread-fetcher, normalization, retrieval, and adapter tests | **PASS — 10 files, 93 tests** |
| Focused workerd behaviors: source-admin, ledger, and workspace-config | **PASS — 3 files, 17 tests** |
| `cd edge && npm run typecheck` | **PASS** |
| `cd edge && npm test` | **PASS — 67 files, 814 tests** |
| `cd edge && npm run test:e2e` | **PASS — 4 files, 42 tests** |
| `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` | **PASS** |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py` | **PASS — validator-reported focused 134 unit / 17 workerd and 50 required files** |

The green suite misses the blockers for specific reasons:

- It intentionally asserts permanent tombstone precedence after a newer
  descriptor (`knowledge-ledger.test.ts:845-862`) but has no reply-deletion
  authorization/availability adversary.
- It tests P1 expiry before approval and partial-page restart, but not approval
  expiry after page claim or after a partial disposition
  (`knowledge-backfill.test.ts:165-235,238-340` and
  `knowledge-ledger.workers.test.ts:659-885`).
- The validators check declared paths, strings, pins, and their selected tests;
  they do not prove that a package deploy script cannot publish a known admin
  bearer or that an unmodeled Slack event cannot exercise a destructive state
  transition.

# External gates

These are real external blockers/stop gates, not defects to “fix” by silently
adding live configuration:

1. **R1:** re-verify the exact `server-v0.0.5` artifact/image checksum, supported
   API/status semantics, host/health behavior, provider/model variables,
   first-boot key path, log redaction, service-scoped OpenAI key ownership,
   data-egress/retention, region/sizing/cost, and one-volume/one-replica plan.
2. **R2:** approve and prove the synthetic same-service native backup/restore,
   restart persistence, original-volume rollback, and supported key-rotation
   procedure.
3. **C1:** approve exact Cloudflare target, Queue and DLQ names/policies,
   producer/consumer bindings, public verifier tuples, secrets, scheduled
   trigger/team scope, staging deploy, and rollback. Queue names and trigger
   bindings are correctly absent from `edge/wrangler.bot.toml`.
4. **S1:** approve exact Slack staging scopes/subscriptions and exact test
   channels before any Slack application mutation.
5. **P1:** select the external signing authority and approve the exact
   team/project/channel, readers, retention, release IDs, rollback owner,
   maximum count/rate/errors, date range, one-channel canary, and each immutable
   dry-run manifest separately.

This rereview performed no read/write external verification and therefore does
not claim any of these gates is satisfied.

# Final decision and counts

**Verdict: NOT READY.** The dormant signed lifecycle and P1 public routes are
substantially stronger and correctly fail closed while verifier configuration
is absent. Queue routing, durable outbox/lease behavior, scheduler fencing,
reconciliation response-loss proof, bounded discovery, manifest completeness,
scope/CAS checks, Local effect fencing, and retrieval authorization are
generally defensible in the reviewed source.

That does not make B0-B4 source-ready. B-01 permits destructive knowledge
denial by an ordinary channel member, B-02 has no supported recovery from a
valid P1 timing boundary, and B-03 places a known admin credential behind a
repository-provided deploy command. Correct all three, add the specified
adversarial tests, rerun the focused/full suites and both validators, and then
perform another fresh source review before claiming B0-B4 complete.

- **BLOCKING: 3**
- **NONBLOCKING: 4**
- **External stop-gate groups still open: 5 (R1, R2, C1, S1, P1)**
- **Deployments, secret changes, external mutations, and Git mutations: 0**
