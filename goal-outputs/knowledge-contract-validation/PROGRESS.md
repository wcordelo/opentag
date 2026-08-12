# PROGRESS — knowledge-contract-validation

**Goal:** Close and verify the highest-risk OpenTag validation milestone: complete Slack reaction/membership subscriptions, define bot-message indexing semantics, run live Slack and Buzz admission checks, provision a test provider workspace, execute failure-injection and recovery tests, and verify the deployed harness image digest.
**Started:** 2026-08-01 America/Los_Angeles
**Last updated:** 2026-08-03 00:00 PDT
**Status:** in_progress
**Subagent calls used:** 5/30
**Fable advisor calls used:** 0/2

## 2026-08-02 23:37 PDT fresh local validation and image-build gate

- [x] The current checkout passes 146 unit files / 1,390 tests, bot Worker
  e2e 8 files / 70 tests, Graphify e2e 5 tests, Graphify policy 10 tests,
  typecheck, deploy-config validation, shell syntax, downloaded
  Supermemory/tigrisfs artifact verification, static rollout checks, and
  `git diff --check`.
- [!] The approved local `linux/amd64` Supermemory image build reached Docker
  but failed resolving the public `cloudflare/sandbox:0.12.4` base image
  because Docker's credential helper returned an invalid-parameter error.
- [ ] No credential-helper repair, image publication, deployment, secret
  change, or external state mutation was performed; image digest and FUSE
  runtime evidence remain open.

## 2026-08-02 23:25 PDT one-click R2 secret-path repair and live preflight

- [x] The one-click deployment script now requires and provisions
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from the two
  `OPENTAG_SECRET_SUPERMEMORY_R2_*` inputs; docs and the rollout checker now
  use the same contract.
- [x] Focused deploy-script tests (6 tests), the full edge suite (146 files /
  1,389 tests), typecheck, shell syntax, downloaded Supermemory/tigrisfs
  artifact verification, static rollout checks, and `git diff --check` pass.
- [!] The fresh read-only live preflight fails the newly explicit secret gate:
  deployed Supermemory is missing `R2_ACCESS_KEY_ID` and
  `R2_SECRET_ACCESS_KEY`. No secret was supplied or changed.
- [ ] The deployed Worker still reads back as the legacy mountBucket bundle;
  both query Containers remain unready and no deployment or restart occurred.

## 2026-08-02 23:26 PDT Slack indexing audit

- [x] Slack source audit is complete for the requested indexing semantics:
  reaction and membership events are represented, bot-authored messages are
  retained as knowledge candidates without waking turns, eligible events are
  durably owned before acknowledgement, and member join/leave events
  invalidate the channel ACL. The fresh suite includes the member-join
  regression.
- [x] The current local regression remains green at 146 unit files / 1,389
  tests, with typecheck, bot e2e (8 files / 70 tests), Graphify e2e (5 tests),
  Graphify policy (10 tests), deploy-config validation, downloaded
  Supermemory/tigrisfs artifact verification, shell syntax, and
  `git diff --check` also passing.
- [ ] Live installed-manifest and token-scope readback, private/MPIM
  visibility, complete-history backfill receipt, and provider-backed indexing
  receipt remain open; source coverage is not live installation coverage.

## 2026-08-02 23:32 PDT MCP authorization reconciliation

- [x] Reconciled the MCP implementation and documentation around the locked
  boundary: external/operator callers use `ADMIN_SECRET`; internal callers use
  short-lived, single-use actor tokens with team/project/resource scope,
  current source authorization, durable audit, and replay protection. Named
  raw query templates remain operator-only.
- [x] The focused MCP suite passes 10 tests; the full local suite passes 146
  files / 1,390 tests; typecheck and `git diff --check` pass.
- [ ] This source/test reconciliation does not close the live provider,
  custody, external MCP, or derived-index rollout gates.

## 2026-08-02 23:32 PDT authenticated Slack capability and coverage readback

- [x] The bot token authenticates as `T0BBBEDLEGY` / `U0BAK4AJ2Q1` and maps to
  app `A0BA1NHQD8F`. `conversations.list` over all supported types returns
  four public bot-member channels, two non-member IMs, and no visible private
  channels or MPIMs; `conversations.members` succeeds for the public channel
  membership readback.
- [!] `reactions.get`, `users.profile.get`, and `apps.manifest.export` each
  return `missing_scope`. The installed token therefore does not prove the
  source manifest's reaction/profile capabilities or installed event set.
- [ ] Reinstallation/scope repair, reaction-event delivery, private/MPIM
  coverage, complete-history backfill, and provider-backed indexing remain
  open. No Slack state was mutated.

## 2026-08-02 23:34 PDT fresh strict live preflight

- [x] Static, R2, deployment, registration, pin, artifact, and Graphify
  secret-name checks pass.
- [!] Exactly three live gates fail: Supermemory is missing
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the Supermemory and
  Graphify query instances each report `active=1; healthy=0; failed=0`.
- [ ] No deployment, restart, secret change, Queue mutation, provider action,
  or Slack state mutation was performed.

## 2026-08-02 23:36 PDT blocked-state audit

- [x] The same external blocking condition recurred across three consecutive
  goal audits: missing Supermemory R2 secrets and unhealthy Supermemory and
  Graphify query instances, with no authorized production mutation.
- [x] Local source/test work is complete for the safe scope: Slack indexing
  semantics, actor-bound MCP authorization, synthetic Buzz admission, and
  synthetic provider recovery are covered and validated.
- [ ] Live completion still requires current authorization and external inputs
  for Supermemory deployment/secrets, Slack manifest reinstallation, Buzz
  signer/relay admission, provider custody/effects, live recovery drills, and
  clean harness provenance readback.

## 2026-08-02 23:17 PDT fresh Supermemory and live-gate recheck

- [x] Isolated Supermemory and Graphify package typechecks pass; shell syntax
  and `git diff --check` also pass.
- [x] The strict read-only rollout check passes static, resource, deployment,
  bucket, registration, and secret-name assertions.
- [!] The same check fails only the two health gates: Supermemory and Graphify
  query Containers each report `active=1; healthy=0; failed=0`.
- [!] Fresh deployed Supermemory Worker readback still contains the old
  `mountBucket("STATE_BUCKET", ...)` / `s3fsOptions` calls, while the local
  source uses the pinned tigrisfs entrypoint contract. Deployed harness
  readback still lacks `/health/container`, `sourceDigest`, `sourceRevision`,
  and `sourceTree`.
- [ ] No deployment, restart, secret change, migration cutover, or other
  external mutation was performed.

## 2026-08-02 23:01 PDT integrated synthetic admission/effect recheck

- [x] Added a full synthetic Buzz receive proof through the assembled binding
  path: NIP-98 authorization is cryptographically verified by the fake relay,
  the fetched kind-9 event is signature-verified locally, the server-owned
  channel→tenant map resolves the tenant, the SQLite-backed dedupe/admission
  records are written, the signed fixed reply is accepted, and replay makes no
  second relay request. `buzz-nip98-fetcher.test.ts` passes 23 tests.
- [x] Added a tenant-scoped provider-effect recovery proof. The adapter receives
  only the reviewed connector-effect metadata, resolves an opaque credential
  reference through synthetic custody, injects an ambiguous provider failure,
  recovers on retry with the same idempotency key and external receipt, and
  refuses a post-completion rerun. The provider token is absent from adapter
  envelopes, failure reports, and completion reports. `platform-effect-runner.test.ts`
  passes 12 tests.
- [x] Full local regression now passes 146 files / 1,387 tests, bot Worker e2e
  8 files / 70 tests, Graphify e2e 5 tests, Graphify policy 10 tests,
  typecheck, deploy-config validation, static rollout checks, downloaded
  Supermemory/tigrisfs artifact verification, and `git diff --check`.
- [x] Read-only `check:knowledge-rollout --live --source-dir=/Users/will/Documents/graphify`
  passes the static/resource/deployment/secret-name/registration checks.
- [!] The health-gated read-only check still reports Supermemory and Graphify
  query Containers as `active=1; healthy=0; failed=0`; the Supermemory Worker
  deployment lookup also returned a transient failed read in that run. The
  lower-level container info has no reported health errors, so FUSE/provider
  readiness is still unproven.
- [!] Secret-name readback shows Supermemory has only
  `SUPERMEMORY_SERVICE_AUTH_TOKEN` and `OPENAI_API_KEY`; no R2 access-key pair
  is provisioned. The platform effecter has only `EFFECTOR_AUTH_TOKEN`, with no
  provider-adapter binding/auth secret, and credential custody has only its
  service auth secret. No live provider effect or custody resolution can be
  claimed.
- [ ] No deployment, restart, secret change, Queue mutation, live provider
  effect, commit, push, or PR was performed.

## 2026-08-02 23:09 PDT broker/custody integration recheck

- [x] The broker test now wires the real credential broker and custody Worker
  apps together through a service binding. The request is revalidated against
  tenant metadata and the versioned custody binding before the secret is read;
  the opaque token appears only in the final broker response. The focused
  broker/custody slice passes 2 files / 19 tests, and no request body contains
  the provider token.
- [!] This is local synthetic boundary evidence only. No live Secrets Store
  mapping, tenant provider grant, adapter binding, or external provider
  workspace was changed or claimed.

## 2026-08-02 23:11 PDT post-integration regression recheck

- [x] The broker/custody integration slice passes 2 files / 19 tests.
- [x] Fresh `npm test` passes 146 files / 1,387 tests; `npm run typecheck`
  and `git diff --check` pass. The only test output is the known nonfatal
  missing-Graphify-sourcemap warning.
- [ ] No deployment or external mutation was performed.

## 2026-08-02 23:12 PDT deployed Supermemory source mismatch recheck

- [!] Cloudflare Worker code readback for the deployed `opentag-supermemory`
  bundle still contains the legacy `mountBucket("STATE_BUCKET", ...)` /
  `s3fsOptions` path and `unmountBucket()` cleanup. The deployed bundle also
  lacks the local Worker-side R2 credential-to-Container env mapping.
- [x] The local checkout remains on the approved tigrisfs contract: the
  Dockerfile pins and verifies tigrisfs v1.2.1, the entrypoint owns the FUSE
  mount/read-write/provider gates, and the active Worker source contains no
  `mountBucket` or `unmountBucket` calls.
- [ ] Local source and image validation therefore must not be reported as a
  deployed Supermemory upgrade. No deployment, restart, secret change, or
  migration cutover was performed.

## 2026-08-02 23:02 PDT local harness provenance build

- [x] The current `linux/amd64` harness image built successfully with the
  generated provenance values.
- [x] OCI labels match the local manifest exactly: revision
  `d075431f25f886842aec5552314afea9d1c9c1dd`, source tree
  `7a3f874822d0f785f56b1ec66142523b384e1ff0`, source digest
  `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`,
  and `sourceState=dirty`. The local image is
  `opentag-harness-provenance-test@sha256:ff5e8470c750ed84e4e81f4a01376b3e54abf85910d261365915bf42163ce75e`.
- [ ] The deployed harness still lacks `/health/container`, `sourceDigest`,
  and `sourceRevision`; deployed source/image matching remains open.

## 2026-08-02 23:03 PDT focused synthetic recheck

- [x] `npm test -- --run test/buzz-nip98-fetcher.test.ts
  test/platform-effect-runner.test.ts` passes 2 files / 35 tests.
- [x] `npm run typecheck` and `git diff --check` pass after the local image
  builds and documentation reconciliation.

## 2026-08-02 23:08 PDT local harness runtime smoke

- [x] The locally built `linux/amd64` harness image returned HTTP 200 from
  `/health`, reported Claude Code `2.1.154` and Nanocodex `0.3.0`, and emitted
  the exact embedded revision/tree/source-digest/state labels.
- [x] The disposable local smoke container was removed after readback.
- [ ] This does not attest the deployed Worker/Container image; live source
  and image matching remains open.

## 2026-08-02 23:08 PDT full regression recheck

- [x] Fresh `npm test` passes 146 files / 1,387 tests. The run emitted only
  nonfatal missing-Graphify-sourcemap warnings.
- [x] Fresh `npm run typecheck` and `git diff --check` pass.

## 2026-08-02 23:06 PDT live Container readback

- [!] Supermemory Container v18 has one running `supermemory` instance but
  Cloudflare reports `active=1; assigned=0; healthy=0; failed=0` and no health
  errors; image `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.
- [!] Graphify query Container v6 has the same `active=1; assigned=0;
  healthy=0; failed=0` aggregate and no health errors; image
  `sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.
- [x] Harness Container v4 has seven healthy instances, but still runs the
  previously deployed image `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`,
  which is not source-attested.
- [ ] No Container or deployment mutation was performed.

## 2026-08-02 22:46 PDT stable local recheck

- [x] WorkspaceConfigDO now persists a secret-free Slack manifest receipt per
  installation generation, rejects stale or mismatched generations, and the
  admin wrapper resolves the active generation instead of trusting caller
  input. The focused contract/manifest slice passes 7 tests and the
  WorkspaceConfigDO generation suite passes 10 tests, including duplicate,
  stale, wrong-generation, reactivation, and current-generation cases.
- [x] Manifest digests cover capability content rather than observation time;
  the same installed scopes/events observed later retain one digest while
  freshness remains explicit metadata.
