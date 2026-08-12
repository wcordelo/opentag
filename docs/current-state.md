# OpenTag current implementation and rollout status

Status: **current reconciliation record plus local validation addendum**

Updated: **2026-08-05 14:52 PDT**

This document is the evidence index for the merged connector/platform/router
work and the live rollout performed on 2026-08-01. It reconciles the older
backfill reports and design specs without rewriting their historical evidence.
When a historical report says that a feature was not implemented, read that
statement as true at its recorded review point and use this document for the
current status. The latest rollout addendum below is authoritative for the
current deployed checkpoint; older sections retain their original timestamps.

## Authoritative rollout checkpoint — 2026-08-05 14:52 PDT

Docker Desktop was repaired by resetting the local Docker data directory and
restarting Docker. The Docker daemon now reports version `28.0.1` on `aarch64`,
and the required `linux/amd64` image builds complete again. The reset was local
and recoverable; it did not change Railway or delete any Cloudflare resource.

The Supermemory R2 repair is now deployed. The `opentag-supermemory` Worker is
at version `77bfc140-d149-4399-9f7f-dbe283628f38`; its singleton Container is
running version 32 on the pinned tigrisfs image
`sha256:c84bce9f6119e1946fc1bce799308fd61aea7c978b870d4b98aea72758355614`.
The R2 access-key pair is provisioned as Cloudflare Worker Secrets on the
Supermemory Worker and is passed only into the Container. A temporary isolated
R2 staging bucket was mounted through the full tigrisfs/FUSE image, passed the
read/write probe and Supermemory search probe, and was deleted after the test.

Authenticated `GET /ready?profile=knowledge` on `opentag-bot` now returns HTTP
200 with no blockers. The response reports true for
`knowledgeSearchReachable`, `codeGraphReachable`, `knowledgeReconciliation`,
`knowledgeActorToken`, and `knowledgeConsumerActive`; the dependency probes
for the agent, Supermemory, and Graphify paths all pass. The live rollout
checker passes when it requires active/running instances. Its stricter
control-plane health mode still reports Supermemory and Graphify as
`active=1, healthy=0, failed=0`, even though their instances are running and
the authenticated bot readiness and internal Graphify health probes pass. This
is an unresolved Cloudflare health-aggregate discrepancy, not evidence that
the query services are unreachable; do not mark the strict gate green until
the control-plane signal is explained or the checker is changed with a
documented acceptance rule.

The current harness Worker/image was rebuilt with Docker and deployed as
Worker version `d34621fd-4bae-49f3-8b5f-874e45d87324`; Container version 8 uses
image `sha256:2128a07f6693be5bbb2bd765be368dd6f56617a3ba0af955205d0a3ded0395ff`
and reports seven healthy instances. This direct rollout used the current
dirty checkout, so it proves runtime deployment and health but does not close
the clean source-to-image provenance gate. The deployed agent also passed a
direct DeepSeek AG-UI canary with `RUN_STARTED`, streamed output, and
`RUN_FINISHED`. A fresh canary sent to the actual OpenTag bot
(`U0BAK4AJ2Q1`) is present in `#general` but has no reply, and the current
Worker tail shows no corresponding `/slack/events` invocation. The earlier
`SANDBOX_BACKEND=local requires a running Docker daemon` reply came from the
separate QM bot, not OpenTag. This separates the Cloudflare runtime from the
remaining Slack installation/event-subscription gate. Slack manifest
export/reinstall and installed request-URL, scope, and event readback remain
open.

The controlled provider path is live: the isolated Linear canary completed
through custody, broker, authorization, PlatformState, effecter, adapter, and
Linear, producing `BER-11` with one attempt and a durable completion receipt.
Replaying the completed effect is correctly rejected as non-claimable, but a
read-back endpoint that returns the existing durable receipt for a replay has
not yet been implemented.

The bot was redeployed at version `617b73ca-2114-4723-a819-2086100fa10e`
with operator-search convergence receipt wiring. Its authenticated MCP search
path reaches Supermemory and returns valid bounded responses, but the current
R2-backed corpus returns zero compliant citations for the recent canary
markers. The tenant status readback is 88 ledger rows: 55 `indexed`, 2
`pending`, and 31 `permanent_failure`; all 55 queryability receipts remain
`unverified`, with zero `searchable` receipts. A bounded reconciliation pass
scanned all 88 rows and skipped them because no eligible retryable descriptor
was present. This is now a provider-data/replay convergence gap, not an R2
credential or container-reachability gap.

Buzz configuration is present, and a fresh local Buzz event was published to
the unbound `general` channel. OpenTag rejected its wake with HTTP 400
`buzz_wake_unbound_channel`, confirming the server-owned tenant directory is
enforced. The configured pilot channel has no readable members for the local
signer, so no valid signed event from that channel has yet completed fetch,
verification, tenant admission, dedupe, and reply. That gate requires a
configured signer/member to publish a fresh pilot event.

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
`sourceTree`. These are read-only source/deployment checks; no deployment,
restart, secret change, migration cutover, or other external mutation occurred.

## One-click R2 secret-path repair and live preflight — 2026-08-02 23:25 PDT

The local one-click deploy path now requires and provisions the Supermemory
R2 pair through `OPENTAG_SECRET_SUPERMEMORY_R2_ACCESS_KEY_ID` and
`OPENTAG_SECRET_SUPERMEMORY_R2_SECRET_ACCESS_KEY`; the Worker still maps the
values only into Container `envVars`. Focused deployment tests, the full edge
suite (146 files / 1,389 tests), typecheck, shell syntax, downloaded
Supermemory/tigrisfs artifact verification, static rollout checks, and
`git diff --check` pass.

The fresh read-only live preflight now fails one explicit gate because the
deployed Supermemory Worker has no `R2_ACCESS_KEY_ID` or
`R2_SECRET_ACCESS_KEY` secret names. No secret was supplied or changed. The
deployed bundle remains the legacy mount implementation and the query
Containers remain unready, so local source validation is not live provider or
FUSE evidence.

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
`U0BAK4AJ2Q1`, and app `A0BA1NHQD8F`. A read-only all-type conversation list
returned six conversations: four public channels where the bot is a member,
two IMs where it is not a member, and no private channels or MPIMs visible to
this installation. `conversations.members` succeeds for the public-channel
membership readback.

The same token returns `missing_scope` for `reactions.get`,
`users.profile.get`, and `apps.manifest.export`. The local source manifest is
therefore not installed-token evidence: reaction event delivery, profile
enrichment, private/MPIM visibility, and manifest readback remain open. No
Slack message, reaction, or installation state was mutated.

## Fresh strict live preflight — 2026-08-02 23:34 PDT

The read-only knowledge rollout check is unchanged: all static, R2, deployment,
registration, pin, artifact, and Graphify secret-name checks pass. Exactly three
live gates fail: Supermemory is missing `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY`, and the Supermemory and Graphify query instances each
report `active=1, healthy=0, failed=0`. No deployment, restart, secret change,
Queue mutation, provider action, or Slack state mutation was performed.

## Goal blocked on external gates — 2026-08-02 23:36 PDT

The local source and test milestone is complete, but the validation goal cannot
reach its live end state under the current no-mutation handoff. The same
blocking condition recurred across three consecutive goal audits. Resumption
requires explicit current authorization and the missing external inputs:
Supermemory R2 secrets plus pinned Worker/Container deployment, Slack manifest
reinstallation with reaction/profile coverage, a valid Buzz signer and relay,
an approved custody/provider adapter bound to the isolated test workspace, live
Queue/isolate/recovery drills, and clean harness provenance deployment/readback.
No external mutation was performed.

## Integrated synthetic admission and provider-effect recheck — 2026-08-02 23:01 PDT

The assembled Buzz binding path now has a synthetic end-to-end receipt in
`edge/test/buzz-nip98-fetcher.test.ts`: a fake relay verifies the NIP-98
authorization, returns a cryptographically signed kind-9 event, and accepts
the signed fixed reply. OpenTag locally verifies the event, resolves the
server-owned channel-to-tenant binding, writes the SQLite-backed admission and
reply records, and suppresses the replay without another relay request. This
is source and synthetic-relay evidence; no live Buzz event was admitted.

The platform effect runner now has a synthetic tenant provider recovery proof
in `edge/test/platform-effect-runner.test.ts`. It exercises the reviewed
connector-effect envelope, opaque credential-reference lookup, an ambiguous
provider failure, retry with the same idempotency key and receipt, and
post-completion rerun rejection. The provider token is absent from adapter
envelopes and durable effect reports. This does not configure a real provider
adapter, custody mapping, or external workspace.

The full local regression passes 146 unit files / 1,387 tests, 8 bot Worker e2e
files / 70 tests, Graphify e2e (5 tests), Graphify policy (10 tests),
typecheck, deploy-config validation, static rollout checks, downloaded
Supermemory/tigrisfs artifact verification, and `git diff --check`. The
read-only live rollout check passes resource/configuration/registration checks
when health is not required. The health-gated read-only check still reports
both query Containers as `active=1, healthy=0, failed=0`; FUSE/provider
readiness remains unproven. Secret-name readback shows no Supermemory R2
access-key pair and no platform provider-adapter binding/auth secret. No
deployment or other external mutation occurred.

## Broker/custody integration recheck — 2026-08-02 23:09 PDT

The local broker test now wires the real credential broker and custody Worker
apps together through a service binding. The request is revalidated against
tenant metadata and the versioned custody binding before the secret is read;
the opaque token appears only in the final broker response. The focused broker
and custody slice passes 2 files / 19 tests, with no provider token in the
service-bound request bodies.

This is synthetic local boundary evidence. It does not provision a live
Secrets Store mapping, provider grant, effecter adapter, or external provider
workspace, and it does not close the live effect gate.

## Post-integration regression recheck — 2026-08-02 23:11 PDT

The broker/custody integration slice passes 2 files / 19 tests, and the fresh
full edge suite passes 146 files / 1,387 tests. Typecheck and `git diff --check`
also pass; the only test output is the known nonfatal missing-Graphify-sourcemap
warning. No deployment or external mutation was performed.

## Deployed Supermemory source mismatch recheck — 2026-08-02 23:12 PDT

Cloudflare code readback for the deployed `opentag-supermemory` Worker still
contains the legacy `mountBucket("STATE_BUCKET", ...)` / `s3fsOptions` path and
`unmountBucket()` cleanup. Its bundled `supermemoryContainerEnv` does not carry
the local R2 credential-to-Container mapping. The local checkout is different:
it pins and verifies tigrisfs v1.2.1, starts the mount from the entrypoint,
fences readiness on real mount/read-write/provider checks, and has no active
`mountBucket` or `unmountBucket` calls.

The local Supermemory image and source checks therefore do not attest the
deployed service. This mismatch is the direct reason the health and FUSE gates
remain open; no deployment, restart, secret change, or migration cutover was
performed.

## Local harness provenance build — 2026-08-02 23:02 PDT

The current harness image builds successfully for `linux/amd64`. Its OCI
labels match the generated local provenance manifest exactly: revision
`d075431f25f886842aec5552314afea9d1c9c1dd`, source tree
`7a3f874822d0f785f56b1ec66142523b384e1ff0`, source digest
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`,
and source state `dirty`. The local image is
`opentag-harness-provenance-test@sha256:ff5e8470c750ed84e4e81f4a01376b3e54abf85910d261365915bf42163ce75e`.

The deployed harness remains a separate open gate: its read-back bundle still
lacks `/health/container`, `sourceDigest`, and `sourceRevision`, so the live
image cannot be matched to this local build.

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
this readback was read-only.

## Slack manifest readback contract — 2026-08-02 22:25 PDT

The source now defines a strict, secret-free Slack manifest readback contract
in `edge/src/slack/installation-contract.ts`. It canonicalizes bot scopes and
event subscriptions, computes missing required capabilities, rejects duplicate
or extra receipt fields, extracts only the bot capabilities from a Slack app
manifest response, and produces a SHA-256 manifest receipt without accepting
tokens or raw manifest payloads. The manifest regression now checks the YAML
against the same required scope/event constants used by the readback contract.

The source now persists one validated receipt per Slack installation generation
in WorkspaceConfigDO, rejects stale or mismatched generations, and exposes
admin recording and readback routes that resolve the active generation rather
than trusting caller input. The focused contract/config/manifest tests pass,
and typecheck passes. Manifest digests cover capability content rather than
observation time, so repeated polls retain one capability revision while
freshness remains explicit metadata. The focused contract/manifest slice passes
7 tests and the WorkspaceConfigDO generation suite passes 10 tests. This closes
the local measurement and durable-fence contract only. The live
installed-manifest export, installed-token scope readback, and complete
workspace/history visibility remain open; source YAML or local receipts must
not be reported as live installation coverage.

## Stable local and live recheck — 2026-08-02 22:46 PDT

The stable checkout passes the full edge unit suite (146 files / 1,384 tests),
bot Worker e2e (8 files / 70 tests), Graphify e2e (5 tests), Graphify policy
tests (10 tests), typecheck, deploy-config validation, shell syntax,
Supermemory/tigrisfs artifact verification, and static rollout assertions. The
Supermemory boundary timeout test now synchronizes fake time with the mocked
container request, so the fail-closed timeout path is deterministic.

The strict read-only live rollout check passes every static, bucket, deployment,
secret-name, and artifact assertion but still fails the two query health
aggregates: Supermemory and Graphify each report `active=1, healthy=0,
failed=0`. No deployment, restart, secret change, Queue mutation, provider
effect, commit, push, or PR was performed during this recheck.

## External read-only evidence refresh — 2026-08-02 22:52 PDT

Connected Slack readback confirms bot `U0BAK4AJ2Q1` in `#general` and `#skills`,
the reaction lifecycle thread ended with
`OPENTAG_REACTION_LIFECYCLE_OK`, and the canary parent has no residual
reactions. This connector exposes only those two channels, so it does not
expand the existing four-visible-channel membership claim.

