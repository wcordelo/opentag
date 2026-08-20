# Post-correction integration audit — Supermemory Local B0-B4

**Audit date:** 2026-07-25 (America/Los_Angeles)
**Scope:** the current combined working tree, after correction of the seven
BLOCKING findings in `ADVERSARIAL-REVIEW.md`. This is the integration audit,
not the required fresh independent re-review. No deployment, secret operation,
source enablement, Queue/DLQ binding, Railway or Slack mutation, git-history
mutation, canary, or backfill execution occurred.

> **Historical review note (2026-08-02).** This integration report predates
> the current durable knowledge-event and outbound-observation ownership
> changes. Its `waitUntil` descriptions and line references are retained as
> historical evidence; current behavior is recorded in
> [`docs/current-state.md`](../../docs/current-state.md) and the
> [knowledge contract audit](../knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md).

## Integration verdict

All seven original BLOCKING findings now have connected source corrections and
focused behavioral coverage. The production caller paths were traced from the
Slack/Queue/admin/tool entrypoints through the Durable Objects and external
adapter boundaries. No blocking source issue from those seven findings remains
in this integration audit.

Task G is not complete: a different fresh reviewer must still independently
review the corrected combined tree and report zero BLOCKING findings before R1
planning or external action. The external/runtime proofs listed below also
remain unresolved by design.

## Finding-by-finding correction evidence

### 1. Local document IDs can no longer be relabeled as a newer revision

**Correction.**

- The ledger now persists `local_document_revision` separately from the latest
  `desired_revision`, and separately persists the add attempt token/revision
  (`edge/src/memory/knowledge-ledger.ts:14-20,434-462`).
- A superseding descriptor clears the latest desired revision but does not
  clear the accepted Local ID, its bound revision, or the add-attempt identity
  (`edge/src/memory/knowledge-ledger.ts:493-513`).
- `prepareRevision()` polls a retained ID only when
  `localDocumentRevision === desiredRevision`; a different revision stops as
  `unsupported_update_contract` (`edge/src/memory/knowledge-ledger.ts:763-809`).
- Late `/localAccepted` recording is accepted only for the exact persisted add
  attempt and revision, while conflicting IDs/revisions fail closed
  (`edge/src/memory/knowledge-ledger.ts:813-849`;
  `edge/src/memory/knowledge-do.ts:196-232`).
- Terminal `indexed` and `processing_unconfirmed` outcomes require the exact
  current lease, Local ID, and Local-bound revision. A superseded old lease
  cannot mark the new descriptor indexed
  (`edge/src/memory/knowledge-ledger.ts:682-733`).

**Behavioral evidence.**

- Node SQLite tests cover supersession before add, after `add_started`, after
  Local acceptance, during polling, and immediately before terminal outcome;
  they prove late acceptance remains revision-bound and stale terminal writes
  fail (`edge/test/knowledge-ledger.test.ts:215-315`).
- Workerd repeats all five interleavings through the actual KnowledgeDO RPCs
  (`edge/test/knowledge-ledger.workers.test.ts:7-129`).

**Cross-fix result.** A later content revision can no longer poll the earlier
document as if it contained the later content. Because Local update semantics
remain unverified, the safe terminal behavior is a visible
`unsupported_update_contract` stop, not a guessed second add/update.

### 2. B4 recovery is connected to durable runtime/operator seams

**Correction.**

- `KnowledgeLedger` owns restart-safe reconciliation runs with a persisted
  cursor, claimed page token/body, counts, and commit
  (`edge/src/memory/knowledge-ledger.ts:58-70,864-1003`).
- `runKnowledgeReconciliationPage()` claims one bounded page for one exact
  team, reloads every exact `WorkspaceConfigDO` source, sends selected work
  through the normal durable descriptor/outbox path, and advances only after
  the page commits (`edge/src/memory/knowledge-reconcile.ts:133-262`).
- The authenticated admin route is the actual caller
  (`edge/src/worker.ts:456-476`).
