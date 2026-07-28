# Combined integration audit after the second correction cycle

**Date:** 2026-07-25 (America/Los_Angeles)
**Scope:** the current combined dirty working tree in
`/Users/will/Documents/opentag`
**Result:** **0 known source blockers remain across the 6 BLOCKING findings in
`ADVERSARIAL-REREVIEW.md` after 2 narrow integration fixes.**

This audit read the current authoritative `KNOWLEDGE-BASE-SPEC.md`,
`DECISIONS.md`, `AGENTS.md`, both adversarial reviews, the relevant current
source/tests/configuration/operations documentation, both validators, and
`IMPLEMENTATION-REPORT.md`. It traced each correction through its actual Worker
entry point, Durable Object transaction, downstream caller, recovery path, and
focused behavior tests. Green validators were not treated as proof until their
claims were checked against those call paths.

No Worker or Container was deployed. No Railway, Cloudflare, Slack, Queue,
secret, source-row, canary, backfill, git-reference, or other external mutation
was performed.

## Audit verdict

| Rereview finding | Final source disposition | Runtime caller | Focused proof |
| --- | --- | --- | --- |
| 1. No authorized source lifecycle | Corrected | Signed admin routes -> exact workspace `WorkspaceConfigDO` transaction | Route unit plus workerd lifecycle/replay/race tests |
| 2. Reconciliation is manual only | Corrected, dormant behind C1 | Worker `scheduled()` -> durable global coordinator -> restart-safe per-team pages | Scheduler completion, overlap, restart, backoff, and partial-page tests |
| 3. P1 is caller self-attestation | Corrected for backfill P1, external authority still unconfigured | Admin approval route verifies external Ed25519 artifact -> durable one-use P1 record -> execution | Signature/scope/budget/expiry/replay/workerd tests |
| 4. Queue routing fails open | Corrected, no binding live | Worker `queue()` -> exact primary/DLQ role router; unknown names retry then throw before parse | Router unit tests and Worker-entry body-nonparse test |
| 5. Incomplete discovery is approvable | Corrected after one audit fix | Caller-known manifest ID -> durable per-channel cursor/CAS -> complete-only manifest/approval | Multi-channel/page-cap/config-drift/first-page-failure tests |
| 6. Descriptor rejection is treated as success | Corrected | Shared authoritative disposition proof used by reconcile, DLQ replay, and backfill partial pages | Duplicate/response-loss/supersession/partial-page tests |

The two narrow audit fixes were:

1. Backfill discovery now requires a caller-selected bounded `manifestId` before
   any state or Slack request. This closes the recovery hole where the server
   could persist a generated ID and then fail before returning it.
2. The committed test source-verifier tuple was removed from the deployable
   `edge/wrangler.bot-store.toml` alias and moved to Miniflare-only Vitest
   bindings. No deployable configuration now contains a source-lifecycle or P1
   verifier tuple.

## 1. Independently signed exact-scope lifecycle grants and durable audit

### Source and caller evidence

- `edge/src/config/knowledge-source-authorization.ts:7-45` defines the separate
  grant header, exact action vocabulary, actor identity, exact
  team/project/channel scope, expected config version, request/artifact
  digests, issuer/key, and issued/expiry times.
- `edge/src/config/knowledge-source-authorization.ts:255-435` verifies Ed25519,
  exact protected-header/payload fields, issuer/key, action/scope/config,
  request digest, maximum five-minute lifetime, and expiry. The Worker has no
  signing path.
- `edge/src/worker.ts:467-525` requires both `ADMIN_SECRET` and the signed
  artifact, routes only to the DO named by the verified `teamId`, and forwards
  parsed grant evidence rather than the artifact.
- `edge/src/worker.ts:527-558` exposes distinct inspect, exact-list,
  stage-disabled, update-disabled, first-enable, and disable routes. There is no
  wildcard or generic write route on the Worker.
- `edge/src/config/workspace-config-do.ts:83-107` defines the durable
  authorization audit table and exact-scope index.
- `edge/src/config/workspace-config-do.ts:557-833` atomically rejects grant
  replay, stale config, active ingestion effects, conflicting projects, invalid
  lifecycle transitions, and expiry-at-consume; it records actor, issuer/key,
  artifact/request digests, exact scope, before/after versions, outcome, and
  consume time in the same transaction as the source action.