Cloudflare code readback of deployed `opentag-harness` returns the old bundle:
the worker exposes only the basic `/health` response and contains no
`/health/container`, `sourceDigest`, or `sourceRevision` contract. The
container inventory's image digest is therefore not source-attested. This is
read-only evidence; no deployment or external mutation was performed.

## Local Supermemory image build — 2026-08-02 22:55 PDT

Docker Desktop became reachable after the earlier validation checkpoint. The
approved `linux/amd64` build completed successfully and verified the pinned
Supermemory server and tigrisfs `v1.2.1` archive checksums. The local image is
`opentag-supermemory-tigrisfs-test@sha256:191ae1f738a78a4b93ffbd5a622e7720ab175b5f7f27082edb70b86976a69aaf`.

This is local image evidence only. R2/FUSE mount and remount persistence,
restart recovery, provider add/poll/search, and deployed source/image matching
remain open because the image was not run with production credentials and no
deployment was performed.

## Full regression rerun — 2026-08-02 22:26 PDT

The current checkout passes 146 edge unit files / 1,384 tests, 8 bot Worker
e2e files / 70 tests, Graphify e2e (5 tests), Graphify policy (10 tests),
typecheck, deploy-config validation, source-pinned rollout checks,
Supermemory/tigrisfs artifact verification, and `git diff --check`. The
additional four unit tests are the Slack manifest coverage contract. These
results are local source evidence only; the deployed Supermemory bundle still
reads back as the legacy `mountBucket` implementation, while the live
Supermemory and Graphify query Containers each remain `active=1,
assigned=0, healthy=0, failed=0`.

The production Slack write-path audit found no runtime `knowledgeIndex: false`
call. Normal posts, updates, placeholders, progress, stop acknowledgements,
and paged answers use the observer-backed Web API client; durable render
recovery observes the committed timestamp after exact client-message
reconciliation. The only explicit suppression is a unit-test fixture for
deliberately transient output. This proves the local bot-write default, not
provider queryability or workspace-wide inbound coverage.

## Local source and regression recheck — 2026-08-02 22:15 PDT

The local Supermemory implementation now uses the approved pinned tigrisfs
Container mount. The Dockerfile pins `v1.2.1` and verifies the required
Linux/amd64 archive checksum. The entrypoint requires AWS S3-compatible R2
credentials plus account and bucket identifiers, starts tigrisfs, waits for a
real mount, verifies an unprivileged read/write probe, and only then writes the
R2-ready sentinel. The Worker maps R2 secrets into Container `envVars`, keeps
them out of the bot binding and Supermemory child environment, and observes the
sentinel/mount/read-write fence without calling the Sandbox SDK bucket mount.
The prior credential-less Sandbox SDK description remains historical below.

The ledger now has a second durable queryability contract. Provider
`documents.get(...)=done` continues to mean `indexed` ingestion completion;
the new body-free receipt is revision/document/generation fenced and records
`unverified`, `searchable`, `no_match`, or `provider_unavailable` only after a
separate bounded search readback. Internal KnowledgeDO receipt/read routes and
status aggregates are covered by local tests.

Fresh validation passes: 145 edge unit files / 1,379 tests, 8 bot Worker e2e
files / 69 tests, Graphify e2e (5 tests), Graphify policy (10 tests), focused
Supermemory/checker tests, typecheck, deploy-config validation, source-pinned
rollout preflight, shell syntax, `git diff --check`, and downloaded
Supermemory/tigrisfs artifact verification. The configured non-secret
Cloudflare account identifier passes the 32-character guard and Supermemory
dry-run deployment validation passes. Docker has a client but no reachable
daemon, so image build/FUSE and remount/restart persistence remain open. The
strict read-only live check passes every static/resource assertion and fails
only the Supermemory and Graphify query health aggregates
(`active=1`, `healthy=0`).

No path-bound legacy editor kernel is present. The remaining Wrangler tail
processes are generic read-only log readers and were not terminated. No
deployment, secret, Queue, provider, credential-removal, commit, push, PR, or
external-publication action was taken in this checkpoint.

The live `opentag-supermemory` Worker source was read back separately after
this local validation. Its deployed bundle still contains the legacy
Sandbox-owned `mountBucket` lifecycle and the failure string `Supermemory R2
binding mount is not ready`; it does not contain the current local
`Supermemory tigrisfs mount is not ready` source path. This is a source-to-live
divergence, not evidence that the upgraded tigrisfs image is healthy. The
current local source remains the release candidate, while the deployed Worker
is a stale legacy revision until an explicitly approved redeploy occurs.

The knowledge-service deploy script now refuses a real deployment when its
tracked inputs have both staged and working-tree changes (or are untracked).
Running that guard against this checkout exits before invoking Wrangler and
lists the affected Supermemory files.

The one-click deployment flow now performs the analogous clean-input check for
the harness before any secret or deployment operation. A local failure
injection also proves that the Supermemory entrypoint exits before provider
start when the R2/FUSE credential contract is incomplete. These are local
failure gates; they do not attest the already deployed harness image or live
Supermemory Container.

The full current edge suite now passes 145 files / 1,379 tests. Typecheck,
source-pinned rollout preflight, downloaded Supermemory/tigrisfs verification,
and diff checks also pass. A fresh read-only deployed-source check still finds
the legacy Supermemory `mountBucket` bundle, so the live Worker remains stale.

Fresh read-only Container info reports harness version 4 with 7 healthy
instances and image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
The Supermemory singleton is version 18 with `active=1`, `assigned=0`,
`healthy=0`, `failed=0` and image
`sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.
Graphify query is version 6 with the same zero-healthy aggregate and image
`sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.

Read-only Slack confirmation at 22:17 PDT found exact terminal replies for
the explicit and bot-message markers. Reaction readback for the lifecycle
marker returned no reactions after completion, and tested-channel membership
includes bot `U0BAK4AJ2Q1`. This confirms the canary behavior only; installed
reaction/profile scopes and broader Slack completeness remain unproven.

## Live Slack completeness and reaction readback — 2026-08-02 22:08 PDT

The source manifest regression passes 2 tests and asserts the required Slack
history/read, reaction, profile, team, and channel-join scopes. It retains
reaction, membership, installation-revocation, and channel lifecycle event
subscriptions. Authenticated membership readback confirms bot
`U0BAK4AJ2Q1` in the four visible public channels: `#general`,
`#new-channel`, `#social`, and `#skills`.

