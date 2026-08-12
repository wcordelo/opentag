# B0-B4 implementation report — Supermemory Local knowledge index

**Status:** the combined second-correction integration audit traced all six
BLOCKING findings in the 2026-07-25 adversarial rereview through their runtime
callers, durable state, cross-fix interactions, and focused tests. Two narrow
integration defects found by that audit were corrected: first-call backfill
discovery now starts from a caller-known stable manifest ID, and the committed
test source-verifier tuple was removed from the deployable bot-store Wrangler
alias and confined to Miniflare bindings. The resulting combined source has
zero known blockers from those six findings. This report does not modify or
overrule either adversarial review and is not a replacement for the required
next fresh independent adversarial rereview. No Worker/Container deployment,
Railway mutation, Slack change, Queue mutation, secret operation, git-history
mutation, source enablement, canary, backfill, or other external action
occurred.

> **Current-state reconciliation (2026-08-02).** This report is a historical
> B0–B4/R1 snapshot. Its automatic-ingestion description below reflects the
> then-current `waitUntil` plan. The current source adds a pre-ack
> `DeferredIngressDO` ownership fence for inbound knowledge events and durable
> ownership for outbound observations. Current deployment status and open live
> gates are maintained in [`docs/current-state.md`](../../docs/current-state.md)
> and the [knowledge contract audit](../knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md).
> The Python validators referenced by this report are likewise historical
> snapshot validators, not current-tree gates. They are expected to fail after
> the canonical contract moved from Railway/B0–B4 to Cloudflare-only derived
> indexes. Current acceptance is the edge/Worker test matrix, derived-worker
> typechecks, deploy-config checks, and knowledge-rollout preflight.

## Goal and local acceptance (copied from PROGRESS)

[GOAL]: Implement the approved OpenTag Supermemory Local on Railway knowledge-base SPEC end to end: complete and independently validate B0-B4 source/tests locally, then stage and execute B5-B9 only through their explicit Railway, Cloudflare, Slack, canary, backfill, and cleanup approval gates, preserving repository invariants and unrelated work.

LOCAL ACCEPTANCE:
- `cd edge && npm run typecheck && npm test && npm run test:e2e` passes.
- `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` passes.
- Implementation `validate.py` proves all required B0-B4 files/tests/config exist, exact SDK pin and tag contract exist, no production ingestion is enabled, and forbidden Supabase/Postgres/current-prefix claims are absent.
- A fresh independent reviewer reports no BLOCKING source, security, durability, or invariant findings. BLOCKING findings trigger correction plus a fresh re-review.

## Verified source and test facts

- Automatic ingestion is wired as `slackVerify -> waitUntil -> KnowledgeDO
  descriptor/outbox -> optional Cloudflare Queue -> opentag-bot queue() ->
  bounded Slack fetch/normalization -> Supermemory Local adapter`. Slack
  acknowledgement and the ordinary turn path do not perform ingestion.
- `WorkspaceConfigDO` owns a separate fail-closed
  `tracked_knowledge_sources` table. Missing rows are disabled, source lookup
  has no ordinary-config fallback, configuration version is database-owned and
  monotonic, and a partial unique index permits only one enabled project for an
  exact `(teamId, channelId)`.
- The Worker exposes separate inspect/list, disabled staging/update,
  first-enable, and later-disable source routes. `ADMIN_SECRET` is only a
  second factor: each call also requires a short-lived, one-use Ed25519 artifact
  from a separately approved external issuer, bound to exact
  team/project/channel/action/request/config version and a named actor. The DO
  atomically consumes it and stores redacted durable evidence. No issuer,
  verifier value, or private signing key is present in a deployable knowledge
  configuration; C1/S1 must approve those values before the routes become
  available. Deterministic Ed25519 test key material remains only under
  `edge/test/helpers/`, and the test public verifier tuple is injected only by
  the Miniflare Vitest configuration. Once an enabled row is disabled,
  re-enable remains blocked until deletion/reindex is verified. Production
  `wrangler.bot.toml` still has no live Queue producer or consumer.