### Bypass and cross-fix result

`putTrackedKnowledgeSource` remains an internal binding-only compatibility/test
RPC in `WorkspaceConfigDO`; a non-test caller scan found no runtime caller and
the Worker exposes no route to it. Every externally reachable lifecycle
transition uses `authorizedTrackedKnowledgeSourceAction`. Disable and policy
changes also share the ingestion-effect fence, so a signed grant cannot race an
active Local effect into a stale transition.

### Test evidence

- `edge/test/knowledge-source-admin.test.ts:64-180` proves both credentials are
  required, an unset verifier returns unavailable, verified evidence alone is
  forwarded, and cross-project grants fail before the DO call.
- `edge/test/knowledge-source-admin.workers.test.ts:54-284` proves durable
  stage/update/first-enable/list/disable audit, one-use replay rejection,
  wildcard/cross-scope/wrong-action/request/expiry denial, conflicting-project
  disposition, and active-effect fencing.

### External-only gate

C1/S1 must select and approve the external issuer, key ID, public verifier,
actor model, and exact staging matrix. No deployable verifier value, issuer,
private signing key, or tracked source is present. Deterministic test keys exist
only in test helpers and Miniflare-only bindings.

## 2. Dormant but complete scheduled coordinator, fence, continuation, and metrics

### Source and caller evidence

- `edge/src/memory/knowledge-ledger.ts:83-105` defines the durable global
  coordinator record.
- `edge/src/memory/knowledge-ledger.ts:1292-1530` implements single-cycle
  acquisition, overlap fencing, lease-expiry reclaim, scope-digest drift reset,
  page checkpoint, team advancement, bounded backoff, release, completion, and
  persisted counters/error codes.
- `edge/src/memory/knowledge-do.ts:303-415` exposes only the internal
  coordinator claim/checkpoint/advance/release/fail RPCs.
- `edge/src/memory/knowledge-reconcile.ts:458-679` requires the exact enable
  flag, Queue producer binding, role-valid Queue names, and a bounded exact team
  list. It resumes a stable per-team run/page, bounds one invocation, continues
  later schedules, and emits run-start/page/lag/run-error/run-complete metrics.
- `edge/src/worker.ts:1195-1206` is the actual source-level `scheduled()` caller
  and places the coordinator in `waitUntil`.

### Bypass and cross-fix result

The authenticated `/admin/knowledge/reconcile` route remains an exact-team
diagnostic page, not the cadence engine. The coordinator freezes the team list
and digest and calls the same restart-safe per-team run/page implementation.
It validates exact Queue role configuration before beginning, so scheduler
activation cannot bypass finding 4.

### Test evidence

- `edge/test/knowledge-reconcile.test.ts:344-622` proves completion without
  manual calls, durable continuation, bounded pages, and a partial-page failure
  that remains uncommitted and enters persisted backoff.
- `edge/test/knowledge-ledger.test.ts:481-586` proves overlap fencing, reclaim,
  scope drift reset, backoff, page checkpoints, and cycle completion.
- `edge/test/knowledge-ledger.workers.test.ts:525-578` proves the coordinator
  fence in workerd.

### External-only gate

C1 must approve and add the actual cron trigger, producer/consumer bindings,
exact primary/DLQ names, retry/retention policy, enable flag, exact team scope,
and deployed metric sink verification. All are absent today; source code alone
does not claim periodic production convergence.

## 3. Independent external signed P1 with exact scope, budget, releases, expiry, rollback, and non-replay

### Source and caller evidence

- `edge/src/memory/knowledge-backfill-authorization.ts:3-43` defines a separate
  P1 artifact type and verifier configuration. It is independent from
  `ADMIN_SECRET` and from source-lifecycle grant types.
- `edge/src/memory/knowledge-backfill-authorization.ts:170-435` verifies Ed25519
  and binds approval ID, human approver, manifest ID/digest, exact
  team/project/channels/range, maximum count/rate/errors, release IDs, rollback
  owner, issuer/key, issued time, expiry, and a maximum 24-hour lifetime.
