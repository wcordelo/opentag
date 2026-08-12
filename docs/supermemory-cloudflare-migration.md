# Supermemory Cloudflare migration runbook

This runbook is a controlled migration procedure, not a deployment command.
No step that creates a bucket, changes a secret, deploys a Worker/Container, or
stops Railway is authorized by the file alone.

## Current read-only gate — 2026-08-02 22:15 PDT

The local source follows the approved pinned `tigrisfs`/Container contract.
The Dockerfile pins `v1.2.1` and verifies the Linux/amd64 archive checksum.
The entrypoint requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`R2_ACCOUNT_ID`, and `R2_BUCKET_NAME`, starts tigrisfs, waits for a real mount,
performs a `supermemory`-user read/write probe, and writes the R2-ready
sentinel only after that probe. The Worker maps R2 access secrets into
Container `envVars`, strips storage credentials from the Supermemory child,
and observes the sentinel/mount/read-write fence without calling
`mountBucket`/`unmountBucket`. The bot binding has no derived-index
credentials. Docker/FUSE build and restart persistence remain unverified
because the local Docker daemon is unavailable.

The durable ledger now separates provider ingestion completion from queryability
with a body-free, revision/document/generation-fenced receipt. Fresh local
validation passes 145 edge unit files / 1,379 tests, 8 bot Worker e2e files /
69 tests, Graphify e2e (5 tests), Graphify policy (10 tests), focused
Supermemory/checker tests, typecheck, deploy-config validation, source-pinned
rollout preflight, shell syntax, diff checks, and live artifact
download/checksum/member verification. Supermemory dry-run deployment
validation also passes with the configured account guard. No deployment or
external mutation was performed.

Knowledge readiness is HTTP 200, while full readiness is HTTP 503 on the
credential broker, platform effecter, and OAuth checks. The tenant ledger is
84 rows: 55 indexed, 2 pending, and 27 permanent failures; tenant outbox and
DLQ are empty. `indexed` currently records provider document-poll completion,
not search convergence: the exact fresh marker still has zero authenticated
citations, and the local adapter regression now tests the separate
`add -> poll -> search` sequence.

Supermemory version 18 and Graphify query version 6 each have one active but
zero assigned/healthy query instances, so the strict rollout gate remains
open. Buzz signed admission remains blocked at relay HTTP 526. The provider
effect path is fail-closed without an adapter/custody mapping, and the local
harness manifest is dirty relative to the deployed image. No additional
deployment, migration replay, cutover, Railway shutdown, credential removal,
provider mutation, or Queue mutation was performed here.

The 22:14 PDT rerun passes 145 edge unit files / 1,379 tests, 8 bot Worker
e2e files / 69 tests, Graphify e2e/policy, typecheck, deploy-config, shell,
diff, and downloaded Supermemory/tigrisfs artifact checks. The strict live
check still fails only the Supermemory and Graphify query health aggregates;
the deployed Supermemory Worker also reads back as the legacy `mountBucket`
bundle rather than this local tigrisfs candidate. Do not redeploy until the
Docker/FUSE and explicit approval gates are satisfied.

## Fresh read-only gate — 2026-08-02 20:59 PDT (historical snapshot)

The deployed bot remains HTTP 200 and the harness reports version 4 with
seven healthy instances. The deployed harness image is
`sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880`,
but the dirty local source manifest differs, so source-to-image provenance is
still open. The empty Buzz probe returns HTTP 400
`buzz_wake_unexpected_fields`; no signed admission receipt exists.

The latest tenant readback is 83 rows: 55 indexed, 2 pending, and 26
permanent failures, with empty outbox and tenant-local DLQ. The exact fresh
unmentioned Slack marker still has zero authenticated knowledge citations
despite a queue `indexed` outcome. Strict rollout still fails the Supermemory
and Graphify query Container health aggregates (`active=1`, `assigned=0`,
`healthy=0`, `failed=0`). No deployment, migration replay, cutover, Railway
shutdown, credential removal, provider mutation, or Queue mutation occurred.

