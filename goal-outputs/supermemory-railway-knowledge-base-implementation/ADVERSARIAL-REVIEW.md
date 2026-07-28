BLOCKING

# Fresh independent adversarial review — B0-B4

**Review date:** 2026-07-25 (America/Los_Angeles)
**Scope:** Current combined working tree in `/Users/will/Documents/opentag`; source,
tests, inert infrastructure, validators, reports, and governing contracts only.
No deployment, secret access, external mutation, git-history mutation, or source
correction was performed.

**Verdict:** The local command matrix is green, but B0-B4 do not satisfy the
source, security, durability, and invariant acceptance contract. The findings
below require correction followed by a different fresh independent re-review.

## Findings

### 1. BLOCKING — a superseding event can mark an old Local document as the new revision

**Evidence.**

- On every accepted newer descriptor, the ledger upsert clears
  `desired_revision` but deliberately leaves `local_document_id`,
  `local_workflow_status`, and `last_local_operation` intact
  (`edge/src/memory/knowledge-ledger.ts:263-283`).
- `prepareRevision()` blocks a different revision only when the retained row
  still has a truthy `desiredRevision`; when that field was cleared, any retained
  `localDocumentId` is reused as a poll target and the new revision is written
  into the row (`edge/src/memory/knowledge-ledger.ts:543-555`).
- After that poll returns `done`, the dispatch records the newly normalized
  revision as both desired and indexed without proving that the polled document
  contains that revision (`edge/src/memory/supermemory-adapter.ts:408-429`).
- The existing interleaving tests cover a changed *terminal indexed* revision
  and a same-revision poll resume, but not a newer descriptor arriving after
  `/localAccepted` and before terminal `done`
  (`edge/test/knowledge-ledger.test.ts:111-165`).

**Impact.** A normal edit/redelivery race during an initial asynchronous add can
produce this state: Local ID `doc-old` contains revision A, a newer descriptor
for revision B clears the stored desired revision, and the B attempt polls
`doc-old` then writes `indexed_revision=B`. Search usually suppresses the stale
Local result because its metadata still says A, leaving a falsely converged,
permanently unavailable source. It could also accept incorrect content if Local
mutation/dedup behavior differs from the unverified assumption. This violates
same-revision convergence and the ledger's authority.

An in-memory probe against the actual `KnowledgeLedger` produced:
`localDocumentId="doc-old"` plus no desired revision before preparation, followed
by `{decision:"poll", localDocumentId:"doc-old"}` for `sha256:new`.

**Required correction and verification.** Persist the revision associated with
every accepted Local ID separately from the latest desired revision. A newer
descriptor must not erase that association. Finish/resume polling the accepted
ID only for its own revision, then converge the later revision through the
verified update path or stop as `unsupported_update_contract`. Add Node and
workerd interleaving tests for descriptor arrival before add, after
`add_started`, after `/localAccepted`, during polling, and immediately before
terminal outcome.

### 2. BLOCKING — B4 reconciliation, DLQ operations, and backfill are disconnected pure planners

**Evidence.**

- `planKnowledgeReconciliation()` accepts one caller-supplied row and returns one
  pure action; it has no durable cursor, bounded ledger enumeration, stale-lease
  scan, alarm/scheduler, authoritative config reload, or Queue handoff
  (`edge/src/memory/knowledge-reconcile.ts:25-60`).
- DLQ “inspection” and “replay” operate only on an already materialized in-memory
  array; they do not inspect or replay a Cloudflare DLQ
  (`edge/src/memory/knowledge-reconcile.ts:63-88`).
- Backfill likewise accepts a caller-materialized candidate array and returns an
  in-memory manifest/jobs tuple. It neither discovers candidates nor binds a
  reviewed manifest to later execution (`edge/src/memory/knowledge-backfill.ts:42-116`).
  One request-level `configVersion` is also applied to every channel, although
  tracked-source versions are per exact source (`edge/src/memory/knowledge-backfill.ts:9-19,89-97`).
- A repository-wide non-test reference scan found no runtime callers of
  `planKnowledgeReconciliation`, `inspectKnowledgeDlq`,
  `planKnowledgeDlqReplay`, or `createKnowledgeBackfillDryRun`. The tests invoke
  only the pure functions (`edge/test/knowledge-reconcile.test.ts:13-54`;
  `edge/test/knowledge-backfill.test.ts:10-35`).

