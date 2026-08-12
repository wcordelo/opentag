# Supermemory Cloudflare Container image

This is the private `opentag-supermemory` Container image. The Worker facade
owns authentication and route allowlisting; the bot reaches it through a
Cloudflare service binding. It is not a public Supermemory endpoint and it is
not a Railway deployment.

The image pins Supermemory Local `server-v0.0.5` and tigrisfs `v1.2.1`, with
SHA-256 verification for both artifacts, then extends the version-matched
Cloudflare Sandbox runtime. The Container is intentionally a singleton
(`max_instances = 1`) so the R2-backed embedded state has one writer. The
existing `$SUPERMEMORY_DATA_DIR/api-key` bootstrap contract remains the
private facade's server-key source.

The Worker passes only the R2 endpoint credentials required by the Container
through `envVars`: non-secret `R2_ACCOUNT_ID`/`R2_BUCKET_NAME` variables
and Worker Secrets mapped to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
The entrypoint removes the ephemeral container machine-id before starting the
server so Supermemory derives its storage key from the persisted R2
`machine-key`, rather than from a replacement Container identity. It starts
tigrisfs, waits for the real mount, proves
`supermemory`-user read/write access, and writes the R2-ready sentinel only
after that probe. tigrisfs uses an ephemeral on-disk cache and waits for close
flushes. A separate disposable local model cache is cleared at boot and
bind-mounted over the R2 `models` directory so rename-heavy model downloads do not depend on
R2/FUSE atomic rename semantics. It drops storage and facade credentials from the
Supermemory child, and redacts generated Supermemory keys, provider keys, and
service tokens from child logs. The documented self-hosted
provider, embedding, performance, and telemetry variables remain configurable
through the Container environment; no `DATABASE_URL` is configured.

The local-directory fixture path is available only when
`SUPERMEMORY_ALLOW_LOCAL_DISK=true` is set explicitly; the Cloudflare
Worker/Container environment never sets that flag. Production does not fall
back to local disk when the R2/FUSE contract is unavailable.

The port gate has one bootstrap exception for the Cloudflare supervisor:
`GET /health` may return `200` before `onStart` observes the R2-ready
sentinel. Every other request returns `503` until the R2 signal exists, and
health remains `503` until the provider-ready signal exists. The signal is
written only after
`/v3/openapi` returns a successful `2xx`; a reachable degraded (`4xx`/`5xx`)
application is not healthy. Only the provider-ready state proxies requests to
Supermemory.

## Release gates

Before enabling production traffic, staging must prove:

- binding mount, remount, restart, and R2 persistence;
- add → poll → search, update, delete, and tombstone behavior;
- concurrent reads with exactly one writer;
- `/api-key` bootstrap and the Worker route allowlist;
- cold start, local model-cache, search latency, and rollout recovery;
- absence of raw keys in Container logs, Worker bindings, and diagnostics.

A failed FUSE correctness or durability test stops the migration. The approved
fallback is rollback to the read-only Railway service during burn-in, not an
unreviewed local-disk or alternate database implementation.

The binary license and upstream source notice are preserved in the image. The
image remains private to OpenTag.