- All Local adds/searches derive the exact opaque tag `workspace:{teamId}` on
  the server. Add derives stable `customId`/`sourceKey` as
  `slack:{teamId}:{channelId}:{threadTs}`; content revision never changes this
  identity. Caller tags, arrays, prefixes, globs, and custom IDs are rejected.
- The SDK is pinned exactly to `supermemory@4.24.12` in package and lock files.
  The adapter sets `maxRetries: 0`, bounds request time, requires a
  credential/path/query/fragment-free HTTPS origin, uses hybrid v4 search, and
  applies exact project/channel/active filters. Search scope comes from the
  verified request context and current enabled source, not tool arguments.
- `search_slack` is the only turn-time Local surface. It returns structured
  `knowledge_unavailable` degradation, rechecks the source after retrieval,
  and accepts a citation only when its exact project/channel/revision matches
  a current non-tombstoned indexed ledger row with the same config version.
- Slack fetch is pagination-, cursor-, message-, byte-, retry-, and
  `Retry-After`-bounded. A partial/capped/ambiguous fetch remains `incomplete`
  and cannot become a write. Normalization is deterministic across ordering,
  Unicode, whitespace, duplicates, and transient fields; it excludes generic
  Slack action `value` payloads from corpus text.
- Only Local status `done` writes `indexed_revision`. `queued`, `extracting`,
  `chunking`, `embedding`, `indexing`, and `unknown` remain non-terminal.
- The additive KnowledgeDO ledger/outbox preserves the existing manual
  `memory_write`/`memory_search` table and helpers. Duplicate/out-of-order
  descriptors converge, config drift is a no-op, failed Queue sends remain
  recoverable, leases bound at-least-once work, and an accepted Local internal
  ID is persisted before polling.
- Poll timeout records `processing_unconfirmed`; reconciliation resumes the
  same Local document ID. An add crash before that ID is durably known stops as
  `ambiguous_add_contract`, with no second add. Unsupported indexed edits and
  reply deletions that change an indexed revision stop as
  `unsupported_update_contract`. Only a proven root-message deletion (or
  source disable) gives tombstone precedence and stops as
  `unsupported_delete_contract`; exact deleted and parent Slack timestamps are
  retained in the descriptor.
- Reconciliation now has a source-level scheduled entry and a durable global
  coordinator behind C1. It freezes an exact configured team list and scope
  digest, fences overlapping invocations, resumes the same team/run/page after
  restart, bounds pages/teams per invocation, persists bounded backoff, and
  continues on later schedules until the cycle completes without manual calls.
  The existing admin exact-team route remains a one-page diagnostic. No cron
  trigger, Queue binding, scheduler enablement, or team scope is live.
- Reconciliation consumes application-level descriptor results. A page
  advances only after acceptance or an authoritative exact
  duplicate/converged/superseded proof; response loss requires proof of the
  exact durable descriptor. Counts and structured run/page/lag/error metrics
  do not label rejected work enqueued.
- The future C1 Queue entry requires distinct exact primary/DLQ names with
  role-bound `-dlq` validation. Missing, swapped, or arbitrary names retry and
  throw before job parsing. DLQ capture remains durable-before-ack and
  cursor-bounded. Exact replay records `replayed` only after a directly observed
  acceptance. Authoritative `accepted_response_lost`, duplicates, convergence,
  and safe supersession persist an explicit `disposed` disposition. Unproved
  rejection releases the claim. There is no bulk or automatic replay.
- Bounded Slack history discovery requires one caller-chosen stable manifest
  ID, one team/project, a non-empty exact channel list/range, count/rate/error
  budgets, release IDs, and rollback owner. KnowledgeDO persists each channel
  as unvisited, pending with its own cursor, or exhausted, and atomically merges
  deduplicated candidates behind a per-channel state/cursor CAS. The same
  caller-known manifest resumes after a failed first Slack page, a 20-page
  invocation cap, or restart until every channel is exhausted. Config drift
  and an exact final count over budget become terminal inert states. Only a
  complete persisted discovery produces the canonical version-2 manifest and
  digest.