## Prior read-only gate — 2026-08-02 20:41 PDT (historical snapshot)

At that historical checkpoint, the source and deployed path were the upgraded
Cloudflare Sandbox design: the Worker owned the credential-less STATE_BUCKET
mount and the Container used only a disposable local model-cache overlay. The
current approved source contract is the pinned tigrisfs Container path recorded
above; the local lifecycle still requires a successful 2xx response from
/v3/openapi before provider readiness is released.

The latest authenticated readiness probe is HTTP 200, but the strict rollout
check still reports Supermemory and Graphify as active=1, assigned=0,
healthy=0, failed=0. The tenant readback is 80 rows (53 indexed, 2 pending,
25 permanent), and the separate operator DLQ has 100 pending records. No
migration replay, cutover, Railway shutdown, credential removal, provider
mutation, or deployment was performed.

The fresh Slack marker/search canary proves explicit retrieval but not
complete-history parity. Restart/remount persistence, update/delete/tombstone
convergence, provider recovery, Graphify artifact receipts, and clean image
provenance remain stop gates. The tigrisfs proposal mentioned in that earlier
checkpoint was superseded only for that mixed source snapshot; the current
approved handoff requires the pinned tigrisfs contract.

## Current rollout checkpoint — 2026-08-02 20:24 PDT (historical snapshot)

The deployed Supermemory implementation at that time was the upgraded
Cloudflare Sandbox path: the Worker mounted the credential-less `STATE_BUCKET`
binding at `/var/lib/supermemory` and gave model downloads a disposable local
cache overlay. The current source has been reconciled to the approved pinned
`tigrisfs`/Container-credential contract. Supermemory version 18 is running with image digest
`sha256:e0d3914e04e90f94f14472cbe7f3ccd0afc21db27a653353f10ae4c5d1cbcefe`.

The last recorded authenticated knowledge readiness was HTTP 200 and provider
tail readback showed document write/poll plus `/v4/search` HTTP 200. The authoritative tenant
readback is 77 ledger rows: 32 indexed, 19 leased, 2 pending, and 24
permanent; outbox and DLQ work are empty. Thirty old `local_add` rows were
reopened with correction reference
`supermemory-v18-r2-model-cache-repair-da95429a`, but the leased rows have not
yet converged. This is not a migration cutover or Railway shutdown receipt.

The current open gates are restart/remount persistence, update/delete/tombstone
receipts, parity against the legacy path, complete-history backfill, Graphify
artifact/citation evidence, and a clean harness source-to-image attestation.
The separate Buzz canary is blocked at the Worker-to-relay HTTP phase with
status 526; no valid signed admission is claimed.

## Current rollout correction — 2026-08-03

The current Cloudflare readback supersedes the older point-in-time health
claims above: Supermemory and Graphify query applications each report
`healthy=1` and `failed=0`; their inactive Durable Object instances reflect
normal idle eviction. The harness provenance gate is closed for the deployed
clean image. The remaining strict knowledge failure is the missing
Supermemory `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` Worker Secrets.
Railway remains read-only. Buzz signed admission, provider custody/effect
receipts, complete-history indexing, and live recovery drills remain open.

Read-only Wrangler verification confirms the Supermemory application is at
version 18 with one running instance and the expected image digest; Graphify's
query and builder applications are at version 6 with one running instance each.
The full local validation pass is green, but Docker is unavailable, so FUSE
remount, restart persistence, and clean image rebuild evidence remain open.
The strict Container preflight still reports both query instances as `running`,
not `healthy`, with `active=1`, `assigned=0`, `healthy=0`, and `failed=0` for
each query application. The local Supermemory port gate now keeps non-health
traffic at `503` before R2, exposes only bootstrap health before the lifecycle
mount, and returns health `200` only after `/v3/openapi` returns a successful
`2xx` and the provider-ready sentinel is written. A reachable `4xx`/`5xx`
application remains degraded. This repair awaits a separately approved
redeploy.