- The future exact DLQ consumer persists actual Queue messages before ack;
  inspection is cursor-bounded; replay claims one durable record, requires an
  exact source plus correction reference, reloads current config, and returns
  through the normal outbox (`edge/src/memory/knowledge-reconcile.ts:303-437`;
  `edge/src/memory/knowledge-ledger.ts:1005-1139`;
  `edge/src/worker.ts:478-512,1021-1032`).
- Backfill performs bounded Slack discovery only for one exact team/project and
  a non-empty exact channel list. It pins each source's own config version,
  stores a canonical SHA-256 manifest, and executes restart-safe pages only
  after digest/scope/config/P1 checks
  (`edge/src/memory/knowledge-backfill.ts:90-139,219-329,359-593`).
- Ordinary `/descriptor` rejects all backfill jobs. Only a job in the current
  claimed page of the persisted approved manifest can enter the outbox
  (`edge/src/memory/knowledge-do.ts:133-148,386-537`).
- Admin callers are connected for discover, approve, and execute
  (`edge/src/worker.ts:514-594`).

**Behavioral evidence.**

- Unit tests cover live versus expired leases, authoritative config reload,
  durable-page continuation, actual DLQ capture before ack, and one-record
  replay (`edge/test/knowledge-reconcile.test.ts:37-54,79-238`).
- Backfill tests cover per-source versions, digest tamper, config drift, exact
  team scope, and no empty/all-workspace discovery default
  (`edge/test/knowledge-backfill.test.ts:42-71,74-175`).
- Workerd tests prove the claimed reconciliation page survives continuation,
  DLQ state is durable, direct backfill descriptors fail, and claim/enqueue
  requires persisted P1 plus the current page token
  (`edge/test/knowledge-ledger.workers.test.ts:187-373`).

**Important limit.** Reconciliation is an authenticated, manually invoked,
one-page-at-a-time operator control. There is no periodic alarm, cron, or
scheduled reconciliation caller in this tree. The correction supplies an
executable durable recovery path and clears the original disconnected-planner
blocker, but it must not be described as periodic. Scheduling and operational
cadence remain future C1/operations work.

### 3. Reader policy is enforced against the exact turn

**Correction.**

- Source policy is canonical `bundle:{bundleId}`, not a free-form authorization
  label (`edge/src/config/knowledge-config.ts:47-95`).
- `searchSlackKnowledge()` requires a frozen exact-team/channel/conversation/
  execution human permission snapshot that already allows `search_slack`
  (`edge/src/tools/search-slack.ts:40-70,234-267`).
- It reloads the current channel config and exact bundle, requires that bundle
  to allow `search_slack`, and requires the source policy to name that same
  bundle before Local is called (`edge/src/tools/search-slack.ts:78-155`).
- It repeats source and bundle/policy checks after Local and again after the
  awaited ledger checks before returning any excerpt
  (`edge/src/tools/search-slack.ts:284-316`).
- The tool handler derives team/channel from request context, requires the
  exact active execution and its permission snapshot, and checks the durable
  exact turn both before and after retrieval
  (`edge/src/tools/search-slack.ts:326-359`;
  `edge/src/tools/index.ts:64-85,544-548,684-706`).
- The real agent-turn path resolves the bundle, removes non-automation-safe
  tools for automation actors, builds/binds the exact permission snapshot, and
  passes the guarded edge tools to the agent
  (`edge/src/agent-turn.ts:673-759`).

**Behavioral evidence.**

- Search tests cover matching policy, wrong bundle, wrong source policy, a
  bundle without the tool, source/bundle/policy changes during Local, wrong
  team/channel scope, automation, and exact-turn Stop winning during Local
  (`edge/test/search-slack.test.ts:133-280`).
- Agent-turn integration coverage proves an explicit human bundle exposes
  `search_slack` and the same nominal bundle does not expose it to automation
  (`edge/test/agent-turn-harness.test.ts:362-404`).

### 4. Config changes fence already leased ingestion effects

**Correction.**

- `WorkspaceConfigDO` persists bounded ingestion-effect leases scoped to the
  exact team/project/channel/config version
  (`edge/src/config/workspace-config-do.ts:65-76,341-487`).