**Impact.** There is no executable bounded recovery path for abandoned
`processing_unconfirmed`, incomplete rows that exhaust Queue delivery, stale
leases, permanent failures, ledger/Local drift, or actual DLQ contents. There
is also no operable exact-scope backfill path. This is materially less than B4's
required periodic reconciliation, observable DLQ/explicit replay, and reviewed
dry-run backfill controls.

**Required correction and verification.** Add a durable, bounded, cursor-based
enumeration surface owned by the appropriate DO/operator control plane; reload
the exact current source before requeueing; wire explicit single-record DLQ
inspection/replay to the approved Queue/DLQ seam; and make backfill discovery
and execution consume a tamper-evident approved manifest with per-source config
versions and exact bounds. Keep all live calls behind C1/P1. Test crash/restart,
cursor continuation, stale lease, exhausted retry, config drift, one-record
replay, manifest mismatch, and “no default all” behavior against real seams.

### 3. BLOCKING — `readerPolicyRef` is indexed metadata, not enforced caller authorization

**Evidence.**

- `searchSlackKnowledge()` loads the enabled tracked source and passes its
  `readerPolicyRef` to Local, but it never compares that reference to the
  caller's resolved access bundle or another authoritative reader-policy
  decision (`edge/src/tools/search-slack.ts:24-42,74-132`).
- The tool handler derives only team/channel from request context
  (`edge/src/tools/search-slack.ts:144-164`).
- Tool availability is separately computed from the channel access bundle
  (`edge/src/agent-turn.ts:716-731`), but the default bundle does not include
  `search_slack` (`edge/src/config/access-bundle.ts:30-48`), and no code binds a
  custom bundle that contains the tool to the source's `readerPolicyRef`.
- Search tests construct a source policy string but contain no caller bundle or
  policy-authorization case (`edge/test/search-slack.test.ts:42-86`).

**Impact.** Any custom access bundle that permits `search_slack` can retrieve an
enabled channel's corpus even when it is not the reader policy referenced by
the source. Filtering Local results to the stored policy label proves document
metadata consistency, not that the requester is entitled to that policy. This
violates the SPEC's caller-policy authorization boundary.

**Required correction and verification.** Resolve an authoritative reader
policy for the exact turn and require it to authorize the source before Local is
called. Re-evaluate the same decision after Local returns, alongside the current
source/version and ledger checks. Do not equate a free-form metadata string with
authorization. Add actual agent-turn tests for allowed bundle/policy, wrong
bundle, policy change during search, automation actor, and exact-turn Stop.

### 4. BLOCKING — source disable/config change does not fence an already leased external add

**Evidence.**

- The Queue consumer loads the source once and checks version/scope before
  acquiring its ledger lease (`edge/src/memory/knowledge-jobs.ts:233-266`).
- The dispatch can then perform a multi-page Slack fetch and a Local add using
  that stale source snapshot without another authoritative source check
  (`edge/src/memory/supermemory-adapter.ts:279-317,327-385`).
- Outcome recording validates only the ledger lease token, not the current
  tracked-source version or enabled state
  (`edge/src/memory/knowledge-ledger.ts:452-461`).
- Disabling a tracked source updates only `WorkspaceConfigDO`; it does not fence
  active knowledge leases or create a delete/tombstone descriptor
  (`edge/src/config/workspace-config-do.ts:303-390`).

**Impact.** A disable or reader-policy/config change that commits after the
consumer's first lookup can still be followed by Slack content egress to Local
under the stale policy. Search correctly closes its own authorization race, but
automatic writes do not. “Disable is immediate” and configuration-before-
ingestion therefore are not preserved across the external-effect window.

**Required correction and verification.** Give configuration changes a durable
fence over active ingestion effects. At minimum, reload and match the exact
enabled source/version immediately before Local add and before accepting a
terminal outcome; the disable operation must revoke/drain or otherwise
quiesce an already claimed stale effect before it reports completion. Test
disable and policy/version changes at every await boundary, especially after
fetch, after `add_started`, and before `/localAccepted`.

### 5. BLOCKING — Slack pagination has no request or overall timeout

**Evidence.**

- The independent page reader calls `fetch()` without an `AbortSignal` or
  timeout (`edge/src/slack/knowledge-thread-fetcher.ts:184-225`).
- Page/message/byte limits do not bound a never-settling transport. The allowed
  20 pages and two 429 sleeps of up to ten seconds per page can also exceed the
  fixed 60-second ledger lease (`edge/src/slack/knowledge-thread-fetcher.ts:66-74,193-216`;
  `edge/src/memory/knowledge-jobs.ts:16,247-266`).