The local Queue contract now carries the exact observed Slack message timestamp
for non-delete message, reaction, edit, and outbound observations. Supermemory
dispatch retries a complete-but-stale thread with
`observed_message_missing` before any derived-provider write. The focused and
full local suites cover this fence; it has not been deployed, so it does not
alter the migration cutover gate.

## Staging resource gate

After explicit operator approval, create the two buckets independently and
verify the account before applying any Worker configuration:

```bash
cd /Users/will/Documents/opentag/edge
export CLOUDFLARE_ACCOUNT_ID='approved-account-id'
npx wrangler r2 bucket create opentag-supermemory-state
npx wrangler r2 bucket create opentag-code-graphs
```

The Workers use their R2 bindings for facade-side metadata and artifact
publication. The Supermemory Worker retains `STATE_BUCKET` read access for the
`api-key` bootstrap, while its singleton Container mounts the bucket through
pinned tigrisfs. Configure the non-secret `R2_ACCOUNT_ID` and
`R2_BUCKET_NAME` variables in the Supermemory Worker, then provision
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker Secrets through the
one-click inputs `OPENTAG_SECRET_SUPERMEMORY_R2_ACCESS_KEY_ID` and
`OPENTAG_SECRET_SUPERMEMORY_R2_SECRET_ACCESS_KEY`; the Worker maps them only
into Container `envVars` as AWS-compatible variables. Graphify's
query role remains a separate read-only binding. Configure the server-owned
`GRAPHIFY_REPOSITORY_CATALOG`, then provision service and Container tokens with
`wrangler secret put`. Deploy the target services before deploying the bot so
its `SUPERMEMORY` and `GRAPHIFY` service bindings resolve.

The standalone `npm run deploy:supermemory` and `npm run deploy:graphify`
commands require `OPENTAG_KNOWLEDGE_DEPLOY_APPROVED=true` for a non-dry
deployment after the staging approval. Their `--dry-run` form still validates
the same configuration without changing Cloudflare state.

Read-only preflight:

```bash
npm run check:knowledge-rollout
npm run verify:supermemory-artifact -- --download
npm run check:knowledge-rollout -- --live
npm run migrate:dry -- --source-dir=/absolute/path/to/graphify
npx wrangler r2 bucket list
npx wrangler deployments list --name opentag-supermemory
npx wrangler deployments list --name opentag-graphify
npm run validate:deploy-config
```

The first command is a local/static contract check. The `--live` form only
performs read-only Wrangler queries for the approved account; it must report
both buckets and both target Workers before any service or bot deployment.
`npm run migrate:dry` prints the ordered freeze, seed, parity, burn-in, and
cutover gates and then runs the same static contract check. It rejects live,
deployment, shutdown, deletion, and secret-mutation options.

No production traffic is enabled by this preflight. A missing bucket, target
Worker, token, or Container health result stops the rollout.

## Freeze and inventory

1. Record the current Railway service release, volume identity, last verified
   backup, representative search fixtures, and the active OpenTag ledger
   revisions.