The human explicit canary
[`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
returned `OPENTAG_MILESTONE_EXPLICIT_OK` at `1785728831.600039`. The
bot-message event canary
[`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
returned `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`; the live
tail recorded the channel-message route and an `indexed` queue outcome. The
reaction lifecycle canary
[`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
showed the working `eyes` reaction while running, returned
`OPENTAG_REACTION_LIFECYCLE_OK` at `1785729227.808039`, and had no reaction
after the terminal reply.

This closes the live Slack response/reaction behavior sub-gate. It does not
close installed-token scope readback, workspace-wide/private/MPIM visibility,
complete-history backfill, or KnowledgeDO/derived-index queryability. The
strict rollout checker still fails only the Supermemory and Graphify query
Container health aggregates. Local harness provenance remains dirty at
`sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa`,
while the deployed image is
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`;
Docker/FUSE build and source-to-image attestation remain open.

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

## Durable convergence and provider-effect contract follow-up — 2026-08-02 21:38 PDT

The knowledge ledger now keeps provider ingestion completion separate from
retrieval convergence. `knowledge_query_convergence` stores only bounded
metadata keyed by source key, content revision, and derived-index generation:
the query digest, provider result count, matching citation count, status, and
check time. The internal `/query-convergence` route rejects stale document IDs,
stale revisions, generation mismatches, malformed digests, and a `queryable`
receipt without a matching citation. `/state` and the durable status snapshot
expose the current receipt without returning message bodies or raw queries.

`SupermemoryAdapter.searchSlackForConvergence()` returns provider-result count
alongside the already filtered citations. The existing ledger `indexed` status
still means the provider document reached `done`; only a separate receipt with
at least one exact, authorized citation may claim `queryable`. A zero-result
search is recorded as `not_found`, not silently promoted to success. No live
receipt was written in this local-only checkpoint.

The platform effect vocabulary now includes a narrow `connector_effect`
envelope for the next adapter slice. It accepts only a connector/action pair,
opaque credential reference and version, authorization/request digests, and an
opaque durable request reference; it carries no prompt, query, content, token,
or provider payload. Linear `create_issue` and Google Drive `search` are the
first reviewed pairs. The deployed effecter remains fail-closed with no
provider adapter or custody mapping, and the existing direct Linear tool has
not been cut over to this envelope. A tenant-scoped adapter must resolve the
durable request reference, revalidate custody and grants, perform the provider
call idempotently, and return an external receipt before this path can be
enabled.

## Audit reconciliation — 2026-08-02 21:16 PDT

The latest read-only audits separate provider ingestion completion from search
convergence. Queue dispatch records ledger `indexed` after the provider
document poll reaches `done`; it does not issue a subsequent search readback.
The fresh Slack marker reached an `indexed` queue outcome but returned zero
authenticated citations for an exact operator search. The local adapter test
now covers `add -> documents.get(done) -> search` and keeps an empty search
result distinct from provider completion. Do not reinterpret `indexed` as
queryable until the raw provider search response, ledger row, and citation
filtering result are captured together. The safe architecture follow-up is a
separate durable query-convergence receipt or an explicit two-stage
ingestion/queryability contract.

Current read-only Wrangler state reports Supermemory Container version 18 with
image `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`
and Graphify query version 6 with image
`sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.
Each has one active/running instance, but each reports `assigned=0` and
`healthy=0`; the strict rollout checker therefore has two live failures.

Buzz is source-complete and locally tested across seven focused files / 93
tests plus typecheck, but the live route has only reached the schema/config
boundary (`400 buzz_wake_unexpected_fields`). The known signed wake still
fails at the relay HTTP 526 boundary, so no live signed event, authenticated
fetch, durable admission, callback, or tenant-scoped runtime receipt is
claimed.

The provider/effect audit found no registered platform effect adapter and no
default custody Secrets Store mapping. The Linear fixture is not on the
broker/effect-ledger path; real mutation, receipts, revocation, rollback,
lease recovery, and live Queue/DLQ drills remain open. Local effect/custody
tests are synthetic contract evidence only.

Fresh authenticated bot readback is knowledge-ready (`/ready?profile=knowledge`
HTTP 200) but full-ready HTTP 503 with blockers
`credentialBrokerReachable`, `platformEffecterReachable`, and `oauth`. Tenant
status is now 84 rows: 55 indexed, 2 pending, and 27 permanent failures;
outbox and tenant-local DLQ are empty. The latest reconciliation completed
after scanning 84 rows and skipping 84.

Harness version 4 has seven healthy instances and image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`,
but the local source manifest is dirty and differs from the deployed image.
Docker is unavailable, so clean source-to-image attestation and restart
durability remain open.

The post-audit local validation is green: 145 edge test files / 1,373 tests,
typecheck, and `git diff --check` pass. This is local source evidence and does
not alter any live gate.

A later-dated worktree note describes a Supermemory secret/bootstrap and
redeploy attempt after the earlier read-only sweep. This continuation did not
reproduce, reverse, or extend that action. The Wrangler readback above is the
current checkpoint evidence; no additional deployment or external mutation
was performed here.

## Final read-only gate sweep — 2026-08-02 20:59 PDT

The latest read-only sweep confirms the deployed bot is HTTP 200 and reports
configured model, Slack, knowledge, Buzz, broker, effecter, and harness
bindings. This is configuration evidence, not provider authorization or an
external-effect receipt. The harness Container info endpoint reports version
4 with seven healthy instances and deployed image
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`.
The local source manifest remains dirty and differs from that image, so clean
source-to-image provenance is still open.

The live Buzz empty-body probe returns HTTP 400
`buzz_wake_unexpected_fields`, proving schema/configuration reachability only;
there is still no valid signed relay event, authenticated fetch, or
tenant-scoped admission receipt. The fresh unmentioned canary's exact marker
still has zero authenticated knowledge citations despite a queue `indexed`
outcome. The latest tenant status readback is 83 ledger rows: 55 indexed, 2
pending, and 26 permanent failures; outbox and tenant-local DLQ are empty.

The strict rollout checker still fails only the Supermemory and Graphify query
Container health checks: each reports `active=1`, `assigned=0`, `healthy=0`,
and `failed=0`. No deployment, replay, provider mutation, Queue mutation,
credential removal, commit, push, PR, or external publication occurred.

## Local stability validation — 2026-08-02 21:06 PDT

The affected source slice passes 8 test files and 95 tests, covering response
routing, pre-admission, Slack manifest and lifecycle contracts, knowledge
scheduling/observation, Slack Web API writes, and canonical thread
normalization. Typecheck and staged/unstaged diff checks also pass. This is
local evidence only; the response-routing repair, observed-message inclusion
fence, and successful-2xx readiness correction remain deployment-gated.
The follow-up queue/normalization/Web API rerun passed 3 files and 70 tests,
including an explicit bot-message Events API indexing contract.

## Full local validation rerun — 2026-08-02 21:09 PDT

The full edge unit suite passes 145 files and 1,372 tests; the bot Worker e2e
suite passes 8 files and 67 tests. Typecheck and staged/unstaged diff checks
pass. The only test output is the known nonfatal Graphify dependency
sourcemap warning. This is local evidence and does not change the live gates.

## Local failure/recovery slice — 2026-08-02 21:10 PDT

Durable ingress, Stop/recovery, knowledge reconciliation/queue, Supermemory
boundary, harness routing, and runtime-probe tests pass: 9 files and 140
tests. These deterministic local receipts do not prove live isolate-loss,
deployed Queue/DLQ replay, provider recovery, or Container restart
durability.

## Derived-index validation — 2026-08-02 21:12 PDT

Deploy-config validation passes. Graphify Worker e2e passes 1 file / 5 tests
and Graphify policy tests pass 10 tests. Static knowledge rollout checks pass
for privacy, Supermemory single-writer policy, exact Graphify pin,
catalog/CAS/artifact rules, binding-owned R2, and authoritative Queue/DLQ
ownership. The last strict live read-only result remains the two query
Container aggregates with zero healthy instances.

## Strict live rollout recheck — 2026-08-02 21:13 PDT

The read-only rollout checker passes every static, R2, secret-name, pin,
artifact, and deployment assertion. It exits 1 only for the Supermemory query
and Graphify query Container health checks: both report
`instance_state=running; active=1; healthy=0; failed=0`. No deployment or
recovery mutation was attempted.

## Fresh read-only live reconciliation — 2026-08-02 20:41 PDT

The latest authenticated live readback was captured at 20:31 PDT and
supersedes the older tenant counts below. The knowledge readiness profile
returned HTTP 200, but full readiness remains blocked by the credential broker,
platform effecter, and OAuth gates. This proves service reachability and
configuration, not complete indexing or external-effect authorization.

The tenant status readback contained 80 ledger rows: 53 indexed, 2 pending,
and 25 permanent failures. The outbox was empty and the tenant-local DLQ
summary was zero. The separate operator Queue/DLQ endpoint contained 100
pending captured failure records. These are different durable surfaces; the
tenant summary must not be described as proof that the operator DLQ is empty.
No DLQ replay or disposal was performed.

The fresh Slack canary wrote marker message 1785725283.368069, left the
equivalent unmentioned retrieval request 1785725304.390959 silent, and
answered the explicit retrieval request 1785725373.889899 with
OPENTAG_SUPERMEMORY_SEARCH_OK at 1785725391.260059 after the visible
Searching Slack status. The old OpenTag AG-UI/model-unconfirmed and Working
surfaces were absent, and the retrieval parent had no lingering reaction.
This proves the deployed explicit search path, not workspace-wide coverage
or no-mention retrieval routing.

## Fresh Slack routing and reaction control — 2026-08-02 20:45–20:54 PDT

Two new controlled messages were posted in `#general` through the connected
Slack user surface. The explicit mention at
[`1785728816.021889`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728816021889)
received the exact reply `OPENTAG_MILESTONE_EXPLICIT_OK` at
`1785728831.600039`; the thread's terminal reaction state was empty. The
marker-shaped unmentioned message at
[`1785728708.551929`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785728708551929)
received no reply and no reaction because it was not a question or recognized
action request. A valid unmentioned deployment-status question at
[`1785729068.726309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729068726309)
received `OPENTAG_MESSAGE_EVENT_TAIL_OK` at `1785729079.363589`. The live
Worker tail recorded the `channel_message` route and a knowledge queue
outcome of `indexed`; an authenticated operator search for the exact marker
returned zero citations, so queue acceptance is not yet search convergence.
The subsequent authenticated tenant status readback is 83 ledger rows:
55 indexed, 2 pending, and 26 permanent failures, with zero pending outbox
work and an empty tenant-local DLQ summary.
Finally, the explicit reaction lifecycle control at
[`1785729211.926069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785729211926069)
showed `eyes` while the turn was running and no reaction after the final
reply. The messages were authored as the connected William user with the
Slack ChatGPT app marker, so this is a controlled live surface check, not
proof of a native Slack-client human-origin event.

Slack readback remains bounded: reactions.get, users.profile.get, and
apps.manifest.export each return missing_scope for the installed bot token.
The bot is confirmed in four visible public channels: general, new-channel,
skills, and social. Private-channel, MPIM, workspace-wide history, and
complete-history backfill remain unproven. The source manifest requesting
those scopes is not an installed-manifest receipt.

The local response router now recognizes response-directed forms such as
please reply exactly, please respond with, and answer to as action requests,
while retaining silence for please do not reply. Four focused routing and
pre-admission files pass 30 tests and typecheck. This repair is not deployed.
The live explicit reaction control did show add/remove cleanup; reaction
event refresh and installed reaction read scope remain unproven.

At that historical checkpoint, the source contract was the upgraded Cloudflare
Sandbox design: credential-less Worker-owned STATE_BUCKET mount, disposable
local model-cache overlay, and provider readiness fenced on a successful 2xx
openapi response. The current source contract is the pinned tigrisfs Container
path recorded in the latest addendum above.
The strict rollout check still fails only aggregate Container health:
Supermemory and Graphify each report active=1, assigned=0, healthy=0, and
failed=0 while their instance listings say running. The local readiness-gate
correction is not deployed.

The deployed harness image digest is
sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880.
The current local source manifest is
sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa
with workingTreeDirty=true, so source-to-image provenance is still open.
The controlled Linear fixture project exists as
1e98bfb6-27d1-46d8-879c-7975107e7005, but the OpenTag broker/effect path is
not wired to it. Buzz still has no valid signed admission receipt and its
known Worker-to-relay probe remains at HTTP 526. No deployment, provider
mutation, Queue mutation, replay, commit, push, PR, or external publication
was performed.

## Local provider-readiness correction and fresh live recheck — 2026-08-02 20:37 PDT

The local Supermemory entrypoint and Worker lifecycle now release provider
readiness only after `/v3/openapi` returns a successful `2xx` response. A
reachable but degraded application response (`4xx`/`5xx`) no longer creates the
provider-ready sentinel or makes the port gate report healthy. Focused
Supermemory boundary tests, shell syntax, typecheck, and `git diff --check`
pass.

The fresh strict read-only rollout check still passes every static/resource/
secret/pin/artifact assertion and fails only the two live Container health
checks. Supermemory Container version 18 and Graphify query version 6 each
report `active=1`, `assigned=0`, `healthy=0`, `failed=0`; the instance listing
reports `running`, which is not an assigned healthy receipt. No deployment,
provider mutation, Queue mutation, commit, push, or PR was performed.

## Local validation addendum — 2026-08-02 20:16 PDT

The local knowledge contract now binds every non-delete Slack observation to
the exact message timestamp that triggered it. Inbound messages, reaction
events, message updates, and outbound Slack writes carry `observedMessageTs`
through job creation, durable descriptor identity, and Queue dispatch. The
dispatch checks the normalized canonical thread before calling
`/message-thread/put` or the derived provider; if a complete Slack response
does not contain that exact timestamp, it records the retryable
`slack_thread_incomplete / observed_message_missing` outcome. This closes the
stale-fetch acknowledgement gap locally without weakening the authoritative
KnowledgeDO/Queue contract. Delete and reply-delete jobs retain their
body-free tombstone semantics.

The new contract is covered by valid/invalid job tests, scheduling tests for
message/reaction/outbound observations, and a dispatch regression test. The
final local pass is green: 144 unit test files / 1,370 tests, 67 bot Worker
tests, 5 Graphify Worker tests, 10 Graphify policy tests, typecheck,
deployment-config validation, Supermemory artifact verification, static/live
rollout preflights, and diff checks. No deployment or external mutation was
performed for this local-only hardening; the deployed no-tag retrieval gap and
provider durability gates remain unchanged.

## Local readiness-gate correction and live recheck — 2026-08-02 20:24 PDT

The local Supermemory port gate now treats bootstrap and application traffic
separately. Before the Worker-owned R2 mount exists, `GET /health` returns a
bootstrap `200` so the Cloudflare supervisor can reach the Worker lifecycle
hook; every non-health request returns `503`. After the R2 signal, health stays
`503` until the provider-ready sentinel exists, and only then does the gate
return `200` or proxy to Supermemory. This prevents an early provider request
from being mistaken for a successful empty response. The focused entrypoint
and rollout-checker tests, shell syntax, and typecheck pass locally.

Fresh read-only Wrangler state is Supermemory Worker version
`61370dc7-0f1b-4488-8e49-86eb18bc78f6`, Graphify Worker version
`2b087539-65c8-40c3-be69-4773af3a9315`, Supermemory Container version 18 with
image `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`,
and Graphify query image
`sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`.
Both query applications report `active=1`, `assigned=0`, `healthy=0`, and
`failed=0`; the strict live preflight therefore fails only those two health
checks. The local port-gate correction is not deployed. No authenticated
knowledge readiness recheck, provider mutation, deployment, commit, push, or
PR was performed in this pass.

Read-only R2 object metadata confirms the Supermemory `api-key` bootstrap
object exists (91 bytes; value not read) and the `opentag-code-graphs` bucket
currently has no `code-graphs/` artifact. Graphify therefore remains
configured but not backed by a live active artifact.

## Historical live reconciliation — 2026-08-02 19:45 PDT

At that historical live readback, the immediate provider-reachability incident
was closed enough for a bounded search path but the knowledge completeness
claim was still open. The deployed Supermemory Worker used the Worker-owned R2
binding plus a disposable local model-cache overlay. The current local source
has since been reconciled to the pinned tigrisfs Container contract; no legacy
rewrite process is present.

| Area | Current evidence | Remaining gap |
| --- | --- | --- |
| Supermemory provider | Authenticated knowledge readiness is HTTP 200; the singleton is running version 18 with image `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`; provider tail shows document write/poll and `/v4/search` HTTP 200 after the local model-cache overlay | Prove restart/remount persistence, update/delete/tombstone convergence, latency budget, parity against Railway, and convergence of the reopened rows |
| Knowledge readiness | `/ready?profile=knowledge` returns HTTP 200 with all knowledge and code-graph checks true; `npm run check:knowledge-rollout -- --live` passes its static/live resource checks | Readiness probes do not prove Queue execution, complete history, provider parity, or searchable coverage |
| Slack ACL freshness | Bot deployment `764a18ea-bda9-4209-bdbc-0b9cc81a6cba` runs reconciliation every five minutes with `KNOWLEDGE_SLACK_ACL_MAX_AGE_MS=600000`; the live cadence canary returned `OPENTAG_KNOWLEDGE_CADENCE_OK` | Reinstall/read back the manifest and prove reaction, membership, lifecycle, token-revocation, and private/MPIM event receipts |
| No-tag retrieval routing | The deployed bot did not answer the top-level action request at [`1785725304.390959`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725304390959); the same request with an explicit mention at [`1785725373.889899`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725373889899) returned `OPENTAG_SUPERMEMORY_SEARCH_OK` at [`1785725391.260059`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725391260059). The current checkout adds retrieval rule `t1.12` and passes local route/pre-admission tests | Deploy the local routing fix under explicit approval, then rerun the unmentioned retrieval canary and confirm passive conversation remains silent |
| Durable knowledge state | Latest status readback is 77 rows: 32 indexed, 19 leased, 2 pending, and 24 permanent failures; outbox and DLQ are empty; recovery reopened 30 `local_add` rows with 30 successful recovery receipts; latest reconciliation scanned 77 and enqueued 19 | Let the leased rows converge or expire/retry, retain the 24 intentionally bounded permanent outcomes, then complete inventory/backfill and produce a bounded completeness digest |
| Workspace admission | `all_delivered` with `defaultProjectId: workspace-default` is server-owned and live | It covers eligible installed-app delivery, not every Slack workspace message; inventory and source/project identity convergence remain open |
| Supermemory source contract at that historical deployment | Worker-owned `STATE_BUCKET` mount plus local model-cache bind overlay was source-complete and deployed; no new EIO was observed in the post-rollout tail sample | Current local source uses pinned tigrisfs; Docker/FUSE restart, remount, one-writer, redaction, and durability evidence remain open |
| Buzz receive | Bot version `764a18ea-bda9-4209-bdbc-0b9cc81a6cba` reaches the relay HTTP phase and records HTTP 526 for the known wake; canonical relay-origin secret reprovision did not change the result, while direct local relay checks return expected 401/403 authorization responses | Resolve the Worker-to-relay TLS/edge path, then prove signed fetch, tenant admission, dedupe, retry, and callback receipts |
| Harness provenance | Local manifest is `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa` with `workingTreeDirty:true`; Docker is unavailable | Read back authenticated `/health/container` provenance from a clean release image and match it to the Worker version |

The failure recovery operation was intentionally bounded. It listed safe
failure metadata without lease or provider-attempt tokens, then reopened only
the 30 old `local_add` rows under correction reference
`supermemory-v18-r2-model-cache-repair-da95429a`. Twenty-four rows remain
permanent because their recorded outcomes are `unsupported_update_contract`
(23) or Slack `thread_not_found` (1); they were not treated as recoverable
adds. Nineteen reopened rows are still leased, so a healthy provider/readiness
probe is not a row-level completion receipt.

The Buzz failure is now phase-qualified: the deployed Worker receives HTTP
526 while fetching the relay query endpoint. A local ephemeral NIP-98 request
reaches the same relay and receives HTTP 401 without auth and HTTP 403 for an
unauthorized signer. This is evidence of a relay HTTP/Worker-egress boundary
problem, not proof of valid Buzz admission.

The recovery code has since been corrected in bot version
`764a18ea-bda9-4209-bdbc-0b9cc81a6cba`. It preserves the desired revision when
reopening ambiguous adds, accepts the normalized revision for legacy rows that
already lost it, and renews an expired poll window for the same provider
document ID. Live trace evidence shows three post-fix rows reaching
`knowledge_dispatch_outcome: indexed` and `knowledge_queue_dispatch:
recorded_success`, with four earlier recovery dispatches also completing
successfully. The authoritative row counts must still be read back after the
drain; no complete-history claim is made from tail logs alone.

The live Slack/provider evidence is recorded in the
[ACL cadence canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719827818089)
and [provider receipt canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719693438309).
No Railway shutdown, migration cutover, credential removal, commit, push, or
PR was performed.

The 19:45 validation pass completed typecheck, 1,368 unit tests, 67 bot Worker
tests, 5 Graphify Worker tests, Graphify policy tests, deployment-config and
Supermemory artifact checks, both static and live rollout preflights, Graphify
pin verification, shell syntax, and staged/unstaged diff checks. Read-only
Wrangler state shows Supermemory version 18 and Graphify query/builder version
6 running with one instance each. Docker is unavailable, and the Container API
reports active instances with zero assigned/healthy aggregate counts even
though the instance listing is `running`; retain direct provider receipts as
the evidence of application reachability and keep container health/restart
evidence open.

A fresh human [marker write](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725283368069)
and [explicit-mention search](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725373889899)
returned `Searching Slack` followed by `OPENTAG_SUPERMEMORY_SEARCH_OK`; the
parent message had no lingering reaction. The matching [untagged search request](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725304390959)
received no reply on the deployed version. The local router now recognizes
leading `search`, `look up`, `lookup`, and `query` requests as retrieval/action
traffic with regression coverage, but that repair has not been deployed.

The strict read-only preflight
`npm run check:knowledge-rollout -- --live --require-healthy-instances` fails
for both query Containers because Cloudflare reports `running`, not `healthy`.
The local port-gate repair keeps non-health traffic at `503` before R2, allows
only bootstrap health before the lifecycle mount, and makes `/health` return
`200` after the provider-ready sentinel; image and Worker redeployment are
still gated.

## Historical reconciliation — 2026-08-02 17:38 PDT

The current state has three separate truth levels. The merged source and local
tests cover the routing, reaction, observer, tenancy, and recovery contracts.
The deployed bot is live for ordinary Slack routing but its knowledge search
provider is degraded. The installed Slack token is behind the source manifest,
so reaction/profile enrichment and workspace-wide coverage are not yet live
claims.

| Area | Current evidence | Remaining gap |
| --- | --- | --- |
| Slack routing and working reaction | Human explicit/no-mention/passive controls are live; current replies contain neither `OpenTag AG-UI · model unconfirmed` nor `Working…`; terminal `eyes` cleanup was observed | Read back the installed manifest and live reaction/membership/lifecycle events after reinstall; run DM/MPIM/private-channel controls |
| Slack indexing semantics | Every committed bot post/update is observed by default, including placeholders and progress; bot messages are retained with attribution but cannot trigger turns | Decide transient-history retention, then prove ledger → provider → search receipt for a fresh bot write and a human message |
| Workspace admission | Live policy reads `all_delivered` with `workspace-default` | This covers only eligible delivered events, not every workspace message; inventory/backfill and source identity convergence are absent |
| Knowledge provider | `/ready?profile=knowledge` fails `knowledgeSearchReachable`; Supermemory is assigned but unhealthy and Graphify is unassigned/unhealthy; remote `error.log` shows repeated EIO model-cache rename failures on R2/FUSE | Roll the image/Worker cache repair, prove R2 remount and add/poll/search/update/delete/tombstone receipts, then recover quarantined rows |
| Durable knowledge state | 64 ledger rows: 42 permanent and 22 retryable failures; no outbox/DLQ work; 34 completed and three running reconciliation records; no inventory/backfill completion | Provider receipt, queue execution, retry/DLQ recovery, and complete-history receipt |
| Slack app installation | Source manifest asks for `reactions:read` and `users.profile:read`; installed token has neither; bot is in four visible public channels | Reinstall/read back scopes and event delivery; establish private/MPIM visibility and bounded completeness receipt |
| Buzz | Empty wake reaches schema validation (`400 buzz_wake_unexpected_fields`) | Valid signed NIP-OA admission, relay fetch, tenant callback, dedupe/retry proof |
| External effects | Isolated Linear fixture `OpenTag E2E Provider Smoke - 2026-08-02` exists, but the custody binding map and provider adapters are absent | Broker-mediated controlled provider effect, receipt, deletion/revocation, and reconciliation |
| Harness provenance | Live image digest is known and seven instances are healthy; local source manifest is dirty and differs | Clean release build plus embedded source/image/Worker attestation |

The local Supermemory repair now allows a 90-second Worker wake, prepares a
local `/var/cache/supermemory` s3fs cache for rename-heavy model downloads, and
waits for the Worker-owned R2 mount plus application port 6768 before
releasing readiness. It passes local typecheck, focused tests, rollout checks,
and artifact verification. The Worker-side repair is deployed as
`be2128c7-2617-4acb-b378-9522252451ea` without a Container image rollout; the
live R2/FUSE EIO failure remains, so this is not a provider fix yet.

## Evidence anchors

| Evidence | Value |
| --- | --- |
| Merged OpenTag baseline | `d075431f25f886842aec5552314afea9d1c9c1dd` (`origin/main`, current fast-forwarded `main`) |
| Prior recorded deployment baseline | `498164fd2f63540b14988f028a1d97efa3f9d47d` — historical deployment evidence retained below; later merged source must not be treated as live automatically |
| Working tree | `main` with user-owned knowledge, Supermemory, Graphify, ACL, reaction, and documentation changes restored after the fast-forward; no reset or force operation was used |
| Live bot deployment inspected | `opentag-bot`, current code deployment `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`; `/health` returns HTTP 200 and the authenticated knowledge readiness probe returns HTTP 200 with all knowledge and code-graph checks true |
| Live harness deployment inspected | `opentag-harness`, Worker version `718af083-0b2d-4809-a878-7b98e7b3aef6`; the Container application reports seven healthy instances |
| Harness image | Wrangler `containers list/info` verifies deployed image `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`; the current local source manifest is `sha256:8b003407364eb9c96499e71294f7d421b5028f365d92bcea63fe6d7f1aaf6baa` with `workingTreeDirty:true`, so the digest is known but its source relationship to this checkout remains open |
| Knowledge R2 resources | `opentag-supermemory-state` and `opentag-code-graphs` are provisioned; both derived-index Workers are deployed privately. Current Container image digests are Supermemory `sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe` and Graphify `sha256:ed87ed229ec111feea1542ca3d8af1940bcd6ef6f621bed88d9fd128130c4c72`; Supermemory version 18 is running and provider tail readback shows document write/poll plus `/v4/search` HTTP 200, while Graphify artifact/query parity remains open |
| Live bot health | `agent.modelConfigured: true`, `knowledge.reconciliationConfigured: true`, `knowledge.reconciliationTriggerConfigured: true`, `credentialBroker.authConfigured: true`, `buzz.allowedRelayOriginConfigured: true`, `oauth.allowedRedirectOriginsConfigured: false`; authenticated `/ready?profile=knowledge` is now HTTP 200, while this remains configuration/probe evidence rather than Queue, signer, or external-effect proof |
| Live Buzz configuration | The new bot has the signer, relay, auth-tag, channel-map, and independent relay-allowlist bindings; `POST /buzz/wake` now rejects `{}` with HTTP 400 `buzz_wake_unexpected_fields`, proving the configuration gate is passed, but no valid signed NIP-OA admission has been run |
| Live bot source readback | Cloudflare deployment and health readback match the current release graph; explicit and no-mention human turns exercised routing, `eyes` cleanup, and the silent final surface. Knowledge convergence remains unproven |
| Fresh Slack readback | Current bot-authored marker at `1785693801.754259` was written and read back in `#general`; it proves connector write/read and bot-message feedback-loop suppression only |
| Fresh human Slack canary | Current deployment controls explicit `1785701425.622489`, no-mention `1785701448.262779`, and passive `1785701473.534779` prove current delivery/routing/reaction cleanup/silence; retrieval request `1785694376.778339` reached `Searching Slack` then returned `Knowledge unavailable.`, leaving the indexing receipt gate open |
| Live Slack bot membership | After inviting bot `U0BAK4AJ2Q1` to the three previously uncovered visible public channels, the bot-token inventory reports `is_member:true` in `#general` (`C0BA1MKPRE3`), `#new-channel` (`C0BADPYGSR3`), `#social` (`C0BAF3XC3AA`), and `#skills` (`C0BGS7FNQUE`); authenticated member readback includes the bot in all four. Installed-manifest readback and workspace-wide completeness remain open |
| Local Slack inventory/backfill continuation | `discoverAll: true` now enumerates server-visible public/private/IM/MPIM conversations, including archived records for explicit exclusion, without caller cursors; it persists a digest-bound inventory receipt in KnowledgeDO, refuses incomplete/over-limit inventories, and reuses the receipt on retry; history cursors and accumulated thread state remain restart-safe under the exact source/job identity |
| Local thread-fetch continuation | KnowledgeDO persists the next Slack cursor and accumulated page state under the exact source/job identity, resumes after retry/isolate loss, clears terminal work, and reports body-free `threadFetch` counts through the admin status surface; hard message/byte bounds remain explicit size-bound outcomes |
| Slack canary thread | [final routing and concurrency canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785630816681659) |
| Slack passive-only canary | [top-level plus untagged `yo` remained silent](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785629853529029) |
| Stale-turn cleanup thread | [pre-fix thread stopped safely](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785626165915119) |
| Cloudflare origin | `https://opentag-bot.williamlopezc.workers.dev` |

## 2026-08-02 21:25 PDT provider-startup continuation

The Supermemory Worker was redeployed through version
`91916818-d7a0-4359-b220-e9c0dc690a1d` after the credential-less R2 mount and
startup path changes. A fresh internal bootstrap API key was placed in the
private `opentag-supermemory-state` bucket, and the approved `OPENAI_API_KEY`
was uploaded only as a secret on the private Supermemory Worker. No provider
key was added to the bot, harness, or Graphify Worker.

The live `knowledge` readiness probe still did not return within 60 seconds.
Tail evidence from the current Supermemory Worker shows the request entering
`containerFetch` and then being canceled at roughly 30 seconds; it never
reaches `onStart`, the R2 mount, the port-gate release, or the Supermemory
HTTP probe. Cloudflare reports the singleton Container as active/running but
with `healthy: 0` and `assigned: 0`. Graphify has the same active/running,
zero-healthy shape. This narrows the blocker to Container provisioning/port
readiness or platform assignment below the application routing layer; it is
not evidence of a Slack routing failure.

The source was simplified to rely on the Sandbox SDK's own production
`containerFetch` timeout path rather than duplicating startup orchestration in
the subclass. `npm run typecheck`, the focused Supermemory/runtime-probe
tests, `git diff --check`, and `npm run check:knowledge-rollout -- --live`
pass. The rollout checker still correctly reports FUSE persistence, provider
parity, and cutover as unproven. The tenant status readback is 40 terminal
`permanent_failure` rows, zero pending/sending/due outbox work, zero DLQ work,
21 completed reconciliation runs that skipped all 40 terminal rows, zero
backfill/inventory receipts, and 59 durable message-to-thread mappings.

The next provider gate is a controlled Container readiness receipt: a healthy
assigned instance, successful R2 mount, server `/health`, and a fresh
add/poll/search/delete receipt. Until that exists, the existing ambiguous
ledger rows must remain quarantined; reconciliation must not silently retry
them, and the bot must continue returning a degraded knowledge result.

## 2026-08-02 13:11 PDT guarded bot deployment and live Slack controls

The guarded direct bot deployment succeeded as version
`8fd0e0bb-7167-40b5-a223-c626f701f916` with immutable generation
`cf-validation-2026-08-02`. `/health` is HTTP 200 and reports the current
native Nanocodex, observer, Buzz, harness, queue, and knowledge-generation
configuration. Authenticated `/ready?profile=knowledge` and
`/ready?profile=full` remain HTTP 503: Supermemory and Graphify service probes
are false, and the full profile additionally reports credential-broker,
platform-effecter, and OAuth blockers.

The live KnowledgeDO status after deployment is now 40
`permanent_failure` rows, no pending/sending outbox work, no DLQ work, no
backfill completion, no inventory receipt, and no recovery audit. The latest
reconciliation run scanned 40 rows and skipped all 40 terminal rows. The
current Supermemory and Graphify uploads are present, but their singleton
query containers report zero healthy instances; no provider secret/bootstrap
or derived-index receipt is claimed.

Current-version Slack controls in `#general`:

- [explicit mention](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701425622489)
  received `OPENTAG_POST_DEPLOY_EXPLICIT_OK` from `berendo`; terminal readback
  showed no lingering reaction.
- [no-mention question](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701448262779)
  received `OPENTAG_POST_DEPLOY_NO_MENTION_OK`; terminal readback showed no
  lingering reaction.
- [passive control](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701473534779)
  received no reply and no reaction.
- The [smoke-style sentence](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785701364700649)
  received no reply or reaction, demonstrating that routing still classifies
  non-question operational text as passive unless it contains a clear ask or
  mention.

Slack search found no `OpenTag AG-UI` or `Working…` messages after
2026-08-02, so the removed visible progress/model surface is not appearing in
the current deployment's completed messages. This does not prove ephemeral
transport behavior or reaction-added/removal event delivery.

The current bot code and the two private derived-index Workers are deployed.
The local source now mounts R2 through Worker bindings and no longer passes
bucket-scoped credentials to either Container. The current service uploads are
present, but both singleton query containers report zero healthy instances;
provider boot, queue convergence, and a successful search receipt remain open.
The broker/custody internal auth mismatch is corrected; custody still has no
approved Secrets Store binding map, so provider resolution remains fail-closed.
The platform effecter likewise reports no provider adapters. No secret value is
recorded here.

The new bot has a declared 15-minute reconciliation trigger and a team scope in
its deployment configuration. That proves the release graph is present, not
that Cloudflare has executed a cron run. The live WorkspaceConfigDO admission
policy is readable as `all_delivered` with `defaultProjectId:
workspace-default`, while an existing source state still reports project
`default`; policy/source identity convergence remains open. The authenticated
`/ready` route is the strict gate and returns 503 for the unavailable derived
services.

The bot marker readback proves only that the connected bot identity can write
and read `#general`. The current-version human controls prove explicit and
no-mention response routing, passive silence, terminal reaction cleanup, and
absence of the removed surface in current-day messages. The separate retrieval
canary failed with `Knowledge unavailable.`, so neither KnowledgeDO ownership
nor derived-index convergence should be inferred from Slack thread results.

## 2026-08-02 10:57 PDT validation addendum

The local tenant-isolation audit found three connector authorization call paths
that bypassed the tenant-bound Durable Object helper: the two exported
WorkspaceConfigDO authorization helpers and the broker/custody revalidation
calls. They now use `tenantStub`, and focused broker, custody, tenancy, and
workspace-config tests pass (3 files / 19 tests, plus 2 Worker files / 17
tests); `npm run typecheck` also passes. This patch is local-only in the dirty
checkout and has not been redeployed, so the live provider gate remains closed.

The source manifest contains the required reaction, membership, message, and
channel-lifecycle subscriptions and the required history/reaction scopes. Live
Slack channel inventory still reports bot membership in `#general` only among
the listed public channels; `#new-channel`, `#social`, and `#skills` are not
bot-member conversations. Therefore the source contract is complete, but the
installed-manifest readback and workspace-wide indexing claim remain open.

## 2026-08-02 11:04 PDT live addendum

The tenant-bound fix is deployed in custody version
`5efe1e39-c2c8-4220-a83f-16469aa09e7a`, broker version
`4db9e036-da62-49bb-82c8-76a94c9860c0`, and bot version
`bd19e926-b8c9-439c-a9e8-d01da0f6cbe2`. Broker health now reports
`providerResolutionEnabled:false` when custody reports
`bindingConfigConfigured:false`, eliminating the previous readiness
overstatement. The bot health response reports the immutable index generation
as configured after redeploying with `cloudflare-r2-v1`; this is configuration
evidence, not derived-index read/write proof.

The current bot-authored Slack marker at `1785693801.754259` was written and
read back in `#general` with no response, as expected for a bot message. This
proves current bot connector write/read and feedback-loop suppression only; it
does not substitute for a human inbound canary or knowledge convergence receipt.

Cloudflare secret-name readback confirms the bot and internal service auth
secrets exist, but the Supermemory Worker has only its service-auth secret and
the Graphify Worker has no R2 read-access secret names. Custody has
`CUSTODY_AUTH_TOKEN` but no live binding map. Secret-name presence is not token
validity or provider authorization; these missing binding/credential contracts
are consistent with the retrieval canary's `Knowledge unavailable.` result.

## 2026-08-02 11:11 PDT human Slack canary addendum

The authenticated Slack user can now create a real human-side canary. The
explicit-mention message at
[`1785694221.865769`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694221865769)
received `eyes` from `berendo`, then the exact reply
`OPENTAG_EXPLICIT_HUMAN_CANARY_OK`; a later reaction readback showed no
remaining reaction. The no-mention question at
[`1785694253.415069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694253415069)
received `OPENTAG_NO_MENTION_CANARY_OK` without a mention and with no lingering
reaction. The passive `yo` control at
[`1785694282.922709`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694282922709)
received no reply, no reaction, and no busy warning. These prove current
message event delivery, flexible routing, reaction add/remove, and the silent
Slack surface. They do not yet prove a KnowledgeDO/derived-index receipt for
the human messages.

## 2026-08-02 11:16 PDT knowledge retrieval canary addendum

A fresh human retrieval request at
[`1785694376.778339`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694376778339)
entered the deployed search path and produced the intermediate `Searching
Slack` status, followed by `Knowledge unavailable.` at `1785694396.357459`.
The `eyes` reaction was absent on terminal readback. This proves the current
bot can admit a human knowledge request and clean up its working reaction on
the error path, but it does not prove that the earlier marker was indexed or
searchable. The live knowledge/indexing gate is therefore currently failed or
degraded, consistent with the missing R2/provider boot credentials; it is not
a Slack delivery or routing failure.

## 2026-08-02 11:56 PDT credential-less R2 mount continuation

The local Supermemory and Graphify Worker roles now extend the current
`@cloudflare/sandbox` SDK, export its `ContainerProxy`, and mount the existing
`STATE_BUCKET`/`ARTIFACTS` bindings without R2 access keys. Supermemory holds
its application behind a port gate until the Worker-owned mount is released;
Graphify query mounts read-only and leaves the builder without bucket access.
The affected Worker typechecks, focused boundary/entrypoint tests, Graphify
policy tests, deploy-guard tests, static rollout checks, and `git diff --check`
pass locally. This is source/local evidence only until the two Workers are
redeployed and a fresh add → poll → search receipt is read back.

## 2026-08-02 16:40 PDT Supermemory storage contract reconciliation

The preceding 11:56 section is historical evidence for the earlier
Worker-owned binding-mount design; this 16:40 section is also historical and
is superseded by the 19:00/20:16 reconciliation above. At that historical
checkpoint, the checkout pinned `tigrisfs v1.2.1` and its Linux/amd64 archive
checksum, passed the non-secret R2 account/bucket identifiers and dedicated R2
key pair only into the Supermemory Container, mounted
`/var/lib/supermemory` before opening the application port gate, and strips the
storage credentials before starting the Supermemory child. The Container
lifecycle checks the entrypoint-owned mount sentinel and enforces the existing
singleton writer boundary.

The source, focused Supermemory boundary tests, full TypeScript check, static
knowledge preflight, pinned Supermemory/tigrisfs artifact verification, and
Graphify policy tests are locally validated. The current live Supermemory
deployment has not been replaced with this source: the new R2 key-pair secret
names are intentionally still a release gate, and no FUSE durability or
restart-persistence proof is claimed. Railway remains read-only during burn-in;
no cutover, shutdown, or credential removal has occurred.

## 2026-08-02 11:37 PDT Slack membership continuation

The authenticated Slack surface invited bot `U0BAK4AJ2Q1` to
`#new-channel` (`C0BADPYGSR3`), `#social` (`C0BAF3XC3AA`), and `#skills`
(`C0BGS7FNQUE`). Fresh member readback includes the bot in all three channels,
and the bot-token inventory reports `is_member:true` for all four visible
public channels, including `#general` (`C0BA1MKPRE3`). This closes the
visible-channel membership sub-gate. It does not prove installed manifest
subscription readback, private/DM/MPIM coverage, complete history backfill, or
KnowledgeDO/derived-index convergence.

## Latest local validation addendum

The following changes are source- and test-validated locally. The current bot
release and derived-index Worker graph are now deployed, but live behavior is
marked separately where an external credential, user action, or durable receipt
is still missing:

- Slack manifest coverage now includes reaction and membership event families.
- The current bot release is deployed as code version
  `8fd0e0bb-7167-40b5-a223-c626f701f916`; its liveness payload now reports the
  pinned model, reconciliation trigger, knowledge bindings, relay allowlist,
  and credential-broker auth as configured. This does not prove authenticated
  `/ready`, queue consumption, or a live Slack event round trip.
- Slack installation lifecycle coverage is source-complete locally: the
  manifest subscribes to uninstall, bot-token revocation, public/private
  channel archive/deletion/unsharing/close, unarchive/open, and bot-leave
  events; WorkspaceConfigDO persists a per-team installation generation plus
  per-channel lifecycle state; lifecycle events are fenced by
  `(team_id,event_id)`, disable indexed sources and ingestion leases, invalidate
  ACL state, and remain idempotent. User-only OAuth revocation does not revoke
  the bot installation. Reinstall activation is explicit and never
  auto-re-enables a previously disabled source. Live manifest readback and a
  new-build lifecycle canary remain open.
- Bot-authored Slack messages are retained for knowledge indexing with explicit
  attribution, including the real Slack `subtype: "bot_message"` form, while
  pre-admission rejects them as new turn triggers.
- Reaction events refresh their thread descriptor; membership events
  invalidate the durable channel ACL state and retrieval fails closed while it
  is stale. Canonical normalization now persists aggregate reaction counts in
  the content and revision, and the queue consumer sends the enriched primary
  document with reaction/distillation/burst metadata to Supermemory. Structured
  distillation artifacts and burst documents are still not separate durable
  search documents. OpenTag's own transient `eyes` add/remove is excluded from
  knowledge refreshes while user-authored `eyes` remains an engagement signal;
  the new-build live add/remove proof remains open. Reaction payloads without a
  parent, nested `message_replied`/`message_changed` parents, and
  `message_deleted` events carrying only `deleted_ts` now resolve through a
  body-free durable message-to-thread map; unresolved identities fail closed
  instead of guessing a root.
- Ordinary human agent turns add an `eyes` reaction before work and remove it
  during outer lifecycle cleanup. Explicit reaction requests and trivial
  acknowledgements are exempt so a requested reaction is not removed. A
  delayed durable cleanup lease remains to remove the reaction after isolate
  loss or an ambiguous turn.
- Every eligible human Slack message is classified before response admission,
  including top-level channel messages and group DMs. Clear intent may enter
  the turn lifecycle without a mention; conversational noise is observed and
  does not wake the agent. Bot-only messages remain indexed with attribution
  but cannot create a response turn.
- The visible `OpenTag AG-UI · model unconfirmed` and `Working…` strings were
  removed from the Slack progress/recovery renderer. The normal turn lifecycle
  also no longer publishes Slack's `Thinking…` assistant status; it retains
  idempotent empty-status cleanup for stale statuses left by older builds or
  interrupted turns. Final session context now contains only the optional
  session-events link and no runtime/model label.
- All production Slack write paths now use the outbound knowledge observer by
  default, including placeholders and progress writes. Local metadata is
  stripped from the Slack request, the tenant is derived from the execution
  fence, and only an explicit internal `knowledgeIndex: false` suppresses
  observation. Equal-millisecond post/final-update observations are ordered
  deterministically, and changed `chat.update` bodies receive distinct
  idempotent observation identities so later content cannot be hidden behind
  an earlier completed update job. The observer still refetches the current
  thread, so this is current-state convergence rather than historical retention
  of every transient streaming revision. Supplemental renderer posts and the
  empty-terminal fallback now also receive deterministic client message IDs
  under the execution fence, so ambiguous retries do not create avoidable
  duplicate messages. In production, indexed posts and updates fail before
  network dispatch when no durable observer is bound; alarm recovery uses an
  exact client-message lookup instead of substituting a thread root.
- Outbound observation now fails closed when the exact channel has no enabled
  knowledge source: the durable job retries and eventually exposes exhaustion
  instead of treating zero descriptors as successful indexing. A new
  server-owned WorkspaceConfigDO admission policy supports an `all_delivered`
  mode that materializes a default project/reader/retention source for every
  Slack event delivered to the installed app; explicit disabled rows remain
  opt-outs. The live team DO now reads this policy as `all_delivered` with
  `workspace-default`; the existing source-identity mismatch and complete
  workspace coverage remain open. “All
  delivered” is not a workspace export: Slack visibility, installation
  membership, event subscriptions, supported subtypes, file-body handling, and
  the bounded explicit backfill manifest still define the actual coverage
  boundary.
- Slack ACL refreshes use a durable invalidation-revision compare-and-swap and
  clear stale invalidation metadata on success. The local refresh worker now
  fetches bounded `conversations.members` pages, persists the sorted member set,
  enforces a bounded snapshot age, and retrieval uses a short-lived revocable
  KnowledgeDO read lease containing the requester. Live deployment and the
  complete workspace admission and installed-manifest readback remain open.
- Knowledge reads now have a shared current-bundle/connector-grant boundary:
  bot tools re-read the current WorkspaceConfigDO bundle and compare its
  revision to the frozen turn snapshot, resource-bound wiki/code/custom reads
  require matching grants, Graphify reads retain exact repository fencing, and
  actor-token Slack MCP reads now use the same short-lived membership
  lease/check/release and per-citation ledger-current fence as the bot Slack
  tool. The public route still
  needs a separate internal transport gate to preserve operator-only external
  MCP. This is source-tested; live actor/MCP access and upstream ACL sync
  remain open.
- The Cloudflare-only Supermemory and Graphify services are source-complete and
  deployed privately. Their live rollout checker passes the deployment,
  binding, and resource checks, but both singleton query containers report zero
  healthy instances. Provider boot, migration/parity, production cutover, and
  a live add/poll/search receipt remain open; R2 is mounted through Worker
  bindings rather than bucket-scoped credentials.
- The KnowledgeDO now exposes a tenant-scoped admin status snapshot for the
  persisted ledger, outbox, DLQ, reconciliation runs, and backfill manifests;
  this makes durable local backlog and completeness state inspectable without
  returning message bodies. It does not yet probe Cloudflare Queue lag,
  derived-index reachability, or live ACL freshness.
- The local provider/effecter contract slice is green: 16 files and 85 tests
  cover billing, credential custody/broker, memory deletion, OAuth, platform
  effects, and provisioning adapters. This is fail-closed contract evidence;
  it does not establish a live provider workspace, external receipt, deletion,
  or reconciliation result.
- Harness release provenance now has a local contract: `edge/scripts/harness-provenance.mjs`
  hashes the exact Dockerfile, prompt, lockfile, and image input sources;
  `deploy-opentag.mjs` injects that manifest into an ephemeral Wrangler
  `image_vars` config; the Docker image records source revision, tree, digest,
  and working-tree state as OCI labels and runtime variables; the Worker
  exposes `CF_VERSION_METADATA` on `/health`; and authenticated
  `/health/container` returns the image's embedded source provenance. The
  current digest above is a dirty-checkout local manifest, not a release
  attestation. Wrangler now verifies the deployed harness image digest as
  `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`
  with seven healthy instances. The deployed image's embedded source
  provenance has not been read back, and its image digest does not match the
  current local source manifest, so source-to-image identity remains open.
- Recovery rendering now requires an exact Slack `client_msg_id` lookup when a
  duplicate post response omits its timestamp. It no longer substitutes the
  thread root timestamp, which could observe the wrong message. The local
  ambiguity/recovery tests and typecheck pass; a live ambiguous-write drill is
  still open.
- Local validation now covers 144 files / 1,357 tests, 8 bot-store Worker files
  / 66 tests, and 1 Graphify Worker file / 5 tests. The event-identity and
  readiness/probe slices are included in that total. The event-identity slice
  passed 4 files / 108 tests plus 1 Worker file / 15 tests; typecheck,
  deploy-config validation, static rollout checks, and `git diff --check` pass.
  Existing missing `@cloudflare/containers` sourcemap warnings are non-fatal;
  this remains local evidence until the reviewed bundle is live.
- The local bot deployment vars pin `AGENT_MODEL = "gpt-5.6-sol"`, matching the
  harness model contract, and the deployed bot now reports
  `modelConfigured:true`. Human response-routing canaries are live-verified;
  authenticated readiness and a successful knowledge-backed answer receipt
  remain open.
- The installation lifecycle is now durable and source-tested, but the live
  Slack manifest has not been read back, and no production uninstall/token-
  revocation/archive/private-channel replacement canary has proven the new
  generation fence.
  Broad `all_delivered` indexing also lacks a proven content-governance and
  physical purge gate across every derived index.
- The shared-fleet decision is not yet matched by Slack credential custody:
  runtime calls use a deployment-wide bot token and static channel map rather
  than a server-owned per-installation token directory with rotation,
  revocation, and cross-tenant isolation evidence. The broker and custody
  service-binding auth secrets are now present, but provider resolution remains
  disabled until an approved Secrets Store binding map exists.
- `tracked_knowledge_sources`, `KnowledgeJob`, the KnowledgeDO ledger/outbox,
  event history, derived-index history, and DLQ records now carry source type.
  Legacy ledger identity migrates to a composite team/source/channel/thread
  uniqueness boundary, and reconciliation compares the same typed identity.
  Non-Slack queue jobs still fail closed with a durable permanent outcome until
  their connector-specific fetch/dispatch contract exists; this is not a claim
  that wiki, code, custom-db, or Drive ingestion is enabled.

The detailed gap matrix, including the distinction between explicitly enabled
Slack sources and workspace-wide indexing, is in
[`goal-outputs/knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md`](../goal-outputs/knowledge-contract-validation/KNOWLEDGE-CONTRACT-GAP-AUDIT.md).

## 2026-08-02 12:44 PDT recovery and deployment-preflight continuation

The live readiness and KnowledgeDO readbacks now identify the active failure
boundary precisely. Authenticated `/ready?profile=knowledge` and
`/ready?profile=full` both return HTTP 503: the bot binding is reachable, but
Supermemory and Graphify are not ready from the bot's private service-binding
probes. The live tenant KnowledgeDO has 36 ledger rows, all in
`permanent_failure`, with no pending outbox or DLQ records. The newest source
state has `lastLocalOperation: "add_started"`, `lastLocalError:
"local_rejected"`, no Local document ID, and project `default`, while the
server-owned admission policy names `workspace-default`. This is a real
indexing failure and a policy-identity mismatch, not merely delayed search.

The local repair adds three safety controls. The one-click deployment script
now requires at least one Supermemory provider secret for the supported
OpenAI, Anthropic, Gemini, Groq, or Workers AI paths; missing provider
configuration fails before deployment. Adapter HTTP failures preserve only a
bounded status class, and an add that ends in a 5xx no longer clears its
`add_started` marker because the provider outcome is ambiguous. KnowledgeDO
now exposes an exact `/admin/knowledge/recover` path through the bot, records
operator recovery attempts in `knowledge_recovery_audits`, and requeues only
an exact terminal Local failure. Known-document failures requeue with their
identity; ambiguous `add_started` failures requeue only into the provider
identity probe and cannot issue a direct add until that probe returns one exact
miss. Tombstones and non-Local terminal outcomes remain blocked. This prevents
duplicate external documents while making safe recovery durable and auditable.

Queue replay of an ambiguous add now probes the private Supermemory
`documents/list` boundary with workspace and source-key filters, requires one
exact `customId` plus metadata identity, adopts a single existing document,
and only issues a new add after an exact miss. Multiple matches or malformed
provider identity remain terminal and require operator review. The live
provider cannot exercise this probe until its model/bootstrap secret is
configured.

Local evidence for this continuation is `npm run typecheck`, 70 focused
knowledge-ledger/reconciliation/adapter/SDK-contract tests, 16 worker-ledger tests, and
`git diff --check`. None of these changes has been deployed yet. The live
provider secret/bootstrap gate, the current 36 ambiguous terminal rows, the
`default` versus `workspace-default` policy correction, and a fresh add/poll/
search receipt remain open.

## Status vocabulary

- **Source-complete** — implementation and focused tests exist; this is not a
  claim that an external provider or production canary is configured.
- **Live-verified** — the deployed Worker or harness performed the behavior
  against a real Slack or Cloudflare endpoint.
- **Synthetic-live** — the deployed admin/DO path performed the behavior with a
  synthetic tenant and opaque test metadata; no real provider or user data was
  touched.
- **Fail-closed** — the feature refuses to cross an unconfigured or
  unauthorized boundary; this is a safety result, not a completed integration.
- **Open gate** — a required external dependency, policy, or rollout proof is
  still missing.

## Feature-by-feature evidence

| Feature or contract | Current result | Evidence and boundary |
| --- | --- | --- |
| Slack Events API, HMAC verification, pre-admission, stable turn identity | Live-verified | The current bot accepted an untagged thread question, an untagged problem/action request, and an explicit mention; after the in-flight turn completed, an explicit marker was accepted without a stale-turn warning. |
| Flexible Slack response routing | Live-verified; indexing receipt open | The fresh explicit control and valid unmentioned deployment-status question both replied exactly, while the marker-shaped passive message stayed silent. The local route also classifies top-level channel messages and MPIMs; live DM/MPIM and complete-history coverage remain open. |
| Durable session events, render obligations, deduplication, recovery fences | Source-complete; live path exercised | Focused edge tests cover the DO contracts; the live Slack canary exercised normal admission and terminal delivery. Crash recovery and duplicate replay still require targeted fault injection rather than a normal canary. |
| Streaming/conflation, status/title, busy-turn feedback | Live normal-turn path; concurrency recovery open | Current human turns complete without the removed AG-UI/model label or lingering working reaction. A distinct response-worthy message that arrives during a genuine turn still receives the busy warning; there is no durable follow-up queue/coalescing policy. Transport-failure recovery remains open. |
| Stop and cancellation | Live-verified for stale-row cleanup; source-complete for lifecycle | Sending `<@U0BAK4AJ2Q1> Stop` to the earlier stale thread produced `Stopped.` and cleared the row. Full in-flight AG-UI/harness quiescence and late-output suppression still require a targeted canary. |
| Durable HITL and quick actions | Source-complete | Source and focused tests cover `choiceId`, DO polling, synthetic user turns, and exact fences. A live button-click canary remains open. |
| Native typed Nanocodex Responses adapter | Live-verified | Slack marker `OPENTAG_NANOCODEX_NATIVE_OK` returned from `--nanocodex`; the typed adapter, provider state, replay, and completed-only commit are source-tested. A live reconnect/checkpoint replay drill remains open. |
| Claudex model path through the private harness boundary | Live-verified | Slack marker `OPENTAG_CLAUDEX_HARNESS_OK` returned after the harness redeploy. This verifies the private Worker/service-binding path, not a public harness endpoint. |
| Harness sandbox, egress, sentinels, remote-git postconditions | Source-complete; image digest verified, source mapping open | Harness image and Worker are deployed with the expected binding. Wrangler verifies image `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880` and seven healthy instances. The current local source manifest is different and dirty, and the embedded live source provenance has not been read back. No live repository push or PR was performed in this canary. |
| Runtime/capability identity and deployment evidence | Live liveness/configuration; readiness still incomplete | `/health` remains a bounded liveness probe. The deployed bot now exposes admin-authenticated `/ready`, whose production default is the strict `full` profile and whose `core`/`knowledge` profiles identify missing contracts without revealing secrets; configured service bindings also receive bounded health probes. Live health now reports the pinned model, reconciliation trigger, relay allowlist, and broker auth as configured. An unauthenticated `/ready` probe returns 401; authenticated readiness, queue execution, cron receipt, external provider effects, and Buzz admission remain separate live gates. |
| Actor-bound knowledge/MCP authorization | Source-complete; synthetic/admin path only | Token, replay, team/project, ACL, audit, and source-authorization contracts are focused-tested. External MCP remains operator-only; no actor token or real external MCP call was exposed in this rollout. |
| Slack knowledge search and ordinary retrieval | Current live path reachable; convergence open | The current unmentioned question replied through the deployed `channel_message` route and its queue recorded `indexed`, but an authenticated operator search for the exact canary returned zero citations. The zero-healthy derived query Containers and unresolved provider/readback convergence remain open. |
| Cerebras-style retrieval quality pipeline | Architecture target; MVP only | OpenTag has normalized thread ingestion, reaction-aware primary-document enrichment, Supermemory hybrid search, and cross-source RRF. Structured Slack distillation/burst child artifacts, explicit IDF/recency/semantic lists, ordinary-path reranking, cross-index quality evaluation, and convergence metrics are not yet independently owned or live-gated. |
| Cloudflare-only Supermemory and Graphify derived indexes | Deployed privately; Container health/readback open | Service-binding transport, private route boundaries, Supermemory singleton/pinned tigrisfs Container mount and startup gate, Graphify exact-commit builder/query roles, artifact CAS, ACL checks, citation revisions, policy tests, Wrangler dry-runs, and a local Graphify fixture smoke pass. The required Supermemory R2 secret names are still missing, and both singleton query containers report `instance_state=inactive`; migration/parity, production cutover, and live search receipts remain open. |
| Platform effect/custody Worker shells | Adapter deployed; fail-closed | `opentag-platform-effecter`, the private provider adapter, request resolver, idempotency Worker, credential broker/custody, memory deletion, provisioning, OAuth, billing, and callback Workers answer health checks. Broker and custody internal auth are configured, but custody reports `bindingConfigConfigured:false`; cache-busted effecter health reports `adapterConfigured:true`, `providerEffectsEnabled:false`, and `providerAdapterReady:false` until the controlled workspace subject and custody mapping exist. No real provider effect or receipt is claimed. |
| Slack bot-message indexing, reaction/membership capture, and installation lifecycle | Source-complete; partial live gate | Local normalization retains bot messages and avoids turn feedback loops; reaction events enqueue thread refreshes, aggregate counts alter canonical revisions and primary-document enrichment, membership events invalidate ACL state, and the ACL reconciler fetches/persists a bounded member set with revision fencing. The live channel-message canary reached an `indexed` queue outcome but exact Supermemory search returned zero citations; installed manifest/scopes, lifecycle events, ACL refresh, and derived-index convergence remain open. |
| Slack working reaction and silent AG-UI surface | Live normal-turn verified; recovery/live lifecycle open | The explicit reaction lifecycle control showed `eyes` during the turn and an empty final reaction state; the final reply contained neither removed AG-UI/model text nor `Working…`. Isolate-loss cleanup, reaction event refresh, and stale status cleanup remain open. |
| Knowledge delivery durability and recovery observation | Deployed; live convergence and fault injection open | Verified Slack events are durably owned before acknowledgement, outbound writes are observed by default, and recovery writes use exact client-message lookup and retry semantics. The current canary produced a queue `indexed` outcome but zero exact search citations, so derived-index convergence, live policy, cron, DLQ, long-thread, unresolved-event, and fault-injection receipts remain open. |
| Connector labels, opaque credential references, bundle revisions, revocation, citations | Synthetic-live | The synthetic platform run exercised reference writes/reads, grants, marketplace metadata, revocation, and effect creation. Tokens never entered OpenTag state. |
| Google Drive search | Source-complete; fail-closed live gate | Drive connector and citation code are present and focused-tested. `CONNECTOR_CREDENTIALS` is not configured in the deployed bot, so no provider happy path was claimed. |
| Guarded Linear create | Source-complete; fail-closed live gate | Approval, requester attribution, project/milestone preservation, revalidation, and duplicate protection are source-tested. The isolated fixture exists, but no broker, OAuth grant, provider adapter, or live Linear mutation is configured. |
| Platform provisioning and idempotency | Synthetic-live | A synthetic tenant completed all required provisioning steps; repeat provisioning returned the same receipt and final status became `active`. This is metadata ledger evidence, not proof of external resource creation. |
| Identity custody references | Synthetic-live after hotfix | The deployed admin path put, read, and revoked a synthetic identity. The original live read exposed a route bug; `9d4538c` fixed it and the retest returned HTTP 200 before revocation. |
| Credential custody references and OAuth grants | Synthetic-live | Put/get/revoke and grant lifecycle calls returned successfully for synthetic metadata. No provider token, OAuth code, or external callback was used. |
| Marketplace and connector lifecycle | Synthetic-live | Curated entry, list, and revoke paths completed against the platform Durable Object. Trust review and provider execution are still external gates. |
| Usage metering | Synthetic-live | The live synthetic run recorded a meter event, repeated it idempotently, and listed it. Billing provider reconciliation is not deployed. |
| Memory policy and deletion request | Synthetic-live; executor open | Policy and deletion request state were recorded and listed. The deletion intent remains pending until a separately deployed effect worker proves source-by-source completion. |
| Effect intents, leases, retries, completion, cancellation | Synthetic-live | Provisioning intent claim/complete and retryable fail/reclaim/cancel all completed in the deployed DO. This validates the handoff ledger, not a real provider side effect. |
| Router heuristic classification and measurement ledger | Live-verified in shadow mode | Admin summary/list showed a Tier 1 counterfactual record dispatched to Tier 2 and existing conservative command fallbacks. The separate Slack response-worthiness gate is live and does not enable a tier. `shadowOnly` remains true; Tier 1 and Tier 3 are not user-facing. |
| Buzz `/buzz/wake` admission | Configuration gate live; signed admission open | The deployed bot now has signer, relay, channel-map, and independent allowed-relay-origin configuration. A live empty POST returns HTTP 400 `buzz_wake_unexpected_fields`, proving the route is configured and validating input. No valid signed NIP-OA wake, authenticated relay fetch, dedupe receipt, or tenant-scoped callback is claimed. |
| One-click/CLI secret configuration | Source-complete; deployment path not independently canaried | The secret-safe deploy script and Wrangler path exist. The rollout used existing Cloudflare secrets; a fresh one-click install dry run is not proof of an end-to-end new-tenant installation. |
| Trace correlation and structured delivery metrics | Source-complete | Correlation and metric contracts are focused-tested and emitted as structured Worker records. No external trace collector or dashboard is configured. |

## Routing and turn-finalization correction

The current Slack contract is intentionally more flexible than mention-only
admission:

1. The verified ingress normalizer retains every eligible human message instead
   of limiting response routing to mentions and threaded replies.
2. Slack's duplicate `message` delivery for an explicit `app_mention` is
   rejected before it can register a second active turn.
3. `response-routing.ts` applies a deterministic response-worthiness gate.
   DMs, MPIMs, explicit mentions, trusted triggers, files, questions, action
   requests, and problem reports proceed to the normal Tier 2 lifecycle.
   Passive channel or thread conversation is observed and remains available
   through Slack history without waking the agent.
4. Only a response-worthy event reaches durable pre-admission, so an ignored
   event cannot orphan an `active_turns` row.
5. The normal final render confirmation remains the owner of cleanup. It
   deletes the exact active-turn row after Slack visibility is confirmed;
   the busy warning is reserved for a real distinct concurrent turn.

The routing gate is separate from Router Tier 1/Tier 3 dispatch. The current
router still records shadow measurements and sends admitted work to Tier 2.
The busy warning remains a real-concurrency signal: it is expected when a
second response-worthy message arrives before the first turn has rendered its
terminal state, not when an old duplicate row is left behind.

## Decisions now locked

These decisions supersede unresolved wording in the original handoff and
backfill reports:

1. OpenTag uses one shared Worker fleet with strict per-team Durable Object
   isolation. Caller input never chooses an arbitrary DO name; server-owned
   tenant resolution does.
2. Cloudflare Worker Secrets are the deployment/bootstrap credential mechanism,
   configured through a one-click Wrangler flow or the Cloudflare CLI. This does
   not mean that one global Worker Secret is a safe substitute for mutable,
   per-tenant OAuth/token custody in a shared fleet.
3. Internal knowledge/MCP uses actor-bound bot tokens. External MCP is
   operator-only, with synthetic validation first. The user authorized a live
   rollout without an additional approval gate, but missing provider/relay
   credentials still cause a fail-closed result.
4. Nanocodex has a native typed Responses adapter now. It remains behind the
   existing harness/wire boundary for coding turns and does not introduce a
   second shell or repository executor.
5. Router rollout begins with exact heuristic shadow measurement. Tier 2 is the
   safe dispatch floor until knowledge health, quality gates, cost attribution,
   and rollback evidence justify a Tier 1 change.
6. QM is a design reference for capability profiles, durable leases,
   serviceability/preflight evidence, typed tool provenance, grants, and
   operator/admin separation. OpenTag does not adopt QM's Node/Postgres/Fly/AWS
   spine, Socket Mode, or direct user-agent credential model.

## Remaining gaps and their owners

### 1. Workspace-wide admission and production durability remain open

The source now durably owns verified Slack event callbacks before returning HTTP
200 and durably owns outbound observations, including recovery writes. The
source now has a server-owned `all_delivered` admission policy that materializes
a default source without accepting a caller-selected project and preserves
disabled-channel opt-outs. A rollback to `explicit` drains active default-source
effects, disables those rows, and preserves them as opt-outs if `all_delivered`
is later restored. The live team DO now reads the policy as `all_delivered`
with `defaultProjectId: workspace-default`. The Slack app is confirmed as a
member of the four visible public channels, but the installed token is missing
the source-declared reaction/profile scopes and complete workspace coverage is
not proven.
Complete-history backfill, queue/DLQ receipts, cron execution, and live
per-conversation convergence must be proven before this becomes a production
completeness claim.

### 2. Per-tenant custody is not solved by Worker Secrets alone

The user decision names Worker Secrets for deployment configuration, while the
current Layer 3 contract still models `external_kms`, `wrapped_do_envelope`, and
`self_hosted` custody references. The safe interpretation is:

- Worker Secrets hold deployment-wide bootstrap/runtime values and are set by
  the one-click or CLI flow.
- Tenant Durable Objects hold only opaque references, versions, grants, and
  revocations.
- A real shared-fleet connector still needs a broker/effecter that can resolve
  an authorized tenant reference without turning a deployment-wide Worker
  Secret into cross-tenant ambient access.

This is an architecture gap, not a documentation omission. Do not add
`workers_secrets` as a per-tenant custody backend until the access, rotation,
revocation, and isolation semantics are specified and tested.

### 3. External effect execution is deployed only as fail-closed shells

The platform Durable Object is a durable metadata ledger. The separate effect,
custody, provisioning, OAuth, billing, and deletion Workers now exist. Internal
broker/custody authentication is configured, but custody still has no approved
Secrets Store binding map, the effecter has no provider adapters, and provider
resolution/effects remain disabled. They are therefore still
diagnostic/fail-closed surfaces, not proof of a real provider effect, receipt,
deletion, or reconciliation.

### 4. Provider integrations remain deliberately gated

Drive and Linear must remain fail-closed until `CONNECTOR_CREDENTIALS`, provider
custody, grants, allowlists, and a synthetic/test workspace are all present.
No live external write, OAuth callback, billing call, or deletion call was
performed in this rollout.

### 5. Buzz needs complete runtime configuration and authenticated admission evidence

The current version contains signer, relay URL, auth-tag, channel-to-tenant,
and independently provisioned `BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN` bindings.
An empty live wake request now reaches schema validation and returns 400
`buzz_wake_unexpected_fields`, so the configuration gate is closed. Health and
schema validation still do not prove a signed NIP-OA admission, authenticated
relay query, event signature verification, dedupe, or runtime callback. Verify
relay membership, then run a synthetic signed event through authenticated fetch,
event verification, dedupe, and tenant-scoped runtime admission.

### 6. Router and knowledge rollout gates remain open

Router Tier 1/Tier 3 stay dark. Knowledge reconciliation is now declared in the
deployed environment with a 15-minute trigger and the current team scope, but
no cron execution receipt or live server-owned admission-policy readback exists.
Fresh Slack indexing is eventually consistent and derived-index provider boot
is still fail-closed.
Before enabling a new tier or broadening sources, collect shadow volume,
outcome, feedback, ACL, latency, and cost evidence and prove rollback.

### 7. Turn concurrency and reaction cleanup still need a product-safe lifecycle

The current pre-admission contract rejects a distinct response-worthy message
when an active row exists and posts the “active turn” warning. It has no durable
follow-up queue, coalescing rule, or user-visible state endpoint. The active row
uses a fixed two-hour lease and is refreshed only at lifecycle boundaries; it is
not a continuous execution heartbeat. The `eyes` reaction now has a delayed
durable cleanup lease aligned with the two-hour active-turn TTL in addition to
the in-process `finally` path. The lease is source-complete but not live-
verified; a future heartbeat can shorten stale reaction cleanup without risking
removal during a long legitimate turn. These behaviors are safe defaults for
duplicate suppression. The busy warning itself uses a stable Slack idempotency
key and releases its dedupe claim if outbound knowledge ownership fails, but the
response-worthy follow-up policy still does not
queue or coalesce a distinct ask that arrives during a genuine turn.

### 8. Live coverage still has targeted holes

The current canary proves flexible Slack routing, explicit-turn finalization,
stale-row cleanup, native Nanocodex, Claudex, search-path admission/error
handling, router measurement, platform metadata, and fail-closed Buzz
behavior. It does not yet
prove in-flight Stop quiescence/late-output suppression, live HITL button
persistence, delayed-file repair, attachment staging, live Drive/Linear
provider calls, authenticated Buzz wake, provider checkpoint reconnect, or a
fresh one-click installation. The deployed health response now reports
`modelConfigured: true`, but that is configuration evidence rather than a new
human answer canary or full model provenance attestation. These are explicit
next tests, not implicit passes.

### 8a. Local failure/recovery is green; live fault injection remains open

The local deterministic matrix now passes 10 targeted files / 143 tests across
deferred ingress, ambiguous Slack writes, bot-turn observation recovery,
knowledge queue/ledger retry and exhaustion, effect leases, memory deletion,
Buzz admission contracts, and native Nanocodex response handling. That closes
the local safety contract, not the live rollout. Production still needs
acknowledgement cleanup after an ambiguous Slack write, turn-finalization
recovery after isolate loss, Queue/index retry and DLQ replay in the deployed
binding, provider effect lease recovery, and Buzz relay/runtime retry with
dedupe. Each drill needs a durable before/after receipt, not only logs.

### 9. Retrieval quality is below the architecture target

The current implementation is a safe indexing and authorization foundation, not
the complete Cerebras-style retrieval system described in the knowledge
specification. It normalizes whole Slack threads, invokes the enrichment seam,
and delegates hybrid search to Supermemory, then fuses source lists with RRF.
The default queue path currently falls back to raw-thread-plus-engagement text
when no distillation model is configured; when enrichment produces a structured
artifact, it is folded into the primary document rather than retained as a
separate versioned artifact or burst document. Open quality work also includes
explicit IDF/recency/semantic retrieval lists, ordinary-path reranking, and a
golden-corpus quality/freshness evaluation. These are separate from the P0
guarantee that committed observations are durably owned and should be closed
before claiming high-quality company-wide search rather than before claiming
the narrower MVP contract.

### 10. Slack coverage is bounded by visibility, lifecycle, and backfill state

The Events API can only deliver messages visible to the installed app and bot,
and the current manifest has not been read back from the live installation.
The normalizer intentionally handles only supported subtypes and stores file
metadata rather than file bodies. The backfill runner now has a server-owned
`discoverAll: true` mode that inventories the conversations visible to the
installed bot and persists a digest-bound completeness receipt before history
fetching. It remains bounded at 50 eligible conversations per manifest and
refuses incomplete pagination, so it is not a literal workspace export or a
complete-history proof until the live inventory, per-conversation history,
thread-size, file, subtype, edit/delete, and reconciliation receipts exist.
Archive, leave, uninstall, token-revocation, and installation-replacement
generations now have a local durable handler, but coverage cannot be described
as continuous until the installed manifest, live event delivery, activation
procedure, and derived-index tombstone/reconciliation readback are proven.

### 11. Reaction artifacts, connector consumers, governance, and multi-tenant custody remain open

Source-typed queue/ledger identity and the non-Slack consumer boundary are now
implemented locally, including legacy identity migration and durable
`unsupported_source_type` outcomes. Enabling wiki, code, custom, or Drive
sources still requires an authoritative fetch, mutation/delete, credential,
retry/DLQ, and live canary contract for each connector.

Reaction lifecycle and primary-document signal propagation are source-complete
locally, but structured distillation and author-burst artifacts are not yet
independently owned, searchable, deletable, or citable. The broad indexing
policy also needs a content-governance classifier, admin visibility, retention
enforcement, and physical purge evidence across all indexes. Finally, a shared
Worker fleet cannot use one deployment-wide Slack token as its long-term
per-team custody model; installation-scoped lookup, rotation, revocation, and
noisy-neighbor limits remain required.

The code-graph catalog is currently intentionally scoped to the OpenTag
repository. If the product requirement is company-wide search across the four
backfilled repositories, qm, Nanocodex, Buzz, and Centaur still need explicit
server-owned catalog entries, credential scopes, rebuild schedules, ACL grants,
and per-repository freshness/completeness receipts; they are not indexed merely
because their fork-sync automations exist.

### 2026-08-03 rollout correction

The provider-effect architecture is no longer only a local shell. The private
request resolver, idempotency Durable Object Worker, Linear provider adapter,
and effecter binding are deployed and source-backed. The effecter exposes
connector_effect only; provisioning, custody, OAuth, billing, memory, and
unknown effect kinds remain fail-closed. The bot keeps provider mode disabled
until a controlled Linear workspace subject and custody mapping are installed.

The remaining live knowledge failure is now precise: the two Supermemory R2
secrets are missing. The strict checker was corrected to distinguish healthy
Container applications from idle Durable Objects; both query applications
report healthy=1 and failed=0, while their DOs are inactive after idle
eviction, which Cloudflare documents as normal lifecycle behavior. Slack
installed scopes, complete admission/backfill, signed Buzz admission,
provider receipts, live recovery drills, and clean harness source/image
provenance remain open evidence gates.

### 2026-08-04 live routing evidence

The latest human canary separates Slack event delivery from routing logic:
an unmentioned question in #general produced no reply, while an equivalent
plain-language explicit mention received a normal reply. The local classifier
supports the no-mention route, so ordinary message-event delivery and
installed-manifest readback remain the active Slack gate.

The native Nanocodex adapter also completed a live explicit Slack canary. The
latest harmless Stop drill was quarantined before harness execution and
therefore proves neither quiescence nor late-output suppression. Buzz reaches
schema validation on an empty request, but signed relay admission remains
unverified.

## Backfill and feedback reconciliation

The complete-history reports for qm, Nanocodex, Buzz, and Centaur remain
valuable evidence of their source trees and historical classifications. Their
current OpenTag comparisons are now accompanied by
[CURRENT-STATE-RECONCILIATION.md](../goal-outputs/multi-repo-parent-sync-architecture-backfill/CURRENT-STATE-RECONCILIATION.md),
which maps every old “not implemented” or “blocked” statement to the current
source/live status. The attached QM feedback is incorporated in the QM section
of that reconciliation and in the capability/custody decisions above.

Historical defer and Not Applicable items were not silently filtered. Durable
leases, audit, replay, tenant resolution, readiness, preflight, and source
authorization were retained where they fit the Cloudflare stack. Kubernetes,
Rails/Postgres product persistence, Redis topology, Socket Mode, and other
incompatible infrastructure remain explicitly out of scope while their
portable contracts are preserved.

## Revalidation commands

From `edge/`:

```bash
npm test -- --run test/platform-state-do.test.ts
npm test -- --run test/response-routing.test.ts test/pre-admit-turn.test.ts test/cloudflare-slack-adapter.test.ts test/slack-stream.test.ts
npm run typecheck
npm run validate:deploy-config
```

For a new rollout, verify `/health`, run a bounded Slack marker, inspect the
router admin summary without exposing secrets, and run only synthetic platform
operations until provider custody and external effect workers are proven.

## 2026-08-04 control-path and live preflight correction

The bot is deployed as version `54515284-a310-4d43-9f49-1295bafc0b92`. The
Slack rate limiter now has a durable generation fence: a Stop preempts queued
normal writes, queued render attempts fail as definitive no-ops, and the Stop
acknowledgement uses control priority. The affected Slack, Stop, and durable
rate-limit tests pass (`74` tests). A signed synthetic long-turn/Stop drill
reached `stop_command_received` and produced `:octagonal_sign: Stopped.`;
this is a deployed control-path receipt, not a replacement for a real Slack
thread canary.

The latest strict live knowledge check supersedes earlier same-day
single-failure notes. It currently has two failures: the Supermemory Worker
does not have `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY`, and the
Supermemory query instance is `stopped` with `healthy=0; failed=0` because the
Container cannot establish its required R2/tigrisfs mount. Graphify remains
registered with `healthy=1; failed=0`. The exact fix is to provision a
bucket-scoped R2 Object Read & Write token for
`opentag-supermemory-state`, enter its two values with the write-only
`wrangler secret put` workflow, and restart/re-read Supermemory. No secret
value belongs in chat, source, or logs.

Real human-authored Slack messages at
`1785822892.400989` and `1785822949.953319` produced no bot reply in the
observation window after this deployment, while the signed synthetic route
was admitted and stopped. This leaves Slack app reinstall/readback and
ordinary-message Event API delivery as an external installation gate; the
source classifier and deployed endpoint are not evidence that the installed
manifest has the required subscriptions. The installed bot also reports
`users.profile.get` as `missing_scope` during the synthetic canary, matching
the known manifest readback gap.

## 2026-08-04 current rollout checkpoint

The harness provenance gate is now live-verified. Local commit `a9cf6aa`
contains only the scoped harness provenance changes and reports
`workingTreeDirty=false`; Cloudflare application version 6 is at 100% on image
`sha256:f853b7257f6183d11e7855c76ee31664e95813af679c23329ed77cdd92e038e0`,
with 7 healthy and 0 failed instances. The harness and bot were deployed by
the guarded rollout command with Supermemory and Graphify explicitly skipped.

A fresh explicit Slack control at
[1785818656.409849](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785818656409849)
returned `4` at 1785818666.201239 and left no reaction on the parent. A fresh
ordinary no-mention control at
[1785818683.157419](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785818683157419)
remained silent, so installed ordinary-message event delivery and manifest
readback remain open. A fresh `--nanocodex` request was quarantined before
harness execution and is not recovery evidence.

The strict live knowledge checker still has exactly one failure:
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are absent from the Supermemory
Worker. Supermemory and Graphify query applications pass the healthy-instance
gate with `healthy=1` and `failed=0`; idle Durable Object state is normal. Buzz
has schema/configuration reachability but no valid signed admission receipt,
and the provider adapter remains disabled until custody and a controlled
Linear workspace subject are configured. Railway remains read-only.

The strict live knowledge check has one failure, not three:
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are absent from the Supermemory
Worker. Supermemory and Graphify query applications both report
`healthy=1; failed=0`; their Durable Object `inactive` state is normal idle
eviction. The harness provenance gate is closed for the current deployment:
Cloudflare version 6 is at 100% on image
`sha256:f853b7257f6183d11e7855c76ee31664e95813af679c23329ed77cdd92e038e0`
with seven healthy instances.

The remaining user/operator gates are external to the OpenTag source: an
account administrator must create a bucket-scoped R2 S3 token and enter its
two values through the write-only Worker Secret workflow; a Slack workspace
administrator must reinstall the current manifest; a controlled Buzz relay
event and tenant mapping are needed for a signed admission receipt; and a
controlled Linear test tenant, custody mapping, and provider credential are
needed before enabling provider effects. No secret should be pasted into chat.

## Latest live Slack readback — 2026-08-03 22:10 PDT

The installed app now delivered ordinary channel messages in `#general`:

- Explicit question [1785819895.661429](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785819895661429) received `6` at 1785819903.847239.
- Unmentioned top-level question [1785819923.155599](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785819923155599) received `6` at 1785819928.833469.
- An unmentioned threaded follow-up [1785819948.422389](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785819948422389) received `5` at 1785819955.833559.
- Passive conversation [1785820063.298189](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785820063298189) remained silent.
- The explicit and unmentioned parents had no remaining reactions after completion.

This proves the flexible routing path and passive silence in the current
installed surface. It does not prove the manifest through `apps.manifest.export`
because the connected bot token still lacks that read scope. The no-tag Stop
canary sent through the ChatGPT Slack connector was not valid recovery evidence:
that connector appended a `Sent using @ChatGPT` footer, so the event was not an
exact `stop` command. A raw transport reply was bot-authored and was correctly
ignored. In-flight quiescence and late-output suppression remain open until a
human-authored exact Stop is exercised.

## Fresh rollout correction — 2026-08-03 23:17 PDT

The strict live knowledge preflight was rerun against the current Cloudflare
state. It has two blocking failures: Supermemory is missing the
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secret names, and its query
instance is `inactive` with `healthy=0; failed=0`. Graphify is registered with
`healthy=1; failed=0`; the earlier Graphify-unhealthy claim is stale. Static
Graphify source-pin, Supermemory artifact, deploy-config, and 82 focused tests
all pass locally. The provider-adapter, request-resolver, idempotency, and
effecter Workers are deployed; provider effects remain fail-closed until a
controlled credential-custody workspace is configured.

The current bot version `54515284-a310-4d43-9f49-1295bafc0b92` passed a real
mention canary: parent `1785823907.868169` received a bot reply at
`1785823916.194899`. A real unmentioned threaded follow-up
(`1785824162.624719`) and real threaded Stop messages
(`1785823961.282869`, `1785824017.302689`, `1785824070.799199`, and
`1785824111.475349`) produced no bot reply. This is current evidence that
mention delivery works but the installed Slack app's general `message.*`
event delivery is still not proven; reinstall/read back the source manifest
before claiming no-tag routing or live Stop quiescence. The exact-marker
canary `1785823877.108789` did reach the bot but was rejected by its security
screen, which is separate from event delivery.

Buzz health now reports signer, relay, independent allowlist, tenant directory,
and wake configuration as present. No fresh signed canonical-event admission
receipt was produced in this checkpoint, so Buzz remains configuration-live,
admission-unverified. Railway remains read-only; no cutover, shutdown, or
credential removal occurred.

## 2026-08-03 23:27 PDT authoritative live preflight

The strict knowledge rollout check was rerun against the current Cloudflare
state. It has exactly two failures: Supermemory is missing the
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` Worker secrets, and its query
instance is stopped with `active=0; healthy=0; failed=0`. Graphify is healthy
with `healthy=1; failed=0`; its inactive Durable Object state is normal idle
eviction and is not an unhealthy query application.

The current Wrangler identity has account-read but not account-level R2 token
creation permission. A bucket-scoped R2 Object Read & Write token for
`opentag-supermemory-state` must therefore be created by an account
administrator and entered only through the interactive secret workflow. The
harness provenance gate is closed for the deployed clean image. Provider
Workers are deployed but intentionally fail closed until a controlled Linear
workspace and custody-backed credential are configured. Slack manifest
readback, signed Buzz admission, and live recovery drills remain open.

## 2026-08-03 23:32 PDT Worker source redeploy

The current Supermemory Worker source was redeployed as version
`d85b3a1a-2e59-4619-a96f-6eae3a2ffc86` and the current Graphify Worker source
as version `c5daebda-056e-49dc-9f1f-add24b0001c6`. Both deploys explicitly used
`--containers-rollout=none`: the Worker source/config was updated, while no
Container image was built or replaced because Docker is unavailable. The
strict post-deploy check still fails only on the absent Supermemory R2 secret
pair and its stopped query instance.

## 2026-08-03 23:37 PDT Container rollout readback

Docker Desktop was made available through its installed CLI path. The current
Supermemory linux/amd64 image built with the pinned server and tigrisfs
checks; Cloudflare reported no Container configuration change because that
image was already present. The current Graphify query/builder image was built
and applied. After normal startup, Graphify again passed the strict health
gate with `healthy=1; failed=0`.

A read-only code-graph Slack canary at `1785825331.979619` produced no thread
reply. This leaves the Slack delivery/feature invocation and citation receipt
unproven; it is not evidence that Graphify's Container is unhealthy. The
strict knowledge check still has exactly two failures: missing Supermemory
R2 secrets and the stopped Supermemory query instance.

## 2026-08-03 23:43 PDT Slack delivery diagnosis

Current explicit code-graph mention `1785825654.491479` and plain `2 + 2`
mention `1785825745.790249` both received no thread reply. A live tail of bot
version `54515284-a310-4d43-9f49-1295bafc0b92` emitted no `turn_*` or
`slack_message_routed` event for either message. This narrows the live issue
to installed Slack Event API delivery or manifest state, rather than the
Graphify tool implementation. The tail separately showed background
`knowledge_http_503` retries caused by missing Supermemory R2 credentials.

## 2026-08-03 23:49 PDT provider readiness correction

Read-only Linear discovery confirmed the isolated project
`OpenTag E2E Provider Smoke - 2026-08-02`
(`1e98bfb6-27d1-46d8-879c-7975107e7005`) in the Berendo team; no issue was
created. The provider adapter now probes credential-broker readiness before
advertising effects. Its controlled subject is configured as
`workspace:controlled-linear-test`, and version
`c2a57312-9e93-4d9e-a90a-7ee0bae0b295` is deployed.

Live effecter health is HTTP 200 with `adapterConfigured=true`, but correctly
reports `providerEffectsEnabled=false` and `providerAdapterReady=false` while
the custody mapping and provider credential are absent. The focused provider
test slice passes 9 tests.

## 2026-08-03 23:55 PDT external-gate ownership check

The focused provider, support-worker, and deploy-script tests pass: 16 tests
across 3 files, and `git diff --check` is clean. A fresh strict live knowledge
preflight still has exactly two failures: the Supermemory Worker has no
`R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` secrets, and its query instance
returns to `stopped` with `active=0; healthy=0; failed=0` after startup. This
confirms the remaining Supermemory blocker is credential provisioning, not the
current image or Worker source. Graphify remains healthy with `healthy=1`.

The deployed effecter health remains intentionally fail-closed:
`providerEffectsEnabled=false` and `providerAdapterReady=false`. No code,
deployment, or local test is missing for that gate; credential custody still
needs an approved Secrets Store mapping and a controlled Linear provider
credential. Slack manifest reinstall/readback and a fresh signed Buzz event
remain external workspace/operator gates. Harness provenance is not an open
gate in this checkpoint.

## 2026-08-03 23:58 PDT Buzz configuration readback

The deployed bot health endpoint reports all Buzz configuration gates present:
signer, relay, independent relay-origin allowlist, tenant directory, and wake
bindings. A fresh unauthenticated `POST /buzz/wake` probe returns HTTP 400
`buzz_wake_unexpected_fields`, confirming the route and schema are reachable.
This is not an admission receipt; a valid signed canonical relay event is still
required for the live Buzz gate.

## 2026-08-04 00:01 PDT source-gate verification

Typecheck passes. The full edge suite passes 148 test files and 1,414 tests.
The only transient failure was a stale test double for the shared Slack rate
limit Durable Object; it omitted the production `commit` method. The test now
models the reservation/commit contract and the full suite is green. This
closes the local source gate; live Slack delivery, provider custody, Buzz
admission, and Supermemory R2 credentials remain external gates.

## 2026-08-04 00:04 PDT Slack model-quota readback

Fresh Slack history confirms the installed bot receives and starts explicit
mention turns: the code-graph thread produced a bot delivery, but the delivery
was an OpenAI quota error, `You have no credits remaining`. The public agent
runtime health endpoint is reachable and the deployed agent Worker has an
`OPENAI_API_KEY` secret binding, but health cannot prove provider quota. The
unmentioned follow-up still received no reply, so ordinary `message.*` routing
and manifest scope readback remain open. This separates provider quota from
the Slack subscription gate; do not send more canaries until quota is restored.

## 2026-08-04 00:11 PDT bot deployment correction

The first bot deployment of the error-boundary change briefly omitted the
runtime generation var because the manual command did not pass it. The safe
bot deploy wrapper redeployed with `SUPERMEMORY_INDEX_GENERATION=cloudflare-r2-v1`
as version `f06b9456-c817-4f08-af83-cdced1b2029a`. A cache-busted live health
readback now reports `indexGenerationConfigured:true`; this supersedes the
intermediate `abe6b775-7b11-48d3-9b0a-1db193fd07ac` readback. No canary was
sent during the transient mismatch.

## 2026-08-04 00:10 PDT bot error-boundary deployment

The Slack adapter now maps model quota/credential failures to a stable
OpenTag-facing error and does not expose provider billing URLs or raw quota
details. The focused Slack renderer test passes, typecheck passes, and the
full suite passes 148 files / 1,415 tests. The bot Worker was deployed as
version `abe6b775-7b11-48d3-9b0a-1db193fd07ac`. This improves failure delivery
without claiming model availability; no new live canary was sent while the
provider quota gate remains open.

## 2026-08-04 20:46 PDT provider and Supermemory credential repair

The local `.env` contains `DEEPSEEK_API_KEY` but no `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, or `AWS_SECRET_ACCESS_KEY`. The
DeepSeek key was stored only as the `opentag-agent` Worker secret
`DEEPSEEK_API_KEY`; the existing `OPENAI_API_KEY` secret was retained for
rollback and was not printed or removed.

The triage runtime now has an explicit provider boundary. The agent Worker
variables select `deepseek` / `deepseek-v4-flash` /
`https://api.deepseek.com/`, the Container forwards `DEEPSEEK_API_KEY`, and
OpenAI remains an explicit rollback provider. Local typecheck and provider
tests pass, and direct DeepSeek Responses probes pass for text and function
tools. The configuration dry-run with `--containers-rollout=none` passes, but
the image deployment is not complete because the local Docker content store
returns I/O errors and Wrangler cannot build the Container image. No
Worker-only rollout was used because it would leave the old runtime image in
place.

Supermemory remains blocked on a new, bucket-scoped R2 Object Read & Write
credential for `opentag-supermemory-state`. An account administrator must
create the R2 access-key pair, then enter it through the two write-only
commands in the migration runbook. No unrelated Cloudflare or AWS credential
may be substituted. Railway remains read-only.