- Backfill P1 authority is an external one-use Ed25519 artifact, not
  caller-controlled fields. It binds manifest ID/digest, exact scope/range,
  count/rate/error budgets, release IDs, human approver, issued/expiry times,
  and rollback owner. The Worker has verifier-only configuration and no minting
  path/private key; KnowledgeDO rejects replay and every execution effect after
  expiry. An expired pending page can resume only under a new exact,
  independently signed one-use approval after the prior approval expires.
  Renewal preserves the page token, prior dispositions, indexes, error count,
  and rate accounting, recomputes an elapsed rate window for only
  still-unclassified jobs, and appends a supersession-linked audit row.
  `ADMIN_SECRET` remains the separate execution/transport authority.
- Execution rechecks digest, complete discovery, unexpired P1 evidence, exact
  scope/config, and durable rate/error budgets. Every enqueue result is
  classified. The page cursor advances only after all jobs are accepted, exact
  duplicates, authoritatively converged/accepted-after-response-loss, or
  explicitly safely superseded. Partial acceptance persists successful
  dispositions and an operator-visible error without advancing or reporting
  the full page enqueued. The ordinary descriptor endpoint rejects all
  backfill jobs. There is no all-workspace default.
- The inert Railway image assets pin Local `server-v0.0.5`, both published Linux
  checksums, `/var/lib/supermemory`, all three `gpt-5.1` model variables, and
  local `Xenova/bge-base-en-v1.5` at 768 dimensions. The image is non-root and
  the PID-1 wrapper redacts configured/generated key patterns from its first
  byte, forwards termination, and preserves child status in fake-child tests.
- Implementation/runtime files introduce no current Supabase, PostgreSQL,
  Hyperdrive, pgvector, Vectorize, or workspace-prefix/glob retrieval path.

## Actual B0-B4 feature paths

Configuration and contracts:

- `edge/package.json`, `edge/package-lock.json`
- `edge/src/config/knowledge-config.ts`,
  `edge/src/config/knowledge-source-authorization.ts`,
  `edge/src/config/workspace-config-do.ts`, `edge/src/env.ts`
- `edge/src/memory/knowledge-contract.ts`
- `infra/supermemory/Dockerfile`, `infra/supermemory/entrypoint.sh`,
  `infra/supermemory/README.md`,
  `infra/supermemory/test-fixtures/fake-supermemory.sh`

Durable ingestion, fetch, retrieval, and operations:

- `edge/src/memory/knowledge-do.ts`, `knowledge-ledger.ts`,
  `knowledge-jobs.ts`, `knowledge-queue-routing.ts`,
  `knowledge-backfill.ts`, `knowledge-backfill-authorization.ts`,
  `knowledge-reconcile.ts`,
  `normalize-slack-thread.ts`, `supermemory-client.ts`,
  `supermemory-adapter.ts`
- `edge/src/slack/knowledge-thread-fetcher.ts`
- `edge/src/tools/search-slack.ts`, `edge/src/tools/index.ts`
- `edge/src/worker.ts`, `edge/wrangler.bot.toml`
- `docs/operations.md`

Contract/regression tests and fixture:

- `edge/test/knowledge-config.test.ts`,
  `knowledge-source-admin.test.ts`,
  `knowledge-source-admin.workers.test.ts`,
  `workspace-knowledge-config.workers.test.ts`,
  `supermemory-contract.test.ts`, `supermemory-entrypoint.test.ts`
- `edge/test/knowledge-ledger.test.ts`,
  `knowledge-ledger.workers.test.ts`, `knowledge-queue.test.ts`
- `edge/test/knowledge-thread-fetcher.test.ts`,
  `normalize-slack-thread.test.ts`, `supermemory-adapter.test.ts`,
  `search-slack.test.ts`, `knowledge-reconcile.test.ts`,
  `knowledge-backfill.test.ts`