- `edge/src/worker.ts:677-715` accepts only `teamId` and `manifestDigest` in the
  approval JSON and gets the artifact from its dedicated header; caller-supplied
  approver/reference/time/gate fields are rejected.
- `edge/src/memory/knowledge-backfill.ts:783-828` reloads the complete persisted
  manifest, recomputes the digest, verifies the external artifact, and forwards
  only verified evidence to KnowledgeDO.
- `edge/src/memory/knowledge-ledger.ts:2086-2212` persists one-use approval
  evidence, rejects approval ID replay, rechecks complete discovery and every
  bound field, and marks only that manifest approved.
- `edge/src/memory/knowledge-ledger.ts:2214-2305` and
  `edge/src/memory/knowledge-do.ts:680-744` recheck unexpired P1 evidence,
  manifest identity, count/rate/error budget, current page, and job membership
  at claim and enqueue.
- `edge/src/worker.ts:718-745` is the separate execution route; its bearer can
  execute only a previously externally approved manifest and cannot mint P1.

### Bypass and cross-fix result

The ordinary `/descriptor` endpoint rejects every `reason: "backfill"` job.
Only a job in the current page of the complete P1-approved manifest can reach
the outbox. Replaying the same approval ID is rejected durably. Approval expiry
is checked both before page claim and before each enqueue, closing a
claim-then-expire effect race.

### Test evidence

- `edge/test/knowledge-backfill.test.ts:159-236` proves missing verifier,
  invalid signature, expiry, and every signed scope/budget/release/rollback/
  digest mismatch fails.
- `edge/test/knowledge-ledger.workers.test.ts:659-859` proves caller
  self-attestation is rejected, missing verifier is unavailable, P1 evidence is
  one-use, ordinary descriptor bypass is blocked, and only the current approved
  page executes.

### External-only gate

P1 authority selection, public verifier configuration, the actual canary
decision, and every real backfill approval remain external. No P1 issuer/key,
artifact, approval record, canary, or live backfill exists. The one-channel
canary still requires its separate explicit P1 approval before an external
source authority may issue the corresponding first-enable grant.

## 4. Exact fail-closed Queue name routing

### Source and caller evidence

- `edge/src/memory/knowledge-queue-routing.ts:1-38` requires both exact names,
  distinct roles, primary without `-dlq`, DLQ with `-dlq`, exact delivery-name
  equality, and throws for missing/swapped/unknown names.
- `edge/src/memory/knowledge-queue-routing.ts:40-50` retries the batch without
  inspecting its bodies.
- `edge/src/worker.ts:1176-1194` invokes the router before either handler.
  Routing failure retries, emits a bounded routing metric, and throws; only the
  exact DLQ reaches durable DLQ capture and only the exact primary reaches
  ingestion.

### Test evidence

- `edge/test/knowledge-queue.test.ts:169-208` covers exact primary/DLQ,
  arbitrary, missing, identical, and swapped names plus body-independent retry.
- `edge/test/knowledge-ledger.workers.test.ts:273-301` invokes the actual Worker
  Queue entry with a body getter that would throw if parsed and proves unknown
  routing retries before parsing.

### External-only gate

Production `wrangler.bot.toml` has no Queue producer, consumer, primary/DLQ
name, or retry policy. C1 must approve and validate all of them together before
deployment.

## 5. Complete restart-safe per-channel discovery with no approvable incomplete state

### Source and caller evidence

- `edge/src/memory/knowledge-backfill.ts:551-608` now requires a
  caller-selected bounded `manifestId` before any state or Slack work, loads an
  existing exact scope when present, and otherwise starts that same known ID.
- `edge/src/memory/knowledge-backfill.ts:647-753` starts or resumes durable
  discovery, processes at most 20 pages, preserves each channel cursor, returns
  `discovering` while incomplete, and creates a manifest only after reloading a
  fully complete candidate set.
- `edge/src/memory/knowledge-ledger.ts:1736-1972` persists every requested
  channel as `unvisited`, `pending`, or `exhausted`, merges one page under an
  expected status/cursor transaction, preserves deduplicated candidates, and
  reaches `complete` only when every channel is exhausted. Over-budget and
  config-drift states are terminal/inert.
