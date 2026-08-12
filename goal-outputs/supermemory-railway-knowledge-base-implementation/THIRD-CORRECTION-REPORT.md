# Third Correction Integration Report

Date: 2026-07-25 (America/Los_Angeles)

Scope: the three BLOCKING findings in
`SECOND-ADVERSARIAL-REREVIEW.md`, audited against the canonical
`KNOWLEDGE-BASE-SPEC.md`, current source, tests, deploy configuration,
operations documentation, implementation report, and both repository
validators.

Verdict: **0 known source blockers remain across these 3 findings after 3
narrow integration fixes.**

No Worker or Container was deployed. No Railway, Cloudflare, Slack, Queue,
secret, source row, canary, backfill, Git reference, or other external state was
mutated. `PROGRESS.md` and all review artifacts were left unchanged.

> **Historical validator note (2026-08-02).** Validator results in this report
> belong to the former Railway/B0–B4 snapshot. They are retained for the
> correction history, not as current-tree acceptance after the Cloudflare-only
> architecture change. Use the current knowledge contract audit and rollout
> preflight for present status.

## Corrections made by this audit

1. A proven root-delete descriptor now has precedence while it is still queued,
   not only after the tombstone outcome is recorded. A later reply/edit callback
   cannot replace the root-delete outbox row in that race window.
2. A fresh P1 renewal may carry compatible same-or-stricter count/rate/error
   budgets. It cannot loosen the preceding approval, and a rate limit too small
   for the immutable pending page fails closed.
3. Deploy safety now recursively scans all package scripts and all deployable
   Wrangler TOMLs below `edge/`, rather than only the four top-level TOMLs.

## 1. Root-only deletion authority and reply-deletion fail-closed behavior

Status: **closed**

- `edge/src/memory/knowledge-jobs.ts:128-176` classifies a deletion from the
  verified Slack callback. A complete, consistent root identity emits `delete`
  with `threadTs === messageTs`. A reply or broadcast reply emits
  `reply_delete` with the exact parent `threadTs` and deleted `messageTs`.
  Contradictory or insufficient identity cannot emit a root delete; an exact
  distinct parent plus envelope deletion timestamp can only request refetch.
- `edge/src/memory/knowledge-contract.ts:183-216` rejects any root delete whose
  deleted timestamp differs from the root and any reply delete without a
  distinct exact deleted timestamp. Queue parsing reconstructs the same
  canonical job, so a malformed body cannot bypass this invariant.
- `edge/src/memory/knowledge-ledger.ts:780-802` now preserves queued root-delete
  precedence before Queue consumption. This closes the remaining race where a
  later callback could previously replace the delete descriptor before its
  tombstone was written.
- `edge/src/memory/supermemory-adapter.ts:309-316` tombstones only `delete` (or
  an already disabled source) without a Slack refetch.
  `edge/src/memory/supermemory-adapter.ts:339-387` refetches and normalizes a
  `reply_delete`; an indexed revision change stops as
  `unsupported_update_contract`, never as a tombstone.
- `edge/src/memory/knowledge-ledger.ts:1085-1116` converts unchanged refetched
  content back to indexed state and blocks a changed indexed revision.
  `edge/src/tools/search-slack.ts:204-231` accepts citations only for current
  `indexed`, non-tombstoned, exact-revision rows, so the blocked mutation is
  immediately non-searchable.

Behavioral proof:

- `edge/test/knowledge-queue.test.ts` covers proven root deletion, ordinary and
  broadcast reply deletion, exact parent/deleted timestamps, and malformed or
  contradictory identity.
- `edge/test/supermemory-adapter.test.ts` proves root deletion does not fetch,
  while reply deletion refetches and records
  `unsupported_update_contract` without a tombstone.
- `edge/test/knowledge-ledger.test.ts` covers unchanged/changed indexed
  revisions, duplicate/out-of-order reply-delete races, tombstone precedence,
  and queued root-delete precedence over later reply/edit callbacks.

## 2. Expired P1 pending-page renewal

Status: **closed**

- `edge/src/memory/knowledge-backfill-authorization.ts:170-430` verifies a
  compact external Ed25519 artifact and binds its one-use ID, human approver,
  exact manifest digest/team/project/channels/range/releases/rollback owner,
  issuance/expiry, and bounded budgets. It permits only budgets at or below the
  immutable manifest maxima and never below the manifest's actual job count.
- `edge/src/memory/knowledge-ledger.ts:2173-2261` accepts renewal only for the
  same running/approved manifest after the prior approval is expired and the
  signed issuance is not earlier than that expiry. Replay, overlap, changed
  immutable scope, looser budgets, and an already expired replacement are
  rejected transactionally.
- `edge/src/memory/knowledge-ledger.ts:2262-2349` preserves the pending page
  token, jobs, prior dispositions, next index, execution-error count, and rate
  state. If the old fixed window elapsed, only unclassified jobs are reserved
  in the new window. A stricter rate that cannot cover the immutable pending
  page is rejected rather than bypassed.