- The Queue consumer acquires this config-effect lease before its ledger lease,
  supplies a renewing `validateSource()` function to dispatch, and releases the
  effect in `finally` (`edge/src/memory/knowledge-jobs.ts:270-360`).
- Dispatch validates the same effect after Slack fetch, around revision
  preparation, immediately before Local add, immediately after Local accepts,
  before polling, and before every recorded outcome
  (`edge/src/memory/supermemory-adapter.ts:299-487`).
- A source disable or policy/version write returns 409 while an exact effect is
  active. After release/expiry, a successful write commits the new version; a
  stale Queue attempt then fails its exact version/effect checks
  (`edge/src/config/workspace-config-do.ts:489-585`).
- The maximum fetch/add/poll path is deliberately shorter than both durable
  leases (`edge/src/memory/knowledge-contract.ts:15-29`).

**Behavioral evidence.**

- Workerd proves both disable and policy changes are rejected while an effect
  is live, then permits disable after release
  (`edge/test/workspace-knowledge-config.workers.test.ts:57-107`).
- Dispatch tests inject config invalidation after fetch, after `add_started`,
  before `/localAccepted`, and before terminal outcome and assert no later
  unsafe effect/state acceptance occurs
  (`edge/test/supermemory-adapter.test.ts:141-229`).

**Cross-fix result.** A completed disable cannot be followed by a stale add.
An update attempted during an effect is not reported as complete; it receives
409 and must be retried after the bounded effect releases or expires. This is
quiescence-by-admission, not asynchronous cancellation of an in-flight Local
request.

### 5. Slack pagination is bounded by request and overall deadlines

**Correction.**

- The fetch outcome has an explicit `timeout` incomplete reason
  (`edge/src/slack/knowledge-thread-fetcher.ts:25-52`).
- `fetchKnowledgeThread()` creates an overall abort controller/deadline/timer,
  passes the signal/deadline to every page, and races even a signal-ignoring
  reader against the deadline (`edge/src/slack/knowledge-thread-fetcher.ts:105-208`).
- The production page reader applies a per-attempt abort timeout, forwards the
  overall signal to `fetch`, bounds `Retry-After`, refuses a sleep that would
  exceed the overall deadline, and bounds response-body parsing
  (`edge/src/slack/knowledge-thread-fetcher.ts:210-325`).
- The fixed execution budgets keep the maximum Slack/add/poll/control path
  below the ledger and config-effect leases
  (`edge/src/memory/knowledge-contract.ts:15-29`).

**Behavioral evidence.**

- Tests cover an overall-deadline-only reader, a hung transport that settles
  only on abort, total-budget exhaustion across 429 retries, and the numeric
  lease-budget relationship
  (`edge/test/knowledge-thread-fetcher.test.ts:150-212`).

### 6. Disabled-first staging can receive exactly one first activation

**Correction.**

- Tracked sources persist `ever_enabled`; migration marks previously enabled
  rows as historical (`edge/src/config/workspace-config-do.ts:48-59,129-151`).
- Disabled-never-enabled to enabled is allowed and sets `ever_enabled=1`.
  Enabled-then-disabled to enabled remains blocked until Local deletion/reindex
  semantics are verified (`edge/src/config/workspace-config-do.ts:489-585`).
- The one-enabled-project partial unique index remains authoritative during
  concurrent first activation (`edge/src/config/workspace-config-do.ts:60-64`).

**Behavioral evidence.**

- Workerd covers disabled-first activation, post-disable re-enable denial, and
  concurrent conflicting projects (`edge/test/workspace-knowledge-config.workers.test.ts:5-55`).

### 7. Docker default argv no longer repeats the server binary

**Correction.**

- Docker uses the wrapper as `ENTRYPOINT` and an empty JSON `CMD`; the wrapper
  alone selects the pinned binary (`infra/supermemory/Dockerfile:39-42`;
  `infra/supermemory/entrypoint.sh:7-8,52-71`).

**Behavioral evidence.**

- The argv fixture checks the exact Dockerfile contract and executes the wrapper
  with no arguments, while the existing tests also prove secret redaction,
  signal forwarding, and child status propagation
  (`edge/test/supermemory-entrypoint.test.ts:23-65`).