2. For a prolonged freeze, pause delivery at the Cloudflare Queue control
   plane after explicit operator approval:

   ```bash
   npx wrangler queues pause-delivery opentag-knowledge
   ```

   Queue delivery pause stops the consumer while producers may continue to
   append authoritative work. Verify the paused state and queue age/retention
   in the Cloudflare Queue dashboard or approved operational readback. This is
   the migration freeze; it does not pause `KnowledgeDO`, the ledger, or
   producers. The command is documented in the [Wrangler Queue commands](https://developers.cloudflare.com/workers/wrangler/commands/queues/).
3. Optionally set `SUPERMEMORY_CONSUMER_MODE=paused` as a defense-in-depth
   handler fence and verify runtime evidence reports `consumerPaused: true`.
   The handler calls `retryAll`, and the configured `max_retries` budget can
   move repeatedly retried messages to the DLQ. Therefore this variable is
   not a substitute for queue-level pause during a prolonged migration.
   Leave the Railway service read-only and retain its rollback credentials.
4. Verify the staging R2 bucket is dedicated to Supermemory and that the
   Worker binding names match the intended buckets.
5. Choose a new, immutable server-owned `SUPERMEMORY_INDEX_GENERATION` for
   the isolated Cloudflare state (for example, `cloudflare-r2-v1`). Do not
   reuse a generation for another bucket or provider. The ledger treats
   provider document IDs as valid only within the matching generation.

During parity burn-in only, the bot may set `SUPERMEMORY_MIGRATION_MODE=true`
to retain the legacy URL/key read path. Remove that flag and the legacy values
before the Cloudflare-only cutover; without the flag, the client fails closed
instead of silently falling back.

## Seed and verify

Prefer a verified compatible Supermemory state export. If the pinned binary
does not provide one, configure the new generation on the bot and replay
authoritative KnowledgeDO ledger content through generation-aware
reconciliation and the normal ingestion adapter with bounded Queue rate. Even
when the content revision is unchanged, a ledger row indexed under a different
generation is re-enqueued. A generation change archives the old derived binding
and re-adds the source to the new isolated state; it never sends a Railway
document ID to Cloudflare. If Queue delivery is still paused, that replay only
stages authoritative messages; resume delivery after the new service is ready
and before expecting the derived index to converge. Do not copy raw Railway
credentials into chat, logs, Git, or the bot Worker.

For a compatible export that preserves provider document IDs, verify that the
export and the ledger describe the same provider state before cutover. Do not
set a new generation unless the imported state is the new generation; a
generation mismatch is intentionally fail-closed rather than silently issuing
updates against an unknown store.

The staging gate must prove:

- the Worker-owned Container mount establishes R2 access before application
  startup and remounts it after restart;
- `$SUPERMEMORY_DATA_DIR/api-key` is created/read without being logged;
- add → poll → search reaches terminal `done`;
- update, delete, and tombstone behavior converges to the ledger;
- concurrent reads work with exactly one writer;
- representative searches match the retained Railway read path;
- latency, cold start, model-cache, and R2 egress are within the approved
  budget.

A failed binding-mount correctness or durability assertion stops migration. Do not
fall back to an unapproved local disk, Postgres database, or second writer.

## Burn-in and cutover

1. Keep Railway read-only through the burn-in window and compare indexed
   revisions/search fixtures against the Cloudflare service.
2. After the Cloudflare service and Container/R2 gates pass, clear any
   `SUPERMEMORY_CONSUMER_MODE=paused` handler fence, then resume Queue
   delivery:

   ```bash
   npx wrangler queues resume-delivery opentag-knowledge
   ```

   Resume only after the staging gate is signed off; the command is approval-
   gated and is not run by this repository. Enable the bot's `SUPERMEMORY`
   service binding only after the same sign-off.
3. Monitor Queue age, DLQ depth, ledger/index revision drift, FUSE errors,
   restart recovery, search latency, and credential-redaction checks.
4. If the handler fence caused messages to reach the DLQ before Queue delivery
   was paused, inspect the durable records with
   `GET /admin/knowledge/dlq?cursor=<n>&limit=<1..100>` and replay only one
   exact record at a time with
   `POST /admin/knowledge/dlq/<recordId>/replay`. Replay is never bulk or
   automatic; correct the root cause first and use the exact `sourceKey` plus a
   bounded correction reference. Cloudflare Queue DLQ behavior is described in
   the [DLQ documentation](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
5. Obtain explicit production cutover approval naming the exact Railway
   service/volume and Cloudflare bindings before removing Railway credentials
   or configuration. Remove the legacy migration mode, URL/key, and temporary
   staging values only after the Cloudflare generation is stable.

Rollback first pauses `opentag-knowledge` Queue delivery, preserves the
authoritative ledger, returns reads to the retained Railway service during
burn-in, and re-runs the representative search and restart checks. It does
not delete either bucket or reinitialize embedded state. If the handler fence
is used during rollback, treat it as bounded protection and monitor the DLQ;
do not leave it enabled instead of pausing Queue delivery.
