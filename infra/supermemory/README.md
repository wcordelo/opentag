# Supermemory Local image contract

This directory is the dedicated `infra/supermemory/` Railway build context. It
is a file-only B0 asset, not an authorization to create a Railway service,
volume, variable, domain, backup, or deployment.

`Dockerfile` pins `server-v0.0.5` and verifies the published Linux checksum:

| Architecture | SHA-256 |
| --- | --- |
| x64 | `b2fccca3ff2b5607ce41028c759f375c4ecf5461adc9f3306f41c2757edaf375` |
| arm64 | `dd3e48fbabbffc628c5f61b3d895c27abf803c5a2f9fb485d73bc72f40613c0f` |

The image uses `tini`, runs as `supermemory`, keeps state only below
`SUPERMEMORY_DATA_DIR=/var/lib/supermemory`, and pins the non-secret runtime
tuple `OPENAI_MODEL=gpt-5.1`, `OPENAI_FAST_MODEL=gpt-5.1`,
`OPENAI_TEXT_MODEL=gpt-5.1`, local `Xenova/bge-base-en-v1.5`, and 768
dimensions. It deliberately does not set `DATABASE_URL` and never embeds an
API key; the pinned binary's handling of an arbitrary inherited
`DATABASE_URL` remains unverified. The build preserves the upstream source license/notice;
binary redistribution outside OpenTag's private build remains a legal/product
stop.

The entrypoint sets `umask 077`, requires an owner-writable data directory,
uses a first-byte FIFO redactor for generated `sm_...`, provider-shaped, bearer,
and configured client/provider secrets, and returns the child exit status after
forwarding termination. Its fake-child tests prove this wrapper only; they do
not prove the Local binary's generated-key file/path/format.

## Explicit stops before R1

- The pinned binary has not been smoke-tested for its bind host, a safe health
  endpoint, generated-key file/path/rotation behavior, or arbitrary
  `DATABASE_URL` handling. Do not invent a Railway healthcheck.
- A real empty-volume first boot must prove owner-only auth/data paths and that
  no generated key or provider secret reaches Railway logs.
- The approved provider account must prove `gpt-5.1` availability without
  placing an `OPENAI_API_KEY` in this repository or transcript.
- Railway's mounted volume may be root-owned. This non-root image must be
  tested against the exact mount before R1; do not silently use root or a
  guessed `RAILWAY_RUN_UID` setting.
- No source can be production-enabled until an authoritative workspace/project/
  channel administrator authorization contract exists. The current DO RPC is
  intentionally not exposed by an admin route.

Do not run this image or create `.supermemory` in the repository for B0.
