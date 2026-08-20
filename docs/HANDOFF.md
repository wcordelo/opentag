# OpenTag — current session handoff

Status: **reconciled with merged `origin/main`, the 2026-08-01 rollout, and
the live feature checks**

Updated: **2026-08-05 14:52 PDT**

Read [PRODUCT.md](./PRODUCT.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
[DECISIONS.md](./DECISIONS.md), and
[docs/current-state.md](./current-state.md) first. The last document is
the evidence index: it distinguishes source-complete, live-verified,
synthetic-live, fail-closed, and open-gate states.

## Latest live checkpoint — 2026-08-05 14:52 PDT

Docker Desktop is repaired and available again. The local daemon reports
version `28.0.1`; the Supermemory tigrisfs image and the current harness image
both build successfully for the Cloudflare `linux/amd64` target.

Supermemory R2 credentials are now present as Cloudflare Worker Secrets on
`opentag-supermemory`. The Worker is deployed at version
`77bfc140-d149-4399-9f7f-dbe283628f38`; the singleton Container is running
version 32 with image
`sha256:c84bce9f6119e1946fc1bce799308fd61aea7c978b870d4b98aea72758355614`.
An isolated staging R2 bucket passed the tigrisfs/FUSE mount, unprivileged
read/write, and Supermemory search checks and was removed after the test.

The authenticated knowledge readiness probe now returns HTTP 200 with no
blockers and all agent, Supermemory, Graphify, reconciliation, actor-token,
consumer, and index checks true. The active-instance rollout check passes.
The optional strict control-plane health check still sees both singleton
query applications as `active=1, healthy=0, failed=0`, despite running
instances and successful authenticated readiness/internal health probes. Keep
this as an explicit Cloudflare health-aggregate discrepancy until explained;
do not claim the strict gate is green.

The harness was rebuilt and deployed from the current local checkout as Worker
version `d34621fd-4bae-49f3-8b5f-874e45d87324`; Container version 8 uses image
`sha256:2128a07f6693be5bbb2bd765be368dd6f56617a3ba0af955205d0a3ded0395ff`
and reports seven healthy instances. Because the checkout is dirty and the
deployment was intentionally direct, clean immutable source provenance is
still open. The deployed agent also passed a direct DeepSeek AG-UI canary. A
fresh canary sent to the actual OpenTag Slack bot is present in `#general` but
produced no reply, and the current Worker tail showed no `/slack/events`
request. The earlier `SANDBOX_BACKEND=local` error was returned by the
separate QM bot, so it is not evidence about the OpenTag deployment. Unlock
the Mac and reinstall/read back the current manifest before retrying live
Slack canaries.

The live provider adapter canary completed a real Linear write as `BER-11`
with one attempt and a durable receipt. A replay of the completed effect was
rejected as non-claimable, preventing a duplicate write; receipt-returning
replay readback remains a follow-up gap.

The bot was redeployed at version `617b73ca-2114-4723-a819-2086100fa10e` with
operator-search query-convergence receipt wiring. The authenticated MCP search
path reaches Supermemory and returns valid responses, but the current R2-backed
corpus returns zero compliant citations for the recent canary markers. The
tenant ledger readback is 88 rows: 55 `indexed`, 2 `pending`, and 31
`permanent_failure`; all 55 queryability receipts remain `unverified`. A
bounded reconciliation pass scanned all 88 rows and skipped them because no
eligible retryable descriptor was present. The remaining knowledge gap is
provider-data replay/convergence, not R2 credentials or container reachability.

Buzz remains fail-closed as intended. A fresh event published to Buzz
`general` was rejected by OpenTag as `buzz_wake_unbound_channel` because that
channel is not in the server-owned tenant directory. The configured pilot
channel has no readable members for the local signer; it still needs a fresh
event signed by the configured pilot signer and a successful
fetch/verify/admit/dedupe/reply receipt.

## Fresh local validation and image-build gate — 2026-08-02 23:37 PDT

The current checkout passes the full edge suite (146 files / 1,390 tests),
bot Worker e2e (8 files / 70 tests), Graphify e2e (5 tests), Graphify policy
(10 tests), typecheck, deploy-config validation, shell syntax, downloaded
Supermemory/tigrisfs artifact verification, static rollout checks, and
`git diff --check`. A local `linux/amd64` Supermemory image build reached
Docker but stopped while resolving the public `cloudflare/sandbox:0.12.4`
base image because Docker's credential helper returned an invalid-parameter
error. No Docker credential, Cloudflare resource, secret, deployment, or
external state was changed; the image digest and FUSE runtime gate remain
unverified.

## Fresh Supermemory and live-gate recheck — 2026-08-02 23:17 PDT

The isolated Supermemory and Graphify package typechecks pass, as do shell
syntax and `git diff --check`. The strict read-only rollout check again passes
the static, resource, deployment, bucket, registration, and secret-name
assertions, but fails only the two health gates: Supermemory and Graphify
query Containers each report `active=1, healthy=0, failed=0`.

Fresh deployed Worker readback still finds the old Supermemory application
calls `mountBucket("STATE_BUCKET", ...)` and `s3fsOptions`, while the local
checkout uses the pinned tigrisfs entrypoint contract. The deployed harness
bundle still lacks `/health/container`, `sourceDigest`, `sourceRevision`, and
`sourceTree`. These readbacks confirm source/deployment skew; no deployment,
restart, secret change, migration cutover, or other external mutation was
performed.

## One-click R2 secret-path repair and live preflight — 2026-08-02 23:25 PDT

The local one-click deployment script now requires and provisions
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from the secret-only inputs
`OPENTAG_SECRET_SUPERMEMORY_R2_ACCESS_KEY_ID` and
`OPENTAG_SECRET_SUPERMEMORY_R2_SECRET_ACCESS_KEY`. The read-only rollout
checker now treats both names as required Supermemory secrets. Focused deploy
script tests, the full edge suite (146 files / 1,389 tests), typecheck, shell
syntax, downloaded Supermemory/tigrisfs artifact verification, static rollout
checks, and `git diff --check` pass.

The fresh live preflight reports the expected missing production names:
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. No secret was supplied or
changed. The deployed Worker remains the legacy `mountBucket` bundle and both
query Containers remain unready; this source repair is not deployed evidence.

## Slack indexing audit — 2026-08-02 23:26 PDT

The Slack source audit is complete for the requested indexing semantics:
reaction and membership events are represented, bot-authored messages are
retained as knowledge candidates without waking turns, eligible events are
durably owned before acknowledgement, and member join/leave events invalidate
the channel ACL. The fresh suite includes the member-join regression.

The current local regression remains green at 146 unit files / 1,389 tests,
with typecheck, bot e2e (8 files / 70 tests), Graphify e2e (5 tests), Graphify
policy (10 tests), deploy-config validation, downloaded Supermemory/tigrisfs
artifact verification, shell syntax, and `git diff --check` also passing.
The live installed manifest, token scopes, private/MPIM visibility, complete
history backfill receipt, and provider-backed indexing receipt remain open;
source coverage is not live installation coverage.

## MCP authorization reconciliation — 2026-08-02 23:32 PDT

The knowledge MCP implementation and documentation now agree on the locked
boundary: external/operator callers use `ADMIN_SECRET`, while internal callers
use short-lived, single-use actor tokens with team/project/resource scope,
current source authorization, durable audit, and replay protection. Named raw
query templates remain operator-only. The focused MCP suite passes 10 tests and
the full local suite passes 146 files / 1,390 tests; typecheck and
`git diff --check` pass. This is source/test evidence only and does not change
the open live provider, custody, or external MCP rollout gates.

## Authenticated Slack capability and coverage readback — 2026-08-02 23:32 PDT

The local bot token authenticates as team `T0BBBEDLEGY`, bot user
`U0BAK4AJ2Q1`, and app `A0BA1NHQD8F`. A read-only `conversations.list` over
public channels, private channels, IMs, and MPIMs returned six conversations:
four public channels where the bot is a member, two IMs where it is not a
member, and no private channels or MPIMs visible to this installation.
`conversations.members` succeeds for the public-channel membership readback.

The same token returns `missing_scope` for `reactions.get`,
`users.profile.get`, and `apps.manifest.export`. Therefore the source
manifest's reaction/profile/event requirements are not installed-token proof;
reaction event delivery, profile enrichment, private/MPIM visibility, and the
installed manifest remain live gates. No Slack message, reaction, or
installation state was mutated.

## Fresh strict live preflight — 2026-08-02 23:34 PDT

The read-only knowledge rollout check is unchanged: all static, R2, deployment,
registration, pin, artifact, and Graphify secret-name checks pass. Exactly three
live gates fail: Supermemory is missing `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY`, and the Supermemory and Graphify query instances each
report `active=1, healthy=0, failed=0`. No deployment, restart, secret change,
Queue mutation, provider action, or Slack state mutation was performed.

## Goal blocked on external gates — 2026-08-02 23:36 PDT

The local source and test milestone is complete, but the validation goal cannot
reach its live end state under this handoff's no-mutation boundary. The same
blocking condition has now recurred across three consecutive goal audits. To
resume, explicitly authorize the current production actions and provide or
confirm the missing external inputs: provision the two Supermemory R2 secrets
and deploy the pinned Worker/Container images, reinstall/read back the Slack
manifest with reaction/profile coverage, configure a valid Buzz signer and
relay, wire the approved custody/provider adapter to the isolated test
workspace, run live Queue/isolate/recovery drills, and deploy/read back the
clean harness provenance image. No such action was taken here.

## Integrated synthetic admission and provider-effect recheck — 2026-08-02 23:01 PDT

The local checkout now includes assembled synthetic proofs for the two
remaining executable boundaries. Buzz uses a fake relay that verifies NIP-98
authorization and returns a signed kind-9 event; OpenTag verifies that event,
resolves the server-owned channel-to-tenant map, writes SQLite-backed admission
and reply receipts, publishes a signed fixed reply, and suppresses replay.
The platform effect runner resolves an opaque credential reference through
synthetic custody, injects an ambiguous provider failure, retries with the
same idempotency key and external receipt, and rejects a completed rerun.
Provider tokens do not enter adapter envelopes or effect reports.

The full local regression passes 146 unit files / 1,387 tests, bot Worker e2e
8 files / 70 tests, Graphify e2e 5 tests, Graphify policy 10 tests, typecheck,
deploy-config validation, static rollout checks, downloaded Supermemory/tigrisfs
artifact verification, and `git diff --check`. Read-only live resource and
registration checks pass, while the health-gated check still reports both
query Containers `active=1, healthy=0, failed=0`. Secret-name readback still
shows no Supermemory R2 access-key pair and no provider-adapter binding/auth
secret. These synthetic checks do not close live Buzz admission, provider
effects, custody, FUSE, or recovery gates. No deployment or external mutation
was performed.

## Broker/custody integration recheck — 2026-08-02 23:09 PDT

The local broker test now wires the real credential broker and custody Worker
apps together through a service binding. The request is revalidated against
tenant metadata and the versioned custody binding before the secret is read;
the opaque token appears only in the final broker response. The focused broker
and custody slice passes 2 files / 19 tests, with no provider token in the
service-bound request bodies.

This remains synthetic local boundary evidence. No live Secrets Store mapping,
provider grant, effecter adapter, external provider workspace, or production
configuration was changed or claimed.

## Post-integration regression recheck — 2026-08-02 23:11 PDT

The broker/custody integration slice passes 2 files / 19 tests, and the fresh
full edge suite passes 146 files / 1,387 tests. Typecheck and `git diff --check`
also pass; the only test output is the known nonfatal missing-Graphify-sourcemap
warning. No deployment or external mutation was performed.

## Deployed Supermemory source mismatch recheck — 2026-08-02 23:12 PDT

Cloudflare code readback for the deployed `opentag-supermemory` Worker still
contains the legacy `mountBucket("STATE_BUCKET", ...)` / `s3fsOptions` path and
`unmountBucket()` cleanup. Its bundled `supermemoryContainerEnv` does not carry
the local R2 credential-to-Container mapping. The local checkout instead pins
and verifies tigrisfs v1.2.1, starts the FUSE mount from the entrypoint, fences
readiness on real mount/read-write/provider checks, and contains no active
`mountBucket` or `unmountBucket` calls.

Treat the local Supermemory image/source validation as pre-deployment only.
The deployed service remains on the old contract and the health/FUSE gate is
open. No deployment, restart, secret change, or migration cutover was
performed.

## Local harness provenance build — 2026-08-02 23:02 PDT

The current harness image builds successfully for `linux/amd64`. Its OCI
labels exactly match the generated local provenance manifest: revision
`d075431f25f886842aec5552314afea9d1c9c1dd`, source tree
`7a3f874822d0f785f56b1ec66142523b384e1ff0`, source digest
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`,
and source state `dirty`. The local image is
`opentag-harness-provenance-test@sha256:ff5e8470c750ed84e4e81f4a01376b3e54abf85910d261365915bf42163ce75e`.

This proves local source-to-image label integrity only. The deployed
`opentag-harness` bundle still lacks `/health/container`, `sourceDigest`, and
`sourceRevision`, so its running image cannot be matched to this local build.

## Local harness runtime smoke — 2026-08-02 23:08 PDT

The locally built harness image started as a disposable `linux/amd64`
container and returned HTTP 200 from `/health`. The response reported Claude
Code `2.1.154`, Nanocodex `0.3.0`, and the exact embedded revision, source tree,
source digest, and `dirty` source state recorded above. The disposable
container was removed after the readback.

This is local runtime evidence only; the deployed Worker and Container still
run the older, unmatched image.

## Live Container readback — 2026-08-02 23:06 PDT

Read-only Wrangler inventory reports Supermemory Container v18 running one
`supermemory` instance with `active=1`, `assigned=0`, `healthy=0`,
`failed=0`, and no reported health errors; its image is
`sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.
Graphify query Container v6 reports the same health aggregate and no reported
health errors; its image is
`sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.
The harness Container remains v4 with seven healthy instances and image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.

The zero `assigned`/`healthy` query state remains a live readiness blocker;
this readback did not mutate Containers or deployments.

## Latest stable local recheck — 2026-08-02 22:46 PDT

The local source now has a generation-scoped Slack manifest receipt in
WorkspaceConfigDO. The admin recording route validates a secret-free readback,
resolves the active installation generation, and forwards the guarded write;
the admin lookup reads the same durable installation state. Manifest digests
cover capability content rather than observation time, so repeated polls retain
one capability revision while freshness remains explicit metadata. The focused
contract/manifest slice passes 7 tests and the WorkspaceConfigDO generation
suite passes 10 tests.

The Supermemory provisioning-health boundary test now synchronizes fake time
with the mocked container request. The full edge unit suite passes 146 files /
1,384 tests, bot Worker e2e passes 8 files / 70 tests, Graphify e2e passes 5
tests, Graphify policy passes 10 tests, and typecheck, deploy-config, shell,
artifact, and static rollout checks pass. The strict read-only live check still
fails only Supermemory and Graphify query health: each reports
`active=1, healthy=0, failed=0`.

No deployment, restart, secret change, Queue mutation, provider effect,
commit, push, or PR was performed. Docker was unavailable at this checkpoint;
the later local image build is recorded below.

## External read-only evidence refresh — 2026-08-02 22:52 PDT

The connected Slack readback confirms bot `U0BAK4AJ2Q1` in `#general` and
`#skills`, the latest reaction lifecycle thread ended with the exact
`OPENTAG_REACTION_LIFECYCLE_OK` marker, and the parent message has no residual
reactions. This connector exposes only those two channels; the broader
four-channel membership claim remains limited to the authenticated Cloudflare
readback recorded below.

Cloudflare Worker code readback for deployed `opentag-harness` returns the old
bundle: it exposes the basic `/health` response but contains no
`/health/container`, `sourceDigest`, or `sourceRevision` contract. The deployed
container image digest is therefore not source-attested, even though the
container inventory exposes an image digest. No deployment or other external
mutation was performed.

## Local Supermemory image build — 2026-08-02 22:55 PDT

Docker Desktop became reachable after the earlier validation checkpoint. The
approved local build completed successfully with
`docker build --platform=linux/amd64 -t opentag-supermemory-tigrisfs-test
infra/supermemory`. The build verified the pinned Supermemory server checksum,
the pinned tigrisfs `v1.2.1` archive checksum, and produced local image
`opentag-supermemory-tigrisfs-test@sha256:191ae1f738a78a4b93ffbd5a622e7720ab175b5f7f27082edb70b86976a69aaf`
for `linux/amd64`.

This closes the local image-build gate only. R2/FUSE mount, remount,
read/write persistence, restart recovery, provider add/poll/search, and
source-to-deployed-image attestation remain unproven because the image was not
run with production credentials and no deployment was authorized.

## Latest local source reconciliation — 2026-08-02 22:15 PDT

The local Supermemory source now follows the approved pinned `tigrisfs`
Container contract: `TIGRISFS_VERSION=v1.2.1` and the Linux/amd64 archive
checksum are verified in the Dockerfile; the entrypoint requires the four
storage variables, starts tigrisfs, waits for a real mount, performs a
Supermemory-user read/write probe, and writes the R2-ready sentinel only after
that probe. The Worker maps R2 access secrets to Container-only AWS variables,
does not call `mountBucket` or `unmountBucket`, and observes the sentinel,
mountpoint, and unprivileged read/write state. The bot binding still receives
no derived-index credentials. The prior credential-less Sandbox SDK mount
description below is historical evidence from the earlier mixed snapshot.

The authoritative ledger now has a separate, durable queryability receipt
beside `indexed` ingestion completion. It is generation/revision/document
fenced, idempotently replaceable, body-free, and exposed only through internal
KnowledgeDO routes and status aggregates. `indexed` still means provider
document polling reached `done`; `searchable`, `no_match`, and
`provider_unavailable` require a separate search readback.

The source now also contains a strict Slack manifest readback contract. It
normalizes and digests bot scopes/events, reports missing capabilities, rejects
duplicate or extra receipt fields, and never accepts tokens or raw manifest
payloads. WorkspaceConfigDO persists one receipt per installation generation,
and the admin route resolves the active generation before forwarding the
generation-fenced write. The YAML regression uses the same required capability
constants. This is local contract evidence only; live manifest export,
installed-token scope readback, and complete workspace/history visibility
remain open.

The full regression rerun at 22:26 PDT passes 146 edge unit files / 1,383
tests, 8 bot Worker e2e files / 69 tests, Graphify e2e (5 tests), Graphify
policy (10 tests), typecheck, deploy-config validation, source-pinned rollout
checks, Supermemory/tigrisfs artifact verification, and `git diff --check`.
The live Supermemory Worker remains the legacy deployed bundle and both query
Containers still report zero healthy instances; no external mutation was
performed.

The production Slack write-path audit found no runtime `knowledgeIndex: false`
call. Normal posts, updates, placeholders, progress, stop acknowledgements,
and paged answers use the observer-backed Web API client, and durable render
recovery observes the exact committed timestamp after reconciliation. The only
explicit suppression is a unit-test fixture for deliberately transient output.
This is local bot-write evidence, not provider queryability or workspace-wide
inbound coverage.

Fresh validation passes: 145 edge unit files / 1,379 tests, 8 bot Worker e2e
files / 69 tests, Graphify e2e (5 tests), Graphify policy (10 tests), focused
Supermemory/checker tests, typecheck, deploy-config validation, source-pinned
rollout preflight, shell syntax, `git diff --check`, and downloaded
Supermemory/tigrisfs artifact verification. The configured non-secret
Cloudflare account identifier is a valid 32-character value and Supermemory
dry-run deployment validation passes. Docker has a client but no reachable
daemon, so image build/FUSE and remount/restart persistence remain open. The
strict read-only live check passes all static/resource assertions and fails
only the Supermemory and Graphify query health aggregates
(`active=1`, `healthy=0`).

No path-bound legacy editor kernel is present. Generic Wrangler tail readers
remain running and were not terminated. No deployment, secret, Queue, provider,
credential-removal, commit, push, PR, or external-publication action occurred
in this checkpoint.

Read-only Cloudflare source readback found that the deployed
`opentag-supermemory` bundle is still the legacy Sandbox `mountBucket`
implementation and contains `Supermemory R2 binding mount is not ready`. The
current checkout is the upgraded pinned-tigrisfs implementation and contains
no `mountBucket`/`unmountBucket` lifecycle. Treat the deployed Worker as stale
until the Docker/FUSE gates pass and an explicitly approved redeploy is made;
do not infer live Supermemory readiness from the local green checks. The
knowledge-service deploy script now refuses to invoke Wrangler when its
tracked inputs have staged/working-tree divergence or are untracked; it was
exercised against this checkout and stopped before upload.

The one-click deployment flow now applies the same clean-input rule to the
harness before secret or deployment mutation. A local Supermemory failure
injection proves missing R2/FUSE credentials stop the entrypoint before the
provider starts. Neither result attests the existing deployed harness image
or live Supermemory Container; Docker/FUSE and explicit redeploy gates remain
open.

The current source recheck passes 145 edge unit files / 1,379 tests,
typecheck, source-pinned rollout checks, downloaded Supermemory/tigrisfs
verification, and diff checks. The deployed Worker source readback still
contains the legacy `mountBucket` bundle, so do not treat this local evidence
as a live upgrade.

Fresh read-only Container info reports harness version 4 with 7 healthy
instances and image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
Supermemory version 18 and Graphify query version 6 each report
`active=1`, `assigned=0`, `healthy=0`, and `failed=0`; their image digests are
`sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`
and `sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.

Read-only Slack confirmation found exact terminal replies for the explicit and
bot-message markers, no reactions remaining on the lifecycle marker, and bot
`U0BAK4AJ2Q1` in the tested channel membership. Installed reaction/profile
scopes and workspace-wide/private/MPIM/history completeness are still not
proven.

## Live Slack completeness and provenance readback — 2026-08-02 22:08 PDT

The source manifest regression passes 2 tests and asserts the required Slack
history/read, reaction, profile, team, and channel-join scopes. The manifest
retains reaction, membership, installation-revocation, and channel lifecycle
event subscriptions. Authenticated membership readback confirms bot
`U0BAK4AJ2Q1` in the four visible public channels: `#general`,
`#new-channel`, `#social`, and `#skills`.

The real human explicit canary
[`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
returned `OPENTAG_MILESTONE_EXPLICIT_OK` at `1785728831.600039`. The real
bot-message event canary
[`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
returned `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`; its live
tail classified the event as a channel message and recorded an `indexed`
queue outcome. The reaction lifecycle canary
[`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
showed the working `eyes` reaction while running, returned
`OPENTAG_REACTION_LIFECYCLE_OK` at `1785729227.808039`, and had no reaction
after terminal cleanup.

These receipts prove the live Slack response/reaction path and bot-message
event handling, not installed-token scopes, complete Slack history, private or
MPIM visibility, or derived-index queryability. The strict rollout check still
fails the Supermemory and Graphify query Container health aggregates. Local
harness provenance is
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
with `workingTreeDirty:true`; the deployed image is
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
Docker/FUSE build and clean source-to-image attestation remain open. No
external mutation occurred in this readback.

## Final local and strict live gate rerun — 2026-08-02 22:14 PDT

The final local edge unit suite passes 145 files / 1,379 tests; the bot
Worker e2e suite passes 8 files / 69 tests; typecheck and `git diff --check`
pass. Graphify Worker e2e passes 5 tests, Graphify policy passes 10 tests,
deploy-config validation passes, the Slack manifest test passes 2 tests, shell
syntax passes, and downloaded Supermemory/tigrisfs artifact verification
passes.

The strict read-only rollout check passes every static, R2, deployment,
secret-name, pin, and artifact assertion. It fails exactly two live health
gates: Supermemory query `instance_state=running; active=1; healthy=0;
failed=0` and Graphify query `instance_state=running; active=1; healthy=0;
failed=0`. No deployment, restart, Queue mutation, credential change, or
provider action was attempted.

## Audit reconciliation — 2026-08-02 21:16 PDT (historical snapshot)

Three fresh read-only audits and a current Wrangler readback narrow the
remaining gaps:

- Knowledge dispatch currently treats a successful provider
  `documents.get(...)=done` poll as ledger `indexed`; it does not perform a
  search readback. The fresh canary has an `indexed` queue outcome but zero
  authenticated citations for its exact marker. A local regression now
  exercises `add -> documents.get(done) -> search` and proves that an empty
  search result remains distinct from provider completion. No production
  status change is justified until the raw provider search response and the
  corresponding ledger row are captured. The durable contract needs a
  separate query-convergence receipt or an explicitly documented distinction
  between ingestion completion and queryability.
- Current read-only Container info remains Supermemory version 18,
  `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`,
  and Graphify query version 6,
  `sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.
  Both have one active/running instance but `assigned=0` and `healthy=0`;
  strict rollout therefore still fails both query health gates.
- Buzz source plumbing is locally complete (seven focused test files, 93
  tests, and typecheck), including signed fixtures, NIP-98, dedupe, retry,
  and reply paths. The live empty-body response is only
  `400 buzz_wake_unexpected_fields`; the known signed wake still stops at the
  relay HTTP 526 boundary. No live signed event, authenticated fetch,
  durable admission, callback, or tenant runtime receipt exists.
- The provider/effect audit found no registered platform effect adapter and no
  custody Secrets Store mapping in the default deployment. The Linear fixture
  is not wired through the broker/effect ledger, so no real provider mutation,
  receipt, revocation, rollback, or live lease-recovery drill is proven.
  Local effect/custody/recovery tests pass, but they remain synthetic.
- Fresh authenticated bot readback is knowledge-ready (`/ready?profile=knowledge`
  HTTP 200) but full-ready HTTP 503 with blockers
  `credentialBrokerReachable`, `platformEffecterReachable`, and `oauth`.
  Tenant status is now 84 rows: 55 indexed, 2 pending, and 27 permanent
  failures; outbox and tenant-local DLQ are empty. The latest reconciliation
  completed after scanning 84 rows and skipping 84.
- Harness Container version 4 has seven healthy instances and image
  `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
  The local source manifest is dirty and differs from that image; Docker is
  unavailable, so source-to-image attestation and rebuild/restart evidence
  remain open.
- The post-audit local validation is green: 145 edge test files / 1,373
  tests, typecheck, and `git diff --check` pass. This does not alter any live
  gate.

A later-dated worktree note describes a Supermemory secret/bootstrap and
redeploy attempt after the earlier read-only sweep. I did not reproduce,
reverse, or extend that action in this continuation. The current Wrangler
readback above is the authoritative state for this checkpoint; no additional
deployment, secret, Queue, provider, credential-removal, commit, push, PR, or
external publication was performed here.

## Final read-only gate sweep — 2026-08-02 20:59 PDT

The deployed bot remains HTTP 200 with configured model, Slack, knowledge,
Buzz, broker, effecter, and harness bindings. Harness Container info reports
version 4 with seven healthy instances and image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`;
the dirty local source manifest does not match that image, so clean
source-to-image provenance remains open.

The empty Buzz probe returns HTTP 400 `buzz_wake_unexpected_fields`, not a
signed admission receipt. The fresh unmentioned canary marker still returns
zero authenticated knowledge citations despite a queue `indexed` outcome.
Tenant status is 83 rows: 55 indexed, 2 pending, and 26 permanent failures;
outbox and tenant-local DLQ are empty. Strict rollout still fails the
Supermemory and Graphify query Container health aggregates
(`active=1`, `assigned=0`, `healthy=0`, `failed=0`). No deployment, replay,
provider or Queue mutation, credential removal, commit, push, PR, or external
publication occurred.

## Local stability validation — 2026-08-02 21:06 PDT

The affected Slack/knowledge source slice passes 8 files and 95 tests;
typecheck and staged/unstaged diff checks pass. The covered contracts include
response routing, pre-admission, manifest/lifecycle events, knowledge
scheduling and observation, Slack writes, and canonical thread normalization.
This remains local evidence; no deployment or external mutation occurred.
The follow-up queue/normalization/Web API rerun passed 3 files and 70 tests,
including an explicit bot-message Events API indexing contract.

## Full local validation rerun — 2026-08-02 21:09 PDT

The full edge unit suite passes 145 files and 1,372 tests; the bot Worker e2e
suite passes 8 files and 67 tests. Typecheck and staged/unstaged diff checks
pass. The only output is the known nonfatal Graphify dependency sourcemap
warning. No deployment or external mutation occurred.

## Local failure/recovery slice — 2026-08-02 21:10 PDT

Durable ingress, Stop/recovery, knowledge reconciliation/queue, Supermemory
boundary, harness routing, and runtime-probe tests pass: 9 files and 140
tests. These deterministic local receipts do not prove live isolate-loss,
deployed Queue/DLQ replay, provider recovery, or Container restart
durability.

## Derived-index validation — 2026-08-02 21:12 PDT

Deploy-config validation passes. Graphify Worker e2e passes 1 file / 5 tests
and Graphify policy tests pass 10 tests. Static rollout checks pass for
privacy, Supermemory single-writer policy, exact Graphify pin, catalog/CAS/
artifact rules, binding-owned R2, and authoritative Queue/DLQ ownership. The
last strict live read-only result remains the two query Container aggregates
with zero healthy instances.

## Strict live rollout recheck — 2026-08-02 21:13 PDT

The read-only rollout checker passes every static, R2, secret-name, pin,
artifact, and deployment assertion. It exits 1 only for Supermemory query and
Graphify query Container health: both report
`instance_state=running; active=1; healthy=0; failed=0`. No deployment or
recovery mutation was attempted.

## Fresh read-only live reconciliation — 2026-08-02 20:41 PDT

The latest authenticated readback was captured at 20:31 PDT. Knowledge
readiness is HTTP 200, while full readiness remains blocked by the credential
broker, platform effecter, and OAuth checks. Tenant status now reads 80 ledger
rows: 53 indexed, 2 pending, and 25 permanent failures, with an empty
outbox and tenant-local DLQ summary. The separate operator Queue/DLQ surface
has 100 pending captured records; do not replay or dispose them without an
explicit operator action.

The deployed Slack search canary wrote marker 1785725283.368069, kept
unmentioned retrieval 1785725304.390959 silent, and returned
OPENTAG_SUPERMEMORY_SEARCH_OK for explicit retrieval 1785725373.889899 at
1785725391.260059. The installed bot token still lacks reactions:read and
users.profile:read: reactions.get, users.profile.get, and
apps.manifest.export return missing_scope. Membership is confirmed only for
the four visible public channels general, new-channel, skills, and social.
No workspace-wide, private-channel, MPIM, or complete-history claim is valid.

The current source is the upgraded Worker-owned R2 binding implementation,
not the historical tigrisfs proposal. The strict live rollout check still
fails only Supermemory and Graphify aggregate health
(active=1, assigned=0, healthy=0, failed=0). The deployed harness image is
sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880,
whereas the dirty local source manifest is
sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa.
Buzz remains unproven at HTTP 526, and the OpenTag effect path is not wired
to the controlled Linear fixture. No deployment, Queue or provider mutation,
replay, commit, push, or PR occurred in this continuation.

## Fresh Slack routing and reaction addendum — 2026-08-02 20:45–20:54 PDT

The explicit control at
[`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
received `OPENTAG_MILESTONE_EXPLICIT_OK` at `1785728831.600039`; its final
reaction readback was empty. The marker-shaped fresh unmentioned message at
[`1785728708.551929`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728708551929)
received no reply or reaction because it was not a question or recognized
action request. The valid unmentioned deployment-status question at
[`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
received `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`; the live
tail recorded a `channel_message` route and a knowledge queue outcome of
`indexed`. An authenticated operator search for the exact marker returned
zero citations, so queue acceptance is not yet search convergence. The
subsequent tenant status readback is 83 ledger rows: 55 indexed, 2 pending,
and 26 permanent failures, with zero pending outbox work and an empty
tenant-local DLQ summary. The
explicit reaction lifecycle control at
[`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
showed `eyes` during the turn and an empty reaction state after the final
reply. These messages were posted through the connected Slack user surface
and carry the ChatGPT app marker; they are controlled live checks, not proof
of a native Slack-client human-origin event.

The local response router now recognizes response-directed reply/respond/
answer forms with exact/with/to continuations and keeps please do not reply
silent. The focused routing/pre-admission tests (30) and typecheck pass. This
repair is local-only; no deployment or reaction-scope change occurred.

## Local provider-readiness correction — 2026-08-02 20:37 PDT

The local Supermemory entrypoint and Worker lifecycle now require a successful
`2xx` response from `/v3/openapi` before creating the provider-ready sentinel
or releasing the Container health gate. A reachable `4xx`/`5xx` response is
still degraded and cannot be reported as healthy. Focused boundary tests,
shell syntax, typecheck, and diff checks pass.

The fresh strict read-only rollout check still fails only the two live
Container health checks: Supermemory and Graphify each report
`active=1`, `assigned=0`, `healthy=0`, `failed=0`; their instances are listed
as `running`, which is not a healthy receipt. No deployment, provider or
Queue mutation, commit, push, or PR was performed.

## Local source reconciliation — 2026-08-02 20:16 PDT

The knowledge queue now carries the exact Slack message timestamp that caused
an inbound, reaction, or outbound observation. Job creation rejects malformed
or non-Slack inclusion timestamps, descriptor identity includes the timestamp,
and Supermemory dispatch refuses to index a thread until the exact observed
message is present in the fetched canonical thread. A complete but stale Slack
response records `observed_message_missing` as a retryable outcome, so a
provider write cannot acknowledge a snapshot that omitted the message which
triggered it. Delete jobs remain tombstone-driven and do not require the
deleted message to be fetched.

This hardening is local-only. It has contract coverage for valid/invalid job
identity, event scheduling, reaction and outbound observations, and the
complete-but-stale dispatch path. It is not present in the inspected deployed
bot until a separately approved deployment and live canary are run.

The final local validation pass is green: typecheck, 144 unit test files with
1,370 tests, 67 bot Worker tests, 5 Graphify Worker tests, 10 Graphify policy
tests, deployment-config validation, Supermemory artifact verification,
static/live knowledge rollout checks, and staged/unstaged diff checks. Docker
is unavailable, so image rebuild, FUSE remount, restart persistence, and
clean harness source-to-image attestation remain open.

The local Supermemory port gate was additionally tightened after this pass:
bootstrap `GET /health` may return `200` before the Worker-owned R2 mount so
the Cloudflare lifecycle hook can run, but non-health traffic returns `503`
until R2 is mounted. Health remains `503` between the R2 signal and provider
startup, and returns `200` only after the provider-ready sentinel. Focused
tests, shell syntax, typecheck, and the strict read-only rollout check pass
for the local contract. The live strict check still reports both query
Containers as `active=1`, `assigned=0`, `healthy=0`, `failed=0`; this repair has
not been deployed.

## Current session reconciliation — 2026-08-02 19:00 PDT

This section supersedes the 17:38 checkpoint below. The reported legacy
Supermemory writer processes (`91517`/`91518`) are no longer present, and a
five-second watch of the affected image, entrypoint, Worker, and Wrangler
files found no concurrent rewrite. The current goal remains active; no
process was killed and no other app-server task was terminated.

At the 19:00 historical checkpoint, the Supermemory implementation was the
upgraded Cloudflare Sandbox path: the Worker owned the credential-less
`STATE_BUCKET` binding mount at `/var/lib/supermemory`, used a disposable local
model-cache bind mount at `/var/lib/supermemory/models`, and held the
application behind the R2 and port readiness fences. The current source has
since been reconciled to the pinned tigrisfs/Container-credential contract
recorded at the top of this handoff. The historical source and
[`docs/supermemory-cloudflare-migration.md`](./docs/supermemory-cloudflare-migration.md)
remain useful only for that earlier checkpoint.

The current evidence is:

- `opentag-bot` deployment `764a18ea-bda9-4209-bdbc-0b9cc81a6cba` runs the
  five-minute reconciliation schedule with a 600-second Slack ACL freshness
  bound.
- Authenticated `/ready?profile=knowledge` returns HTTP 200 with every
  knowledge and code-graph check true. The old provider failure was narrowed
  to R2/FUSE model-cache renames; after the local cache overlay, no new EIO
  was observed in the provider tail sample.
- The Supermemory Container is running version 18 with image digest
  `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.
  Provider tail evidence includes successful document write/poll responses
  and `/v4/search` HTTP 200. This does not yet prove restart persistence,
  update/delete/tombstone convergence, or migration parity.
- Bot deployment `764a18ea-bda9-4209-bdbc-0b9cc81a6cba` carries bounded Buzz
  receive telemetry plus the durable ambiguous-add and expired-poll recovery
  fixes. A known wake reaches the relay HTTP phase and receives HTTP 526.
  Re-provisioning the canonical relay origin did not change that result; a
  local NIP-98 request reaches the relay and receives the expected 401/403
  authorization responses. No valid Buzz admission is claimed.
- Live Slack controls completed with
  [ACL cadence](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719827818089)
  returning `OPENTAG_KNOWLEDGE_CADENCE_OK` and
  [provider receipt](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719693438309)
  returning `OPENTAG_KNOWLEDGE_PROVIDER_RECEIPT_OK`.
- The fresh Supermemory marker was written at
  [`1785725283.368069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725283368069).
  The deployed bot did not answer the unmentioned retrieval request at
  [`1785725304.390959`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725304390959),
  while the explicit-mention control at
  [`1785725373.889899`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725373889899)
  returned `OPENTAG_SUPERMEMORY_SEARCH_OK`; the local checkout's `t1.12`
  retrieval fix passes route and pre-admission tests but is not deployed.
- A fresh human [marker write](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725283368069)
  followed by an [explicit-mention retrieval](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725373889899)
  returned `Searching Slack` and `OPENTAG_SUPERMEMORY_SEARCH_OK`; the queried
  parent had no lingering reaction. The equivalent [untagged search request](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725304390959)
  received no reply on the deployed version, exposing a routing gap rather
  than a provider reachability failure.
- The operator recovery endpoint safely listed failure metadata without
  exposing lease or provider-attempt tokens. Thirty `local_add` rows were
  reopened with correction reference
  `supermemory-v18-r2-model-cache-repair-da95429a`; no row was blocked by the
  recovery operation. The latest live status readback is 77 ledger rows:
  32 indexed, 19 leased, 2 pending, and 24 permanent failures. Outbox and
  DLQ work are empty. The latest reconciliation is complete after scanning 77,
  enqueueing 19, and skipping 58; the 19 leased rows have not yet converged.
- The 24 remaining permanent rows are bounded classes from the prior contract:
  23 `unsupported_update_contract` outcomes and one Slack terminal
  `thread_not_found`; they are not silently being requeued.
- Local harness provenance is
  `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
  with `workingTreeDirty:true`; Docker is unavailable and the live
  `/health/container` source-to-image mapping remains unverified.
- The recovery trace now shows the repaired transition: identity probes reach
  the private Supermemory service, three post-fix rows reached explicit
  `indexed` outcomes, and their Queue deliveries were acknowledged as
  `recorded_success`. Earlier rows also produced four recorded successes.
  Remaining rows are still being drained; this is not yet a complete-history
  receipt.

- The stable validation pass now includes typecheck, 1,370 unit tests, 67 bot
  Worker tests, 5 Graphify Worker tests, Graphify policy tests, deployment
  configuration validation, Supermemory artifact verification, both static and
  live rollout preflights, Graphify pin verification, shell syntax, and staged
  plus unstaged diff checks. Docker remains unavailable, so image rebuild,
  FUSE remount, and restart-persistence evidence are still open.
- The local router now classifies leading `search`, `look up`, `lookup`, and
  `query` requests as retrieval/action traffic and has focused regression
  coverage. This fix is local-only pending the explicit deployment gate; the
  live untagged routing canary therefore remains open.
- A strict read-only health preflight using
  `--require-healthy-instances` fails for both query Containers: Cloudflare
  reports state `running`, not `healthy`. The local port-gate repair keeps
  non-health traffic at `503` before R2, allows only bootstrap health before
  the lifecycle mount, and makes `/health` return `200` after the
  provider-ready sentinel; the image and Worker have not been redeployed.

No Railway shutdown, migration cutover, credential removal, commit, push, or
PR was performed. Remaining gates are the explicit deployment and rerun of the
local no-tag retrieval fix, Slack reinstall/scope and lifecycle readback,
complete-history inventory/backfill, convergence of the remaining recovery
rows, provider update/delete/tombstone and restart receipts, Graphify artifact
and citation receipts, valid signed Buzz admission, provider-effect testing,
failure-injection drills, and clean harness source-to-image attestation.

## Latest handoff checkpoint — 2026-08-02 17:38 PDT

The current deployed Slack surface is healthy for flexible response routing,
working-reaction cleanup, passive silence, and removal of the old visible
model/progress text. It is not yet a healthy knowledge system: authenticated
knowledge readiness fails `knowledgeSearchReachable`; Supermemory is assigned
but unhealthy, Graphify is unassigned/unhealthy, and the tenant ledger has 42
permanent plus 22 retryable failures with no provider receipt. The remote
Supermemory error log shows repeated EIO model-cache rename failures on the
R2/FUSE mount.

The live admission policy reads back as `all_delivered` with
`defaultProjectId: workspace-default`, but this means every eligible event
delivered to the installed app, not every Slack workspace message. The source
manifest declares reaction/profile scopes that the installed bot token does
not have (`reactions:read`, `users.profile:read`); the bot is currently a
member of the four visible public channels and no workspace-wide/private/MPIM
completeness claim is justified.

The local Supermemory repair extends wake to 90 seconds, uses a local s3fs
cache for model downloads, and fences readiness on the Worker-owned R2 mount
and application port 6768. Its Worker-side change is deployed as
`be2128c7-2617-4acb-b378-9522252451ea` without a Container image rollout;
Docker is unavailable for the required image restart. Remaining live gates are
Slack reinstall/readback and complete backfill, provider add/poll/search and
recovery receipts, valid signed Buzz admission, a broker-mediated provider
workspace effect, failure-injection drills, and a clean harness provenance
attestation. All current OpenTag changes remain staged/local-only; no commit,
push, or PR was created in this run.

## Local-only contract follow-up — 2026-08-02 21:38 PDT

The knowledge ledger now separates provider ingestion from retrieval
convergence. `knowledge_query_convergence` is a durable, body-free receipt
keyed by source key, content revision, and derived-index generation. The
internal `/query-convergence` route accepts only bounded counts, a SHA-256
query digest, and an opaque document identity; it rejects stale revisions and
cannot record `queryable` without a matching citation. `indexed` therefore
continues to mean provider polling reached `done`, while `queryable` requires
an explicit authenticated search readback. `SupermemoryAdapter` exposes
provider-result counts through `searchSlackForConvergence` for that readback.

The platform effect contract now has a secret-free `connector_effect` kind for
the reviewed Linear `create_issue` and Google Drive `search` pairs. Its
metadata carries only opaque request/credential references, versions, and
digests. No provider adapter, custody mapping, deployment, or live receipt was
enabled; the direct Linear tool remains a separate fail-closed path until a
tenant-scoped adapter can resolve the durable request reference and return an
external receipt.

## Current release anchors

| Item | Value |
| --- | --- |
| Merged baseline | `d075431f25f886842aec5552314afea9d1c9c1dd` (`origin/main`) |
| Working branch | `main` |
| Source hotfix | `9d4538c`, identity read forwarding; focused test added |
| Live bot inspected | current code version `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`; health reports model, knowledge bindings, observer, index generation, Buzz, and broker configuration present; authenticated knowledge readiness is HTTP 200 |
| Live harness inspected | version `718af083-0b2d-4809-a878-7b98e7b3aef6`; local provenance contract exists, but live image/source digest mapping remains open |
| Current bot deployment | Guarded bot, broker, custody, harness, Supermemory, and Graphify deployments are present; Supermemory version 18 is running and provider `/v4/search` readback is HTTP 200; Graphify artifact/citation parity and custody/effect execution remain open |
| Current Slack membership | Bot `U0BAK4AJ2Q1` is confirmed in `#general`, `#new-channel`, `#social`, and `#skills` by authenticated member readback and bot-token inventory; installed-manifest and complete indexing receipts remain open |
| Slack routing smoke | Explicit [`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889) and valid no-mention [`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309) replied exactly; marker-shaped passive [`1785728708.551929`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728708551929) stayed silent |
| Knowledge retrieval smoke | ACL cadence [`1785719827.818089`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719827818089) returned `OPENTAG_KNOWLEDGE_CADENCE_OK`; provider receipt [`1785719693.438309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719693438309) returned `OPENTAG_KNOWLEDGE_PROVIDER_RECEIPT_OK`; complete-history and row-level recovery receipts remain open |
| Passive-only smoke | [top-level plus untagged `yo` stayed silent](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785629853529029) |
| Stale-turn cleanup | [pre-fix thread stopped safely](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785626165915119) |

The checkout was fast-forwarded to merged `origin/main` and the user-owned
knowledge, ACL, reaction, Supermemory, Graphify, and documentation changes were
restored without resetting the worktree. The current bot health is 200 and
reports the model, knowledge bindings, observer, index generation, Buzz, and
broker configuration, but this is not a readiness or provider proof. Both
derived-index R2 buckets and private Worker/Container deployments exist, while
the Supermemory provider path is now reachable through the private service
binding. The effecter, custody, OAuth, billing, and deletion shells remain
fail-closed.

The local failure/recovery matrix now passes 10 targeted files / 143 tests;
this is deterministic contract evidence only and does not close the live
isolate-loss, deployed Queue/DLQ, provider, or Buzz recovery drills.

The local harness provenance manifest currently reports
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`
and `workingTreeDirty:true`. The deploy script now carries that exact manifest
into the image build, the Worker `/health` response exposes its version
metadata, and authenticated `/health/container` exposes the image's embedded
source values. Docker is unavailable here, so this is not a deployed release
attestation.

## What is implemented now

### Layer 1 — Slack agent spine

Slack Events API ingress, HMAC verification, stable identities,
pre-admission, session/event replay, render obligations, exact effect fences,
Stop continuation, durable HITL, quick actions, channel/thread memory,
requester attribution, and fail-closed authorization rules are source-complete
and deployed. Local routing now classifies every eligible human message:
explicit mentions, DMs, MPIMs, files, questions, action requests, and problem
reports may wake the bot without a tag, while passive conversation remains
history-only. Duplicate
Slack `message` delivery for an `app_mention` is discarded before admission,
so it cannot leave a stale active-turn row. The live canary verified all of
those routing decisions, exact explicit-turn finalization, and follow-up
delivery after the preceding turn reached its terminal state. The same canary
showed the busy warning when a second response-worthy message arrived during
a genuinely running first turn; that is expected concurrency feedback, not
the stale duplicate-admission bug. The latest local work additionally retains
bot-authored messages, schedules reaction/membership refreshes, adds a bounded
ACL lease, durably owns inbound knowledge events and outbound observations,
adds a delayed durable cleanup lease for the Claude-Tag-style working reaction,
indexes committed Slack writes by default, and no longer starts Slack's
`Thinking…` assistant status while retaining stale-status cleanup; those
changes are included in the guarded bot deployment. Live reaction and
membership event delivery, KnowledgeDO ownership, and derived-index receipts
remain unproven even though the Slack response surface is live-verified.

### Layer 2 — coding and model plane

The private harness Worker and Container are deployed with sentinel credentials,
egress policy, remote-git postconditions, native Claude, Claudex, and the
native typed Nanocodex Responses adapter. Slack canaries returned exact markers
for Claudex and native Nanocodex. A live repository push/PR, live Stop, and
checkpoint reconnect were not run in this rollout. The current harness version
is known, but the immutable container image/source mapping is not. Local
ambiguous recovery now requires an exact Slack client-message lookup before
observing a duplicate post, so a thread root can no longer be mistaken for the
recovered message. Supplemental renderer posts and empty-terminal fallbacks now
carry deterministic client-message IDs under the execution fence as well.

### Layer 3 — platform foundation

The user decisions are locked:

- one shared Worker fleet with strict per-team Durable Object isolation;
- Worker Secrets for deployment/bootstrap configuration, through one-click
  Wrangler or the Cloudflare CLI;
- actor-bound internal knowledge tokens, operator-only external MCP, synthetic
  validation first, and live rollout permitted; and
- native typed Nanocodex Responses now, behind the existing harness boundary.

`PlatformStateDO` and `layer3-contract.ts` provide metadata-only provisioning
with external step receipts, identity/credential references, OAuth grants,
marketplace metadata, metering, memory governance/deletion receipts, and a
secret-free effect-intent ledger. A synthetic tenant completed provisioning,
idempotent reads/writes, revocation, grants, metering, memory requests, effect
leases, retries, completion, and cancellation.

The platform foundation and follow-up architecture work are merged into the
current mainline. Live effect execution is still blocked by the absence of
provider adapters, custody authentication, provider credentials, and grants.
The isolated Linear fixture exists but is not connected to the broker/effect
ledger; merged source is not treated as an external effect.

Worker Secrets are not a per-tenant OAuth/token database in a shared fleet.
Tenant DOs retain opaque references and grants; a real credential broker/effect
worker must provide tenant-scoped resolution, rotation, revocation, and audit.
Do not add a `workers_secrets` custody backend to the Layer 3 enum until those
semantics are specified and tested.

### Layer 4 — knowledge and MCP

KnowledgeDO, actor-token validation, source authorization, bounded raw query
templates, queue/ledger contracts, and Slack retrieval are source-complete.
The local knowledge milestone adds default outbound observation for every
committed Slack write, bot-message retention, reaction/membership capture,
bounded ACL refresh, durable ingress ownership, and revocable read leases.
Outbound observation now fails closed when the exact channel has no enabled
source, so durable work retries/exhausts instead of silently completing with
zero descriptors; duplicate descriptors in an enabled source remain
idempotent.
An indexed historical marker and ordinary bot routing succeeded in Slack, but
the latest human retrieval canary entered `Searching Slack` and returned
`Knowledge unavailable.`. Server-owned `all_delivered` admission
and source-type isolation are now implemented locally; live team configuration,
Slack visibility/membership, complete-history backfill, and production
readback remain open. Slack installation generations and channel lifecycle are
also now persisted locally: uninstall/token-revocation/archive/leave events
disable sources, ingestion leases, and ACL reads; reinstall activation is
explicit and does not re-enable old sources. The accurate current claim is every delivered message in
an explicitly enabled or server-materialized source, not literally every
workspace message.
No external MCP/provider canary is claimed beyond operator/admin and synthetic
paths.

### Router

The versioned heuristic classifier and `RouterMeasurementDO` are deployed in
shadow mode. Live admin summary/list data showed counterfactual Tier 1
classification with Tier 2 dispatch. Tier 1 and Tier 3 remain dark until
knowledge health, quality/fallback, cost, feedback, and rollback gates are
proven.

### Buzz

`POST /buzz/wake` is present with signer, relay-origin, tenant-directory,
authenticated fetch, event verification, dedupe, and runtime-admit plumbing.
The live endpoint now returns HTTP 400 `buzz_wake_unexpected_fields` for an
empty probe, proving configuration/schema reachability. No valid signed relay
event, authenticated fetch, or tenant-scoped admission receipt is claimed.

## Open gaps

1. Configure and read back server-owned workspace admission, then complete the
   intended channel/source backfill and publish a bounded completeness receipt.
2. Read back the installed Slack manifest and run lifecycle/reaction
   canaries, including private-channel and token-revocation distinctions, then
   complete live ACL reconciliation. Visible public-channel membership is now
   confirmed for the bot, but the local lifecycle handler is source-tested,
   production event delivery and derived-index tombstone
   readback remain unproven. The Supermemory/Graphify Workers are now deployed,
   but provider boot credentials, migration/parity evidence, a successful
   tigrisfs/R2 read-write receipt, and a current queryability receipt remain
   before indexing is healthy. The two required R2 buckets are provisioned;
   Supermemory's bucket mount is now Container-owned through tigrisfs and
   Graphify's artifact mount remains Worker-owned.
3. Deploy a tenant-scoped credential broker/effect worker before enabling Drive,
   Linear, OAuth callbacks, billing, or deletion effects; provide a controlled
   provider workspace and run happy-path, revocation, and ambiguous-failure
   tests.
4. Configure a controlled Buzz signer and relay, then prove NIP-OA admission,
   authenticated fetch, local event verification, dedupe, and tenant-scoped
   runtime admission.
5. Run live Stop quiescence/late-output suppression, HITL button persistence,
   delayed-file/attachment staging, Nanocodex checkpoint reconnect, and
   one-click installation canaries. The deployed health response now reports
   `modelConfigured: true`, but no authenticated readiness receipt or full
   model/provider provenance is recorded.
6. Keep router tiers dark until shadow quality, latency, cost, feedback, and
   rollback evidence pass an explicit rollout decision.
7. Publish immutable harness image/source/Worker provenance and run failure
   injection for Slack writes, isolate loss, Queue/DLQ replay, provider leases,
   and Buzz retries.
8. Add an external trace/metrics collector only if operations needs durable
   cross-service dashboards; structured Worker logs are the current authority.
9. Define the actual Slack completeness claim: Events API visibility and bot
   membership, supported subtypes, file-body treatment, lifecycle/revocation,
   and bounded backfill receipts are part of the contract; `all_delivered` is
   not a workspace export.
10. The normal human reaction add/remove canary is complete; still run reaction
    event refresh and membership/lifecycle canaries, decide whether structured
    distillation/burst child documents are required, and add content-governance
    and physical-purge gates for broad indexing.
 11. Implement authoritative fetch, mutation/delete, credential, retry/DLQ,
    and canary contracts for each non-Slack connector before enabling wiki,
    code, custom database, or Drive consumers. Queue/ledger identity is now
    source-typed locally and unsupported source types fail closed.
12. Replace the single deployment-wide Slack token/channel map with a
    server-owned installation-scoped credential lookup and tenant boundary
    before admitting multiple Slack workspaces to the shared fleet. The
    installation-generation fence is now present locally; credential custody,
    rotation, and cross-tenant lookup are not.
13. Use the new durable queryability receipt after each provider search
    readback. Capture a searchable/no-match/provider-unavailable receipt
    against the current content revision, local document, and index generation;
    never infer searchability from an `indexed` poll outcome alone.

## QM/Centaur/Buzz/Nanocodex guidance

Adapt portable contracts from the backfill reports: durable leases and
heartbeats, capability profiles, serviceability checks, typed tool provenance,
server-resolved tenancy, source/result authorization, replay, audit, and
terminal delivery evidence. Keep OpenTag's Cloudflare/Slack spine. Do not copy
QM's Node/Postgres/Fly/AWS platform, Centaur's Kubernetes/Rails/Postgres
control plane, Buzz's Nostr/media/workflow product surfaces, or Nanocodex's
native subscription-auth/VM/branching surfaces without a separate product
decision.

The complete-history source reports remain under
`goal-outputs/multi-repo-parent-sync-architecture-backfill/`. Historical
“not implemented” claims are point-in-time evidence; use
`CURRENT-STATE-RECONCILIATION.md` and `docs/current-state.md` for current truth.

## Safe validation

```bash
cd edge
npm run typecheck
npm test -- --run test/platform-state-do.test.ts
npm test -- --run test/response-routing.test.ts test/pre-admit-turn.test.ts test/cloudflare-slack-adapter.test.ts test/slack-stream.test.ts
npm run test:e2e
npm run test:e2e:graphify
npm run validate:deploy-config
npm run check:knowledge-rollout
```

Do not print or commit secrets. Do not turn a health binding into proof of
provider authorization. For any future external effect, record the exact
tenant, provider, scope, release, receipt, and rollback evidence without
recording secret material.

## Latest continuation checkpoint — 2026-08-04 control path

The current bot deployment is `54515284-a310-4d43-9f49-1295bafc0b92`.
`/health` is HTTP 200 and the durable Slack-rate-limit binding is present. A
durable generation-fenced rate scheduler was added so Stop preempts queued
normal Slack writes, releases render attempts as definitive no-ops, and sends
the acknowledgement with control priority. The affected local suite passes
74 tests. A signed synthetic long-turn/Stop drill reached
`stop_command_received` and posted `:octagonal_sign: Stopped.`; the synthetic
thread timestamp was not a Slack-created parent, so this is control-path
evidence rather than a real Slack conversation receipt.

The current live preflight has two failures, superseding earlier notes that
listed only the missing secrets: Supermemory lacks
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, and its query instance is now
`stopped` (`healthy=0; failed=0`). Graphify is registered and healthy
(`healthy=1; failed=0`). An account administrator must create a bucket-scoped
R2 Object Read & Write token for `opentag-supermemory-state`, then run:

```bash
cd /Users/will/Documents/opentag/edge
npx wrangler secret put R2_ACCESS_KEY_ID --config workers/supermemory/wrangler.toml
npx wrangler secret put R2_SECRET_ACCESS_KEY --config workers/supermemory/wrangler.toml
```

Enter the values interactively; never paste them into this task. Afterward,
rerun `npm run check:knowledge-rollout -- --live --require-healthy-instances`
and restart/redeploy Supermemory if the instance does not recover.

The real human-authored Slack canaries at `1785822892.400989` and
`1785822949.953319` did not produce bot replies after the deployment. The
signed synthetic endpoint canary did reach the Worker, so the remaining Slack
gap is installed-app delivery/readback: a workspace administrator must
reinstall the current manifest and verify `message.channels`,
`message.groups`, reaction, lifecycle, and revocation subscriptions plus
`reactions:read` and `users.profile:read`. The live synthetic path logged a
`users.profile.get missing_scope` warning, confirming that the installed
token still lacks at least that scope.

## 2026-08-03 post-wiring rollout checkpoint

The private provider path is now present in the primary checkout and deployed:
request resolver 599dad9a-2f67-4c96-bab8-3c9a1fc3aaa6, idempotency Worker
7c224154-13c8-4f1e-b64a-83ad9d940021, provider adapter
519ab423-7f5c-4a4f-bfbb-bd410eb6035f, and effecter
ee503bb6-42ac-4c96-847c-e168caa06df3. Effecter health reports the adapter
configured for connector_effect only. The bot remains in
PLATFORM_PROVIDER_EFFECTS_MODE=disabled; no provider mutation was run.

The affected source slice passes typecheck and 78 focused tests. The live
knowledge checker now has exactly one failure: the Supermemory
R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY secrets are absent. The checker was
corrected to distinguish healthy=1, failed=0 Container applications from idle
Durable Objects whose instance_state is inactive after normal eviction. Both
query applications therefore pass the healthy-instance gate; provider
search/readback and R2 persistence are still unproven.

Still requiring an operator or external fixture: create and provision the
bucket-scoped Supermemory R2 key pair, reinstall/read back the Slack manifest,
provide a valid signed Buzz relay event and tenant map, provision the
controlled Linear subject/custody mapping, run live recovery drills, and
attest the harness source/image mapping. Railway remains read-only.

The effecter health contract was tightened after this checkpoint so binding
presence is no longer reported as provider readiness. Deployment
77fb1243-d9e6-444a-814d-e1ff5c676d35, verified with a cache-busted health
request, reports adapterConfigured:true but providerEffectsEnabled:false and
providerAdapterReady:false. This is the expected fail-closed state while
custody and the controlled workspace are absent.

## 2026-08-04 live routing canary

A human no-mention message at
https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817152734609 produced no
bot reply. An otherwise equivalent plain-language explicit mention at
https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817229507059 received a
normal reply at
https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817241480749. This is
direct evidence that mention delivery works while ordinary message-event
delivery is not yet proven in the installed Slack app. Reinstall/read back
the source manifest before claiming no-tag routing.

## 2026-08-04 harness and Buzz evidence

The native Nanocodex Slack canary
https://berendo.slack.com/archives/C0BA1MKPRE3/p1785817326689779 completed
and identified the NanoCodex adapter. A harmless long-running Stop test was
quarantined by the harness security screen before execution, so no recovery
claim is made. The live Buzz empty request reaches schema validation with
HTTP 400 buzz_wake_unexpected_fields; authenticated signed relay admission
and tenant-scoped retry receipts remain unproven.

## Latest continuation checkpoint — 2026-08-03 22:15 PDT

The current strict knowledge preflight has exactly one failure:
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are absent from the Supermemory
Worker. Supermemory and Graphify query applications both report
`healthy=1; failed=0`; inactive Durable Objects are normal idle eviction. The
harness provenance gate is closed for the deployed clean image, and the
private request-resolver, idempotency, provider-adapter, and effecter Workers
are deployed.

Fresh Slack controls now prove explicit, unmentioned top-level, unmentioned
threaded, passive-silence, and completed-reaction cleanup in `#general`:
`1785819895.661429`, `1785819923.155599`, `1785819948.422389`, and
`1785820063.298189`. The installed-manifest export and private/MPIM/lifecycle
coverage remain unverified. The automated no-tag Stop attempt was invalid
because the ChatGPT connector appended an attribution footer; a raw bot-token
reply was correctly ignored as bot-authored. Human-authored in-flight Stop
quiescence and late-output suppression remain open.

The controlled Linear project exists, but credential custody still has no
Secrets Store binding map or provider token. Buzz has signer, relay, and tenant
directory configuration, but no valid signed relay admission receipt. Railway
remains read-only; no cutover, shutdown, or credential removal occurred.

## Fresh rollout correction — 2026-08-03 23:17 PDT

The latest live checker has two Supermemory blockers, not a Graphify blocker:
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are absent, and the Supermemory
query instance is inactive with `healthy=0; failed=0`. Graphify is healthy at
`healthy=1; failed=0`. Local static checks pass for the pinned Graphify source,
downloaded Supermemory artifacts, deploy configuration, and 82 focused tests.

All isolated provider Workers are deployed, but the adapter intentionally
reports fail-closed until a custody-backed controlled Linear credential and
workspace subject exist. Buzz's deployed health configuration is complete;
the remaining evidence is a fresh signed event fetched from the configured
relay and admitted under the server-owned channel map.

The current bot version `54515284-a310-4d43-9f49-1295bafc0b92` successfully
received and answered a real Slack mention (`1785823907.868169` →
`1785823916.194899`). A real unmentioned threaded follow-up and both
unmentioned and mentioned threaded Stop attempts did not produce a bot reply
(`1785824162.624719`, `1785823961.282869`, `1785824017.302689`,
`1785824070.799199`, `1785824111.475349`). Treat the current Slack gate as
stale/incomplete general `message.*` event delivery until a workspace admin
reinstalls the current manifest and the installed scopes/subscriptions are
read back. Do not use the successful mention as proof of no-tag Stop behavior.

## 2026-08-03 23:27 PDT authoritative preflight

The latest strict live knowledge check has exactly two failures. Supermemory
has no `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` Worker secrets and its
query instance is stopped (`active=0; healthy=0; failed=0`). Graphify is
healthy (`healthy=1; failed=0`); its inactive Durable Object state is normal
idle eviction. The clean harness deployment's source/image provenance is
live-verified, so harness provenance is not a current blocker.

The Wrangler OAuth identity has account-read but no R2 token-creation
permission. An account administrator must create the bucket-scoped R2 Object
Read & Write token for `opentag-supermemory-state` and enter its values only
through the interactive secret workflow. Provider support Workers are
deployed but fail closed pending a controlled Linear workspace and custody
mapping. Slack manifest readback, signed Buzz admission, and live recovery
drills remain open; Railway stays read-only.

## 2026-08-03 23:32 PDT Worker source redeploy

The current Supermemory Worker source is deployed as
`d85b3a1a-2e59-4619-a96f-6eae3a2ffc86`; the current Graphify Worker source is
deployed as `c5daebda-056e-49dc-9f1f-add24b0001c6`. Both deployments used
`--containers-rollout=none` because Docker is unavailable, so no Container
image was replaced. The strict check still fails only on the missing
Supermemory R2 secret pair and the stopped Supermemory query instance.

## 2026-08-03 23:37 PDT Container rollout readback

Docker Desktop's installed CLI path is usable. The current Supermemory image
built with the pinned server/tigrisfs contract and produced no remote
Container change because the image was already present. The current Graphify
query/builder image was built and applied; after startup Graphify passed the
strict health gate. A read-only code-graph Slack canary
`1785825331.979619` received no thread reply, leaving live facade/citation
evidence open while not indicating a Graphify Container failure. The only
current knowledge failures remain the missing Supermemory R2 secret pair and
the stopped Supermemory query instance.

## 2026-08-03 23:43 PDT Slack delivery diagnosis

Current explicit code-graph mention `1785825654.491479` and plain `2 + 2`
mention `1785825745.790249` received no replies. A live tail of bot version
`54515284-a310-4d43-9f49-1295bafc0b92` emitted no `turn_*` or
`slack_message_routed` event for either message, narrowing the issue to
installed Slack Event API delivery or manifest state rather than Graphify.
The tail separately showed `knowledge_http_503` retries from missing
Supermemory R2 credentials.

## 2026-08-03 23:49 PDT provider readiness correction

Read-only Linear discovery confirmed the isolated empty project
`OpenTag E2E Provider Smoke - 2026-08-02`
(`1e98bfb6-27d1-46d8-879c-7975107e7005`) in the Berendo team. The provider
adapter now probes credential-broker readiness before advertising effects.
The controlled subject `workspace:controlled-linear-test` is configured and
adapter version `c2a57312-9e93-4d9e-a90a-7ee0bae0b295` is deployed. Effecter
health correctly remains fail-closed with `providerEffectsEnabled=false` and
`providerAdapterReady=false` until custody has a mapped provider credential.
The focused provider slice passes 9 tests.

## 2026-08-03 23:55 PDT external-gate ownership check

The focused provider, support-worker, and deploy-script tests pass (16 tests
across 3 files), and `git diff --check` passes. The strict live knowledge
preflight still has exactly two failures: the Supermemory Worker lacks
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and its query instance returns
to `stopped` with `active=0; healthy=0; failed=0` because the R2/FUSE bootstrap
cannot complete. Graphify remains healthy (`healthy=1`); its inactive state is
normal idle eviction. This is an external credential gate, not a missing
Supermemory source or image change.

The deployed effecter correctly remains fail-closed until credential custody
has an approved Secrets Store mapping and controlled Linear provider
credential. Slack manifest reinstall/readback and a fresh signed Buzz event
are also operator/workspace gates. Harness provenance is verified and is not
currently blocking the rollout. Railway remains read-only.

## 2026-08-03 23:58 PDT Buzz configuration readback

The deployed bot health endpoint reports the Buzz signer, relay,
independent-origin allowlist, tenant directory, and wake bindings as present.
An empty unauthenticated `POST /buzz/wake` returns HTTP 400
`buzz_wake_unexpected_fields`, proving route/schema reachability only. A valid
signed canonical relay event and tenant-scoped admission receipt remain open.

## 2026-08-04 00:01 PDT source-gate verification

Typecheck passes and the full edge suite passes 148 test files / 1,414 tests.
The shared Slack rate-limit test double was updated to model the production
Durable Object `commit` method. No local source test blocker remains. The
rollout still awaits the external R2 secret pair, Slack manifest reinstall and
readback, a signed Buzz admission event, and custody-backed Linear credentials.

## 2026-08-04 00:04 PDT Slack model-quota readback

Fresh Slack history confirms explicit mention delivery reaches the deployed
bot, but the code-graph turn ended with `You have no credits remaining` from
the OpenAI-backed agent runtime. The runtime health endpoint is reachable and
the Worker has an `OPENAI_API_KEY` secret binding; that does not prove usable
provider quota. An unmentioned follow-up remains unanswered, so Slack
manifest/event readback is still a separate gate. Do not run more canaries
until model quota is restored.

## 2026-08-04 00:11 PDT bot deployment correction

The bot error-boundary change was redeployed with the safe wrapper and the
immutable `SUPERMEMORY_INDEX_GENERATION=cloudflare-r2-v1` var. Final version
`f06b9456-c817-4f08-af83-cdced1b2029a` passes a cache-busted health readback
with `indexGenerationConfigured:true`; the intermediate deployment without
the var is superseded. No live canary was sent during the transient mismatch.

## 2026-08-04 00:10 PDT bot error-boundary deployment

The Slack adapter now redacts provider quota/credential details from
user-visible `RUN_ERROR` notices, including billing URLs. Focused tests,
typecheck, and the full edge suite pass (148 files / 1,415 tests). Bot Worker
version `abe6b775-7b11-48d3-9b0a-1db193fd07ac` is deployed. This is a failure
surface hardening change only; live model canaries remain paused until quota
is restored.

## 2026-08-04 20:46 PDT provider and R2 credential checkpoint

The local `.env` has a `DEEPSEEK_API_KEY` and no Supermemory R2 access-key
pair. The DeepSeek key is now present as the `opentag-agent` Worker Secret
`DEEPSEEK_API_KEY`; the existing OpenAI secret remains for explicit rollback.
The agent source and Worker config select DeepSeek V4 Flash at
`https://api.deepseek.com/`, with the key forwarded only into the agent
Container. Local typecheck, focused provider tests, and direct DeepSeek text
and function-tool Responses probes pass.

The agent image has not been rolled out. Wrangler's `--containers-rollout=none`
configuration dry-run passes, but the normal image build cannot start because
Docker's content store reports I/O errors. Do not claim the live agent is on
DeepSeek until the Container image is rebuilt and a live canary confirms the
model/provider receipt. A Worker-only deployment would leave the old runtime
image in place and is not an acceptable substitute.

Supermemory still requires an account administrator to create a bucket-scoped
R2 Object Read & Write token for `opentag-supermemory-state` and enter its
one-time Access Key ID and Secret Access Key through the write-only Wrangler
commands in the operations runbook. The local `.env` has neither value, and
no unrelated credential may be repurposed. After those secrets exist, rerun
the strict knowledge check, rebuild/restart Supermemory, and prove mount,
add/poll/search, update/delete/tombstone, and restart-recovery receipts.