The real pinned image has not been built or started; that remains an approved
R1 runtime proof, not a local source fact.

## Cross-fix and caller-connectivity conclusions

- Slack ingestion remains connected only through verified Events handling,
  `waitUntil`, KnowledgeDO outbox, optional Queue, and the `opentag-bot`
  `queue()` handler. Ordinary turns cannot reach ingestion.
- The config-effect lease is acquired before the ledger/network dispatch and is
  revalidated across every external-effect boundary. The revision-bound Local
  ID checks independently prevent a newer descriptor from accepting an older
  Local outcome.
- `search_slack` is a real guarded edge tool, not only a standalone helper. It
  uses the permission snapshot created by the actual agent-turn path and closes
  both source-policy and exact-turn Stop races.
- Reconciliation, DLQ, and backfill are connected to authenticated admin and
  Queue entrypoints, while all live Queue/DLQ bindings and data execution remain
  gated.
- Backfill execution is mechanically non-bypassable through the implemented
  runtime paths: ordinary descriptors reject backfill jobs; claim requires a
  persisted P1 record; enqueue requires the exact current approved manifest
  page; digest/scope/config are rechecked.

The P1 approval record is an administrator attestation. `ADMIN_SECRET`
authentication and the persisted fields do not cryptographically prove that
the user granted external P1 approval, and the route accepts the bounded
approval reference/approver/time supplied by the administrator. No P1 approval
was requested or recorded during this audit. Operational procedure must verify
the external approval before calling the approve route.

## Validation evidence

All commands ran on the combined current tree from
`/Users/will/Documents/opentag` unless shown otherwise.

| Command | Result |
| --- | --- |
| `cd edge && npm run typecheck && npm test && npm run test:e2e` | PASS: TypeScript no-emit; 66 unit files / 800 tests; 3 workerd files / 34 tests |
| `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` | PASS: 48,821-byte SPEC and 15,265-byte Railway readiness report |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py` | PASS: source/call-path checks plus 9 focused unit files / 120 tests and 2 focused workerd files / 9 tests |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py --source-only` | PASS: deterministic source/call-path checks; behavioral suites explicitly skipped |
| `git diff --check` | PASS: no tracked-diff whitespace errors; the three integration-output files also passed a direct trailing-whitespace scan because the goal-output tree is currently untracked |
| high-confidence secret-pattern scan, filename-only output over all 58 changed regular files | PASS: no matching filename; no matched value was printed |

The implementation validator now checks ordered caller/effect paths, exact
admin-route connectivity, revision-bound terminal conditions, timeout signal
propagation, exact-turn reader authorization, backfill/P1 routing, and Docker
argv shape. Its default mode also runs the focused correction suites; it no
longer infers all seven behaviors from file sizes and isolated substrings.

## Unresolved external-only and future-stage risks

- A different fresh independent adversarial re-review is still required before
  Task G can close.
- Reconciliation has no periodic schedule. Operators must explicitly continue
  the returned run ID page by page until a future approved scheduler exists.
- P1 is a persisted admin attestation, not independently verified user-approval
  evidence. No canary or backfill approval has occurred.
- Production Queue/DLQ bindings, exact retry/retention policy, source
  enablement authority, Slack scope/subscriptions, Local URL/key, and deployed
  admin controls remain absent or unexercised until C1/S1/P1.
- Local update/delete/get-by-custom-ID/idempotency/replacement semantics remain
  unverified. Edits, deletes, and ambiguous adds continue to block safely.
- The real pinned Local image has not been built or started. Artifact,
  checksum, bind/health, generated-key path/rotation, non-root volume ownership,
  real first-boot redaction, model availability/egress, authenticated
  add-to-done-to-search, cross-workspace isolation, restart persistence,
  backup/restore, and key rotation remain R1/R2 runtime proofs.
- No Railway service/volume/domain, Cloudflare Queue/DLQ, Slack configuration,
  source row, canary, live reconciliation cadence, or backfill target is
  asserted by this report.

## Gate conclusion

**Blocking source issues remaining from the seven original findings: 0.**

Task H/R1 remains blocked on the separately required fresh independent
re-review. All external gates remain unchanged.
