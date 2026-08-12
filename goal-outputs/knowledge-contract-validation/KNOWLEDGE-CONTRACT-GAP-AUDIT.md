# Knowledge and Slack Contract Gap Audit

Updated: 2026-08-02 23:34 PDT

This audit separates local source/test completion from deployed evidence. It is
the authoritative gap list for the current knowledge, Slack reaction, and
runtime-boundary validation goal. A green local test is not treated as a live
integration result.

## 23:34 PDT current-state reconciliation

The source/test milestone remains green: Slack reaction and membership
contracts, bot-message retention without turn feedback, durable event
ownership, actor-bound MCP authorization, operator-only named raw templates,
synthetic Buzz admission, and synthetic provider-effect recovery are covered
by focused tests. The full local suite passes 146 files / 1,390 tests, with
typecheck and diff checks passing.

The strict read-only live preflight still has exactly three blockers:
Supermemory is missing `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the
Supermemory and Graphify query instances each report
`active=1, healthy=0, failed=0`. The authenticated Slack token readback also
returns `missing_scope` for reaction, profile, and manifest inspection, so
source manifest coverage is not installed-token evidence. Live signed Buzz
admission, a broker-wired provider workspace/effect, deployed recovery drills,
and clean harness source-to-image provenance remain unproven. No external
mutation was performed.

## 23:36 PDT blocked-state audit

The same external blockers have recurred across three consecutive goal audits.
Local source/test evidence is complete for the safe scope, but live completion
requires production credentials and mutations excluded by the current handoff:
Supermemory R2 secret/deployment, Slack manifest reinstallation, valid Buzz
signer/relay admission, a configured custody/provider adapter and test
workspace, live recovery drills, and clean harness provenance deployment.

## 23:01 PDT integrated synthetic admission/effect recheck

The assembled Buzz receive path now has a synthetic relay proof: NIP-98
authorization is verified, a signed kind-9 event is fetched and verified,
tenant resolution and durable admission run, a signed fixed reply is accepted,
and replay is suppressed. This closes the local wiring proof only; no live Buzz
event or tenant-scoped callback receipt exists.

The platform effect runner now has a tenant-scoped synthetic recovery proof
covering the metadata-only connector-effect envelope, opaque credential lookup,
an ambiguous provider failure, same-idempotency retry, stable external receipt,
and completed-rerun rejection. Provider tokens are absent from adapter
envelopes and ledger reports. This does not configure a provider adapter,
custody mapping, or external provider workspace.

Local validation passes 146 unit files / 1,386 tests, 8 bot e2e files / 70
tests, Graphify e2e 5 tests, Graphify policy 10 tests, typecheck, deploy-config,
static rollout, artifact verification, and diff checks. Live resource and
registration checks pass without a health requirement. The health-gated check
still reports Supermemory and Graphify `active=1, healthy=0, failed=0`.
Read-only secret-name checks show no Supermemory R2 access-key pair and no
effecter provider-adapter binding/auth secret. FUSE, provider add/poll/search,
live Buzz admission, custody, external effects, and recovery remain open.
No external mutation was performed.

## 22:49 PDT local generation-fence and regression recheck

The Slack manifest receipt now uses the existing durable
`slack_installation_manifests` table as its single source of truth. Recording
requires the active installation generation, rejects stale observations and
generation mismatches, preserves prior generations, and reports whether the
latest receipt is fresh for the current installation. The digest covers the
capability set rather than `observedAt`, so polling does not create false
manifest revisions. The contract/manifest slice passes 7 tests and the
WorkspaceConfigDO generation suite passes 10 tests.

The full local validation passes 146 edge unit files / 1,384 tests, 8 bot
Worker e2e files / 70 tests, Graphify e2e (5 tests), Graphify policy (10
tests), typecheck, deploy-config validation, static rollout checks,
Supermemory/tigrisfs artifact verification, shell syntax, and diff checks.
Docker remains unavailable at `/Users/will/.docker/run/docker.sock`, so image
build, FUSE persistence/remount, and restart recovery are not proven. Live
installed-manifest/scopes, Buzz admission, provider custody/effects, live
Queue/DLQ or isolate-loss recovery, and clean harness source-to-image mapping
remain open. No deployment or external mutation was performed.

## 22:08 PDT live Slack completeness and provenance readback

The manifest regression passes 2 tests and asserts the required Slack
history/read, reaction, profile, team, and channel-join scopes. Its event
families include reactions, membership, installation revocation, and channel
lifecycle changes. Authenticated membership readback confirms bot
`U0BAK4AJ2Q1` in the four visible public channels: `#general`,
`#new-channel`, `#social`, and `#skills`.