- `edge/test/helpers/knowledge-backfill-approval.ts`
- `edge/test/helpers/knowledge-source-grant.ts`
- `edge/test/fixtures/knowledge-backfill/dry-run.json`
- `edge/vitest.workers.bot-store.config.ts`,
  `edge/wrangler.bot-store.toml`

Task F also added this report and
`goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py`.

## Validation evidence

All commands ran from `/Users/will/Documents/opentag` on the combined current
working tree unless the command explicitly changes to `edge/`.

| Command | Result |
| --- | --- |
| `cd edge && npm run typecheck && npm test && npm run test:e2e` | PASS: TypeScript no-emit check; 68 unit files / 825 tests; 4 workerd files / 42 tests |
| `cd edge && npm test -- --run test/knowledge-reconcile.test.ts test/knowledge-backfill.test.ts test/knowledge-ledger.test.ts test/knowledge-queue.test.ts` | PASS: 4 unit files / 49 tests |
| `cd edge && npm run test:e2e -- --run test/knowledge-ledger.workers.test.ts` | PASS: 1 workerd file / 10 tests, including scheduler fence, caller-known first-page-failure recovery, durable per-channel discovery restart/config-drift blocking, DLQ dispositions/exact replay claim, externally verified one-use P1 enforcement, and partial-page dispositions |
| `python3 goal-outputs/supermemory-railway-knowledge-base/validate.py` | PASS: 50,024-byte SPEC and 15,265-byte Railway readiness report |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py` | PASS: deterministic source/call-path checks plus 11 focused unit files / 145 tests and 3 focused workerd files / 17 tests; 52 required files; exact pin/tag/status/search/runtime, root/reply deletion, fail-closed Queue routing, scheduled reconciliation/DLQ, durable discovery, exact-scope same-or-stricter external-P1 renewal, page-disposition, mutation-stop, recursive deployable-config, and forbidden-architecture checks |
| `python3 goal-outputs/supermemory-railway-knowledge-base-implementation/validate.py --source-only` | PASS: deterministic source/call-path checks with the focused behavioral suites explicitly skipped |
| `git diff --check` plus direct trailing-whitespace scan | PASS: no tracked-diff errors and 0 matches across the 10 integration-audit source/test/config/doc/validator/report files; 4 unrelated pre-existing untracked review/readiness artifacts still contain trailing whitespace |
| JSON parse scan | PASS: 3 changed JSON files parsed successfully |
| deployable TOML activation/credential scan plus `cd edge && npm run validate:deploy-config` | PASS: 8 Wrangler TOMLs recursively checked; 0 uncommented Queue binding/name, cron, scheduler scope/enable, lifecycle/P1 verifier, `ADMIN_SECRET`, or known/default admin credential entries; no package deploy target for a bot-store/test/debug TOML |
| high-confidence secret-pattern scan with values suppressed over all 72 changed regular files | PASS after classification: 2 matched files are intentional fake `sm_...`/`sk_...` redaction fixtures; 0 unexplained matches |

Task F corrected six integration defects before its matrix: canonical
job validation is now used by reconciliation (including canonical ISO time),
unsafe Local base URL components are rejected, extreme Slack `Retry-After` is
capped at 10 seconds per retry, and internal Slack action values are omitted
from normalized corpus content. It also blocks source re-enable while Local
deletion/reindex semantics are unverified and rejects citations whose ledger
config version is stale. Regression tests cover each correction.

The B4 correction adds behavioral coverage for durable per-channel cursor
continuation and restart, global page caps, unvisited later channels, empty
exhaustion cursors, authoritative config drift, first-channel count overflow,
actual DLQ batch capture and exact-record replay, manifest
tamper/scope/config mismatch, approval signature/replay/expiry/scope/budget/
release binding, partial enqueue acceptance, and the absence of an
empty/all-workspace discovery default.

The combined second-correction audit then fixed two additional narrow
integration defects. Runtime discovery now rejects a missing manifest ID before
any durable or Slack work, creates or resumes the caller-selected identity, and
has a workerd test proving recovery after the first Slack request fails. The
deployable `wrangler.bot-store.toml` no longer contains the committed test
source-verifier issuer/key tuple; those values are Miniflare-only. The
implementation validator now rejects Queue bindings/names, cron triggers,
scheduler enable/team scope, source-lifecycle verifier fields, and P1 verifier
fields in both production and deployable bot-store TOML.

The third correction cycle distinguishes a proven Slack root deletion from a
reply or broadcast-reply deletion. Reply deletion now creates an exact
`reply_delete` refetch descriptor and can halt only as an indexed mutation
under the unverified Local update contract; malformed deletion identity cannot
tombstone a source. P1 execution now supports exact-scope signed renewal after
expiry without replacing a claimed page or accepted dispositions, while every
page mutation requires the current unexpired approval; renewal budgets may be
the same or stricter but can never loosen the preceding approval. The bot-store deploy
script and Wrangler `ADMIN_SECRET` were removed, the test credential moved to
Miniflare-only bindings, and a standalone deploy-config validator plus unit
coverage enforce that boundary.

The post-correction integration audit additionally traced every original
blocker through its production caller path and cross-fix boundaries:
revision-bound Local IDs/terminal outcomes; WorkspaceConfigDO ingestion-effect
leases around Queue dispatch; exact-turn bundle/policy authorization before and
after Local; request/overall Slack deadlines inside the lease budgets;
disabled-first activation; authenticated durable reconciliation/DLQ/backfill
routes; and the empty Docker default argv. The implementation validator now
checks those ordered call paths and runs the focused correction suites by
default instead of treating substring presence as behavioral proof.

That audit closed three narrow races/coverage gaps before recording the matrix:
a queued proven root delete now keeps precedence before its tombstone outcome
is written; a renewed P1 approval accepts compatible stricter budgets while
rejecting any relaxation or pending-page rate incompatibility; and deploy
safety now scans every package and all eight deployable Wrangler TOMLs
recursively rather than only the four files at `edge/` root.

Reconciliation has a durable scheduled coordinator and source-level
`scheduled()` entry, while the authenticated route is diagnostic only. The
entry is inert because production has no cron trigger, Queue bindings, exact
Queue names, schedule enable flag, or configured team scope; C1 remains
required for all of them.
Backfill execution is gated by complete persisted discovery, an externally
signed one-use P1 record, exact manifest digest/scope/config, unexpired
approval, budgets, and the currently claimed page. No production verifier,
approval artifact, or approval record was created during this work.

## Security and authorization boundaries

Slack HMAC verification precedes descriptor scheduling. Scheduling derives its
team/channel from the verified callback, loads the sole exact enabled project,
and passes only a server-created descriptor. Queue consumption reloads that
exact authoritative source and rejects config/version/scope drift before a
lease or network effect. Retrieval derives team/channel from request context,
uses the current source's project and policy, then revalidates policy and
ledger revision after Local returns.

Supermemory remains a sidecar retrieval index. Conversation, session, config,
manual knowledge, exact-turn/effect, Stop, and obligation state remain in their
existing Durable Objects. Local credentials are optional Env bindings and are
never accepted from a caller. The source tree contains no credential values;
the image contains no secret. The exact Local URL must be a bare HTTPS origin.

## Current disabled state and rollback

No production source is enabled by these files: missing source rows are
disabled; the lifecycle and backfill-P1 verifier issuer/key configurations,
production
Queue/DLQ bindings, exact `KNOWLEDGE_QUEUE_NAME`/`KNOWLEDGE_DLQ_NAME` values,
scheduled trigger, enable flag, and exact team scope are absent; and no Local
URL/key was set. `ADMIN_SECRET` alone cannot use the lifecycle routes. Existing
manual KnowledgeDO
behavior and rows are unchanged; new tables/migrations are additive.
The focused workerd suite receives deterministic source-verifier values through
Miniflare-only bindings; they are test fixtures, not deployable configuration
or evidence that an external authority has been selected.

Because no external action occurred, there is no deployed resource, volume,
domain, Queue, source row, canary, or secret to roll back. The repository-level
rollback boundary is the B0-B4 file set above plus the exact SDK dependency;
existing manual storage must be retained. After any future deployment, rollback
must first disable exact sources and stop producers, preserve the durable
ledger/outbox and original Railway volume, and follow the separately approved
gate-specific plan rather than deleting state.

## Unverified external/runtime facts and known limitations

- The supported B1 identity permits only one enabled project per Slack channel.
- Local update, delete, get-by-`customId`, same-`customId` idempotency, and
  replacement-ID semantics are unverified. Capability methods remain absent;
  indexed edits, reply-deletion mutations, proven root deletes, and ambiguous
  adds block instead of guessing.
- Local bind host, safe health endpoint, generated bearer-key path/format/
  rotation, complete data path, arbitrary inherited `DATABASE_URL` behavior,
  non-root Railway volume ownership, and approved-account `gpt-5.1` model
  availability remain R1 runtime proofs.
- The exact project-administrator authorization issuer/key has not been
  selected or configured. The runtime can independently verify and durably
  consume its signed exact-scope grants, but issuance remains external and
  unavailable until the C1/S1 authority gate is explicitly approved.
- The DLQ consumer, Slack discovery, and manifest execution seams are locally
  tested but have not consumed a deployed Queue/DLQ, real production Slack
  history, or an approved P1 manifest. C1/S1/P1 remain required.
- Scheduled reconciliation is implemented and locally tested, but no
  production cron, Queue/DLQ names/bindings, enable flag, team scope, or
  deployed metric stream exists. Treat periodic convergence as unactivated
  until the exact C1 configuration and runtime proof are approved.
- The P1 approval route requires `ADMIN_SECRET` plus a valid independently
  issued Ed25519 artifact. No external P1 issuer/key has been selected or
  configured, so the route is intentionally unavailable and no approval has
  occurred. The route contains no signing key or minting path.
- The pinned Local binary/image has not been built or started here. Artifact
  download/checksum, first boot, log redaction against the real binary,
  authenticated add-to-done-to-search, cross-workspace isolation, restart
  persistence, backup/restore, and key rotation are not runtime-verified.
- No Railway target, service, volume, domain, Cloudflare Queue/DLQ, Slack scope,
  source, canary, or backfill target is asserted or invented by this report.

## External stop gates

- **R1 — Railway provisioning/deploy:** present exact new project/service,
  volume, domain, version/checksums, variables/secrets, cost cap, downtime,
  runtime proofs, and rollback; mutate only after explicit R1 approval.
- **R2 — restore/key rotation:** present exact original/restored same-service
  volume and rehearsal plan; execute only after explicit R2 approval.
- **C1 — Cloudflare:** present exact Queue/DLQ bindings, retry/retention policy,
  Worker target, and secrets; deploy or mutate only after explicit C1 approval.
- **S1 — Slack:** present exact scopes/subscriptions/install consequences;
  change or reinstall only after explicit S1 approval.
- **P1 — production data:** name the exact team/project/channel canary and every
  backfill manifest separately; ingest only after explicit P1 approval and the
  restore/cross-workspace prerequisites pass.
- **D1 — cleanup:** default RETAIN. Require refreshed exact IDs, usage,
  dependencies, domains, volumes/backups, owner confirmation, rollback proof,
  and explicit deletion approval before any cleanup.

## Next safe action

Run Task G as a fresh, independent, read-only adversarial re-review of the
corrected combined source, `CORRECTION-REPORT.md`,
`SECOND-CORRECTION-REPORT.md`, and this evidence. The integration audit found
zero remaining source blockers across the six rereview findings (and zero
remaining blockers from the seven original findings), but it is not a
substitute for that fresh re-review. Any new BLOCKING source, security,
durability, or invariant finding must be corrected and followed by another
fresh independent re-review. Do not begin R1 planning or any external action
until Task G reports no BLOCKING findings.
