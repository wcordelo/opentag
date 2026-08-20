# `opentag-supermemory`

Private Cloudflare Worker/Container facade for the pinned Supermemory Local
binary. The bot calls this Worker through the `SUPERMEMORY` service binding;
there is no public Supermemory URL in the production bot contract.

The Worker reads the generated `api-key` from the dedicated
`opentag-supermemory-state` R2 bucket and injects it only into the singleton
`SupermemoryContainer`. The Container image starts pinned tigrisfs and mounts
the same bucket read/write at `/var/lib/supermemory`. Non-secret
`R2_ACCOUNT_ID`/`R2_BUCKET_NAME` variables and Worker Secrets
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` enter only the Container
environment, mapped to the AWS-compatible names required by tigrisfs. The
entrypoint removes the ephemeral Container machine-id so Supermemory reuses
the persisted R2 `machine-key` across Container replacements, proves the
mount and unprivileged read/write access, enables the ephemeral tigrisfs disk
cache with close-flush durability, clears and overlays a disposable local
model cache, and removes storage and facade credentials from
the Supermemory child. Bootstrap health is the only pre-mount `200`;
application requests are `503` until `/v3/openapi` returns a successful
`2xx` and the provider-ready signal is written. Production never falls back
to local disk.
`max_instances = 1` is intentional: the embedded Supermemory state has one
writer.

Required secrets/vars are documented in `wrangler.toml`. Do not run `deploy`
until the FUSE persistence, restart, single-writer, key-bootstrap,
route-allowlist, redaction, and latency gates in
[`KNOWLEDGE-BASE-SPEC.md`](../../../KNOWLEDGE-BASE-SPEC.md) pass with an
isolated staging bucket. Production deployment remains an explicit approval
gate.

```bash
npm ci
npm run typecheck
npm run deploy
```