- `edge/src/memory/knowledge-ledger.ts:1976-2075` accepts a manifest only when
  the durable discovery is complete, every channel is exhausted, jobs exactly
  match candidates/scope/config, and the final count is within budget.
- `edge/src/memory/knowledge-backfill.ts:763-828` and
  `edge/src/memory/knowledge-ledger.ts:2117-2164` reject approval for anything
  except that complete canonical persisted manifest.

### Narrow audit fix and tests

Before this audit, a first invocation without a caller ID could persist a
server-generated discovery and fail on the first Slack page before returning
the ID. The state was durable but operationally undiscoverable. The runtime now
requires the stable ID up front.

- `edge/test/knowledge-ledger.workers.test.ts:23-125` proves a 20-page first
  channel leaves later channels visibly unvisited and the same manifest
  continues to complete all channels.
- `edge/test/knowledge-ledger.workers.test.ts:127-203` proves a caller-known
  manifest survives a failed first Slack page and resumes to a complete
  manifest.
- `edge/test/knowledge-ledger.workers.test.ts:205-271` proves config drift makes
  the durable discovery permanently inert.
- `edge/test/knowledge-ledger.test.ts:68-286` proves per-channel states, cursor
  CAS, unvisited visibility, later-channel exhaustion, and over-budget
  completion behavior.

### External-only gate

Real Slack history/scopes, exact source rows, a live token, and the final P1
manifest review remain S1/P1 external gates. No discovery or manifest was
created outside local tests.

## 6. Authoritative descriptor acceptance and dispositions for reconcile, DLQ, and backfill partial pages

### Shared source proof

- `edge/src/memory/knowledge-reconcile.ts:162-243` defines the only safe
  dispositions and proves them against exact ledger identity, authoritative
  current source/config, outbox descriptor key, requested time, and converged
  revision.
- `edge/src/memory/knowledge-reconcile.ts:245-279` treats HTTP 2xx as transport
  success only. It advances on a directly accepted result or an authoritative
  exact duplicate, `accepted_response_lost`, converged, or superseded proof;
  malformed/unproved rejection throws.

### Reconciliation caller

`edge/src/memory/knowledge-reconcile.ts:294-410` classifies each descriptor,
tracks disposition counts, and commits the page only after every claimed row is
either explicitly skipped by policy or safely classified. The durable page
token remains uncommitted on error.

### DLQ caller

`edge/src/memory/knowledge-reconcile.ts:778-861` claims one exact durable record,
reloads exact source/config, submits through the shared descriptor proof, and
persists the exact disposition. `edge/src/memory/knowledge-ledger.ts:1656-1691`
labels only directly observed acceptance `replayed`; safe response-loss,
duplicate, converged, and superseded outcomes are terminal `disposed`
dispositions. Unproved failure releases the replay claim.

### Backfill caller

- `edge/src/memory/knowledge-backfill.ts:845-890` parses the application result
  and uses the same authoritative proof after rejection, malformed response, or
  response loss.
- `edge/src/memory/knowledge-backfill.ts:900-1103` persists each classified job
  disposition as it arrives. A later failure returns `pageStatus: "partial"`
  with successful results retained and no cursor advance.
- `edge/src/memory/knowledge-ledger.ts:2319-2480` permits only safe
  dispositions, rejects conflicts, records a bounded visible page error, and
  refuses commit until every exact pending job is classified.

### Test evidence

- `edge/test/knowledge-reconcile.test.ts:266-343` proves exact duplicate and
  accepted-but-response-lost classification.
- `edge/test/knowledge-reconcile.test.ts:623-708` proves a newer descriptor
  becomes an explicit superseded DLQ disposition rather than false replay.
- `edge/test/knowledge-backfill.test.ts:238-391` proves partial page success is
  durable and not re-enqueued on resume.
- `edge/test/knowledge-ledger.workers.test.ts:592-657` proves durable DLQ
  dispositions, and `:659-859` proves complete P1 discovery plus partial-page
  disposition persistence.

### External-only gate

Actual Cloudflare Queue/DLQ delivery remains C1-only. Real Local update/delete
semantics remain unverified and intentionally stop as
`unsupported_update_contract` / `unsupported_delete_contract`; this audit did
not reinterpret those external contract gates as source success.

