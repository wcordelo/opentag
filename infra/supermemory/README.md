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

## R1 runtime proofs (executed)

- The pinned binary has been smoke-tested on Railway
  (`opentag-supermemory-local` / `supermemory-local`):
  - Bind: public HTTPS serves Local UI at `/` and OpenAPI at `/v3/openapi`
    / `/v4/openapi`.
  - Auth: bearer required; generated key file is exactly
    `$SUPERMEMORY_DATA_DIR/api-key` (volume path `/api-key`).
  - First-boot key is redacted from Railway logs by this entrypoint.
  - Proven ingest path: `POST /v3/documents` → poll `GET /v3/documents/{id}`
    through `queued`/`indexing`/`done` → `POST /v4/search` under an exact
    `containerTag`. Cross-tag search returned zero hits in smoke.
  - Do not invent a Railway `healthcheckPath` from `/` (UI HTML) or
    authenticated data routes.
- Railway volume mounts are root-owned. Proven fix: set service variable
  `RAILWAY_RUN_UID=0`. The entrypoint no longer crash-loops on `chmod`
  denial, but still requires a writable data directory.
- No source can be production-enabled until an authoritative workspace/project/
  channel administrator authorization contract exists. The current DO RPC is
  intentionally not exposed by an admin route.

Do not create `.supermemory` in the repository.