- The new approval is appended to `knowledge_backfill_approvals` with
  `supersedes_approval_id`; the prior signed evidence remains immutable.
- `assertBackfillApprovalActive` is invoked by page claim, each enqueue, result
  recording, failure recording, and commit
  (`edge/src/memory/knowledge-ledger.ts:2121-2150,2351-2636` and
  `edge/src/memory/knowledge-do.ts:678-810`). Expiry therefore authorizes no
  later effect or state advance. Already classified jobs are skipped on resume.
- The public approval route verifies the external signature before forwarding
  redacted verified evidence; the Durable Object has no signing path. Direct DO
  RPC trust remains the previously documented binding-only defense-in-depth
  seam, not a public Worker bypass.

Behavioral proof:

- `edge/test/knowledge-backfill.test.ts` verifies real Ed25519 artifacts,
  accepts safe stricter budgets, and rejects loosened or changed scope/release/
  rollback fields.
- `edge/test/knowledge-ledger.test.ts` exercises expiry immediately after
  claim, a persisted accepted disposition, restart, overlap/replay/expired
  renewal rejection, same-or-stricter renewal, looser-budget rejection,
  preserved page/index/error/rate state, a second expiry, and final commit under
  the current approval.
- Workerd coverage continues to prove one-use P1 evidence, pending-page
  identity, per-operation gating, and partial dispositions.

## 3. Deploy configuration and test-only credentials

Status: **closed**

- `edge/package.json` has no `deploy:bot-store` script. Across all 4 package
  files below `edge/`, 0 deploy commands target
  `wrangler.bot-store.toml` or another test/debug TOML.
- All 8 deployable Wrangler TOMLs below `edge/` contain 0 uncommented
  `ADMIN_SECRET` assignments and 0 known/default admin credential values.
- The one deterministic test admin binding is
  `edge/vitest.workers.bot-store.config.ts:20-27`, inside
  `cloudflareTest(...).miniflare.bindings`. It is absent from every deployable
  TOML.
- `edge/scripts/validate-deploy-config.mjs:37-69` recursively scans package
  scripts and Wrangler TOMLs while excluding generated dependency/build trees.
  Its unsafe fixture proves both test/debug deploy-target and embedded
  credential detection.
- `edge/test/deploy-config-safety.test.ts` independently performs the recursive
  repository scan and executes the standalone validator.

## Bypass, race, and stale-claim audit

- Confirmed and fixed: queued root deletion could be superseded before
  tombstoning.
- Confirmed and fixed: exact-only budget comparisons contradicted the canonical
  same-or-stricter renewal contract.
- Confirmed and fixed: deploy-config scans and the implementation report covered
  only 4 top-level TOMLs while 8 deployable TOMLs exist recursively.
- No alternate public deletion, P1 signing/minting, backfill enqueue, bot-store
  package deploy, or deployable test-binding path was found.
- `docs/operations.md`, `IMPLEMENTATION-REPORT.md`, and the implementation
  validator now state/check same-or-stricter renewal and recursive deploy
  coverage. No validator conclusion was used as a substitute for tracing the
  runtime callers and transactions above.

## Validation evidence

| Command/check | Result |
| --- | --- |
| `cd edge && npm run typecheck && npm test && npm run test:e2e` | PASS: typecheck; 68 unit files / 825 tests; 4 workerd files / 42 tests |
| Focused deletion/P1/deploy-config suites | PASS: 5 files / 52 tests |
| Focused B4 unit set | PASS: 4 files / 49 tests |
| Focused ledger workerd set | PASS: 1 file / 10 tests |
| Implementation validator behavioral matrix | PASS: 11 unit files / 145 tests; 3 workerd files / 17 tests |
| `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` | PASS |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py` | PASS |
| `python3 .../validate.py --source-only` | PASS |
| `cd edge && npm run validate:deploy-config` | PASS: 4 package files and 8 Wrangler TOMLs recursively inspected |
| JSON parse | PASS: 3 changed JSON files |
| `git diff --check` / conflict-marker scan | PASS / 0 files |
| Deploy scan | 0 bot-store/test/debug package deploy targets; 0 live TOML `ADMIN_SECRET`; 0 known/default TOML credentials |
| High-confidence secret-pattern scan (values suppressed) | 2 files, both intentional fake `sm_...`/`sk_...` redaction fixtures; 0 unexplained matches |

The combined dirty tree has 4 pre-existing trailing-whitespace files, all in
unrelated untracked review/readiness artifacts. The 10 source/test/config/doc/
validator/report files touched by this audit have 0 trailing-whitespace or
conflict-marker findings.

## Remaining blockers

**For the 3 second-rereview blockers: 0.**

The pinned Local replacement/delete contract remains deliberately unverified;
indexed edits and reply deletions therefore fail closed as
`unsupported_update_contract`, while proven root deletion records a source
tombstone without pretending that Local deletion succeeded. Production
Railway/Cloudflare/Slack/source enablement/canary/backfill/cleanup gates remain
closed and require their separately named approvals. Those are external
readiness gates, not unresolved source bypasses in this correction set.