- [x] The Supermemory provisioning-health test now waits for the mocked
  container request before advancing fake time; the isolated boundary slice
  passes 6 tests and the full edge unit suite passes 146 files / 1,384 tests.
- [x] Bot Worker e2e passes 8 files / 70 tests; Graphify e2e passes 5 tests;
  Graphify policy passes 10 tests; typecheck, deploy-config validation,
  shell syntax, downloaded Supermemory/tigrisfs artifact verification, and
  static rollout checks pass.
- [!] The strict read-only live rollout check still fails only the two query
  Container health aggregates: Supermemory and Graphify each report
  `instance_state=running; active=1; healthy=0; failed=0`.
- [ ] No deployment, restart, secret change, Queue mutation, provider effect,
  commit, push, or PR was performed.

## 2026-08-02 22:46 PDT local Slack manifest boundary

- [x] The admin manifest recording route validates the exact readback, resolves
  the active installation state, and forwards the generation-fenced write to
  WorkspaceConfigDO. The read route uses the same durable installation-state
  record.
- [ ] Live installed-manifest export, installed-token scope readback, complete
  history visibility, and provider-backed indexing remain open; source YAML
  and local receipts are not live installation or search evidence.

## 2026-08-02 22:49 PDT post-documentation recheck

- [x] Typecheck and `git diff --check` pass after updating the current-state
  index and handoff. The focused Slack manifest/Supermemory boundary slice
  passes 3 files / 13 tests.
- [ ] The goal remains in progress because live Slack installation coverage,
  valid Buzz admission, provider effects, live recovery, and clean deployed
  harness source/image provenance are not all proven.

## 2026-08-02 22:52 PDT external read-only refresh

- [x] Connected Slack readback confirms bot membership in `#general` and
  `#skills`, exact completion of the reaction lifecycle marker, and no
  residual reactions on the canary parent. The connector exposes only those
  two channels, so no broader workspace claim was made.
- [x] Cloudflare deployed Worker code readback for `opentag-harness` contains
  the old basic `/health` response and no `/health/container`, `sourceDigest`,
  or `sourceRevision` contract. The image digest is known from inventory but
  cannot be source-attested from the deployed bundle.
- [ ] No deployment, restart, secret change, Queue mutation, provider effect,
  commit, push, or PR was performed.

## 2026-08-02 22:55 PDT local image-build gate

- [x] Docker Desktop became reachable and the approved
  `linux/amd64` Supermemory image build completed successfully. The build
  verified the pinned Supermemory server checksum and tigrisfs `v1.2.1`
  archive checksum.
- [x] The local image was produced as
  `opentag-supermemory-tigrisfs-test@sha256:191ae1f738a78a4b93ffbd5a622e7720ab175b5f7f27082edb70b86976a69aaf`.
- [ ] R2/FUSE mount, remount and read/write persistence, restart recovery,
  provider add/poll/search, and deployed source/image attestation remain open.
  The image was not run with production credentials and no deployment was
  performed.

## 2026-08-02 22:29 PDT affected validation and strict live recheck

- [x] Focused Supermemory/deployment contract validation passes 6 files / 26
  tests, and edge typecheck passes.
- [x] The strict read-only knowledge rollout recheck passes every static,
  pin, bucket, deployment, secret-name, and artifact assertion.
- [ ] The same strict live check still fails only the two query Container
  health aggregates: Supermemory and Graphify each report
  `instance_state=running; active=1; healthy=0; failed=0`.
- [ ] No deployment, restart, secret change, Queue mutation, provider effect,
  commit, push, or PR was performed.

## 2026-08-02 22:25 PDT Slack manifest coverage contract

- [x] Added `edge/src/slack/installation-contract.ts` with strict
  secret-free manifest readback validation, required bot scope/event
  constants, missing-capability assessment, nested Slack manifest extraction,
  and a canonical SHA-256 coverage receipt.
- [x] Updated the manifest regression to use those same constants instead of
  an independent string list. The focused contract/manifest slice passes 6
  tests and typecheck passes.
- [ ] Live installed-manifest export, installed-token scope readback,
  installation-generation fencing, and durable receipt persistence remain
  open. YAML/source coverage is not live installation evidence.

## 2026-08-02 22:26 PDT full regression rerun

- [x] Full edge unit suite passes 146 files / 1,383 tests; bot Worker e2e
  passes 8 files / 69 tests; Graphify e2e passes 5 tests; Graphify policy
  passes 10 tests; typecheck, deploy-config validation, source-pinned rollout
  checks, Supermemory/tigrisfs artifact verification, and `git diff --check`
  pass.
- [!] Read-only live state is unchanged: the deployed Supermemory Worker
  still contains the legacy `mountBucket` bundle, and Supermemory/Graphify
  query Containers each report `active=1`, `assigned=0`, `healthy=0`,
  `failed=0`.

## 2026-08-02 22:30 PDT bot-write indexing audit

- [x] Audited every production Slack `chat.postMessage`/`chat.update` path.
  Normal writes, placeholders, progress, stop acknowledgements, and paged
  answers use the observer-backed client; durable render recovery observes the
  exact committed timestamp after client-message reconciliation.
- [x] No runtime `knowledgeIndex: false` call exists. The only explicit
  suppression is a unit-test fixture for deliberately transient output.
- [ ] This closes the local bot-write default only; provider convergence,
  complete inbound visibility, and live indexed-query receipts remain open.

## 2026-08-02 22:21 PDT Docker and Buzz boundary recheck

- [x] Docker Desktop was started locally, but the Docker daemon remained
  unavailable at `/Users/will/.docker/run/docker.sock`; no image build or
  FUSE test could run.
- [x] Direct read-only POST to the configured Buzz relay `/query` reaches the
  relay and returns HTTP 401 `missing Nostr auth`. The local environment has
  no `BUZZ_PRIVATE_KEY`, relay URL, or auth-tag material, so no valid signed
  wake can be generated here. The deployed Worker’s known signed path still
  fails at relay HTTP 526.
- [ ] The remaining Buzz work is deployed signer/relay admission and
  tenant-scoped callback proof, not basic relay DNS reachability. The
  Supermemory/Graphify health, provider workspace/effect, live recovery, and
  harness source/image gates remain open.

## 2026-08-02 22:22 PDT provider workspace readback

- [x] Read-only Linear workspace audit found the isolated project
  `OpenTag E2E Provider Smoke - 2026-08-02` in the Berendo team
  (`1e98bfb6-27d1-46d8-879c-7975107e7005`). Its description limits it to
  synthetic test issues and receipt/revocation/recovery validation.
- [x] The project is currently empty; no external test issue was created by
  this readback.
- [ ] This proves only that an isolated provider target exists. OpenTag still
  has no configured provider adapter/custody mapping, broker-mediated
  credential resolution, external receipt, revocation, or recovery proof.

## 2026-08-02 22:15 PDT full current-source validation

- [x] Full edge unit validation passes 145 files / 1,379 tests. Typecheck,
  static rollout checks with the pinned Graphify checkout,
  Supermemory/tigrisfs artifact verification, and `git diff --check` pass.
- [x] Ownership recheck confirms PIDs `91517`/`91518` and any path-bound
  OpenTag kernel are absent. Generic Wrangler readers were not terminated.
- [!] Cloudflare source readback still shows the deployed Supermemory bundle
  uses the legacy `mountBucket` path and lacks the current tigrisfs source
  marker. Local green checks therefore remain source evidence only.

## 2026-08-02 22:16 PDT read-only Container evidence

- [x] Harness Container version 4 reports 7 healthy instances and image
  `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
  The image digest is verified; its source-to-image mapping remains open.
- [!] Supermemory Container version 18 reports `active=1`, `assigned=0`,
  `healthy=0`, `failed=0`, image
  `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.
- [!] Graphify query Container version 6 reports `active=1`, `assigned=0`,
  `healthy=0`, `failed=0`, image
  `sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.

## 2026-08-02 22:17 PDT Slack read-only canary confirmation

- [x] Thread readback confirms the human explicit marker and bot-message
  marker received their exact terminal replies.
- [x] Reaction readback for the lifecycle marker reports no reactions after
  completion, and channel membership readback includes the bot
  `U0BAK4AJ2Q1` in the tested public channel.
- [ ] This does not prove installed reaction/profile scopes or workspace-wide,
  private-channel, MPIM, or complete-history coverage; those remain live
  installation gates.

## 2026-08-02 22:13 PDT harness provenance and Supermemory failure gates

- [x] Tightened the one-click deployment flow so a real deployment fails
  before secret or Wrangler mutation when the tracked harness inputs are
  dirty. The current worktree therefore cannot create another unverifiable
  dirty harness image through that path.
- [x] Added a local failure-injection test proving the Supermemory entrypoint
  exits before provider start when the R2/FUSE credential contract is
  incomplete. The focused deployment/Supermemory slice passes 4 files / 22
  tests and typecheck.
- [ ] The deployed harness digest is still not source-attested, because the
  existing live image predates the clean-input gate and Docker is unavailable
  for a rebuild. Live Slack installation scopes, Buzz admission, provider
  effects, and production recovery receipts remain open.

## 2026-08-02 22:08 PDT ownership and deployment-divergence recheck

- [x] Rechecked the checkout and process ownership. No path-bound legacy editor
  kernel or the previously reported PIDs are present; generic Wrangler tail
  readers remain untouched.
- [x] Re-ran the affected Supermemory contract slice: 8 files / 94 tests
  passed. Static rollout checks, downloaded Supermemory/tigrisfs artifact
  verification, shell syntax, and Docker client inspection also passed.
- [x] Added and exercised a deployment preflight that rejects the current
  mixed `AM`/`MM` Supermemory inputs before Wrangler can upload a revision;
  deployment-guard, Supermemory boundary, and typecheck validation passed.
- [!] Read-only Cloudflare Worker source readback shows the deployed
  `opentag-supermemory` bundle still contains the legacy Sandbox
  `mountBucket` lifecycle and the exact `Supermemory R2 binding mount is not
  ready` failure string. The current local source contains neither lifecycle
  call and uses the pinned tigrisfs sentinel/mount fence. The deployed code
  therefore does not represent the upgraded local implementation.
- [ ] Rebuild the image and deploy the upgraded Worker only after the explicit
  production approval and Docker/FUSE gates in the handoff are satisfied.
  No deployment, secret, Queue, provider, credential-removal, commit, push,
  PR, or external-publication action was taken in this checkpoint.

## 2026-08-02 22:08 PDT live Slack completeness and provenance readback

- [x] The source manifest regression passes 2 tests and asserts the required
  history/read, reaction, profile, team, and channel-join scopes. The manifest
  retains reaction, membership, installation-revocation, and channel
  lifecycle event subscriptions.
- [x] Authenticated Slack membership readback confirms bot `U0BAK4AJ2Q1` in
  the four visible public channels: `#general`, `#new-channel`, `#social`,
  and `#skills`.