- Pagination tests cover thrown transport errors and bounded 429s, but not a
  hung fetch, an overall deadline, lease renewal, or lease expiry during fetch
  (`edge/test/knowledge-thread-fetcher.test.ts:48-66,99-145`).

**Impact.** One Slack request can hold a Queue invocation indefinitely and never
reach retry, DLQ, or reconciliation. Long bounded retry sequences can outlive
the ledger lease, causing competing attempts and conservative
`ambiguous_add_contract` failures. The implementation does not meet the
required pagination/cursor/message/byte/retry/**timeout** bound.

**Required correction and verification.** Add a per-attempt AbortController
deadline plus an overall thread-fetch deadline, classify timeout explicitly as
incomplete/retryable, and either renew the fenced lease or make the total
network/poll budget provably shorter than it. Test a fetch that settles only
when aborted, total-budget exhaustion across pages/429s, and lease expiry
without a second external effect.

### 6. BLOCKING — a source staged disabled can never receive its first enable

**Evidence.**

- The write RPC rejects `enabled=true` whenever an exact row already exists with
  `enabled=0`, without recording whether that row was ever enabled
  (`edge/src/config/workspace-config-do.ts:313-328`).
- The clarification requires only an enabled-then-disabled source to remain
  blocked from re-enable (`goal-outputs/supermemory-railway-knowledge-base-implementation/PROGRESS.md:115-119`).
- The staged rollout explicitly requires configuring a test source disabled
  first and enabling it only after authorization/degradation proofs
  (`KNOWLEDGE-BASE-SPEC.md:282-290`).
- The workerd test starts with an immediate enabled insert and tests only
  enabled -> disabled -> rejected re-enable; it omits disabled -> first enable
  (`edge/test/workspace-knowledge-config.workers.test.ts:15-62`).

**Impact.** The required safe activation sequence is impossible. An operator
would have to insert an enabled source on its first write, bypassing the
specified disabled-first staging posture.

**Required correction and verification.** Persist an `ever_enabled`/lifecycle
state or immutable enable epoch. Permit disabled-never-enabled -> first enable
only through the future authorized configuration path; continue blocking
enabled -> disabled -> re-enable until deletion/reindex is proven. Add workerd
tests for both transitions and for concurrent conflicting projects.

### 7. BLOCKING — the Docker default command passes the server binary as its own argument

**Evidence.**

- The image's entrypoint is the wrapper, while its `CMD` is
  `["/usr/local/bin/supermemory-server"]`
  (`infra/supermemory/Dockerfile:39-41`).
- The wrapper independently chooses `/usr/local/bin/supermemory-server` as
  `binary` and executes `"$binary" "$@"`
  (`infra/supermemory/entrypoint.sh:7-8,54-57`).
- Under the Docker default, this expands to
  `/usr/local/bin/supermemory-server /usr/local/bin/supermemory-server`.
- Wrapper tests invoke the shell script directly with no Docker CMD, or with
  the fixture-only `--wait`; they do not verify the image's default argv
  (`edge/test/supermemory-entrypoint.test.ts:22-49`).

**Impact.** The pinned Local server receives an unintended positional argument
on every default container start. Depending on its CLI parser, the Railway
service can fail immediately or select unintended behavior. The green wrapper
test does not establish a valid image entrypoint.

**Required correction and verification.** Use either an empty/default wrapper
CMD with the wrapper-owned binary, or make the wrapper execute the Docker
command as the binary and supply a fallback only when no command is given. Add
an argv-capturing fixture for the exact Docker ENTRYPOINT+CMD contract, then
build and smoke the pinned image only under the approved R1 gate.

### 8. NONBLOCKING — malformed Local add responses are classified retryable

`addSlackDocument()` creates a retryable `local_malformed_response` for a
missing ID and converts an unsupported status parser error into the generic
retryable path (`edge/src/memory/supermemory-adapter.ts:69-76,163-176`).
Definitive schema mismatch should be permanent, while network/429/5xx remains
retryable. Otherwise malformed responses consume every Queue attempt before
DLQ and obscure the root cause. Add separate malformed-ID/status fixtures and
assert permanent ledger classification plus one alert/metric.

### 9. NONBLOCKING — event ordering truncates Slack timestamp precision

Slack event timestamps are converted through JavaScript milliseconds and then
canonical ISO (`edge/src/memory/knowledge-jobs.ts:101-108`). The ledger rejects a
same-version descriptor whose resulting `requestedAt` is less than or equal to
the current value (`edge/src/memory/knowledge-ledger.ts:240-248`). Two valid
updates for one thread within the same millisecond can collapse as duplicates.
Retain the full Slack event timestamp or stable event ID as the ordering/dedupe
component and test sub-millisecond distinct events.

### 10. NONBLOCKING — optional permalink validation is not source-bound

Citation parsing accepts any HTTPS `slack.com` subdomain URL whose path begins
with `/archives/`, but does not require the path's channel and message timestamp
to match the validated citation (`edge/src/memory/supermemory-adapter.ts:119-140`).
No current add supplies a permalink, so this is not presently reachable from
honest indexed rows. Before enabling permalinks, validate the exact
`/archives/{channelId}/p{threadTs}` relationship (including Slack timestamp
encoding) and test wrong-channel/wrong-thread links.

### 11. NONBLOCKING — the implementation validator is structurally false-green

The validator primarily checks minimum byte sizes and substring/regex presence
(`goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py:15-63,94-102,137-257`)
and then declares durable outbox/lease/same-ID/tombstone/backfill/DLQ contracts
passed (`goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py:278-285`).
It does not detect the Local-ID/revision interleaving, disconnected B4 planners,
missing timeout, policy authorization gap, disabled-first lifecycle, or Docker
argv defect. Keep structural checks, but move behavioral claims to focused
tests/probes and add call-graph/forbidden-shape checks only where deterministic.

## Strengths confirmed

- Slack HMAC verification completes before the Events handler, and knowledge
  scheduling is attached through `waitUntil` rather than awaited in the
  acknowledgement or ordinary turn path (`edge/src/slack-verify.ts:44-79`;
  `edge/src/worker.ts:483-492,594-607,721-731`).
- Production Slack traffic and the Queue consumer remain in `opentag-bot`; no
  live Queue producer/consumer section or tracked-source enablement route was
  added (`edge/src/worker.ts:870-879`; `edge/wrangler.bot.toml:64-69`).
- Exact `workspace:{teamId}` and stable Slack source IDs are server-derived;
  caller tag/custom-ID controls are not present
  (`edge/src/memory/knowledge-contract.ts:91-97,150-156`;
  `edge/src/memory/supermemory-adapter.ts:155-174,223-247`).
- The KnowledgeDO migration is additive and the legacy manual
  `knowledge`/`memorySearch`/`memoryWrite` path remains intact
  (`edge/src/memory/knowledge-do.ts:24-35,69-80,251-340`).
- Search rechecks source version/policy after Local returns and then requires a
  current non-tombstoned indexed ledger revision
  (`edge/src/tools/search-slack.ts:113-134`).
- The Local client rejects non-HTTPS and credential/path/query/fragment-bearing
  base URLs, pins request timeout and disables hidden SDK retries
  (`edge/src/memory/supermemory-client.ts:14-41`).
- No external gates were crossed. The production Queue binding, source route,
  Local secrets, Railway service, Slack changes, canary, and backfill remain
  absent.

## Runtime-only uncertainty (not cleared by this review)

The following remain correctly classified as future approved runtime proofs:
the actual Local artifact build/start; bind host; safe health endpoint;
generated key file/path/format/rotation; complete data/auth/model-cache paths;
arbitrary inherited `DATABASE_URL` behavior; non-root Railway volume ownership;
approved-account `gpt-5.1` availability and provider egress; real first-boot log
redaction; add -> terminal `done` -> search; two-workspace isolation; restart
persistence; backup/restore; and key rotation. None is inferred from green local
tests.

## Commands and results

- `cd edge && npm run typecheck && npm test && npm run test:e2e` — PASS:
  TypeScript; 66 unit files / 767 tests; 3 workerd files / 27 tests.
- `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` — PASS:
  48,821-byte SPEC and 15,265-byte Railway readiness report.
- `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py`
  — PASS: 41 required files / 499,445 bytes plus report.
- `git diff --check` — PASS.
- In-memory read-only probe of the actual transpiled `KnowledgeLedger` — CONFIRMED
  that a newer revision receives `{decision:"poll", localDocumentId:"doc-old"}`.
- Repository-wide non-test caller scan for B4 planner exports — CONFIRMED no
  runtime callers.

The green commands are evidence that existing assertions pass; they do not
invalidate the behavioral blockers above.

## Mutation confirmation

No source, test, spec, validator, report, progress ledger, dependency, lockfile,
git ref, deployment, secret, or external resource was changed. The only write
performed by this review is this
`goal-outputs/supermemory-railway-knowledge-base-implementation/ADVERSARIAL-REVIEW.md`
artifact.

BLOCKING findings: 7

Correction is required, followed by a different fresh independent adversarial
re-review. Task H/R1 planning and all external actions remain blocked.