The human explicit canary
[`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
returned `OPENTAG_MILESTONE_EXPLICIT_OK` at `1785728831.600039`. The
bot-message event canary
[`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
returned `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`; the live
tail recorded an indexed queue outcome. The reaction lifecycle canary
[`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
showed the working `eyes` reaction while running, returned
`OPENTAG_REACTION_LIFECYCLE_OK` at `1785729227.808039`, and had no reaction
after terminal cleanup.

These receipts prove live Slack response/reaction behavior and bot-message
event handling only. They do not prove installed-token scopes,
complete-history or private/MPIM coverage, or KnowledgeDO/derived-index
queryability. The strict rollout check still fails only the Supermemory and
Graphify query Container health aggregates. Local harness provenance is
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
with `workingTreeDirty:true`; the deployed image is
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
Docker/FUSE build and clean source-to-image attestation remain open.

## 22:14 PDT final local and strict live gate rerun

The final local edge unit suite passes 145 files / 1,379 tests; bot Worker
e2e passes 8 files / 69 tests; typecheck and `git diff --check` pass.
Graphify Worker e2e passes 5 tests, Graphify policy passes 10 tests,
deploy-config validation passes, the Slack manifest test passes 2 tests, shell
syntax passes, and downloaded Supermemory/tigrisfs artifact verification
passes.

The strict read-only rollout check passes every static, R2, deployment,
secret-name, pin, and artifact assertion. It fails exactly two live health
gates: Supermemory query `instance_state=running; active=1; healthy=0;
failed=0` and Graphify query `instance_state=running; active=1; healthy=0;
failed=0`. No deployment, restart, Queue mutation, credential change, or
provider action was attempted.

## 21:56 PDT local source reconciliation

The local Supermemory implementation now follows the approved pinned tigrisfs
Container contract. The image pins `v1.2.1` and verifies the Linux/amd64
archive checksum; the entrypoint requires R2 storage variables, starts the
FUSE mount, performs an unprivileged read/write probe, and writes the
R2-ready sentinel only after success. The Worker maps R2 access secrets into
Container `envVars`, removes storage/facade credentials from the Supermemory
child, and observes the mount without calling Sandbox SDK bucket-mount methods.
The bot binding has no derived-index credentials.

The ledger now has a durable body-free queryability receipt separate from
provider-poll `indexed` completion. It is fenced by source identity, content
and index revisions, local document ID, and derived-index generation; repeated
writes replace one fence idempotently, stale generations fail closed, and
status aggregates distinguish unverified/searchable/no-match/provider-
unavailable. Fresh validation passes 145 edge unit files / 1,376 tests, 8 bot
Worker e2e files / 69 tests, Graphify e2e (5 tests), Graphify policy (10
tests), focused Supermemory/checker tests, typecheck, deploy-config validation,
source-pinned rollout preflight, shell syntax, diff checks, and downloaded
Supermemory/tigrisfs artifact verification. Docker/FUSE, live provider, Buzz,
effect, and harness gates remain open. The strict read-only live check passes
all static/resource assertions and fails only the Supermemory and Graphify
query health aggregates (`active=1`, `healthy=0`).

## 21:23 PDT artifact and regression recheck (historical snapshot)

The pinned Supermemory artifact passed checksum and runtime-marker
verification at that earlier source snapshot. That mixed snapshot temporarily
described the Worker-owned credential-less R2 binding design; the current
handoff instead requires the pinned tigrisfs Container mount. The final local
regression passes 145 unit files /
1,373 tests, 8 bot e2e files / 67 tests, 5 Graphify e2e tests, 10 Graphify
policy tests, typecheck, deploy-config validation, shell syntax, and diff
checks. Docker/FUSE build and restart persistence remain unverified because
the local Docker daemon is unavailable; live provider, Buzz, effect, and
harness gates are unchanged.

## 21:16 PDT audit reconciliation

The latest authenticated readback is knowledge-ready (HTTP 200) but full-ready
HTTP 503 on credential-broker reachability, platform-effecter reachability,
and OAuth. The tenant ledger is 84 rows: 55 indexed, 2 pending, and 27
permanent failures; tenant outbox and tenant-local DLQ are empty.

The derived-index gap is now precise: Queue dispatch records `indexed` after
provider `documents.get(...)=done`, without a search readback. The exact fresh
marker still returns zero operator citations. A local adapter regression covers
`add -> documents.get(done) -> search` and keeps provider completion separate
from query convergence. Do not close the “indexed and searchable” claim until
the raw provider response, ledger row, and citation filtering outcome are
correlated or a durable query-convergence receipt is added.

Supermemory v18 and Graphify query v6 each report active/running with zero
assigned/healthy instances. Buzz source plumbing is locally complete, but the
live signed path remains at relay HTTP 526. The effecter has no provider
adapter and custody has no default Secrets Store mapping; no real provider
effect or live recovery drill is proven. Harness version 4 is healthy with a
known image digest, but the dirty local source manifest and Docker outage keep
source-to-image attestation open.

## 20:59 PDT final read-only gate sweep

The deployed bot is HTTP 200 and the harness reports version 4 with seven
healthy instances on image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
The dirty local source manifest differs from that image, so clean
source-to-image provenance remains open. The empty Buzz probe returns HTTP 400
`buzz_wake_unexpected_fields`, not a signed admission receipt.

The fresh unmentioned Slack marker still has zero authenticated knowledge
citations despite a queue `indexed` outcome. Tenant status is 83 rows: 55
indexed, 2 pending, and 26 permanent failures; outbox and tenant-local DLQ
are empty. Strict rollout still fails both query Container health aggregates
(`active=1`, `assigned=0`, `healthy=0`, `failed=0`). No deployment, replay,
provider or Queue mutation, credential removal, commit, push, PR, or external
publication occurred.

## 21:06 PDT local stability validation

The affected Slack/knowledge source slice passes 8 files and 95 tests,
including routing, pre-admission, Slack manifest/lifecycle, knowledge
scheduling/observation, Web API writes, and canonical thread normalization.
Typecheck and staged/unstaged diff checks pass. These are local source
receipts only; deployment, installed-scope readback, and live inclusion
convergence remain open.
The follow-up queue/normalization/Web API rerun passed 3 files and 70 tests,
including the explicit bot-message Events API indexing contract.

## 21:09 PDT full validation rerun

The full edge unit suite passes 145 files and 1,372 tests; the bot Worker e2e
suite passes 8 files and 67 tests. Typecheck and staged/unstaged diff checks
pass. The only output is the known nonfatal Graphify dependency sourcemap
warning. This is local evidence; deployment and live convergence remain open.

## 21:10 PDT local failure/recovery slice

Durable ingress, Stop/recovery, knowledge reconciliation/queue, Supermemory
boundary, harness routing, and runtime-probe tests pass: 9 files and 140
tests. These are deterministic local receipts only; live isolate-loss,
deployed Queue/DLQ replay, provider recovery, and Container restart durability
remain open.

## 21:12 PDT derived-index validation

Deploy-config validation passes. Graphify Worker e2e passes 1 file / 5 tests,
Graphify policy passes 10 tests, and static rollout checks pass for privacy,
single-writer/pin/catalog/CAS/artifact policy, binding-owned R2, and
authoritative Queue/DLQ ownership. The last strict live result still reports
zero healthy instances for both query Container aggregates.

## 21:13 PDT strict live rollout recheck

All static, R2, secret-name, pin, artifact, and deployment assertions pass.
The only live failures remain Supermemory query and Graphify query Container
health: both report `instance_state=running; active=1; healthy=0; failed=0`.
No deployment or recovery mutation was attempted.

## 20:51 PDT local response-routing repair

The latest human-authored no-mention control remained silent while the
explicit control succeeded. The local response router now recognizes
response-directed reply/respond/answer phrases with exact/with/to
continuations and keeps negative phrases silent. The focused routing and
pre-admission tests (30) plus typecheck pass. Deployment, reaction-scope,
event-subscription, and indexing receipts remain open.

## 20:41 PDT fresh live reconciliation

The latest authenticated knowledge readiness probe is HTTP 200, but the
authoritative tenant status is now 80 rows: 53 indexed, 2 pending, and 25
permanent failures. The tenant-local DLQ summary is zero while the separate
operator Queue/DLQ endpoint contains 100 pending captured records. This
scope mismatch is now an explicit documentation gap; neither surface proves
that the other is empty.

The fresh deployed Slack canary wrote marker 1785725283.368069, kept
unmentioned retrieval 1785725304.390959 silent, and returned
OPENTAG_SUPERMEMORY_SEARCH_OK for explicit retrieval 1785725373.889899 at
1785725391.260059. The installed token returns missing_scope for reaction,
profile, and manifest readback calls. Only four visible public channels are
confirmed. Complete-history, private/MPIM, workspace-wide, and installed
manifest receipts remain open.

The upgraded Worker-owned R2 binding source is stable and locally validated.
The strict live check still fails both derived-index aggregate health checks
(active=1, assigned=0, healthy=0, failed=0), and the local successful-2xx
readiness correction is not deployed. The local inclusion fence and
no-mention retrieval classifier repair remain deployment-gated. Buzz signed
admission, provider effects, live recovery drills, and clean harness
source-to-image provenance remain open.

## 20:37 PDT provider-readiness correction

The Supermemory entrypoint and Worker lifecycle now require a successful `2xx`
response from `/v3/openapi` before releasing provider readiness. A listening
application that returns `4xx`/`5xx` can no longer make the port gate report
healthy. Focused boundary tests, shell syntax, typecheck, and diff checks pass.
The strict live rollout check still fails both query Container health checks:
each reports `active=1`, `assigned=0`, `healthy=0`, `failed=0`; no production
redeploy was performed.

## 20:16 PDT local hardening addendum

The source audit found an acknowledgement gap between durable outbound
observation and thread fetch: a transiently stale `conversations.replies`
response could omit the just-observed message while still being classified as
complete. The queue job now carries the exact observed Slack timestamp for
non-delete message, edit, reaction, and outbound observations. Normalized
dispatch checks for that timestamp before `/message-thread/put` and before any
derived-provider mutation; omission records retryable
`slack_thread_incomplete / observed_message_missing`. This is local/test
complete only and remains an open deployment/live-receipt row in the audit.

The final local pass is green with 144 unit test files / 1,370 tests, 67 bot
Worker tests, 5 Graphify Worker tests, 10 Graphify policy tests, typecheck,
artifact/deploy checks, static/live rollout preflights, and diff checks.

## Latest live reconciliation — 2026-08-02 19:45 PDT (historical snapshot)

At that historical checkpoint, the immediate Supermemory reachability incident
was repaired enough for a bounded live search path, but the durable knowledge
contract was not complete. The deployed source used the upgraded Worker-owned
Cloudflare R2 binding mount with a disposable local model-cache overlay. The
current local source contract is the pinned tigrisfs Container path recorded at
the top of this audit.

### 19:00 PDT recovery and relay evidence

- Authenticated knowledge readiness remains HTTP 200. The current Supermemory
  singleton is version 18 and its provider tail contains document write/poll
  plus `/v4/search` HTTP 200 responses after the local model-cache overlay.
- The failure inspection route returned only safe metadata. Recovery reopened
  30 prior `local_add` rows with correction reference
  `supermemory-v18-r2-model-cache-repair-da95429a`; it reported 30 reopened,
  0 blocked, and 0 failed. The current tenant readback is 77 ledger rows:
  32 indexed, 19 leased, 2 pending, and 24 permanent failures. Outbox and DLQ
  work are empty; reconciliation scanned 77, enqueued 19, and skipped 58.
- The 24 permanent rows are not an unexamined backlog: 23 are
  `unsupported_update_contract` and one is Slack `thread_not_found`. The 19
  leased rows remain the active recovery gap and need observed convergence or
  lease-expiry/retry evidence.
- Bot version `764a18ea-bda9-4209-bdbc-0b9cc81a6cba` qualifies Buzz failure
  at phase `relay_http`, status 526. Re-provisioning the canonical relay
  origin did not change it. Local direct requests reach the relay and return
  expected 401/403 authorization responses, but no signed Worker admission,
  tenant callback, dedupe, or retry receipt exists.
- Local harness provenance remains dirty with digest
  `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`;
  Docker and authenticated live source-to-image readback are still open.
- The durable recovery stall is repaired in bot version
  `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`: ambiguous-add recovery preserves or
  safely adopts the exact normalized revision, and an expired
  `processing_unconfirmed` poll renews the bounded window for the same
  document ID. Tail evidence shows three post-fix indexed successes and four
  earlier recorded successes; the final tenant counts still require a durable
  status readback after the Queue drain.

### 19:45 PDT validation evidence

- Typecheck, 1,368 unit tests, 67 bot Worker tests, 5 Graphify Worker tests,
  Graphify policy tests, deployment-config validation, Supermemory artifact
  verification, static/live rollout preflights, Graphify pin verification,
  shell syntax, and staged/unstaged diff checks all pass.
- Read-only Container state shows one running Supermemory instance at version
  18 and one running Graphify query and builder instance at version 6. Docker
  is unavailable; FUSE remount, restart persistence, and clean source-to-image
  attestation remain open. The Container API's aggregate health fields show
  active instances but zero assigned/healthy counts, so the instance listing
  and provider HTTP receipts must not be conflated with a full health proof.

### P0 — still blocks the “every message is indexed and searchable” claim

- Authenticated `/ready?profile=knowledge` is HTTP 200 and the Supermemory
  singleton is running version 18. Provider tail evidence shows document
  write/poll responses and `/v4/search` HTTP 200, so provider reachability is
  no longer the immediate blocker. Restart/remount persistence,
  update/delete/tombstone convergence, parity, and latency receipts remain
  open.
- The latest tenant status is 77 ledger rows: 32 indexed, 19 leased, 2
  pending, and 24 terminal `permanent_failure` rows. Outbox and DLQ work is
  empty. Thirty old `local_add` rows were reopened with recovery receipts, but
  19 remain leased and have not converged. A readiness probe cannot substitute
  for row-level provider receipts or recovery audit entries.
- The live `all_delivered` policy still means every eligible event delivered
  to an installed-app source, not every workspace message. Inventory and
  complete-history backfill are both incomplete, so no workspace-wide
  completeness claim is justified.
- The installed bot still lacks source-declared `reactions:read` and
  `users.profile:read` scopes. The bot's visible four-public-channel
  membership is confirmed, but reinstall/readback, private-channel/MPIM
  visibility, and lifecycle/reaction event delivery remain unproven.
- The deployed bot did not respond to the unmentioned retrieval action at
  `1785725304.390959`, while the explicit-mention control at `1785725373.889899`
  retrieved the fresh marker successfully. The local source now has retrieval
  classifier rule `t1.12` with passing route/pre-admission tests; deployment
  and a repeat live canary remain open.
- A fresh marker write and explicit-mention Slack retrieval returned
  `Searching Slack` and `OPENTAG_SUPERMEMORY_SEARCH_OK`, with no lingering
  reaction on the parent. The equivalent untagged search request was silent
  on the deployed version. The source fix now routes leading search/lookup/
  query requests as retrieval/action traffic, but live re-verification awaits
  deployment approval.
- The strict live Container preflight fails for both query instances because
  Cloudflare reports `running`, not `healthy`. The local port gate now exposes
  a provider-sentinel-backed `/health` response; the image and Worker still
  need a gated redeploy before this can be verified live.

### P1 — blocks operational and effect confidence

- The five-minute reconciliation/600-second ACL freshness repair is live and
  has a successful Slack canary, but it still needs repeated scheduled
  readback, revocation/leave/archive behavior, and source/project identity
  convergence evidence.
- Resolve the Worker-to-relay HTTP 526 boundary, then produce valid signed
  NIP-OA Buzz admission with authenticated relay fetch, tenant admission,
  dedupe, retry, and callback receipts.
- Configure an OpenTag-mediated controlled provider workspace and run effect,
  revocation, deletion, and ambiguous-failure receipts through broker/custody.
- Run live Queue/DLQ replay, isolate-loss, provider lease, and Slack write
  failure-injection drills. Local tests remain contract evidence only.
- Finish Graphify exact-commit artifact publication/query/citation evidence and
  attest the harness image to a clean source revision.

### P2 — quality and product-hardening gaps

- Decide retention and search semantics for placeholder/progress/tool-status
  revisions, then add content governance, physical purge, and derived-index
  tombstone reconciliation for broad admission.
- Keep router tiers dark until shadow quality, latency, cost, feedback, and
  rollback gates pass; finish delayed-file/HITL, Stop late-output, Nanocodex
  reconnect, and OAuth redirect-origin canaries.

## Historical live reconciliation — 2026-08-02 17:38 PDT

The most important distinction is now explicit: the OpenTag source contract is
substantially implemented, but the live knowledge provider and the installed
Slack application are not converged with that contract.

### P0 — blocks the “every message is indexed and searchable” claim

- The live WorkspaceConfigDO policy reads back as `all_delivered` with
  `defaultProjectId: workspace-default`. That means every event delivered to
  an eligible installed-app source is admitted by server policy; it does not
  grant Slack-wide history access and it does not prove a backfill.
- The installed bot token has `channels:history`, `groups:history`,
  `im:history`, and `mpim:history`, but it does not have the source-declared
  `reactions:read` or `users.profile:read` scopes. Direct API probes return
  `missing_scope` for both. The source manifest is ahead of the installed
  installation and must be reinstalled/read back before event enrichment can
  be called complete.
- The bot-token conversation surface currently returns four public channels
  (`#general`, `#new-channel`, `#social`, `#skills`) and two DMs. The bot is a
  member of all four visible public channels. Private-channel, MPIM, archived,
  and any other workspace conversation coverage is not proven. This is an
  installed-bot visibility boundary, not a workspace export.
- Authenticated knowledge readiness still fails only
  `knowledgeSearchReachable`. Supermemory is assigned but unhealthy and
  Graphify remains unassigned and unhealthy. The remote Supermemory
  `error.log` identifies repeated `EIO` failures when the local embedding
  model is atomically renamed inside the R2/FUSE-mounted data directory.
  No successful provider add, poll, search, update, delete, tombstone, or
  remount receipt exists.
- The tenant status has 64 ledger rows: 42 `permanent_failure`, 22
  `retryable_failure`; outbox pending/sending/due and DLQ counts are all zero.
  Reconciliation has 34 completed and three running records, while inventory
  and backfill completion are both zero. The source event path is therefore
  accepting and durably recording work, but it is not producing searchable
  provider evidence.

### P1 — blocks production completeness and external-effect confidence

- Complete the Slack app reinstall and installed-manifest readback, then
  prove reaction-added/removed, membership, lifecycle, token-revocation, and
  ACL-refresh receipts. A source manifest test is not an installed event
  receipt.
- Run the bounded complete-history inventory/backfill and retain its manifest,
  digest, cursor, counts, and terminal receipt. The current `all_delivered`
  policy does not substitute for that historical operation.
- Generate a valid signed NIP-OA Buzz wake with an authenticated relay fetch,
  tenant admission, dedupe, retry, and callback receipt. The current empty
  `/buzz/wake` probe only reaches schema validation; local development vars do
  not contain a usable signer secret.
- Configure the broker/custody binding map and an OpenTag-mediated controlled
  provider workspace. The connected Linear surface exposes the Berendo team
  but no projects; using the connector directly would bypass OpenTag's
  credential/effect boundary and is not an end-to-end provider test.
- Run live ambiguous Slack write, isolate-loss, Queue/DLQ replay, provider
  lease, Buzz retry/dedupe, and source deletion/reconciliation drills. The
  local matrices prove contracts only.
- Attest the harness image to a clean source revision. Wrangler exposes the
  live image digest and seven healthy instances, but the local provenance
  manifest is dirty and no embedded live source manifest has been read back.

### P2 — quality, scale, and product-hardening gaps

- Decide whether transient placeholders/progress/tool-status revisions should
  remain in the canonical knowledge corpus. The current contract observes
  them by default and refetches the current thread, so it does not preserve
  every streamed revision as a separately searchable historical document.
- Add content-governance classification, physical purge/tombstone receipts,
  retention enforcement, and derived-index reconciliation for broad
  `all_delivered` admission.
- Add router shadow quality/latency/cost/feedback/rollback gates before
  enabling Tier 1 or Tier 3; add external metrics/traces only when structured
  logs no longer provide sufficient operations evidence.
- Finish Graphify artifact build/query receipts, repository pagination and
  scale tests, ACL normalization, attachment/file-body treatment, HITL and
  delayed-file canaries, Stop late-output suppression, Nanocodex checkpoint
  reconnect, and OAuth redirect-origin configuration.

### Local repair not yet deployed

The current local Supermemory source increases the Worker container wake bound
to 90 seconds, prepares `/var/cache/supermemory`, passes the Sandbox s3fs
`use_cache` option, and makes `onStart` wait for both the Worker-owned R2
binding and the application on port 6768 before releasing readiness.
Typecheck, focused tests, the live static rollout checker, and pinned artifact
verification pass. The Worker-side change is deployed as
`be2128c7-2617-4acb-b378-9522252451ea`, but `--containers-rollout=none` left
the existing image/instance in place; Docker is unavailable for the required
image rollout. The live EIO error therefore remains open.

## Evidence boundary

The authoritative checkout is `/Users/will/Documents/opentag`, on `main` at
`d075431f25f886842aec5552314afea9d1c9c1dd`, with user-owned uncommitted
knowledge, Supermemory, and Graphify work preserved in place.

The final inspected bot code deployment is `a257b512-3f68-4b5e-946f-672594562697`.
Its `/health` response is HTTP 200 and reports the pinned model, reconciliation
trigger, knowledge bindings, observer, index generation, relay allowlist, and
broker auth as configured. The authenticated `/ready` route is present, but an
unauthenticated probe returns 401 and no operator readiness receipt is recorded.

The two derived-index Workers are deployed privately. Current Wrangler
Container image digests are Supermemory
`sha256:21798c888e0551451b7eca3011a5959d136ef8d94c71ca4a7bac75ab0290036a`
and Graphify
`sha256:d91bd16cb1843248744c8e95c9fcbc1fcf4b5554a8e8a95f72ba89a45055f2cd`.
Both singleton query instances are active/running but report zero healthy
instances and zero assigned instances. No live query or artifact receipt has
been read back. The live knowledge
rollout checker passes deployment, binding, bucket, and fail-closed
architecture checks. The local source now uses credential-less Sandbox SDK R2
binding mounts; the deployed image/source relationship and provider boot
remain open. Public workers.dev 1042 responses are expected because the
services are private.

The latest Supermemory Worker version is
`91916818-d7a0-4359-b220-e9c0dc690a1d`. A fresh internal bootstrap API key is
present in the private state bucket and the approved OpenAI provider secret is
stored only on that private Worker. The current live probe enters the Sandbox
SDK `containerFetch` path and is canceled at approximately 30 seconds before
`onStart`, the R2 mount, the port-gate release, or the application health
probe. This is now a distinct P0 Container provisioning/port-readiness gap,
not merely a missing application secret.

The current tenant status readback is 40 terminal `permanent_failure` ledger
rows, zero pending/sending/due outbox work, zero DLQ work, 21 completed
reconciliation runs that skipped all 40 terminal rows, zero backfill or
inventory receipts, and 59 durable message-to-thread mappings. Static/live
rollout checks pass, but FUSE persistence, provider parity, and cutover remain
unproven.

The bot's current knowledge deployment declares a 15-minute reconciliation
trigger and the current Slack team scope. That is configuration evidence, not
cron execution. The live WorkspaceConfigDO admission policy is readable as
`all_delivered` with `defaultProjectId: workspace-default`; an existing source
state still reports project `default`, so policy/source identity convergence
remains open.

The broker/custody internal service-binding auth secrets are now configured.
Custody still reports `bindingConfigConfigured:false`, and the effecter reports
no provider adapters with `providerEffectsEnabled:false`; no real provider
effect, receipt, deletion, or reconciliation is claimed.

The live Buzz route now has signer, relay, channel-map, and independent relay
allowlist configuration. An empty POST reaches schema validation and returns
HTTP 400 `buzz_wake_unexpected_fields`, closing the configuration gate. No
valid signed NIP-OA admission, authenticated relay fetch, dedupe receipt, or
tenant-scoped callback has been proven.

The connected Slack writer posted a current bot-authored marker at
`1785693801.754259` and read it back from `#general`; this proves connector
write/read and bot feedback-loop suppression only. Current human controls at
[`1785694221.865769`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694221865769),
[`1785694253.415069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694253415069),
and [`1785694282.922709`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694282922709)
prove delivery, flexible routing, reaction cleanup, and silent passive behavior.
A retrieval request at
[`1785694376.778339`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694376778339)
returned `Knowledge unavailable.`, so KnowledgeDO/index convergence remains
open.

The current-version controls against the guarded bot deployment are
[`1785701425.622489`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701425622489)
(explicit mention),
[`1785701448.262779`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701448262779)
(no-mention question), and
[`1785701473.534779`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701473534779)
(passive control). The first two received exact replies and had no terminal
`eyes` reaction; the passive control received neither. A smoke-style sentence
[`1785701364.700649`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701364700649)
was silent, demonstrating routing classification for non-question operational
text. Current-day search found no `OpenTag AG-UI` or `Working…` output after
the deployment. These controls do not prove reaction/membership event
delivery, queue receipt, or derived-index convergence.

The live harness Container application is
`a036892d-53b4-4d8a-a522-d5f6f2554778`; Wrangler verifies image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`
with seven healthy instances. The current local provenance manifest is
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
and is dirty, so the deployed image digest is known but its source relationship
to this checkout has not been attested.

## 2026-08-02 12:44 PDT recovery and preflight continuation

Authenticated live readiness returns HTTP 503 for both `knowledge` and `full`.
The configured bot binding is reachable, but the Supermemory and Graphify
private-service readiness probes are not both healthy. The tenant KnowledgeDO
status is more specific: 36 ledger rows are terminal `permanent_failure`, with
0 pending/sending/due outbox rows and 0 DLQ rows. Reconciliation has run 14
complete cycles plus 3 running records; its latest scan saw 36 rows and
skipped all 36 because terminal failures are not automatically replayed.

The latest source-state readback for Slack source
`slack:T0BBBEDLEGY:C0BA1MKPRE3:1785697846_427369` has project `default`, config
version 2, `lastLocalOperation: "add_started"`, `lastLocalError:
"local_rejected"`, `status: "permanent_failure"`, and no Local document ID.
This proves the event reached the KnowledgeDO ledger and the Local add
boundary, but not that the provider accepted or durably indexed the document.
The live admission policy is `all_delivered` with
`defaultProjectId: "workspace-default"`; the source's `default` identity is a
separate policy-resolution mismatch to correct before claiming workspace-wide
coverage.

The local repair closes several implementation gaps without claiming the live
gate is fixed:

- `edge/scripts/deploy-opentag.mjs` now fails closed unless one supported
  Supermemory provider secret is supplied or already configured, while keeping
  provider selection one-of rather than requiring every provider.
- Supermemory adapter errors retain only a bounded HTTP status class. HTTP 409
  is no longer treated as a safe retry, and an add that reaches an ambiguous
  5xx response keeps its durable `add_started` marker.
- KnowledgeDO exposes an exact, tenant-bound recovery request. It requires
  source/config/request identity, operator identity, and a bounded correction
  reference; it records `knowledge_recovery_audits` and requeues only terminal
  Local failures. Known-document failures retain their identity, while
  `add_started` rows without a Local ID requeue only into the provider identity
  probe. Tombstones and unsupported terminal causes remain audited as blocked,
  and no direct add is issued without an exact provider miss.
- The status snapshot reports recovery audit totals and the latest action, so
  operators can distinguish “reconciliation skipped a terminal row” from “a
  deliberate recovery was attempted.”
- Queue replay of an ambiguous add now probes the private Supermemory
  `documents/list` boundary with workspace and source-key filters, requires
  one exact `customId` plus metadata identity, adopts a single existing
  document, and only issues a new add after an exact miss. Multiple matches or
  malformed provider identity remain terminal and require operator review.
  The live provider cannot exercise this probe until its model/bootstrap
  secret is configured.

Local validation for this continuation is TypeScript typecheck, 70 focused
knowledge-ledger/reconciliation/adapter/SDK-contract tests, 16 Worker-ledger tests, and
`git diff --check`. The changes are still only in the dirty local checkout.
The remaining blockers are provider secret/bootstrap, safe identity resolution
for the 36 ambiguous add rows, the `default` versus `workspace-default`
policy correction, a fresh add/poll/search receipt, Graphify query/artifact
readback, signed Buzz admission, real provider effects, live fault injection,
and harness source-to-image attestation.

## 2026-08-02 10:57 PDT continuation

The local audit found a concrete tenant-boundary defect in connector
authorization. The two exported WorkspaceConfigDO authorization helpers and
the credential broker/custody revalidation calls bypassed `tenantStub`, so the
current WorkspaceConfigDO guard would reject those requests with
`tenant_scope_invalid`. All three call-site groups now use the common helper;
focused broker, custody, tenancy, and workspace-config tests plus typecheck
pass. The change is not deployed yet, so this closes the local defect only.

The source Slack manifest contains the required reaction, membership, message,
lifecycle, history, and reaction read/write coverage. The authenticated Slack
surface now lists bot `U0BAK4AJ2Q1` in all four visible public channels, and the
bot-token inventory reports `is_member:true` for `#general`, `#new-channel`,
`#social`, and `#skills`. Installed-manifest readback, private/DM/MPIM scope,
and complete per-conversation convergence remain open.

## 2026-08-02 11:04 PDT live continuation

The tenant-bound authorization repair is now deployed: custody version
`5efe1e39-c2c8-4220-a83f-16469aa09e7a`, broker version
`4db9e036-da62-49bb-82c8-76a94c9860c0`, and bot version
`bd19e926-b8c9-439c-a9e8-d01da0f6cbe2`. Broker health now delegates its
provider-resolution capability check to custody, so both live health surfaces
report provider resolution disabled while `bindingConfigConfigured:false`.
The bot health readback also confirms the immutable index generation after the
required deployment variable was restored.

A current bot-authored marker at `1785693801.754259` was written and read back
in `#general`. It confirms current connector write/read and bot-message
feedback-loop suppression only; it is not a human ingress, reaction lifecycle,
or derived-index receipt.

The authenticated Slack user then supplied live human controls. Explicit
mention `1785694221.865769` received one `eyes` reaction and the exact bot reply
`OPENTAG_EXPLICIT_HUMAN_CANARY_OK`; a later read showed the reaction removed.
No-mention question `1785694253.415069` received
`OPENTAG_NO_MENTION_CANARY_OK` without a mention and with no remaining
reaction. Passive `yo` control `1785694282.922709` received no reply, reaction,
or busy warning. This closes the current Slack ingress/routing/reaction/UI
canary gate, but not the KnowledgeDO/derived-index receipt gate.

## 2026-08-02 11:16 PDT knowledge retrieval canary

A fresh human request at
[`1785694376.778339`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694376778339)
asked the bot to find the exact prior marker
`OPENTAG_NO_MENTION_CANARY_OK`. The bot entered `Searching Slack` and then
returned `Knowledge unavailable.` at `1785694396.357459`; terminal readback
showed no lingering `eyes` reaction. This is a useful negative live result:
the Slack request was admitted and the search/error lifecycle cleaned up, but
there is no proof that the prior human marker reached KnowledgeDO or either
derived index. Until a tenant receipt and a successful marker search exist,
workspace-wide indexing remains unproven and the live knowledge path should be
treated as degraded.

The connected Linear surface currently exposes a `Berendo` team and no
projects. No project was created during this audit because a direct Linear
connector write would bypass OpenTag's still-disabled broker/custody/effecter
path and would not be an end-to-end provider test. The provider-workspace gate
therefore remains open.

## 2026-08-02 11:56 PDT credential-less R2 mount continuation

- [x] Replaced the local derived-index container credential path with
  credential-less Sandbox SDK R2 binding mounts. Supermemory uses a Worker
  `STATE_BUCKET` mount and a port gate so the bootstrap key cannot be created
  before storage is mounted; Graphify query uses a read-only `ARTIFACTS` mount
  and the builder receives no R2 material.
- [x] Updated package locks, focused tests, both Worker typechecks, the
  Graphify policy suite, the artifact verifier contract, rollout preflight,
  and deployment documentation.
- [ ] Deploy both changed Workers and prove mount/remount persistence,
  add → poll → search, update, delete, tombstone, and marker retrieval with
  durable receipt readback.

## 2026-08-02 11:37 PDT Slack membership continuation

The authenticated Slack connector invited bot `U0BAK4AJ2Q1` to
`#new-channel` (`C0BADPYGSR3`), `#social` (`C0BAF3XC3AA`), and `#skills`
(`C0BGS7FNQUE`). Fresh member readback includes the bot in all four visible
public channels, and the bot-token inventory reports `is_member:true` for the
same set. This closes the visible-channel membership sub-gate, but not
installed-manifest subscription readback, private/DM/MPIM coverage, reaction or
lifecycle event delivery, complete backfill, or derived-index convergence.

## Completed locally

| Area | Evidence | Boundary |
| --- | --- | --- |
| Slack event coverage | `slack-app-manifest.yaml` adds `reactions:read`, reaction events, and membership events | The installed Slack app has not been independently read back after reinstall |
| Bot-message indexing | `normalize-slack-thread.ts`, `normalize-slack-thread.test.ts`, and the knowledge spec retain the real Slack `subtype: "bot_message"` form with explicit attribution | Only events for admitted knowledge sources are scheduled |
| Feedback-loop prevention | Existing pre-admission rejects bot-authored messages before turn creation | The current bot-authored marker proves connector write/read, but a delivered bot-message event and derived-index admission have not been observed on the new build |
| Reaction and membership scheduling | `knowledge-jobs.ts` schedules reaction thread refreshes and durable membership ACL invalidations; documented reaction payloads without a parent resolve through body-free message-to-thread metadata, while `message_replied`, `message_changed`, and `message_deleted` use their nested or durable identities; `knowledge-acl-reconciler.ts` refreshes each tracked channel from Slack; canonical normalization and Supermemory enrichment now carry aggregate reaction counts; the bot's own transient `eyes` add/remove is excluded while user `eyes` remains a signal | The installed manifest, live refresh worker, new-build reaction lifecycle, and recovery of an event whose durable mapping is not yet present have not been independently verified |
| Durable Slack ACL state | `knowledge-do.ts`, `search-slack.ts`, `knowledge-acl-reconciler.ts`, and focused Worker tests persist the sorted member set, compute its digest server-side, fence refreshes by revision, enforce a bounded age, and issue/recheck revocable requester read leases | Live Slack credentials, membership pagination, and periodic reconciliation remain unproven in production |
| Outbound Slack observation | `web-api.ts`, `knowledge-observer.ts`, adapter render paths, busy feedback, Stop, terminal paths, and recovery paths use the observation contract; every committed write is observed by default, local metadata is stripped, same-millisecond observations are ordered, changed update bodies get distinct content-revision identities, idempotent duplicate writes can be looked up before observation, production indexed writes fail before network dispatch without an observer, and an unconfigured channel cannot complete observation with zero descriptors | The current durable bindings are deployed, but the live source policy, queue receipt, descriptor readback, and derived-index convergence are not proven |
| Silent AG-UI surface | `harness-progress-live.ts`, `harness-progress.ts`, `agent-turn.ts`, and `conversation-state-do.ts` no longer render the model identity or `Working…` text; final session context retains only the optional session-events link; `turn-lifecycle.ts` no longer starts Slack's `Thinking…` assistant status and retains only empty-status cleanup | Current human explicit/no-mention canaries show no lingering removed surface; isolate-loss and stale-status recovery remain open |
| Claude Tag-style working reaction | `bot-engine.ts` adds/removes `eyes` around ordinary human agent turns and skips explicit reaction/trivial-ack shortcuts; a durable delayed cleanup lease is aligned with the two-hour active-turn TTL, and `bot-engine-remote-git.test.ts` covers order | Current human explicit/no-mention canaries prove add/remove; reaction event refresh and isolate-loss lease recovery remain open |
| Reaction-aware retrieval input | `normalize-slack-thread.ts` includes aggregate reaction counts in canonical content/revisions; `slack-enrichment.ts` adds the engagement marker and records distillation/burst metadata; `supermemory-adapter.ts` sends the enriched primary document | Burst documents and structured distillation artifacts are not separately persisted/indexed; live add/remove readback is pending |
| Knowledge-read authorization | `knowledge-read-authorization.ts`, search tool tests, Graphify tests, and MCP tests re-read current bundle revisions and require resource-scoped connector grants before retrieval; actor-token Slack MCP Slack reads now use the same membership lease/check/release and ledger-current citation fence as the bot tool | Live ACL sync, actor MCP, and provider/upstream grant readback remain open; the public actor-token route still needs an internal transport boundary |
| Durable knowledge status evidence | `KnowledgeLedger.statusSnapshot()` and tenant-scoped `/admin/knowledge/status` expose persisted ledger, outbox, DLQ, reconciliation, backfill, body-free thread-fetch checkpoint state, server-owned inventory receipt counts, and message-to-thread-map volume/age; message-to-thread mappings are durable metadata used for reaction/deletion recovery | This is source-tested only; it does not replace Cloudflare Queue metrics, deferred-ingress receipt metrics, unresolved reaction/deletion counts, derived-index health, live ACL freshness, or per-conversation history/thread/file/subtype convergence receipts |
| Local safety gates | Full edge suite: 144 files / 1,357 tests; bot-store Worker suite: 8 files / 66 tests; Graphify Worker suite: 1 file / 5 tests; event-identity focus: 4 files / 108 tests plus 1 Worker file / 15 tests. Typecheck, deploy-config validation, static rollout checks, and `git diff --check` pass; only existing Container sourcemap warnings remain | Does not prove Cloudflare bindings, secrets, provider credentials, Slack installation, or live fault injection |

## Open gaps by priority

### Durable ingestion versus queryability is source-complete and live-open

The local ledger now treats provider poll completion and retrieval convergence
as separate facts. A queryability receipt is accepted only for the current
source identity, content/index revisions, local document, and derived-index
generation; it stores no body, query text, token, or citation excerpt. The
receipt can be replaced for the same fence and is aggregated without exposing
content. Live provider search must still write and read a receipt for a real
Slack marker, including an explicit no-match or provider-unavailable outcome.

### P0 — must close before claiming “every Slack message is indexed”

#### Server-owned workspace admission is implemented locally but not configured live

`WorkspaceConfigDO` now stores an administrator-controlled admission policy in
two modes: `explicit`, which preserves exact source rows, and `all_delivered`,
which materializes a server-owned default project, reader policy, and retention
policy on the first delivered Slack event for a channel. Existing disabled
rows remain explicit opt-outs. Outbound observations use the same resolver, so
the default policy also covers bot writes that arrive before a persisted source
row exists. The local Worker test proves creation, idempotent resolution,
version conflicts, active-effect fencing, rollback behavior, and opt-out
behavior. A policy rollback disables materialized workspace-default rows and
preserves them as explicit opt-outs, so restoring `all_delivered` cannot
silently reauthorize a previously materialized channel.

This closes the caller-controlled fallback gap in source. The production policy
is now readable in the live team DO as `all_delivered` with
`defaultProjectId: workspace-default`. The remaining production gaps are the
older `default` source-identity mismatch, Slack installation/membership/scope
and event-delivery coverage, and the complete history backfill. Until those
boundaries are receipted, the current deployed claim is not “every Slack
message.”

#### Bot-message subtype semantics are now explicit and source-correct

The normalizer now admits Slack's documented `subtype: "bot_message"` rows
before assigning `authorKind: "bot"`; the regression test uses that exact
shape. The pre-admission normalizer still rejects bot-only rows and the bot's
own user identity as turn triggers, so indexing bot output cannot wake a new
turn. This closes the local subtype defect, but a new-build Slack canary is
still required to prove that the installed app delivers and indexes such rows.

#### Knowledge retrieval requires one current resource authorization boundary

Unified, wiki, code, custom, and Graphify bot reads now re-read the current
WorkspaceConfigDO bundle, require the frozen turn snapshot to match the current
bundle revision, and require a connector grant bound to the requested source
scope. Actor MCP reads require a current channel-scoped bundle and revalidate
the source grant before accepting results. Slack's dedicated search path still
owns the stronger membership read-lease and citation rechecks. This closes the
previous caller-controlled resource-selection path locally; live actor-MCP,
upstream connector ACL sync, and provider effect authorization remain open.

The actor-token Slack MCP path now delegates Slack retrieval through the same
durable membership lease and per-citation ledger-current fence as the bot
tool. A deletion or unsupported update racing an actor search is therefore
suppressed locally. Live ACL synchronization and actor-MCP readback remain
unproven.

The public `/mcp/knowledge` route accepts either `ADMIN_SECRET` or an
actor-token header. The product decision is operator-only external MCP with
actor-bound tokens for internal calls, but the route has no separate internal
transport/origin gate. Keep actor-token access behind an authenticated internal
boundary (or split the route) before exposing the endpoint to external MCP
clients; short token TTL and HMAC validity are not an origin boundary.

#### Source-side durable knowledge ownership is complete; production rollout is not

The verified `/slack/events` route now persists a stable knowledge-event job
before returning HTTP 200. Outbound observations, duplicate-write lookup,
normal rendering, and `ConversationStateDO` recovery all use a durable
observation job with retry state; observer failures are propagated so the
visible write remains recoverable rather than silently losing the index event.
The source-side closure is covered locally, and the new Worker bindings plus
reconciliation trigger are deployed. Live descriptor readback is still open.
The primary `opentag-knowledge` Queue and `opentag-knowledge-dlq` exist in the
account; their existence and the deployment do not prove that the new bot
bundle has consumed a real event or that lag, retries, DLQ replay, and cursor
convergence are observable.

#### Outbound observation is durable in source; production readback remains open

Normal and recovery Slack writes now use a durable observation owner after the
Slack API succeeds, and observer failures are propagated so the visible write
remains recoverable rather than silently losing the index event.

The shared Web API now has a production-only required-observer mode. Adapter,
busy-feedback, Stop, progress, and bot construction paths enable it, so an
indexed post or update fails before network dispatch if the durable observer
binding is absent. ConversationStateDO recovery uses the same gate. When Slack
returns a successful or duplicate write without a timestamp, recovery looks up
the exact `client_msg_id`; it never treats the thread root as the new message
when an observation contract is active. These are local source/test closures,
not live deployment evidence.

Outbound scheduling now also fails closed when the exact channel has no enabled
source. The durable observation job returns a retryable failure and eventually
records exhaustion instead of being marked complete after creating zero
descriptors. An explicitly enabled source may still return zero newly accepted
descriptors for an exact duplicate or out-of-order revision; that is an
idempotent success, not an admission failure.

The live descriptor readback and queue lag/DLQ evidence remain open. The
account-level Queue and DLQ resources, current bot bindings, and reconciliation
trigger are deployed, but no real event has yet produced a durable current-build
receipt.

#### “Every message we send” now means every committed Slack write

The local outbound observer indexes every committed Slack post/update by
default, including placeholders and progress writes. Local control metadata
never reaches Slack, and an explicit internal `knowledgeIndex: false` is the
only suppression path. Same-body update retries deduplicate, while changed
update bodies receive distinct durable observation identities. Bot-authored
messages are still non-triggering, so raw capture cannot create a retrieval
feedback loop. The source-side policy gap is now closed: the server-owned
`all_delivered` resolver creates the default source for unconfigured channels,
DMs, and MPIMs. The live policy, Slack delivery coverage, and complete-history
backfill remain open before the phrase “every Slack message” can be a
production claim. The current observation contract re-fetches the whole thread,
so it converges the index to current Slack state; it does not preserve every
transient `chat.update` body as a separate historical knowledge version. That
is correct for current-state retrieval, but is an additional gap if streamed
intermediate revisions must be auditable or searchable individually.

#### “All delivered” is not a workspace export

Slack's Events API is visibility- and authorization-bounded: it delivers events
that the installed app and its bot user are allowed to see, not an unrestricted
workspace transcript. The repository manifest subscribes to the four message
families (`message.channels`, `message.groups`, `message.im`, and
`message.mpim`), but the installed app has not been read back and the bot is not
currently proven to be a member of every intended channel or private
conversation. Slack also does not deliver every message subtype through the
same event contract. The current normalizer intentionally admits a bounded set
of subtypes, represents unsupported/deleted rows with canonical markers, and
stores file metadata rather than file bodies. These are sensible safety and
cost defaults, but they are not literal byte-for-byte workspace capture.

The backfill runner now also supports a server-owned `discoverAll: true` mode.
It calls Slack `conversations.list` for public/private channels, IMs, and MPIMs,
keeps only non-archived conversations where the installed bot is a member,
persists a digest-bound inventory receipt in KnowledgeDO, and refuses incomplete
pagination or over-limit inventories. A retry of the same manifest reuses that
receipt instead of accepting caller channel IDs or cursors. History still caps a
manifest at 50 eligible conversations and 90 days, processes a bounded number
of pages per invocation, and does not prove that every historical channel,
DM, MPIM, file, edit, deletion, and unsupported subtype has reached a terminal
state. The production contract must therefore say either “every supported event
delivered to the installed app” or expand the source lifecycle and backfill
system before using “every Slack message.”

Closure evidence must include an installed-manifest readback, channel and
conversation inventory, durable per-conversation backfill receipts, and an
explicit treatment of inaccessible conversations, files, unsupported subtypes,
edits, deletions, archives, and app/token revocation.

The current bot-token channel inventory makes the boundary concrete: the bot is
confirmed as a member of `#general` (`C0BA1MKPRE3`), `#new-channel`
(`C0BADPYGSR3`), `#social` (`C0BAF3XC3AA`), and `#skills` (`C0BGS7FNQUE`).
The installed manifest, private/DM/MPIM inventory, and complete-history
receipts are still not read back.

#### Production knowledge workers are deployed but not operational

The bot config references deployed private `opentag-supermemory` and
`opentag-graphify` Workers, and both buckets and Container applications are
present. Provider boot secrets are still absent, and both singleton query
containers report zero healthy instances, so the services remain
fail-closed/degraded; the retrieval canary returned `Knowledge unavailable.`.
The Supermemory runbook also requires
FUSE persistence, key bootstrap, restart, single-writer, redaction, latency,
and parity gates before enabling traffic. Deployment presence is therefore not
an operational knowledge rollout.
The newly deployed platform effect/custody shells do not remove this gate or
the provider-effect gate because their health checks explicitly report disabled
provider execution.

#### The reconciliation scheduler is configured but execution is unproven

The production bot TOML now declares a 15-minute cron trigger and the
`KNOWLEDGE_RECONCILIATION_TEAM_IDS` scope, and health reports the trigger as
configured. No Cloudflare cron execution receipt, cursor/lag readback, or
tenant policy readback exists yet. Creating the derived-index Workers and
declaring a cron do not by themselves backfill missed events; a live cursor,
queue/DLQ, and convergence canary are required.

#### Slack ACL refresh is locally implemented but not live

Membership events correctly make a channel stale and retrieval fails closed.
`/acl/refresh` now accepts the canonical member set, computes its digest inside
the KnowledgeDO, persists the set, and requires an `expectedRevision`
compare-and-swap. Retrieval requires a fresh snapshot containing the requester,
with a bounded maximum age, and holds a short-lived KnowledgeDO read lease that
membership invalidation or replacement revokes before the final check. An older
refresh cannot reopen a newer invalidation and a digest alone cannot authorize
access. `knowledge-acl-reconciler.ts` fetches bounded
`conversations.members` pages through the shared rate limiter, refreshes each
tracked channel after membership events, and runs a periodic team pass.
The code is locally tested; the installed Slack manifest, live token scope,
production pagination, and scheduled production execution remain open.

The current local representation keeps the bounded member set as one validated
JSON value. That is safe for the current cap, but a large channel still causes
an O(member-count) parse on each authorization check. A normalized membership
table or equivalent indexed membership lookup remains a P2 scalability task
before very large Slack workspaces are admitted.

### P1 — required live evidence

#### The Slack manifest has not been installed and read back

The repository manifest is updated, but Slack-side subscriptions and the
`reactions:write` capability must be confirmed from the installed app. A
manifest file is not proof of production configuration.

#### Reaction/UI behavior is live for normal turns; event lifecycle remains open

The current human explicit and no-mention canaries proved the new `eyes`
add/remove lifecycle, flexible routing, and clean terminal surface. They did
not prove reaction_added/reaction_removed ingestion, membership refresh,
bot-message indexing, installed manifest readback, or isolate-loss cleanup.

#### Concurrent-turn UX remains hard-reject; working-reaction cleanup is source-complete

The response-worthy routing decision is followed by a hard active-turn
rejection when a distinct ask arrives during a live turn. The warning is a
stable-idempotent visible bot message and releases its dedupe claim when durable
outbound observation fails, but there is no durable follow-up queue, coalescing
policy, or status surface for the user. The `eyes` reaction now has a delayed durable
cleanup lease aligned with the two-hour active-turn TTL in addition to its
in-process `finally` cleanup; the normal-turn live canary proves terminal
removal, while isolate-loss lease recovery remains open. Knowledge scheduling now ignores only the bot's own
`eyes` add/remove events, while human `eyes` reactions still refresh the thread.
The product
contract must decide whether to queue, supersede, or explicitly reject a real
concurrent ask.

#### Buzz runtime configuration and authenticated admission are still incomplete

The deployed bot now has signer, relay URL, auth-tag, channel-to-tenant, and
independent `BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN` configuration. A live empty
POST returns HTTP 400 `buzz_wake_unexpected_fields`, so the configuration gate
is closed and input validation is live. There is still no evidence in this run
of a valid signed NIP-OA event, authenticated relay fetch, event verification,
dedupe, or tenant-scoped callback. Verify relay membership and run a controlled
synthetic signed event through the full path.

#### Provider effect execution is still fail-closed/synthetic

The platform/effecter and custody Worker shells are deployed. Broker and custody
service-binding authentication is now configured, but custody has no approved
Secrets Store binding map and the effecter reports no provider adapters with
provider effects disabled. No test provider workspace and scoped credential
fixture prove a real effect receipt followed by deletion/reconciliation. The
production adapter must remain fail-closed until that test is run and the
receipt is durable.

#### Harness image provenance is locally closed but not live-attested

The local release contract now hashes the exact Dockerfile, prompt, lockfile,
and image input sources in `edge/scripts/harness-provenance.mjs`. The one-click
deploy path injects the resulting source revision, source tree, content digest,
and working-tree state into the Cloudflare Container build. The Docker image
records those values as OCI labels and runtime variables; the Worker exposes
Cloudflare version metadata; and authenticated `/health/container` returns the
embedded image provenance. The current local manifest is
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
with `workingTreeDirty:true`. Wrangler now verifies the live harness image as
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`
with seven healthy instances. The embedded live source provenance has not
been read back and the image digest does not match the current source manifest,
so the digest is verified but source-to-image attestation remains open.

#### The one-click deploy path does not yet match the bot service graph

`deploy-opentag.mjs` now includes Supermemory and Graphify in the default
one-click plan and makes `--skip-knowledge` an explicit dependency-assumed
escape hatch. The default path fails early on the checked-in R2 placeholder or
missing immutable generation instead of publishing a bot whose required service
bindings cannot resolve. The two buckets and private Workers are now
provisioned, but the release flow still needs provider secrets, queue execution,
and health/readback gates before
publishing an operational knowledge path; the script does not create those
external credentials or prove Container readiness.
The direct-deploy footgun is now closed: `npm run deploy:bot` delegates to a
small guarded wrapper that rejects a missing or legacy
`OPENTAG_SUPERMEMORY_INDEX_GENERATION` before invoking Wrangler and forwards
the immutable value to the bot deployment. The one-click path still does not
create external credentials or prove Container readiness.

#### Failure injection is not complete

The local deterministic matrix now passes 10 targeted files / 143 tests. It
covers deferred ingress, ambiguous Slack writes, bot-turn observation recovery,
knowledge queue/ledger retry and exhaustion, effect leases, memory deletion,
Buzz admission contracts, and native Nanocodex response handling. Normal live
canaries cover successful admission and terminal rendering. The production
drills are still missing: acknowledgement cleanup after an ambiguous Slack
write, turn-finalization recovery after isolate loss, Queue/index retry and DLQ
replay in the deployed binding, provider effect lease recovery, and Buzz relay/
runtime retry with dedupe. Each live drill needs a durable before/after receipt,
not only logs; green local tests must not be reported as live recovery proof.

#### Cerebras-quality retrieval parity is still an architecture gap

The [Cerebras knowledge-base reference](https://www.cerebras.ai/blog/how-we-built-our-knowledge-base) describes a mature knowledge layer with source-local
ingestion, structured Slack thread distillation and bursting, a common
queryable schema, multiple retrieval signals, recency/IDF weighting, optional
reranking, project-scoped search, and small retrieval primitives exposed to
MCP clients. OpenTag currently has the source-local admission and normalized
thread foundation, but not the complete quality pipeline:

- Slack ingestion deterministically normalizes the current thread into
  Supermemory; it does not yet produce versioned distilled fields such as
  question, resolution, systems, code references, or qualifying author bursts.
- The live search adapter requests Supermemory `searchMode: "hybrid"` and the
  bot adds cross-source RRF. The bot does not yet expose explicit full-text,
  identifier/IDF, recency/age-decay, semantic-burst, and reranker lists with
  measurable per-stage results; the optional reranker is not wired into the
  ordinary tool path.
- The Cloudflare-only architecture intentionally uses a KnowledgeDO ledger
  plus derived Supermemory/Graphify indexes rather than the reference's one
  canonical embeddings table. That is a valid deployment choice, but it leaves
  cross-index ranking, revision parity, deletion convergence, and quality
  evaluation as OpenTag-owned work rather than capabilities inherited from a
  single query store.
- There is no checked-in golden corpus or production-safe retrieval evaluation
  that measures recall, citation correctness, freshness, ACL leakage, answer
  abstention, latency, and cost across Slack, code, wiki, and custom sources.

This is not a reason to weaken the current fail-closed rollout. Before calling
the knowledge base feature-complete, either narrow the public specification to
the current hybrid-index MVP or implement the missing distillation, burst,
ranking, evaluation, and cross-index convergence contracts and add them to the
deployment gates.

#### Slack lifecycle and revocation coverage is source-complete locally; live proof remains open

The manifest now subscribes to workspace uninstall and bot-token revocation,
the public-channel lifecycle family, and the private-channel `group_*` family.
The local handler persists a per-team installation generation and per-channel
lifecycle state in WorkspaceConfigDO, fences lifecycle delivery by
`(team_id,event_id)`, disables Slack sources and ingestion leases on bot
revocation/archive/deletion/unsharing/close/leave, invalidates KnowledgeDO ACL
state for affected channels, and requires explicit activation after reinstall.
A user-only OAuth revocation does not revoke the bot installation. Activation
never auto-re-enables a source that was disabled by the lifecycle fence, so old
derived documents cannot silently regain authority. Focused pure, Worker, and
queue tests pass. The installed live manifest, production lifecycle delivery,
and derived-index tombstone/reconciliation readback are still unproven; this
is not yet continuous-workspace evidence.

#### Broad indexing has no content-governance gate

The normalizer removes transport metadata and the harness has output-redaction
tests, but knowledge ingestion does not yet provide a workspace-configurable
secret/DLP classifier, legal-hold policy, admin visibility model, or a proven
physical-purge path for all derived indexes. `retentionDays` is represented in
source policy, while deletion remains a fail-closed intent/tombstone flow when
the provider mutation contract is not verified. Turning on `all_delivered`
therefore increases the amount of potentially sensitive content retained before
retention, deletion, export, and audit behavior is proven across the ledger,
Supermemory, Graphify, R2 artifacts, and citations.

#### Shared-fleet Slack credential tenancy is not closed

The locked deployment model is one shared Worker fleet with strict per-team
Durable Object isolation, but Slack calls currently resolve a deployment-wide
`SLACK_BOT_TOKEN` and a static channel-to-tenant map. That is sufficient for the
current single-installation canary; it is not a complete multi-workspace
installation directory with per-team token lookup, rotation, revocation,
Enterprise Grid/Slack Connect identity checks, and audit. Cloudflare Worker
Secrets are per-Worker configuration, not a per-tenant credential database.
Before admitting multiple Slack installations to the same fleet, the broker
must resolve the installation generation and tenant from server-owned state and
prove that one team's token, channel, source, queue, and DO namespace cannot be
used for another team.

#### Reaction artifacts are only partially materialized

Reaction events now trigger a thread refresh. Canonical normalization includes
the aggregate reaction count in both content and the content revision, and the
queue consumer invokes enrichment before the primary Supermemory add/update;
the primary metadata records reaction count, distillation status, and burst
count. The remaining retrieval-quality gap is structural: the returned
distillation artifact and burst documents are not yet separate durable indexed
artifacts, so a search result cannot independently cite a structured resolution
or author burst. Decide whether those are required product documents, then add
stable child identities, ledger ownership, update/delete behavior, and ACL-bound
citations. The normal human reaction add/remove canary is complete; reaction
event ingestion, membership refresh, and isolate-loss cleanup remain open.

#### Cross-source configuration and job identity are source-complete locally; non-Slack execution remains fail-closed

`tracked_knowledge_sources` now persists `source_type` with a legacy-table
migration, the enabled-source index includes it, exact source/effect/grant
queries include it, and Slack resolution filters to `source_type = 'slack'`.
Admin request/grant digests and the WorkspaceConfigDO tests also bind the source
type, including a same-key Slack/wiki isolation case. `KnowledgeJob`, ledger
and outbox uniqueness, event/history/DLQ records, reconciliation identity, and
descriptor keys now carry the source type, and the legacy Slack ledger unique
constraint has a durable migration. The queue consumer validates the typed
source and records a durable `unsupported_source_type` permanent outcome
without invoking the Slack adapter for wiki, code, custom-db, or Drive jobs.
The remaining gate is a live migration/readback on an existing team DO and a
source-specific connector fetch/dispatch contract before enabling a non-Slack
source class in a shared queue.

### P2 — hardening and scale gaps

| Gap | Why it matters | Required follow-up |
| --- | --- | --- |
| Graphify rebuild pass silently limits itself to 32 repositories | Enabled repositories beyond the first page can remain stale without an operator-visible signal | Add registry pagination/cursor ownership or emit a durable truncation metric and alert |
| Graphify Python API boundary has limited policy coverage | Artifact traversal and builder allowlists are tested, but query parsing/revision and subprocess failure boundaries are not exhaustively tested | Add request-level tests for auth, revision headers, artifact paths, bounds, and failure responses |
| Graphify stores `source.tar.gz` in every immutable artifact | It increases sensitive-source retention and R2 cost even though query paths use `graph.json` | Decide whether provenance needs the full archive; if yes, encrypt/retain/expire it explicitly; otherwise remove it |
| Graphify path queries rebuild an undirected projection per request | It increases latency as graphs grow | Cache a bounded projection keyed by artifact revision or precompute it during build |
| ACL state rows are never pruned | Event history is pruned, but one state row remains for every team/channel forever | Add retention or compact inactive channel state without weakening fail-closed behavior |
| Queue reconciliation is disabled in production health | Fresh edits/deletes can wait indefinitely after event loss | Provision and canary the scheduled reconciliation worker before promising completeness |
| Agent model is configured but not answer-canary verified | Routing can reach the configured model while answer delivery, latency, or terminal rendering still fails | Live health reports `modelConfigured:true` for `AGENT_MODEL = "gpt-5.6-sol"`; run a real answer canary and record the complete thread |
| Thread ingestion can exceed bounded per-attempt page limits | Retryable page, timeout, and transport failures now persist the next Slack cursor plus accumulated messages under the exact source/job identity; the next Queue attempt resumes from that checkpoint and status reports active checkpoint counts. Hard message/byte caps are now explicit permanent `slack_thread_size_bound` outcomes rather than endless retries | Add chunked/versioned thread artifacts or an approved larger-size contract, then prove long-thread convergence and expose source-level completeness receipts |
| Outbound `chat.update` revisions are durably identified but not retained as separate historical content versions | A thread refetch can observe the latest body while an earlier streamed body is no longer recoverable as knowledge | Decide whether knowledge is current-state or revision-history; if revision history is required, persist the committed body/revision in a bounded audit stream before refetching |
| Runtime health reports binding/configuration presence but not derived-index availability, queue lag/DLQ, ACL age, manifest revision, or reaction cleanup | A green `/health` response can coexist with missing Workers, stale ACLs, dropped observations, or an old Slack build | Keep `/health` as liveness and use the local admin-authenticated `/ready` production `full` profile as the strict configuration gate; it now performs bounded health probes for configured service bindings. The tenant-scoped `/admin/knowledge/status` exposes persisted ledger/outbox/DLQ/reconciliation/backfill/inventory/map state. Still add Queue lag, deferred-ingress exhaustion, ACL freshness, manifest revision, reaction cleanup, cron readback, and operator-visible readiness alerts, then deploy and live-verify the new route |
| Live Slack delivery coverage for DMs/MPIM is not independently verified | Local `all_delivered` semantics include DMs/MPIM, but the production app manifest, installation, scopes, membership, and event delivery are not read back as a complete live proof | Configure the live policy and verify `message.im`/`message.mpim` delivery with a canary and complete-history backfill |
| Shared-fleet budget and adversarial-isolation evidence is incomplete | One team can consume queue, R2, search, model, or reconciliation capacity needed by another team even when Durable Object names are isolated | Add per-team quotas, cost/latency attribution, bounded queue concurrency, abuse tests, and noisy-neighbor alerts |
| Backfill completion is manifest- and window-bounded | Server-owned inventory discovery now requests archived records, persists a digest-bound visible-to-installed-bot receipt with explicit archived/non-member exclusions, and refuses silent truncation, but the manifest remains capped at 50 conversations and history/thread/file/subtype convergence is not yet terminally receipted | Add resumable inventory batches or an approved larger bound, durable per-conversation history/thread completion receipts, file-content policy, unsupported-subtype accounting, and derived-index convergence readback; current channel-history and thread continuation cursors do not make unsupported content complete |
| Slack installation lifecycle is locally fenced but not live-proven | A live installation may still have stale subscriptions, token custody, or derived-index rows even though the local handler now revokes source/ACL authority | Read back the installed manifest, run uninstall/token-revocation/archive/leave canaries, verify explicit reinstall activation, and add derived-index tombstone/reconciliation receipts |
| Distillation/burst child artifacts are not independently owned | Structured Slack answers and author bursts are only folded into the primary document; they cannot be independently updated, deleted, cited, or reconciled | Add child-document identities and ledger ownership if product requirements call for structured retrieval artifacts |
| Non-Slack connector execution is intentionally fail-closed | Typed identity and durable isolation now prevent collisions, but wiki/code/custom-db/Drive jobs have no production fetch/dispatch adapter behind the queue | Implement and test each connector's authoritative fetch, mutation/delete semantics, provider credentials, retry/DLQ behavior, and live canary before enabling that source type |

## Closure order

1. Read back the server-owned `all_delivered` workspace admission policy for
   each live team, correct the legacy source identity, and complete the history
   backfill.
2. Install/read back the Slack manifest, expand bot membership as required,
   and run the new-build human reaction/indexing/silent-UI canary.
3. Supply least-scope provider credentials, prove derived-index FUSE boot,
   and record queue/descriptor/convergence receipts.
4. Run authenticated Buzz admission, a scoped provider effect with durable
   receipt/deletion, and live failure-recovery drills.
5. Read back harness embedded provenance and reconcile it with the deployed
   immutable image digest; keep the current dirty source out of release claims.
6. Update `docs/current-state.md` with live version IDs and exact evidence.

The current state is therefore **deployed for the bot and Cloudflare knowledge
service graph, source-complete for the requested Slack semantics, but not
production-complete for workspace-wide indexing, derived-index provider boot,
real Slack ingress, Buzz admission, or external provider effects**.