## Cross-fix interaction and bypass scan

- Source disable/update cannot race an active Local effect: lifecycle
  transitions and Queue dispatch share the durable exact-source effect lease.
- Scheduled reconciliation cannot run with a producer but ambiguous Queue
  roles: it requires the binding and passes the same exact-name validator before
  acquiring a coordinator cycle.
- Backfill cannot bypass P1 through the normal descriptor endpoint, and P1
  cannot approve a partial discovery.
- Reconcile, DLQ, and backfill do not have independent success heuristics; all
  consume the same authoritative descriptor-disposition proof.
- A non-test caller search found no Worker route or runtime caller for the
  legacy direct source-write RPC.
- A configuration scan found no uncommented production or deployable-bot-store
  Queue binding/name, cron trigger, scheduler enable/team scope, source
  verifier tuple, P1 verifier tuple, or tracked source.
- No code path mints a lifecycle or P1 signature. Test private keys are confined
  to deterministic test helpers.

## Validator corrections

The implementation validator previously claimed all activation remained absent
while checking only Queue bindings, a cron section, and one P1 public-key name
in production TOML. It now:

- checks both production and deployable bot-store TOML;
- rejects Queue producer/consumer sections and cron triggers;
- rejects primary/DLQ names and schedule enable/team scope;
- rejects all source-lifecycle public-key/issuer/key-ID fields;
- rejects all P1 public-key/issuer/key-ID fields;
- requires the stable caller-known discovery ID and its first-page-failure
  workerd proof;
- runs the focused unit/workerd suites by default and labels `--source-only`
  accurately.

The planning validator remains unchanged and authoritative for the planning
artifacts.

## Validation evidence

| Command | Result |
| --- | --- |
| `cd edge && npm run typecheck && npm test && npm run test:e2e` | PASS — 67 unit files / 814 tests; 4 workerd files / 42 tests |
| `cd edge && npm test -- --run test/knowledge-reconcile.test.ts test/knowledge-backfill.test.ts test/knowledge-ledger.test.ts test/knowledge-queue.test.ts` | PASS — 4 files / 43 tests |
| `cd edge && npm run test:e2e -- --run test/knowledge-ledger.workers.test.ts` | PASS — 1 file / 10 tests |
| `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` | PASS |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py` | PASS — 50 required files; 10 focused unit files / 134 tests; 3 focused workerd files / 17 tests |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py --source-only` | PASS |
| `git diff --check` plus direct trailing-whitespace scan | PASS — no tracked-diff errors; 0 matches in 10 audit-owned files. Five untouched untracked Markdown evidence/spec files each retain one pre-existing hard-break line. |
| JSON parse scan | PASS — 3 changed JSON files |
| deployable TOML activation scan | PASS — 2 files / 0 live activation entries |
| high-confidence changed-file secret scan with values suppressed | PASS after classification — 69 regular files scanned; 3 intentional fake-key fixture files; 0 unexplained matches |

## Remaining external-only gates

1. **R1:** pinned Local image build/start, checksum, bind/health/key path,
   non-root volume ownership, model/provider availability, egress/retention,
   first-byte redaction, authenticated add-to-done-to-search, and Railway
   project/service/volume/domain approval.
2. **R2:** native same-service backup/restore and key-rotation rehearsal.
3. **C1:** exact Cloudflare Worker target, Queue/DLQ resources and policy,
   scheduled trigger/scope, lifecycle/P1 verifier public values, secrets, and
   deployment.
4. **S1:** exact Slack staging scopes/subscriptions/install/source matrix.
5. **P1:** separate exact one-channel canary approval and one independently
   signed artifact for each complete backfill manifest.
6. **D1:** exact cleanup targets with refreshed evidence, owner confirmation,
   and recovery proof.

## Final decision

The six adversarial-rereview blockers are corrected in the local repository
path after the two narrow integration fixes above. **Known remaining source
blockers: 0.** The implementation remains disabled and not production-ready:
all six external/runtime gates remain, and the next safe step is a different
fresh independent read-only adversarial rereview of this combined tree and
report before any R1/C1/S1/P1 action.