- [x] Human explicit canary
  [`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
  returned `OPENTAG_MILESTONE_EXPLICIT_OK` at `1785728831.600039`.
- [x] Bot-message event canary
  [`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
  returned `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`; the
  live tail recorded a channel-message route and an `indexed` queue outcome.
  Source semantics remain explicit: bot-authored messages are attributed
  observations and cannot start response turns.
- [x] Reaction lifecycle canary
  [`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
  showed the working `eyes` reaction while running, returned
  `OPENTAG_REACTION_LIFECYCLE_OK` at `1785729227.808039`, and had no reaction
  after terminal cleanup.
- [ ] These Slack receipts do not prove installed-token scopes,
  workspace-wide/private/MPIM visibility, complete-history backfill, or
  KnowledgeDO/derived-index queryability. The strict rollout check still
  fails the Supermemory and Graphify query Container health aggregates.
- [ ] Harness provenance remains open: local source digest is
  `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
  with `workingTreeDirty:true`, while the deployed image is
  `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
  Docker/FUSE build and clean source-to-image attestation are unavailable.

## 2026-08-02 22:14 PDT final local and strict live gate rerun

- [x] Full local edge unit suite passes 145 files / 1,379 tests; bot Worker
  e2e passes 8 files / 69 tests; typecheck and `git diff --check` pass.
- [x] Graphify Worker e2e passes 5 tests, Graphify policy passes 10 tests,
  deploy-config validation passes, the Slack manifest test passes 2 tests,
  shell syntax passes, and downloaded Supermemory/tigrisfs artifact
  verification passes.
- [x] The strict read-only rollout check passes all static, R2, deployment,
  secret-name, pin, and artifact assertions.
- [ ] The strict live check still fails exactly two health gates:
  Supermemory query `instance_state=running; active=1; healthy=0; failed=0`
  and Graphify query `instance_state=running; active=1; healthy=0; failed=0`.
  No deployment, restart, Queue mutation, credential change, or provider
  action was attempted.

## 2026-08-02 21:56 PDT local contract reconciliation

- [x] Reconciled the local Supermemory source to the approved pinned
  tigrisfs Container contract: Dockerfile archive pin/checksum, Container-only
  R2 env mapping, entrypoint mount/read-write fence, child credential removal,
  and Worker sentinel/mount observation. No `mountBucket` or `unmountBucket`
  path remains in the Worker lifecycle.
- [x] Added a separate durable KnowledgeDO queryability receipt keyed by
  source/revision/document/generation. It is body-free, idempotently
  replaceable, stale-fence rejecting, and aggregated as unverified/searchable/
  no_match/provider_unavailable without changing the meaning of `indexed`.
- [x] Fresh validation passes 145 edge unit files / 1,376 tests, 8 bot Worker
  e2e files / 69 tests, Graphify e2e (5 tests), Graphify policy (10 tests),
  focused Supermemory/checker tests, typecheck, deploy-config validation,
  source-pinned rollout preflight, shell syntax, `git diff --check`, and
  downloaded Supermemory/tigrisfs artifact verification.
- [ ] Docker/FUSE image build, remount/restart persistence, live queryability,
  provider effects, Buzz admission, and harness provenance remain open. The
  strict live check fails only the two query Container health aggregates,
  each with active=1 and healthy=0.

## 2026-08-02 21:23 PDT artifact and regression recheck (historical snapshot)

- [x] The pinned Supermemory `server-v0.0.5` release passed checksum and
  runtime-marker verification at that earlier source snapshot.
- [x] Final local regression passes: 145 unit files / 1,373 tests, 8 bot e2e
  files / 67 tests, 5 Graphify e2e tests, 10 Graphify policy tests, typecheck,
  deploy-config validation, shell syntax, and diff checks.
- [x] No path-bound legacy editor kernel is present; generic Wrangler tail
  readers were left untouched.
- [ ] Docker/FUSE image build, remount/restart persistence, live query
  Container health, provider search convergence, provider effects, Buzz
  admission, and clean harness source-to-image attestation remain open.

## 2026-08-02 21:16 PDT audit reconciliation

- [x] Fresh knowledge audit confirmed that provider `documents.get(...)=done`
  and ledger `indexed` do not perform or prove a search readback. Added a
  local `add -> poll -> search` regression; the Supermemory adapter file now
  passes 23 tests and typecheck passes.
- [x] Fresh Buzz audit confirmed source/test completeness across seven focused
  files and 93 tests, while the live gate remains open at relay HTTP 526. The
  empty-body 400 proves schema/configuration reachability only.
- [x] Fresh provider/effect/harness audit confirmed no registered effect
  adapter, no default custody Secrets Store mapping, no real Linear effect,
  and no clean harness source/image attestation. Local effect/custody/recovery
  tests remain synthetic; Docker is unavailable.
- [x] Current Wrangler readback confirms Supermemory v18 and Graphify query v6
  each have one active/running but zero assigned/healthy query instances; the
  strict rollout checker still fails exactly those two gates.
- [x] Fresh authenticated readback is knowledge-ready (HTTP 200) but full-ready
  HTTP 503 with credential-broker reachability, effecter reachability, and
  OAuth blockers. Tenant status is 84 rows: 55 indexed, 2 pending, and 27
  permanent failures; outbox and tenant-local DLQ are empty.
- [x] Post-audit validation passes: 145 edge test files / 1,373 tests,
  typecheck, and `git diff --check`.
- [x] The local two-stage ingestion-versus-queryability contract is now
  represented by the durable queryability receipt; live provider evidence is
  still required before this gate can be marked complete.

A later-dated worktree note describes a Supermemory secret/bootstrap and
redeploy attempt after the earlier read-only sweep. This continuation did not
reproduce, reverse, or extend that action. No additional deployment, secret,
Queue, provider, credential-removal, commit, push, PR, or external publication
was performed here.

## 2026-08-02 21:13 PDT strict live rollout recheck

- [x] All static, R2, secret-name, pin, artifact, and deployment checks pass
  again.
- [ ] The only blocking live checks remain Supermemory query and Graphify
  query Container health: each reports `instance_state=running; active=1;
  healthy=0; failed=0`. The command exits 1 until healthy receipts exist.
  No deployment or recovery mutation was attempted.

## 2026-08-02 21:12 PDT derived-index validation

- [x] Deploy-config validation passes.
- [x] Graphify Worker e2e passes 1 file / 5 tests and Graphify policy tests
  pass 10 tests.
- [x] Static knowledge rollout checks pass, including privacy, single-writer,
  exact Graphify pin, catalog/CAS/artifact policy, binding-owned R2, and
  authoritative Queue/DLQ checks.
- [ ] The strict live health gate was not rerun here; its last read-only
  result remains the two query Container aggregates with zero healthy
  instances.

## 2026-08-02 21:10 PDT local failure/recovery slice

- [x] Durable ingress, Stop/recovery, knowledge reconciliation/queue,
  Supermemory boundary, harness routing, and runtime-probe tests pass: 9
  files and 140 tests.
- [ ] These deterministic local receipts do not close live isolate-loss,
  deployed Queue/DLQ replay, provider recovery, or Container restart gates.

## 2026-08-02 21:09 PDT full validation rerun

- [x] Full edge unit suite passes: 145 files and 1,372 tests. The only
  output is the known nonfatal Graphify dependency sourcemap warning.
- [x] Bot Worker e2e suite passes: 8 files and 67 tests.
- [x] Typecheck and staged/unstaged `git diff --check` pass.
- [ ] This remains local source evidence; no deployment or external mutation
  occurred.

## 2026-08-02 21:06 PDT local stability validation

- [x] Re-ran the affected Slack/knowledge source slice: 8 files and 95
  tests passed, including response routing, pre-admission, manifest,
  installation lifecycle, knowledge scheduling, observer, Slack Web API, and
  canonical thread normalization.
- [x] Typecheck and staged/unstaged `git diff --check` passed.
- [x] Added and passed an explicit `bot_message` Events API contract test:
  bot-authored deliveries are indexed as knowledge observations without being
  admitted as response turns. The focused queue/normalization/Web API rerun
  passed 3 files and 70 tests.
- [ ] This is local source evidence only; the response-directed routing repair,
  observed-message inclusion fence, and successful-2xx readiness correction
  remain deployment-gated.

## 2026-08-02 20:45–20:54 PDT fresh routing and reaction control

- [x] Explicit control [`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
  received `OPENTAG_MILESTONE_EXPLICIT_OK` at `1785728831.600039`; the
  terminal reaction readback was empty.
- [x] Marker-shaped unmentioned message
  [`1785728708.551929`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728708551929)
  stayed silent because it was not a question or recognized action request.
- [x] Valid unmentioned deployment-status question
  [`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
  received `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`; the live
  tail recorded a `channel_message` route and an `indexed` queue outcome.
- [x] Explicit reaction lifecycle control
  [`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
  showed `eyes` while running and no reaction after the final reply.
- [ ] An authenticated operator search for the exact indexed marker returned
  zero citations, so queue acceptance is not yet search convergence.
- [x] Reconciled the stale `slackConversationModelContext` contract locally:
  it now describes router-selected no-tag responses and passive silence, with
  a regression test. This change remains local-only.
- [x] Added a local response-directed action rule for please
  reply/respond/answer forms with exact/with/to continuations, plus a negative
  test for please do not reply. The focused routing/pre-admission slice (30
  tests) and typecheck pass.
- [ ] Deploy the remaining local response-routing repair under the explicit
  deployment gate and rerun the search/readback receipt.
- [ ] Complete installed manifest/scopes, lifecycle, and reaction-event
  readback; the normal response/reaction path is now live-verified.

## 2026-08-02 20:55 PDT local routing validation

- [x] Full edge unit suite passes: 145 files and 1,371 tests.
- [x] Bot Worker e2e suite passes: 8 files and 67 tests.
- [x] The first focused routing run caught a false positive where the broad
  response-directed pattern matched `please don't reply to that`; the
  negative-response guard was added and the rerun passed all 30 tests.
- [x] The provider audit confirms the effecter remains fail-closed: no
  provider adapter is registered, custody-backed provider resolution is
  unavailable, and the Linear connector is not on the deployed effect path.
- [ ] Do not mark provider effects complete until the broker, custody,
  provider adapter, controlled workspace, external receipt, revocation, and
  rollback evidence exist.

## 2026-08-02 20:59 PDT final read-only gate sweep

- [x] Current bot health is HTTP 200 with model, Slack, knowledge, Buzz,
  broker, effecter, and harness bindings configured. This is configuration
  evidence, not provider or external-effect readiness.
- [x] Harness Container info is readable: version 4, seven healthy instances,
  image digest `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
  The local source manifest is dirty and different, so source-to-image
  provenance remains open.
- [x] The live Buzz empty-body probe returns HTTP 400
  `buzz_wake_unexpected_fields`; no valid signed event, authenticated fetch,
  or tenant-scoped admission receipt exists.
- [x] The authenticated operator search for the fresh canary marker returns
  zero citations despite a queue `indexed` outcome. The current tenant
  status is 83 ledger rows: 55 indexed, 2 pending, and 26 permanent failures;
  outbox and tenant-local DLQ are empty.
- [ ] Strict rollout still fails the Supermemory and Graphify query
  Container-health checks: each reports active=1, assigned=0, healthy=0,
  failed=0. No deployment, replay, provider mutation, Queue mutation,
  credential removal, commit, push, or PR was performed.

## 2026-08-02 20:41 PDT fresh live evidence checkpoint

- [x] At that historical checkpoint, confirmed the upgraded Supermemory source
  contract: Worker-owned credential-less STATE_BUCKET mount, disposable
  model-cache overlay, and successful-2xx provider readiness fencing. No
  legacy rewrite kernel was present and no process was terminated. The current
  source contract is the pinned tigrisfs path recorded in the 21:56 checkpoint.
- [x] Read back authenticated knowledge readiness as HTTP 200 and ran the
  fresh Slack marker/search canary. Marker 1785725283.368069 was indexed;
  unmentioned retrieval 1785725304.390959 stayed silent; explicit retrieval
  1785725373.889899 returned OPENTAG_SUPERMEMORY_SEARCH_OK at
  1785725391.260059. No lingering reaction remained on the retrieval parent.
- [x] Re-read Slack installation boundaries: the bot is in four visible public
  channels, but reactions.get, users.profile.get, and apps.manifest.export
  return missing_scope. Installed-manifest, private/MPIM, workspace-wide, and
  complete-history receipts remain open.
- [x] Re-read durable knowledge state: 80 tenant ledger rows (53 indexed,
  2 pending, 25 permanent), empty outbox, tenant-local DLQ summary zero, and
  100 pending records on the separate operator Queue/DLQ endpoint. No replay
  or disposal was performed.
- [ ] Resolve the live Container health boundary: Supermemory and Graphify
  each report active=1, assigned=0, healthy=0, failed=0 even though their
  instance listings say running.
- [ ] Deploy the local observedMessageTs and retrieval-routing hardening only
  after the explicit deployment gate, then rerun the no-mention canary and
  stale-fetch inclusion receipt.
- [ ] Prove complete-history coverage, provider CRUD/recovery, valid Buzz
  admission, the broker-mediated provider effect, live Queue/DLQ and
  isolate-loss recovery, and clean harness source-to-image provenance.

## 2026-08-02 20:47 PDT validation rerun

- [x] Re-ran edge typecheck, the focused 9-file recovery/routing/provider
  slice (190 tests), shell syntax, and staged/unstaged diff checks.
- [x] Re-ran the strict live rollout checker. Every static contract, exact
  Graphify pin, R2 resource, secret-name, artifact, and Worker deployment
  check passed.
- [ ] The only live rollout failures are Supermemory and Graphify aggregate
  Container health: each is reported as active=1, assigned=0, healthy=0,
  failed=0 while its instance listing reports running. No deployment or
  external mutation was performed.

## 2026-08-02 20:37 PDT provider-readiness correction and fresh live readback

- [x] Tightened both local Supermemory readiness paths to require a successful
  `2xx` response from `/v3/openapi`; a listening application that returns
  `4xx`/`5xx` can no longer create the provider-ready sentinel or release the
  Container health gate. Focused Supermemory boundary tests, shell syntax,
  typecheck, and diff checks pass.
- [x] Re-ran the strict read-only rollout check. Static contracts, exact
  Graphify pin, R2 resources, secret names, and deployment records pass.
- [ ] The live check still fails only the two Container health checks:
  Supermemory and Graphify each report `active=1`, `assigned=0`, `healthy=0`,
  `failed=0`; their instance listings say `running`, which is not a healthy
  receipt. No deployment, provider mutation, Queue mutation, commit, push, or
  PR was performed.

## 2026-08-02 20:24 PDT readiness-gate correction and strict live recheck

- [x] Tightened the local Supermemory port gate so bootstrap health remains
  available for the Cloudflare lifecycle hook, while non-health traffic is
  `503` until R2 and provider readiness. Added focused regression coverage and
  updated the rollout checker wording to match the actual contract.
- [x] Re-ran shell syntax, focused entrypoint/checker tests, typecheck, the
  full unit suite (1,370 tests), bot and Graphify e2e suites, Graphify policy,
  deploy-config validation, Supermemory artifact verification, and diff checks.
- [x] Read back current deployment records: Supermemory Worker
  `61370dc7-0f1b-4488-8e49-86eb18bc78f6`, Graphify Worker
  `2b087539-65c8-40c3-be69-4773af3a9315`, Supermemory Container v18, and
  Graphify query v6. Both query Containers report `active=1`,
  `assigned=0`, `healthy=0`, `failed=0`.
- [ ] Deploy the local gate correction and obtain assigned healthy Container
  receipts, then prove remount/restart persistence and provider CRUD/search
  receipts. No deployment, provider mutation, Queue mutation, or external
  publication was performed in this checkpoint.

## 2026-08-02 20:16 PDT local inclusion-fence checkpoint

- [x] Added exact `observedMessageTs` propagation for Slack message, edit,
  reaction, and outbound observations. Job validation rejects malformed or
  non-Slack values, descriptor identity includes the timestamp, and dispatch
  records a retryable `observed_message_missing` result when a complete fetch
  omits the observed message.
- [x] Added contract, scheduling, and complete-but-stale dispatch regression
  coverage. The final local validation pass is green: 144 unit test files /
  1,370 tests, 67 bot Worker tests, 5 Graphify Worker tests, 10 Graphify
  policy tests, typecheck, artifact verification, deploy-config validation,
  static/live rollout checks, and diff checks.
- [ ] Deploy this local hardening and run a live stale-fetch/inclusion receipt
  canary. No deployment, cutover, Queue mutation, or external publication was
  performed in this checkpoint.

## 2026-08-02 19:00 PDT recovery and Buzz boundary checkpoint

- [x] Deployed the bounded Buzz receive telemetry patch as bot version
  `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`. A known wake reaches the relay HTTP
  phase and receives HTTP 526. Re-provisioning the canonical relay origin did
  not change the result; direct local relay checks return 401/403 as expected
  for missing or unauthorized authentication. Valid signed Buzz admission is
  still open.
- [x] Added and exercised the operator failure-metadata listing path without
  returning lease tokens, add-attempt tokens, provider IDs, or message bodies.
- [x] Reopened 30 old `local_add` failures with correction reference
  `supermemory-v18-r2-model-cache-repair-da95429a`; recovery readback reported
  30 reopened, 0 blocked, and 0 failed.
- [x] Read back the current durable state: 77 ledger rows with 32 indexed, 19
  leased, 2 pending, and 24 permanent failures; outbox and DLQ are empty. The
  latest reconciliation is complete after scanning 77, enqueueing 19, and
  skipping 58.
- [ ] Let the remaining reopened rows converge or expire/retry, then retain
  provider receipts for add/poll/search and recovery. The remaining 24
  permanent rows are bounded contract outcomes: 23 unsupported updates and
  one Slack terminal `thread_not_found`.
- [ ] Resolve the Worker-to-Buzz-relay HTTP 526 boundary, prove signed fetch,
  tenant admission, dedupe, retry, and callback receipts.
- [ ] Build or obtain a clean harness image and read back its authenticated
  source-to-image provenance; local manifest remains dirty and Docker is
  unavailable.
- [ ] Deploy the local retrieval-routing `t1.12` fix and rerun the unmentioned
  action-request canary. The deployed version did not wake for the live search
  request, while the explicit-mention control retrieved the marker successfully.

- [x] Root-caused and repaired the recovery stall: reopening an ambiguous add
  cleared `desired_revision`, causing `/resolveAmbiguousAdd` to return 409;
  the resolver now adopts the normalized revision only when the current lease
  is an exact add-started ambiguity. Expired `processing_unconfirmed` poll
  windows now renew for the same document ID without a second add.
- [x] Deployed the fix as bot version
  `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`; live tail evidence shows three rows
  reaching `indexed` and `recorded_success` after the fix, plus four earlier
  recovery successes. The remaining count must be read back from the durable
  tenant status endpoint after the drain.

## 2026-08-02 19:45 PDT validation checkpoint

- [x] Passed `npm run typecheck`, the full unit suite (1,368 tests), the bot
  Worker suite (67 tests), the Graphify Worker suite (5 tests), Graphify policy
  tests, deployment-config validation, Supermemory artifact verification,
  static and live rollout preflights, Graphify exact-pin verification, shell
  syntax, and staged/unstaged diff checks.
- [x] Fixed the provisioning-health unit test to drain fake timers created
  after the 90-second bounded wake timeout; the production health path remains
  fail-closed at HTTP 503 when the singleton does not respond.
- [ ] Build the image with Docker and prove FUSE remount/restart persistence;
  Docker is unavailable in the current environment.

- [x] Ran a fresh human marker-write and explicit-mention retrieval canary:
  the bot returned `Searching Slack` and
  `OPENTAG_SUPERMEMORY_SEARCH_OK`, and the parent had no lingering reaction.
- [ ] Deploy and re-run the untagged search canary. The deployed version was
  silent for the untagged action request; local routing now recognizes leading
  `search`, `look up`, `lookup`, and `query` requests, with focused tests
  passing, but the repair remains local-only pending the deployment gate.
- [ ] Redeploy the local Supermemory `/health` port-gate repair and require
  Cloudflare `healthy` state. The strict live preflight currently fails for
  both query Containers, which report `running`.

## 2026-08-02 18:20 PDT current continuation

- [x] Confirmed the reported legacy rewrite kernels (`91517`/`91518`) are
  absent and that the current Supermemory source is stable under a five-second
  file watch. No process was killed and no unrelated worktree state was
  reset, stashed, or rewritten.
- [x] Recorded the mixed-snapshot source correction: the current approved
  contract is the pinned tigrisfs Container mount at `/var/lib/supermemory`,
  with Container-only R2 credentials, an unprivileged read/write fence, and a
  90-second wake/readiness bound. The earlier Worker-owned binding description
  is retained only as historical evidence from that mixed snapshot.
- [x] Deployed the ACL cadence repair as bot version
  `7832ace9-4856-4b0c-8ea5-899ee61a291e`: five-minute reconciliation with a
  600-second `KNOWLEDGE_SLACK_ACL_MAX_AGE_MS` bound. The live cron run refreshed
  one source and completed successfully.
- [x] Read back authenticated knowledge readiness as HTTP 200 with all
  knowledge and code-graph checks true, and passed
  `npm run check:knowledge-rollout -- --live`.
- [x] Captured live Slack/provider receipts: the
  [ACL cadence canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719827818089)
  returned `OPENTAG_KNOWLEDGE_CADENCE_OK`; the
  [provider canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719693438309)
  returned `OPENTAG_KNOWLEDGE_PROVIDER_RECEIPT_OK`; provider tail readback
  includes document write/poll responses and `/v4/search` HTTP 200.
- [x] Confirmed the current singleton Supermemory instance is running version
  18 with image digest
  `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.
- [ ] Complete the knowledge claim: the latest tenant status is 77 rows,
  with 32 indexed, 19 leased, 2 pending, and 24 permanent failures; no
  completed inventory or backfill exists. Let the reopened rows converge with
  provider receipts and produce a bounded complete-history digest.
- [ ] Complete Slack reinstall/manifest and scope readback, reaction and
  membership/lifecycle event receipts, private/MPIM coverage, valid signed
  Buzz admission, controlled provider effects, Queue/DLQ and isolate-loss
  drills, Graphify artifact/citation receipts, and clean harness provenance.

## Historical checkpoint — 2026-08-02 17:38 PDT

- [x] Reconciled the live bot health/readiness, WorkspaceConfigDO admission
  policy, KnowledgeDO status, Slack token scopes, visible bot membership,
  and private Container state. The live policy reads back as
  `all_delivered` with `defaultProjectId: workspace-default`; this is a
  server-policy receipt, not a workspace export or a completed backfill.
- [x] Confirmed the current bot-token scope gap: the source manifest declares
  `reactions:read` and `users.profile:read`, but the installed token omits
  both. Direct `reactions.get` and `users.profile.get` probes return
  `missing_scope`. The bot is currently admitted to four visible public
  channels and two visible DMs; private-channel/MPIM coverage is not proven.
- [x] Defined the effective outbound indexing contract: committed bot
  `chat.postMessage` and `chat.update` writes, including placeholders,
  progress, tool-status, busy, Stop, terminal, and error messages, are
  observed by default. OpenTag's own transient `eyes` reaction and other
  non-message effects are intentionally not message documents. Changed
  updates need a live provider receipt proving same-source revision
  convergence rather than duplicate documents.
- [x] Added a local Supermemory readiness repair: the Worker wake bound is
  90 seconds and container startup now waits for the mounted R2 volume and
  the application port before releasing readiness. Typecheck, focused
  Supermemory/runtime tests, rollout checks, artifact verification, and
  diff hygiene pass locally.
- [x] Root-caused the live provider failure from the remote R2 `error.log`:
  Supermemory repeatedly fails startup with `EIO` while renaming the local
  embedding model inside `/var/lib/supermemory/models/.../model_quantized.onnx`.
  This is a model-cache/R2-FUSE atomic-rename incompatibility, not a missing
  Slack event or bot routing problem.
- [x] Deployed the Worker-side mount-cache repair as version
  `be2128c7-2617-4acb-b378-9522252451ea` with
  `--containers-rollout=none`. The Cloudflare Container image was not rebuilt
  or rolled, so the live provider failure remains open and the deployment is
  not treated as a successful end-to-end fix.
- [ ] Deploy that local provider repair and obtain an assigned healthy
  Supermemory instance plus R2 persistence/remount, add/poll/search/update/
  delete, tombstone, and durable receipt evidence. Docker is unavailable in
  the current environment, and a Container restart/image rollout is still
  required before the local cache option can be exercised.
- [ ] Complete Slack app reinstall/manifest readback, lifecycle/reaction
  event receipts, complete-history inventory/backfill, and a fresh
  bot-message observer receipt that can be found through search.
- [ ] Produce valid signed Buzz admission, a broker-mediated provider effect
  in a controlled test workspace, live Queue/DLQ and isolate-loss recovery
  receipts, and a clean harness source-to-image attestation.

The 64-row count above is historical evidence from the earlier 18:20
checkpoint. The latest readback is 77 rows with 32 indexed, 19 leased, 2
pending, and 24 permanent failures; outbox and DLQ work remain empty. The
latest reconciliation scanned all 77 rows and enqueued 19. Inventory and
backfill remain incomplete.

## 2026-08-02 21:25 PDT provider-startup continuation

- [x] Uploaded the approved provider secret only to the private Supermemory
  Worker and seeded the private R2 `api-key` bootstrap object without exposing
  either value to the bot, harness, logs, Git, or docs.
- [x] Redeployed Supermemory as version
  `91916818-d7a0-4359-b220-e9c0dc690a1d` and simplified the subclass to use
  the Sandbox SDK's own `containerFetch` startup path.
- [x] Captured a clean live trace: the current Supermemory request enters
  `containerFetch`, then is canceled at roughly 30 seconds before
  `onStart`, R2 mount, port-gate release, or the application health probe.
  Cloudflare reports the instance active/running but not healthy or assigned;
  Graphify has the same instance shape.
- [x] Passed focused provider/runtime tests, TypeScript typecheck, diff
  hygiene, and the live static rollout checker.
- [ ] Resolve the Container provisioning/port-readiness or assignment gap and
  produce healthy-instance, R2-mount, add/poll/search/delete, and persistence
  receipts before reprocessing the 40 quarantined ledger failures.

## 2026-08-02 13:25 PDT guarded bot deployment and Slack controls

- [x] Published the guarded bot build as version
  `8fd0e0bb-7167-40b5-a223-c626f701f916` with immutable generation
  `cf-validation-2026-08-02`. The bot health readback is HTTP 200; strict
  readiness remains HTTP 503 because Supermemory and Graphify are unhealthy,
  while full readiness also reports disabled credential/effect/OAuth paths.
- [x] Ran current-version Slack controls: explicit mention and a normal
  no-mention question both received exact replies with no terminal `eyes`
  reaction; passive `yo` received no reply or reaction. A smoke-style
  operational sentence was classified as passive.
- [x] Searched current-day Slack messages and found no `OpenTag AG-UI` or
  `Working…` output after the guarded deployment.
- [x] Re-read the live KnowledgeDO and derived-index boundary: 40 ledger rows
  are `permanent_failure`, outbox/DLQ work is empty, reconciliation skipped
  all 40 terminal rows, both derived query containers report zero healthy
  instances, and the live source still has `default` versus
  `workspace-default` identity drift.
- [ ] Provision a supported Supermemory provider secret/bootstrap, repair the
  unhealthy derived containers, and prove a fresh add → poll → search receipt.
- [ ] Read back reaction/membership event delivery, Buzz signed admission,
  provider effects, Queue/DLQ recovery, and harness source-to-image provenance.

## 2026-08-02 12:44 PDT recovery and deployment-preflight continuation

- [x] Re-read authenticated live readiness, KnowledgeDO status, admission
  policy, source state, Cloudflare secret names, and derived-index Container
  state. The live knowledge profile remains HTTP 503; 36 ledger rows are
  terminal `permanent_failure`, with no pending outbox or DLQ work. The newest
  source has `add_started` plus `local_rejected` and no Local document ID, so
  provider acceptance is ambiguous.
- [x] Added a one-of Supermemory provider-secret preflight to the one-click
  deployment script. It accepts an existing or securely supplied OpenAI,
  Anthropic, Gemini, Groq, or Workers AI secret and fails before deployment if
  none is configured.
- [x] Preserved bounded provider HTTP status classes and stopped treating HTTP
  409 as a safe retry. Retryable add failures keep `add_started` when no Local
  document ID exists, preventing duplicate external writes.
- [x] Added exact, tenant-bound, operator-audited terminal knowledge recovery
  through `/admin/knowledge/recover`. Known-document Local failures can be
  requeued, while ambiguous adds requeue only into the provider identity probe;
  tombstones and unsupported failure classes remain durably blocked.
- [x] Added a private Supermemory exact-identity probe for ambiguous adds. A
  single matching `customId` and source metadata adopts the existing document;
  an exact miss is the only case that may issue a new add. Multiple or
  malformed identities remain blocked.
- [x] Updated `docs/current-state.md` and this gap audit with the live failure
  counts, current image digests, policy/source identity mismatch, recovery
  boundary, and remaining external gates.
- [x] Passed `npm run typecheck`, 70 focused knowledge-ledger/reconciliation/
  adapter/SDK-contract tests, 16 Worker-ledger tests, and `git diff --check`.
- [x] Closed the direct-deploy footgun: `npm run deploy:bot` now fails closed
  unless an immutable `OPENTAG_SUPERMEMORY_INDEX_GENERATION` is supplied and
  forwards that value to Wrangler.
- [ ] Provision a supported Supermemory provider secret/bootstrap, correct the
  `default` versus `workspace-default` identity mismatch, and prove a fresh
  add → poll → search receipt before attempting recovery of any ambiguous row.
- [ ] Read back a Graphify query/artifact receipt, run valid Buzz admission,
  provision a scoped provider workspace, execute live failure drills, and
  attest the deployed harness image to source.

## 2026-08-02 10:57 PDT continuation

- [x] Repaired the tenant-bound connector authorization boundary. The two
  WorkspaceConfigDO authorization helpers and the credential broker/custody
  revalidation calls now use `tenantStub`, which propagates the required
  `x-opentag-tenant-id` header. Focused broker, custody, tenancy, and
  workspace-config tests passed; `npm run typecheck` passed. This is local
  source evidence only and has not been redeployed.
- [x] Audited `slack-app-manifest.yaml`: reaction, membership, message,
  lifecycle, history, and reaction-write/read coverage is present in source and
  manifest tests.
- [x] Re-read live Slack channel inventory: the bot is a member of `#general`
  only among the listed public channels; `#new-channel`, `#social`, and
  `#skills` are not current coverage. This reinforces that “every Slack
  message” must be scoped to events Slack delivers to accessible installed-app
  conversations.
- [ ] Redeploy the tenant-bound authorization patch and prove a live broker/
  custody authorization request; the custody binding map and provider adapter
  are still unavailable.
- [ ] Run a signed-in human Slack canary; the available connector can only
  create bot-authored messages and cannot prove reaction cleanup or human
  inbound routing.

## 2026-08-02 11:04 PDT live continuation

- [x] Deployed the tenant-bound authorization repair to custody
  `5efe1e39-c2c8-4220-a83f-16469aa09e7a`, broker
  `4db9e036-da62-49bb-82c8-76a94c9860c0`, and bot
  `bd19e926-b8c9-439c-a9e8-d01da0f6cbe2`.
- [x] Corrected broker health so `providerResolutionEnabled` reflects the
  downstream custody health capability instead of only binding presence. Live
  broker and custody health now both report provider resolution disabled while
  the custody binding map is absent.
- [x] Restored the required `SUPERMEMORY_INDEX_GENERATION` deployment variable
  after a direct bot deploy omitted it; the final live bot health readback
  reports `indexGenerationConfigured:true`.
- [x] Posted and read back current bot marker
  `1785693801.754259` in `#general`; this proves current bot write/read and
  expected bot-message no-response behavior only.
- [x] Ran the focused failure/recovery matrix after the deployment changes:
  9 files / 176 tests passed.
- [ ] Obtain a signed-in human Slack session, valid Buzz signer/relay fixture,
  provider binding map, and authenticated harness token to close the remaining
  live gates.

## 2026-08-02 11:11 PDT human canary continuation

- [x] Ran a real authenticated human explicit-mention canary at
  `1785694221.865769`: Slack delivered the event, OpenTag added `eyes`, the bot
  returned `OPENTAG_EXPLICIT_HUMAN_CANARY_OK`, and the reaction was absent on
  terminal readback.
- [x] Ran a real authenticated human no-mention question at
  `1785694253.415069`: the bot returned `OPENTAG_NO_MENTION_CANARY_OK` without
  a mention and left no reaction.
- [x] Ran the passive-message control at `1785694282.922709`: `yo` produced no
  reply, no reaction, and no busy warning.
- [ ] Read back a tenant KnowledgeDO/derived-index receipt for the human
  messages; the retrieval canary reached the search path but returned
  `Knowledge unavailable.` and no admin credential is available for a durable
  status readback.

## 2026-08-02 11:16 PDT knowledge retrieval canary continuation

- [x] Ran a fresh human retrieval request at `1785694376.778339`. The
  deployed bot entered `Searching Slack` and then returned `Knowledge
  unavailable.` at `1785694396.357459`; its `eyes` reaction was gone on
  terminal readback.
- [ ] Do not count this as an indexing pass. It proves request admission,
  search-path invocation, and error-path reaction cleanup, while leaving the
  KnowledgeDO/derived-index receipt and marker-search result unproven. The
  live search/index service is currently degraded or unavailable.

- [x] Performed a read-only Linear provider discovery: the connected workspace
  exposes the `Berendo` team, but no projects exist. This does not provision a
  test workspace or exercise OpenTag's provider effect path; the broker/custody
  binding map and provider adapter remain unavailable.

## 2026-08-02 11:37 PDT Slack membership continuation

- [x] Invited bot `U0BAK4AJ2Q1` to the previously uncovered visible public
  channels `#new-channel` (`C0BADPYGSR3`), `#social` (`C0BAF3XC3AA`), and
  `#skills` (`C0BGS7FNQUE`).
- [x] Re-read channel members through the authenticated Slack surface and
  confirmed the bot in all four visible public channels; the bot-token
  inventory also reports `is_member:true` for all four.
- [ ] Read back the installed Slack manifest and prove actual reaction,
  membership, and lifecycle event delivery into KnowledgeDO. This membership
  change closes only the visible-channel access sub-gate.
- [ ] Redeploy the credential-less derived-index mount path and record a
  successful KnowledgeDO, Queue, Supermemory/Graphify, and marker-search
  receipt; provider boot remains a separate gate.

## 2026-08-02 11:56 PDT credential-less R2 mount continuation

- [x] Replaced the derived-index container credential path locally with
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

Entries below retain earlier checkpoints for auditability. The current live
state is the later deployment-reconciliation, Buzz-configuration, harness-
digest, and human-canary entries near the end of this file; earlier failures
are not current deployment claims.

## Completed tasks
- [x] Reconciled the authoritative dirty OpenTag checkout, current Cloudflare deployments, bindings, buckets, health response, and external integration evidence without resetting or stashing user work.
- [x] Added Slack manifest coverage for `reactions:read`, reaction events, and membership events.
- [x] Defined bot-message indexing: Slack `subtype: "bot_message"` rows are retained with explicit attribution, while pre-admission rejects bot output as turn triggers to prevent feedback loops.
- [x] Added durable reaction-triggered thread scheduling and idempotent membership ACL invalidation.
- [x] Added durable Slack ACL stale/fresh state and retrieval authorization fences; local Worker tests cover invalidation, duplicate delivery, refresh, and stale retrieval denial.
- [x] Removed the visible `OpenTag AG-UI · model unconfirmed` and `Working…` progress text from the Slack renderer and recovery path, and stopped starting Slack's `Thinking…` assistant status while retaining stale-status cleanup.
- [x] Removed the residual runtime/model label from final session context blocks; the optional session-events link is the only retained context decoration.
- [x] Added the Claude Tag-style `eyes` working reaction around ordinary human agent turns, with normal completion cleanup, a delayed durable cleanup lease for isolate loss, and exemptions for explicit reaction and trivial-ack shortcuts.
- [x] Added an outbound Slack knowledge observer across the shared adapter, progress renderer, busy feedback, Stop acknowledgement, and terminal/error paths; every committed write is observed by default, local metadata is stripped before Slack, and explicit suppression is reserved for internal non-knowledge effects.
- [x] Added durable pre-ack ownership for inbound knowledge events and durable alarm-owned outbound observations, with recovery writes using the same observation contract.
- [x] Made outbound observation fail closed when a channel has no explicitly enabled knowledge source; the durable observation retries and eventually surfaces exhaustion instead of completing with zero descriptors, while duplicate descriptors remain idempotent.
- [x] Added server-owned WorkspaceConfigDO Slack admission policy modes: `explicit` preserves exact source rows, while `all_delivered` materializes a default project/reader/retention source on first delivery; policy rollback drains active effects, disables materialized rows, and preserves disabled-channel opt-outs; local tests cover idempotence, version conflicts, rollback fencing, and opt-out behavior.
- [x] Added deterministic ordering for same-millisecond outbound post/final-update descriptors, content-revision identities for changed update bodies, and revision-CAS protection for Slack ACL refreshes.
- [x] Added idempotent duplicate-post lookup so an ambiguous Stop/final write can still produce an outbound observation when Slack omits the original timestamp.
- [x] Added bounded Slack `conversations.members` pagination, server-computed member-set digests, durable member-set persistence, requester membership fencing, event-triggered refresh, and periodic tracked-channel reconciliation.
- [x] Added a shared current-bundle and resource-grant authorization fence for unified, multi-source, Graphify, and actor-MCP retrieval paths, with stale-revision and wrong-resource tests.
- [x] Extended response routing to classify top-level channel messages and MPIMs, while preserving observe-only behavior for conversational noise and bot-loop protection; added ingress, pre-admission, routing, and group-DM Stop tests.
- [x] Passed the full edge suite (141 files, 1,317 tests), the full Worker suite (8 files, 59 tests), `npm run typecheck`, static knowledge rollout checks, and `git diff --check`. The suite emits only existing missing-sourcemap warnings from `@cloudflare/containers`.
- [x] Completed a fresh post-fix review cycle for the ACL path: freshness age, revocable read leases, and bounded Slack response bodies are now enforced locally; remaining gates are production-only.
- [x] Re-read the live Cloudflare and Slack surfaces: the bot remains the pre-milestone bundle, both derived Workers return HTTP 404 and Wrangler reports error 10007, the two required R2 buckets are provisioned, the deployed bot bundle still contains the removed AG-UI/`Working…`/active-turn strings and no `knowledge_observation` or reaction-cleanup symbols, and the live health response still reports `modelConfigured:false`, `reconciliationConfigured:false`, `credentialBroker.authConfigured:false`, and `oauth.allowedRedirectOriginsConfigured:false`.
- [x] Provisioned `opentag-supermemory-state` and `opentag-code-graphs` in the approved Cloudflare account and completed successful local Wrangler Container dry-runs for both services; deployment remains held because bucket-scoped R2 credentials and service/provider secrets are not available.
- [x] Persisted the documented Buzz relay fetch and independent allowlist origins in `wrangler.bot.toml`; deploy-config validation and the focused Buzz/health slice passed 42 tests. Live version 109 still predates these vars and has no signed admission proof.
- [x] Pinned `AGENT_MODEL = "gpt-5.6-sol"` in the local bot deployment vars; deploy-config and health tests pass, while the live bot still reports `modelConfigured:false` until redeployed.
- [x] Fresh bot Wrangler dry-run passed at 04:57 PDT and resolved the Queue/DLQ, service bindings, explicit Buzz origins, and model var; no publication occurred.
- [x] Ran the local failure/recovery matrix covering deferred ingress, knowledge ledger/queue retry and exhaustion, ambiguous Slack writes, and bot-turn observation recovery: 6 files / 110 tests passed.
- [x] Ran the expanded local failure/recovery matrix after the source-identity and observation fixes: 10 targeted files / 143 tests passed across deferred ingress, Slack write ambiguity, turn observation recovery, queue/ledger retry and exhaustion, effect leases, memory deletion, Buzz admission, and native Nanocodex responses. This closes the deterministic local contract only; live isolate-loss, provider, relay, and deployed-queue drills remain open.
- [x] Fresh live recheck at 06:42 PDT: the bot health endpoint returned 200, but `modelConfigured:false` and `knowledge.reconciliationConfigured:false` remain; `check:knowledge-rollout -- --live` has exactly two blocking failures, `opentag-supermemory Worker is deployed` and `opentag-graphify Worker is deployed`.
- [x] Ran the provider/effecter contract and worker slice: 16 files / 85 tests passed across billing, credential custody/broker, memory deletion, OAuth, platform effects, and provisioning adapters.
- [x] Re-ran the admission rollback validation after adding the workspace-default provenance marker: the full edge suite passed 141 files / 1,317 tests, the full Worker suite passed 8 files / 59 tests, typecheck passed, and static rollout checks passed; only existing missing-sourcemap warnings remain.
- [x] Made tracked-source and queue/ledger identity source-complete locally: legacy rows migrate to a composite team/sourceType/project/channel key, event/outbox/history/DLQ records retain the type, exact source/effect/grant/reconciliation queries bind it, Slack resolution filters to Slack, a same-key Slack/wiki isolation test passes, and non-Slack queue jobs fail closed with a durable `unsupported_source_type` outcome.
- [x] Wired aggregate reaction counts through canonical Slack normalization, content revisions, queue-consumer enrichment, primary Supermemory text, and flat metadata; local normalization, enrichment, and adapter tests pass. Structured burst/distillation child documents remain intentionally open.
- [x] Added deterministic harness provenance for the Docker inputs, ephemeral deploy-time `image_vars`, OCI/runtime source metadata, Worker version metadata, and an authenticated container-health readback; the current manifest is dirty local evidence and the live image mapping remains open.
- [x] Changed ambiguous duplicate recovery to require an exact Slack `client_msg_id` lookup before observing a message; the old thread-root fallback is removed, supplemental renderer posts receive deterministic IDs, and the affected recovery tests pass.
- [x] Added Slack installation lifecycle coverage: manifest subscriptions for workspace, public-channel, and private-channel events; bot-token versus user-only OAuth revocation handling; per-team installation generations; per-channel archive/delete/unshare/leave state; `(team_id,event_id)` fencing; source/effect-lease deactivation; tenant-scoped ACL invalidation; explicit reinstall activation; and pure/Worker/queue tests. The subsequent full edge suite passed 142 files / 1,323 tests. Live manifest readback, lifecycle canaries, and derived-index tombstone/reconciliation proof remain open.
- [x] Added a production observer-binding guard at the shared Slack write boundary: indexed posts and updates now fail before the Slack request when no durable knowledge observer is bound; production bot construction and direct busy/Stop/progress clients require that observer. Alarm recovery also requires exact `client_msg_id` lookup before observing timestamp-less Stop acknowledgements and no longer substitutes a thread root when observation is configured. Focused coverage passed 6 files / 157 tests; the full edge suite passed 142 files / 1,327 tests, typecheck and `git diff --check` passed.
- [x] Excluded only OpenTag's own transient `eyes` working reaction from durable knowledge refreshes while retaining user-authored `eyes` reactions as engagement signals; the distinction is covered by queue tests. This is source-complete only until the reviewed bot is deployed.
- [x] Fresh live recheck at 07:52 PDT: `opentag-bot` latest deployment is `88615a84-1396-4298-bd76-95b423db496c`; health remains HTTP 200 with `modelConfigured:false` and `knowledge.reconciliationConfigured:false`; `/buzz/wake` remains HTTP 503 `buzz_receive_not_configured`; a new connected-Slack baseline at `1785682336.591809` is explicitly bot-authored (`U0BAK4AJ2Q1`/`B0BAH924HDY`) and has no reply, so it is not a human canary; `opentag-supermemory` and `opentag-graphify` remain absent.
- [x] Fresh human Slack canary at 08:00 PDT: the connected Slack user surface posted a no-tag response-worthy message as William (`U0BAAQNETQB`) at [`1785682793.019839`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785682793019839), then an explicit-mention control at [`1785682813.095599`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785682813095599). Neither thread received a bot reply or `eyes` reaction after readback, so the canary failed to exercise the new lifecycle; this is direct evidence that the current deployed response/reaction path is not proven, not evidence that the local implementation is wrong.
- [x] Added tenant-scoped durable knowledge status evidence: `KnowledgeLedger.statusSnapshot()` and `/admin/knowledge/status` expose persisted ledger/outbox/DLQ/reconciliation/backfill state without message bodies. The validation checkpoint for this item passed 142 files / 1,331 tests and 8 Worker files / 63 tests, `npm run typecheck` passed, and `git diff --check` passed; the current suite is recorded below.
- [x] Added restart-safe Slack thread-fetch checkpoints: page cursors and accumulated messages persist under the exact tenant/source/job identity, resume after retry or isolate loss, clear on terminal outcomes, and surface as body-free `threadFetch` status. Retryable page/transport/timeouts now resume from the last accepted page; terminal and aged/orphaned checkpoints are cleaned up; hard message/byte bounds become explicit permanent size-bound outcomes. Focused fetcher/ledger/adapter coverage passed 78 tests, Worker coverage passed 13 tests, and typecheck passed.
- [x] Live Slack channel inventory readback at 08:08 PDT shows the bot installation is a member of `#general` (`C0BA1MKPRE3`) but not `#new-channel` (`C0BADPYGSR3`) or `#social` (`C0BAF3XC3AA`); the installed manifest and private/DM/MPIM coverage are still not read back. This directly confirms that the current installation cannot claim workspace-wide indexing.
- [x] Fresh local validation rerun at 08:34 PDT: 142 edge files / 1,331 tests, 8 Worker files / 63 tests, typecheck, deploy-config validation, static rollout checks, and `git diff --check` all pass; live rollout preflight still fails only on the two absent derived-index Workers, `/health` remains 200 with model and reconciliation unconfigured, and `/buzz/wake` remains 503 `buzz_receive_not_configured`.
- [x] Added server-owned Slack conversation inventory for `discoverAll: true` backfills: mixed public/private/IM/MPIM pagination, installed-bot membership classification, bounded exclusion/failure receipts, KnowledgeDO persistence, scope digest binding, incomplete/over-limit fail-closed behavior, and same-manifest receipt reuse; focused API/inventory/backfill tests and the Worker persistence test pass.
- [x] Fresh local validation rerun at 09:01 PDT: 143 edge files / 1,335 tests, 8 Worker files / 64 tests, typecheck, and the focused inventory/backfill slices pass; only existing non-fatal `@cloudflare/containers` sourcemap warnings remain. Live derived Workers, installed Slack readback, and deployment gates remain unchanged.
- [x] Closed three additional Slack event-identity gaps locally: documented reaction payloads now resolve missing parent threads through a body-free durable message-to-thread map with exact root-history fallback; nested `message_replied`/`message_changed` parents are honored; documented `message_deleted` events with only `deleted_ts` resolve root versus reply from that map and fail closed when unresolved. Focused coverage passed 4 files / 108 tests plus 1 Worker file / 15 tests; typecheck passed. Live event delivery, mapping recovery, and derived-index convergence remain open.
- [x] Corrected the server-owned inventory request to include archived conversations so archived history is represented as an explicit exclusion instead of being invisible to backfill; the Slack Web API contract test now asserts `exclude_archived=false`.
- [x] Full local validation at 09:30 PDT: 143 edge files / 1,343 tests, 8 bot-store Worker files / 65 tests, 1 Graphify Worker file / 5 tests, typecheck, deploy-config validation, static rollout checks, and `git diff --check` passed. Existing Container sourcemap warnings remain non-fatal; live derived Workers and Slack/Buzz/provider gates remain open.
- [x] Deployed the current private Supermemory and Graphify Workers and verified their Container applications through Wrangler: both services are ready, the live knowledge rollout checker passes, and the deployed image digests are recorded in the current-state reconciliation; R2 bucket credentials and provider boot remain fail-closed.
- [x] Deployed the current bot release `636be4c0-d8ec-4023-8af4-4157cdb6a6ac` and verified live liveness/configuration fields for the pinned model, reconciliation trigger, knowledge bindings, relay allowlist, and credential-broker authentication. The authenticated `/ready` receipt and end-to-end queue/Slack proof remain open.
- [x] Added the missing broker/custody service-binding auth secrets and verified stable public health readback: broker auth and custody auth are configured, while the custody Secrets Store binding map remains intentionally absent.
- [x] Verified the deployed harness Container image through Wrangler as `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880` with seven healthy instances. The current local source manifest is dirty and has a different digest, so source-to-image provenance remains open.
- [x] Closed the Buzz configuration gate: the independent relay allowlist is live and an empty `/buzz/wake` request reaches schema validation with HTTP 400 `buzz_wake_unexpected_fields`; a valid signed admission and tenant-scoped callback remain open.

## In progress
- [x] Reconcile the current OpenTag dirty worktree, deployment, and external integration state.
- [x] Complete the source-side Slack reaction and membership event subscriptions.
- [ ] Install/read back the Slack manifest and run the new-build reaction/indexing/silent-UI canary.
- [x] Implement the workspace-wide admission policy and server-owned conversation inventory needed for a literal “every delivered Slack event” guarantee; live team configuration, app membership/scopes, and complete-history/per-conversation convergence remain open.
- [x] Finish the source-side durable Slack membership refresh/reconciliation worker.
- [x] Finish the source-side durable knowledge ingress and reaction cleanup owners.
- [x] Finish the tracked-source configuration isolation, source-typed queue/ledger boundary, and primary reaction-enrichment path; live migration/readback, non-Slack connector execution, and reaction canary remain open.
- [x] Finish local Slack lifecycle/revocation handling; production event-delivery and replacement-generation proof remain open.
- [x] Finish local reaction/deletion/message-reply identity resolution; production canary and unresolved-event recovery remain open.

## Blocked
(none)

## Queued
- [x] Define and implement bot-message indexing semantics without retrieval feedback loops.
- [x] Run focused tests, typecheck, and fresh review, then resolve findings.
- [x] Deploy isolated Supermemory/Graphify Workers and bindings; provider/R2 credential activation, FUSE readiness, migration parity, and cutover remain open.
- [ ] Implement source-specific fetch/dispatch consumers and mutation/delete contracts before enabling non-Slack sources.
- [x] Deploy the current bot and verify the deployed harness image digest; authenticated readiness and source-to-image provenance remain open.
- [ ] Run live Slack, Buzz, provider, and failure-recovery validation.
- [x] Update the durable current-state and knowledge-contract gap documents; the requirement audit remains open until live Slack, Buzz, provider, and failure-recovery evidence exists.

## Confirm on return
- Live external gates may remain unproven if the connected Slack/Buzz/provider workspace cannot supply valid credentials or an authorized test fixture; those gates must be reported as evidence gaps rather than inferred passes.

## SPEC

[GOAL]
Close and verify the highest-risk OpenTag validation milestone: complete Slack reaction/membership subscriptions, define bot-message indexing semantics, run live Slack and Buzz admission checks, provision a test provider workspace, execute failure-injection and recovery tests, and verify the deployed harness image digest.

[DONE WHEN]
1. Slack reaction and membership events are subscribed, admitted, captured, and tested.
2. Bot-message indexing semantics are explicit in source, tests, and docs; generated messages cannot create retrieval feedback loops.
3. A real Slack canary proves reaction add/remove and the requested silent AG-UI surface.
4. A valid signed Buzz event proves authenticated admission through tenant-scoped runtime handling.
5. A scoped test provider workspace proves at least one real provider effect and its receipt/deletion behavior, or the exact external blocker is recorded.
6. Failure injection proves durable recovery for acknowledgement cleanup, turn finalization, indexing, and provider/Buzz boundaries.
7. The deployed harness image has a verifiable source/image digest relationship.
8. Focused tests and relevant typechecks pass, durable docs record evidence and remaining gaps, and no requirement is declared complete from indirect evidence.

[DELIVERABLES]
- Updated OpenTag source, tests, manifests, and durable rollout documentation.
- Evidence-backed final status for all seven requirements.

[WORKING FILES]
- This PROGRESS.md and command/test evidence captured in the repository history or rollout docs.

[TASKS]
- [ ] Reconcile current state and preserve unrelated dirty work.
- [x] Implement local Slack event coverage, bot-message policy, and lifecycle/revocation handling; the live manifest/readback and canaries remain open.
- [ ] Validate locally and with fresh review.
- [ ] Deploy and verify provenance.
- [ ] Run live and failure-injection gates.
- [ ] Reconcile docs and completion evidence.

[EXTERNAL GATES]
- Slack production canary and any message/reaction test fixture.
- Buzz signer, relay membership, valid event, and tenant mapping.
- Test provider workspace and scoped credentials.
- Cloudflare deployment and harness image inspection.

## Iteration log
| # | Task | Model | Result | Notes |
|---|------|-------|--------|-------|
| — | Plan | (bash/tool) | ✅ | Current primary checkout is dirty with user-owned knowledge/Graphify/Supermemory work; isolated prior worktree is not authoritative. |
| — | Reconcile | (bash) | ✅ | Confirmed manifest gap, bot-message omission, async knowledge descriptor scheduling, and uncommitted Cloudflare-only knowledge work. |
| — | Local semantics | (bash/Vitest) | ✅ | Added bot-message retention/loop prevention, reaction and membership scheduling, durable ACL stale fences, silent AG-UI rendering, working-reaction lifecycle, and source-side member-set reconciliation. |
| — | Review | (fresh context) | ✅ | ACL freshness, revocable read leases, and bounded Slack response bodies were added after review; the final independent review result is still being reconciled. |
| — | External state | (Wrangler/Cloudflare) | ⚠️ | Fresh `check:knowledge-rollout -- --live` at 06:42 PDT confirms two resource blockers: `opentag-supermemory` and `opentag-graphify` are not deployed. The approved account now contains both required R2 buckets; the primary knowledge Queue and DLQ also exist, and local Container dry-runs pass with fixed manifests, but bucket-scoped R2 credentials and service/provider secrets are unavailable. The live bot `/health` remains HTTP 200 but reports `modelConfigured:false`, `reconciliationConfigured:false`, `credentialBroker.authConfigured:false`, and `oauth.allowedRedirectOriginsConfigured:false`; the harness latest remains version 19 (`718af083-0b2d-4809-a878-7b98e7b3aef6`) with no image digest/source mapping. |
| — | Live Cloudflare source readback | (Cloudflare API/curl) | ⚠️ | At 05:41 PDT the live bot `/health` remained HTTP 200 but both derived-index Worker health URLs returned 404 and both Wrangler deployment queries returned error 10007. The deployed bot bundle still contains the legacy status/active-turn strings and lacks `knowledge_observation` and reaction-cleanup symbols, so the local milestone is not live. |
| — | Live source/readback | (Cloudflare/Slack) | ⚠️ | Cloudflare health remains `modelConfigured:false` and `reconciliationConfigured:false`; Slack readback on 2026-08-02 still finds the old AG-UI/Working text and active-turn behavior. New-build canary remains outstanding. |
| — | Buzz configuration/readback | (Cloudflare/curl) | ⚠️ | Live version 109 has signer, relay URL, auth-tag, and channel-map secret bindings but lacks `BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN`; current `/buzz/wake` returns `503 buzz_receive_not_configured`. No signed admission proof exists. |
| — | Health probe | (bash) | ✅ | Iteration-log recount is 0 and matches the counter; no prior output-file rows require verification. |
| — | Durable observation slice | (bash/Vitest) | ✅ | Added durable inbound knowledge-event ownership, durable outbound observation ownership, default indexing for every committed Slack write, content-revision identities for changed updates, and a delayed durable working-reaction cleanup lease; the latest affected outbound/status slice is 5 files / 75 tests. |
| — | Idempotent Slack write hardening | (bash/Vitest) | ✅ | Duplicate writes without a recoverable timestamp and successful writes without a timestamp no longer claim indexed success; the earlier full edge suite was 141 files / 1,317 tests and the outbound/status lifecycle slice remains 5 files / 75 tests. The validation checkpoint for this item was 142 files / 1,323 tests; the current suite is recorded above. |
| — | Busy-warning recovery hardening | (bash/Vitest) | ✅ | Concurrent-turn feedback now has a stable Slack client message ID and releases its one-minute dedupe claim when durable outbound observation fails; the affected bot-engine/Web API tests remain green in the current 5-file / 75-test slice. |
| — | Knowledge contract, read authorization, and response routing | (bash/Vitest) | ✅ | Accepted the real Slack `bot_message` subtype, added current-bundle/resource-grant fencing across unified, multi-source, Graphify, and actor-MCP reads, and extended deterministic routing to top-level channel messages and MPIMs; the validation checkpoint for this item was 142 files / 1,323 tests. |
| — | Outbound source-admission fence | (bash/Vitest) | ✅ | `scheduleKnowledgeFromSlackMessage()` now rejects an unconfigured channel with `knowledge_observation_source_not_enabled`; an explicitly enabled source still treats duplicate/out-of-order descriptors as a successful idempotent no-op. |
| — | Failure/recovery matrix | (Vitest) | ✅ | Deferred ingress, knowledge ledger/queue retry and exhaustion, ambiguous Slack writes, and bot-turn observation recovery passed: 6 files / 110 tests. This is local evidence; live Queue/DLQ, provider, Buzz, and isolate-loss drills remain open. |
| — | Provider/effecter contract slice | (Vitest) | ✅ | Billing, credential custody/broker, memory deletion, OAuth, platform effects, and provisioning adapter tests passed: 16 files / 85 tests. This proves local fail-closed contracts only; no live provider workspace or receipt/deletion drill exists. |
| — | Workspace admission policy | (Vitest) | ✅ | Added the server-owned `explicit`/`all_delivered` policy and default-source resolver; policy rollback now fences active effects, disables materialized rows, and preserves opt-outs. The validation checkpoint for this item passed 142 files / 1,323 tests; focused Worker coverage remains green. Live team configuration and complete-history backfill remain open. |
| — | Harness provenance and exact duplicate recovery | (bash/Vitest) | ✅ | Added source hashing, deploy-time image variables, OCI/runtime provenance, Worker version metadata, authenticated container health, and exact client-message lookup for timestamp-less duplicate posts; the targeted router/recovery slice passed 69 tests and typecheck passed. Docker build and live attestation remain open. |
| — | Observer binding and reaction noise hardening | (Vitest) | ✅ | Production indexed Slack writes now fail before network dispatch when the durable observer is absent; alarm recovery requires an exact message identity when observation is configured, and only the bot's own transient `eyes` reaction is ignored. Focused coverage passed 6 files / 157 tests; full edge coverage passed 142 files / 1,327 tests. |
| — | Fresh live evidence | (Wrangler/curl/Slack) | ⚠️ | Guarded bot version `8fd0e0bb-7167-40b5-a223-c626f701f916` is live; health is 200, strict knowledge/full readiness is 503 because both derived service probes are false, and current human controls prove explicit/no-mention routing and passive silence. |
| — | Current deployment reconciliation | (Wrangler/curl) | ⚠️ | The guarded bot deployment is live with model, reconciliation, allowlist, broker auth, observer, and index generation configured. Supermemory/Graphify uploads are present, but both singleton query containers report zero healthy instances; the rollout checker passes architecture/resource checks only. |
| — | Broker/custody auth repair | (Wrangler/curl) | ⚠️ | Internal broker and custody auth now read as configured. Custody still reports `bindingConfigConfigured:false`, so no provider credential resolution is enabled. |
| — | Buzz configuration gate | (curl) | ✅ | The allowed relay origin is configured and `{}` reaches `400 buzz_wake_unexpected_fields`; valid signed relay admission, dedupe, and tenant callback remain unproven. |
| — | Harness image digest | (Wrangler Containers) | ⚠️ | Live Container info exposes image `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880` and seven healthy instances; current local source digest is different and dirty, so the source mapping is not attested. |
| — | Human Slack canary | (Slack readback) | ⚠️ | Current-version explicit `1785701425.622489` and no-mention `1785701448.262779` received exact replies with no terminal `eyes`; passive `1785701473.534779` stayed silent. Retrieval `1785694376.778339` entered `Searching Slack` then returned `Knowledge unavailable.`, so indexing convergence remains open. |
| 1 | Buzz admission audit | luna_worker | ✅ | Source/test path is complete; live signed admission remains open at relay HTTP 526. |
| 2 | Knowledge convergence audit | luna_worker | ✅ | `indexed` is provider poll completion, not search convergence; exact live marker search remains zero citations. |
| 3 | Provider/effect/recovery/provenance audit | luna_worker | ✅ | No live provider effect or clean harness source/image attestation; local contracts pass and deployment remains fail-closed. |
| — | Health probe | (bash) | ✅ | Three numbered worker rows match the `3/30` counter; no output-file rows required existence checks. |

## 2026-08-03 authorized test-rollout amendment

The user explicitly authorized the current test rollout after the prior
blocked-state audit. This amendment expands the original validation goal to
include the external actions needed to close the named gates while preserving
the production boundary: Railway remains read-only, no production cutover is
performed, and no Railway credential or configuration is removed.

- [x] Create an isolated deploy snapshot from the current user-owned source
  without rewriting the dirty primary checkout. Local-only snapshot
  `f61e86d51d9d1c35456f092bcbe56f91170f0148` was created in a disposable
  worktree; the dirty primary checkout was not rewritten.
- [ ] Provision the Supermemory R2 access-key pair through the approved
  write-only secret path. Supermemory and Graphify Worker/container artifacts
  are deployed, and the refreshed harness and bot artifacts are deployed; the
  strict live gate remains blocked only by the missing R2 secret pair and
  unhealthy query instances.
- [ ] Reinstall/read back the Slack manifest and scopes, reconcile admission
  coverage, and run indexing/reaction/backfill canaries.
- [ ] Configure a valid Buzz signer/relay admission path and prove signed
  tenant-scoped admission, dedupe, and retry behavior.
- [ ] Implement and wire an isolated non-production provider adapter through
  broker/custody, then prove one scoped effect and its receipt/retry/revocation
  behavior against the controlled provider workspace.
- [ ] Run live Supermemory/Graphify, Slack, Buzz, provider, harness, and
  failure/recovery drills with durable receipts and no secret disclosure.
- [ ] Update current-state and operations evidence with exact pass/fail gates;
  leave unresolved external blockers explicit rather than inferring completion.

## Iteration log amendment
| — | Authorization | (user) | ✅ | Test rollout, Cloudflare secret/deploy changes, Slack reinstall, Buzz configuration, provider adapter work, live canaries, and recovery drills are authorized; Railway remains read-only and no production cutover or credential removal is authorized. |
| 4 | Provider adapter implementation | luna_worker | ✅ | Isolated source/test slice implements strict Linear envelopes, broker-mediated credentials, controlled-workspace checks, durable idempotency receipts, and ambiguous-outcome handling. Resolver/idempotency bindings and custody mapping remain intentionally unconfigured pending integration and external credentials. |
| 5 | Buzz admission implementation audit | luna_worker | ✅ | Isolated source/test slice adds pre-fetch relay allowlisting, signer-bound NIP-OA auth-tag validation, typed relay failure receipts, replay/retry coverage, and tenant-isolation tests. A live signed relay event remains unproven. |

## Operator-owned external prerequisites

- [ ] In the Cloudflare Dashboard, create a bucket-scoped R2 S3 API token for
  `opentag-supermemory-state` with object read/write access, then provision its
  Access Key ID and Secret Access Key through the approved Wrangler secret
  workflow. The current Wrangler OAuth session can deploy Workers but cannot
  create account API tokens, and secret values must not be pasted into chat.
- [ ] Reinstall the Slack app from the current manifest using a workspace-admin
  session and refresh the bot token. Source scopes/events are complete, but the
  installed token readback is missing `reactions:read`, `users.profile:read`,
  and manifest-export capability; the current connected Slack tools do not
  expose an app-manifest reinstall operation.
- [ ] Supply or authorize a non-production Buzz signer/relay fixture with relay
  membership, the configured allowed origin, and a valid tenant channel map.
  The source boundary is repaired, but a valid signed event cannot be invented
  from an empty or HTTP-526 relay response.
- [ ] Approve a controlled Linear test workspace and its credential-custody
  mapping. The provider adapter is fail-closed until the resolver, broker,
  idempotency store, custody mapping, and provider auth are all deployed and
  bound; no provider token belongs in OpenTag source, logs, or chat.

## Handoff — 2026-08-02 22:01 PDT

**Why:** Resume health probe found `Subagent calls used: 4/30` but only three
numbered worker rows in the iteration log. The counter was reconciled to the
log; delegated calls are frozen until a fresh session rechecks the ledger.
**Reconciled counter:** 3/30
**Current state:** Local Slack/bot-message semantics and Supermemory/query
convergence contracts are source-tested; local effect/custody boundaries and
failure matrices are synthetic; live Slack scope/backfill, Buzz admission,
provider effect, recovery, and harness source/image gates remain open.
**Review status:** Local focused and full validation passed; live and Docker
gates remain unverified.
**Next queued step:** Continue with inline source/test work or start a fresh
session that first reruns this counter/log health probe before any delegation.
**Open failures:** Slack installed-scope/completeness, Buzz relay admission,
provider credential/effect mapping, live recovery receipts, Docker/FUSE, and
clean harness provenance.

## 2026-08-03 rollout checkpoint

- Local release validation passed before the final isolated Buzz/provider
  source slices: typecheck, 1,390 unit tests, 70 e2e tests, Graphify e2e and
  policy checks, deploy-config validation, Supermemory artifact verification,
  knowledge rollout checks, and diff checks.
- Cloudflare deployment succeeded for refreshed Supermemory and Graphify
  Workers/Containers, the harness image, and the bot Worker. Railway remains
  read-only; no cutover or credential removal occurred.
- The strict live knowledge checker now has three concrete failures only:
  missing Supermemory `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, plus zero
  healthy Supermemory and Graphify query instances. The current Wrangler OAuth
  identity cannot create the required R2 API token, and the Dashboard browser
  session is not signed in.
- The source-side Buzz and provider adapter slices are complete and tested in
  the isolated snapshot. Buzz still needs a real signed relay event; the
  provider adapter still needs resolver/idempotency bindings, custody mapping,
  provider auth, and effecter wiring before any live provider write is safe.
- Slack source manifest coverage is present, but installed-token scope
  readback and app reinstall remain an authenticated workspace-admin action.

## 2026-08-03 post-wiring rollout checkpoint

- [x] Persisted the provider adapter, request resolver, idempotency Durable
  Objects, tests, effecter binding, and bot integration into the primary
  checkout with targeted patches; the dirty worktree was not reset or cleaned.
- [x] Deployed the private provider request resolver
  (599dad9a-2f67-4c96-bab8-3c9a1fc3aaa6), provider idempotency Worker
  (7c224154-13c8-4f1e-b64a-83ad9d940021), provider adapter
  (519ab423-7f5c-4a4f-bfbb-bd410eb6035f), and effecter
  (77fb1243-d9e6-444a-814d-e1ff5c676d35). Cache-busted live effecter health
  reports adapterConfigured:true, adapterKinds:["connector_effect"],
  providerEffectsEnabled:false, and providerAdapterReady:false until the
  controlled workspace subject and custody mapping are provisioned.
- [x] The adapter remains constrained to tenant-scoped Linear
  create_issue, with broker-mediated credentials, opaque request references,
  durable idempotency, and ambiguous-result receipts. It does not accept
  provider tokens and does not enable any other effect kind.
- [x] Typecheck and the affected provider/Buzz/effecter/deploy slice pass:
  8 files / 78 tests. The full pre-wiring validation remains historical and
  must be rerun after the primary checkout is reconciled.
- [ ] The strict live knowledge checker now has exactly one blocker:
  missing Supermemory R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. The query
  applications report healthy=1 and failed=0; their idle Durable Objects
  report instance_state=inactive as expected after normal eviction. The
  missing secret pair still prevents the Supermemory R2/FUSE readiness
  contract from becoming active.
- [ ] Slack installed-manifest scope readback/reinstall, valid signed Buzz
  admission, controlled Linear custody mapping/effect receipt, live recovery
  drills, and harness source-to-image attestation remain unproven.

The current remaining blockers are operator-owned account or fixture actions,
not unresolved local implementation failures. Do not mark the derived indexes,
workspace-wide Slack completeness, Buzz admission, provider effects, or
harness provenance complete from binding health alone.

## 2026-08-03 primary-checkout validation

- [x] The reconciled primary checkout passes the full unit suite: 148 test
  files / 1,407 tests.
- [x] Worker e2e passes: 8 files / 70 tests. Graphify e2e passes 5 tests and
  Graphify policy validation passes 10 tests.
- [x] Typecheck, deploy-config validation, Supermemory server/tigrisfs
  artifact checksum verification, and git diff checks pass.
- [ ] The current live-gate result is one knowledge failure: Supermemory R2
  secret names are absent. The query applications pass the healthy-instance
  gate with healthy=1 and failed=0; Slack reinstall and installed-scope
  readback are still open, Buzz has no signed admission receipt, provider
  custody is unconfigured, and harness source/image provenance plus live
  recovery drills remain unproven.

## 2026-08-04 live Slack routing canary

- [x] Human no-mention canary
  [1785817152.734609](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817152734609)
  was visible in #general but received no bot reply or thread messages after
  the observation window.
- [x] Human explicit-mention control
  [1785817229.507059](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817229507059)
  received a normal reply at
  [1785817241.480749](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817241480749).
  A marker-shaped explicit request was separately quarantined by the bot
  security screen, so marker canaries are not valid routing controls.
- [ ] The live installation therefore does not yet prove ordinary
  message-event delivery. The source manifest contains the no-tag event
  subscriptions, but the installed app must be reinstalled/read back before
  flexible no-mention routing can be claimed.

## 2026-08-04 harness and Buzz canary evidence

- [x] Native Nanocodex live canary
  [1785817326.689779](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817326689779)
  completed at 1785817337.000189 and replied, “Hello! I used the NanoCodex
  adapter.”
- [ ] A harmless long-running Stop drill was quarantined by the harness
  security screen before execution at
  [1785817364.274859](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817364274859);
  it is not recovery evidence and no external command ran.
- [x] Buzz configuration reachability remains proven: the live empty probe
  returns HTTP 400 buzz_wake_unexpected_fields. A valid signed relay event,
  tenant admission, dedupe, and retry receipt remain open.

## 2026-08-04 local image gates and operator prerequisites

- [x] The pinned Supermemory image builds locally for linux/amd64. The image
  installs Supermemory server-v0.0.5 and tigrisfs v1.2.1 after checksum
  verification. A real R2/FUSE read/write, remount, persistence, and
  restart-recovery proof still requires the two live R2 S3 credentials.
- [x] The harness image builds locally when invoked with the repository root as
  its Docker context. Its current source provenance is
  `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
  with source state `dirty`; the deploy script correctly refuses to publish
  that image until the tracked harness inputs are reconciled into a clean
  release boundary.
- [ ] The only failing strict live knowledge assertion is the absent
  Supermemory `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secret pair. The
  current Wrangler OAuth identity cannot create an account-level R2 API token;
  an operator must create a bucket-scoped token and enter the values through
  the write-only Wrangler secret workflow.
- [ ] Slack still needs a workspace-admin app reinstall/readback using the
  current manifest. The source manifest contains ordinary message, reaction,
  lifecycle, and revocation subscriptions, but the installed token has not
  been proven to have them.
- [ ] Buzz still needs a valid signed relay fixture and tenant admission
  mapping. Provider effects still need a controlled Linear workspace subject,
  custody mapping, and an explicit test-tenant enablement. These are live
  external fixtures, not missing local adapter code.

## 2026-08-04 clean harness deployment and fresh Slack controls

- [x] Created local branch `codex/harness-provenance-rollout` and scoped
  commit `a9cf6aa` containing only the four harness provenance contract files;
  the other staged and untracked rollout work remains untouched.
- [x] Guarded `deploy:one-click --skip-knowledge --preserve-existing-secrets`
  deployed the harness and bot. Harness Worker version is
  `c461d03b-5766-4802-a38b-92358fac7246`; bot Worker version is
  `5c2cced7-b298-4658-a042-c6add9de2f06`. Supermemory and Graphify were not
  redeployed by this command.
- [x] Cloudflare application-version readback reports harness version 6 at
  100% on image
  `sha256:f853b7257f6183d11e7855c76ee31664e95813af679c23329ed77cdd92e038e0`,
  matching the clean local image build. The application is ready with 7
  healthy and 0 failed instances.
- [x] Fresh explicit Slack control
  [1785818656.409849](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785818656409849)
  received the exact reply `4` at 1785818666.201239; the parent had no
  remaining reactions after completion.
- [ ] Fresh ordinary no-mention Slack control
  [1785818683.157419](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785818683157419)
  remained silent. This continues to point to installed Slack event
  subscription/readback, not a local classifier defect.
- [ ] A fresh `--nanocodex` Slack control was quarantined by the security
  screen before harness execution at 1785818620.169059, so it proves neither
  harness execution nor Stop/recovery. The prior native Nanocodex pass remains
  historical until a non-quarantined post-deploy canary is available.

## 2026-08-04 current blocker clarification

- [x] Fresh strict live preflight reduced the knowledge failure set to one:
  Supermemory is missing `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
- [x] Supermemory and Graphify query applications pass the instance-health
  gate with `healthy=1; failed=0`; their Durable Object `inactive` state is
  normal idle eviction and is not an unhealthy-container result.
- [x] Harness source/image provenance is live-verified. Cloudflare version 6
  is 100% on image
  `sha256:f853b7257f6183d11e7855c76ee31664e95813af679c23329ed77cdd92e038e0`
  with seven healthy instances.
- [ ] An account administrator must create a bucket-scoped R2 S3 token for
  `opentag-supermemory-state` and enter both values through the write-only
  Worker Secret workflow. Values must never be pasted into chat.
- [ ] A Slack workspace administrator must reinstall the current manifest;
  the installed bot token still lacks manifest export and reaction/profile
  readback, so ordinary message, reaction, lifecycle, and revocation coverage
  is not live-proven.
- [ ] Live Buzz admission still needs a valid signed relay event and
  tenant-directory fixture. Provider effects still need a controlled Linear
  test workspace, custody mapping, and provider credential. These are external
  fixtures, not missing local adapter implementation.

## 2026-08-03 22:10 PDT live Slack routing readback

- [x] Explicit question `1785819895.661429` returned `6` at
  `1785819903.847239`.
- [x] Unmentioned top-level question `1785819923.155599` returned `6` at
  `1785819928.833469`; an unmentioned threaded follow-up
  `1785819948.422389` returned `5` at `1785819955.833559`.
- [x] Passive ordinary conversation `1785820063.298189` remained silent.
- [x] The tested completed parents had no remaining reactions.
- [ ] No-tag Stop remains open for live recovery evidence: the ChatGPT Slack
  connector appends an attribution footer that makes the test event non-exact,
  while the raw transport posts as the bot and is correctly ignored.

## 2026-08-04 control-path correction and current blockers

- [x] Bot version `54515284-a310-4d43-9f49-1295bafc0b92` deployed the durable
  Slack egress generation fence. Stop preempts queued normal writes, and
  preempted render attempts are classified as definitive no-ops.
- [x] The Slack/Stop/rate-limit focused suite passes 74 tests.
- [x] A signed synthetic long-turn/Stop drill reached
  `stop_command_received` and produced `:octagonal_sign: Stopped.`. It is not
  a real Slack thread receipt because the synthetic parent was not created in
  Slack.
- [ ] The strict live knowledge preflight currently has two failures:
  Supermemory is missing `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and
  its query instance is `stopped` (`healthy=0; failed=0`). Graphify is
  registered and healthy (`healthy=1; failed=0`).
- [ ] A Cloudflare account administrator must create a bucket-scoped R2 Object
  Read & Write token for `opentag-supermemory-state`; only the resulting
  values should be entered through the interactive Wrangler secret workflow.
- [ ] Real human-authored Slack canaries at `1785822892.400989` and
  `1785822949.953319` produced no bot reply after deployment. Reinstall and
  read back the Slack manifest before attributing this to source routing. The
  deployed synthetic path also recorded `users.profile.get missing_scope`.

## 2026-08-03 23:17 PDT fresh rollout correction

- [x] Reran the strict live knowledge preflight. Graphify is healthy
  (`healthy=1; failed=0`); the only unhealthy query service is Supermemory,
  whose R2 secret names are missing and whose query instance is inactive.
- [x] Static Graphify pin/source, downloaded Supermemory artifact, deploy
  configuration, and 82 focused provider/Slack/Stop tests pass.
- [x] Confirmed the provider adapter, request-resolver, idempotency, and
  effecter Workers are deployed. Effects remain fail-closed pending controlled
  custody and Linear workspace fixtures.
- [x] Real Slack mention `1785823907.868169` received bot reply
  `1785823916.194899`.
- [ ] Real unmentioned threaded follow-up `1785824162.624719` and Stop
  attempts `1785823961.282869`, `1785824017.302689`, `1785824070.799199`,
  and `1785824111.475349` received no bot reply. The current live gate is
  installed Slack `message.*` delivery/readback, not the source Stop parser;
  reinstall the manifest before claiming no-tag routing or Stop quiescence.
- [ ] Buzz configuration is present in `/health`, but a fresh signed
  canonical-event admission receipt is still required.

## 2026-08-03 23:27 PDT authoritative live preflight

- [x] Reran `npm run check:knowledge-rollout -- --live --require-healthy-instances`.
  Static contracts, buckets, deployments, secret-name checks, and Graphify
  all pass. Graphify is healthy (`healthy=1; failed=0`).
- [ ] Supermemory is the only failing knowledge service: its Worker lacks
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and its query instance is
  `stopped` (`active=0; healthy=0; failed=0`).
- [x] Harness provenance remains live-verified on the clean deployed image;
  it is not a current blocker. Provider support Workers are deployed but
  fail closed without a custody-backed controlled Linear credential.
- [ ] Slack app installation/readback, fresh signed Buzz admission, provider
  effects, and live recovery drills remain external gates.

## 2026-08-03 23:32 PDT Worker source redeploy

- [x] Redeployed the current Supermemory Worker source as version
  `d85b3a1a-2e59-4619-a96f-6eae3a2ffc86` and Graphify Worker source as version
  `c5daebda-056e-49dc-9f1f-add24b0001c6`. Container rollouts were explicitly
  disabled because Docker is unavailable; no Container image was replaced.
- [ ] The post-deploy strict check is unchanged at two failures: missing
  Supermemory R2 secret names and a stopped Supermemory query instance.

## 2026-08-03 23:37 PDT Container rollout readback

- [x] Built the current linux/amd64 Supermemory image with the pinned
  Supermemory server and tigrisfs checks; Cloudflare reported no Container
  configuration change because the resulting image was already present.
- [x] Built and applied the current Graphify query/builder image. After normal
  startup, the strict check again reports Graphify healthy (`healthy=1;
  failed=0`).
- [ ] The read-only code-graph Slack canary `1785825331.979619` received no
  thread reply, so it proves neither facade invocation nor citation output;
  this remains a Slack delivery/feature invocation gate, not a Graphify
  Container health failure.

## 2026-08-03 23:43 PDT Slack delivery diagnosis

- [ ] Current explicit code-graph mention `1785825654.491479` and plain
  `2 + 2` mention `1785825745.790249` both received no thread reply.
- [x] A live tail of bot version `54515284-a310-4d43-9f49-1295bafc0b92`
  emitted no `turn_*` or `slack_message_routed` event for either message.
  This narrows the current issue to installed Slack Event API delivery or
  manifest state, not the Graphify tool implementation.
- [x] The same tail showed background knowledge retries with
  `knowledge_http_503`; those are a separate consequence of missing
  Supermemory R2 credentials.

## 2026-08-03 23:49 PDT provider readiness correction

- [x] Read-only Linear discovery confirmed the isolated project
  `OpenTag E2E Provider Smoke - 2026-08-02` (`1e98bfb6-27d1-46d8-879c-7975107e7005`)
  in the Berendo team; no issue was created.
- [x] The adapter now probes credential-broker health before advertising
  provider effects. The controlled subject `workspace:controlled-linear-test`
  is configured, and adapter version `c2a57312-9e93-4d9e-a90a-7ee0bae0b295`
  is deployed.
- [x] Live effecter health returns `adapterConfigured=true` but
  `providerEffectsEnabled=false` and `providerAdapterReady=false`, correctly
  reflecting the absent custody mapping. Focused provider tests pass (9).
- [ ] A custody-backed Linear credential/Secrets Store binding is still
  required before a real provider effect can run.
