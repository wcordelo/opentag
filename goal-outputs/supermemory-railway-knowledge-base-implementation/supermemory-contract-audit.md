# Supermemory Local / SDK / Railway contract audit

**Audit date:** 2026-07-19 (read-only public-source check).
**Scope:** B0–B4 implementation contracts and B5 deployment preconditions only. No Local server was started, no repository `.supermemory` directory was created, no provider was authenticated, and no external resource was mutated.

## Decision

`server-v0.0.5` and npm SDK `supermemory@4.24.12` are real, current public releases as of this audit. They are suitable **only behind a narrow typed HTTP/SDK adapter and only after the blockers below are closed**. The B1 product namespace remains the OpenTag invariant `workspace:{teamId}` supplied as the sole `containerTag` on every Local add/search request; it is never caller-controlled and is never a prefix query.

The planning specification contains one material status-name mismatch: its state machine calls out `processing`, but the pinned SDK’s document type enumerates `queued`, `extracting`, `chunking`, `embedding`, `indexing`, `done`, and `failed`. Treat both `indexing` and any undocumented server value as non-terminal; only `done` may set `indexed_revision`. Do not write code assuming a `processing` status exists.

## Source register

Primary sources consulted (all public and read-only):

- [Supermemory Local release `server-v0.0.5`](https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.5) and its [expanded asset list](https://github.com/supermemoryai/supermemory/releases/expanded_assets/server-v0.0.5).
- [Supermemory self-hosting overview](https://supermemory.ai/docs/self-hosting/overview), [quickstart](https://supermemory.ai/docs/self-hosting/quickstart), [configuration](https://supermemory.ai/docs/self-hosting/configuration), [embeddings](https://supermemory.ai/docs/self-hosting/embeddings), and [Local changelog](https://supermemory.ai/changelog/local/).
- [Supermemory add/document API](https://supermemory.ai/docs/add-memories), [search API](https://supermemory.ai/docs/search), [container tags](https://supermemory.ai/docs/concepts/container-tags), and [filtering](https://supermemory.ai/docs/concepts/filtering).
- [npm package metadata for `supermemory@4.24.12`](https://www.npmjs.com/package/supermemory), [SDK repository](https://github.com/supermemoryai/sdk-ts), [generated SDK API index](https://raw.githubusercontent.com/supermemoryai/sdk-ts/main/api.md), [document resource types](https://raw.githubusercontent.com/supermemoryai/sdk-ts/main/src/resources/documents.ts), and [search resource types](https://raw.githubusercontent.com/supermemoryai/sdk-ts/main/src/resources/search.ts).
- Railway’s [volume reference](https://docs.railway.com/volumes/reference), [volume guide](https://docs.railway.com/volumes), [Dockerfile build contract](https://docs.railway.com/builds/dockerfiles), [config-as-code reference](https://docs.railway.com/config-as-code/reference), [healthchecks](https://docs.railway.com/deployments/healthchecks), and [public-domain contract](https://docs.railway.com/networking/domains/working-with-domains).

## Release and licensing evidence

| Claim | Status | Evidence / decision |
|---|---|---|
| `server-v0.0.5` is the current/latest Local release | **VERIFIED** | GitHub marks `server-v0.0.5` “Latest”, released 2026-07-10 from commit `97888ce`; release title is “Pluggable embeddings for self-hosted.” |
| Linux x64 binary and SHA-256 | **VERIFIED** | Release asset `supermemory-server-linux-x64`, 299 MB, has GitHub-published SHA-256 `b2fccca3ff2b5607ce41028c759f375c4ecf5461adc9f3306f41c2757edaf375`. A companion `.sha256` asset is published. |
| Linux arm64 binary and SHA-256 | **VERIFIED** | Release asset `supermemory-server-linux-arm64`, 270 MB, has GitHub-published SHA-256 `dd3e48fbabbffc628c5f61b3d895c27abf803c5a2f9fb485d73bc72f40613c0f`. A companion `.sha256` asset is published. |
| Artifact integrity strategy | **VERIFIED** | At B5 image-build time download the named architecture asset to `mktemp -d`, compare `sha256sum` to the value above and to the corresponding published `.sha256` file, record the command output without credentials, then pin that result in the approved Dockerfile. Do not use a floating install script or `latest`. |
| Local source/license | **VERIFIED (source)** | The upstream repository labels itself MIT and Local documentation calls the self-hosted binary free/open source. |
| Redistribution/container-image rights for the exact released binary | **UNVERIFIED** | The public release page provides assets but this audit did not find an explicit binary redistribution notice, OCI image, or release-attached license text. B5 must preserve upstream notices and obtain a legal/product decision before publishing a derivative image outside OpenTag’s private build/deploy path. |
| SDK version and license | **VERIFIED** | npm currently reports `supermemory` `4.24.12`, public, with built-in TypeScript declarations, Apache-2.0, zero runtime dependencies, and a Cloudflare Workers supported-runtime claim. |

## Local server contract

| Contract requested by B0/B5 | Status | Exact evidence and implementation rule |
|---|---|---|
| `PORT` | **VERIFIED** | Local configuration documents `PORT` or `SUPERMEMORY_PORT`, default `6767`. Railway injects `PORT` and healthchecks use that value. The entrypoint must pass it through unchanged. |
| Bind host (`0.0.0.0`) | **UNVERIFIED** | Official Local documentation states a port but no `HOST`, `HOSTNAME`, or bind-address variable. Do not assert a host-binding flag or rely on loopback/public behavior until the exact artifact is smoke-tested under an approved gate. |
| `SUPERMEMORY_DATA_DIR` | **VERIFIED** | The Local config documents it, default `./.supermemory`; it holds graph data, auth secret, and model cache. Quickstart confirms all state lives there. Set it exactly to `/var/lib/supermemory` on the mounted Railway volume. |
| `DATABASE_URL` | **UNVERIFIED for “ignored”; CONTRADICTED as a required configuration** | Local docs describe an embedded graph engine with no connection string, and the environment-variable reference does not document `DATABASE_URL`. Do not provision/configure Postgres for B1. Do not claim the binary “ignores” arbitrary `DATABASE_URL` without a version-pinned runtime test. |
| LLM requirement | **VERIFIED** | Local needs at least one LLM provider for summaries, contextual chunking, and memory extraction. A non-TTY Docker launch has no wizard; configure one provider input by environment. Local embeddings do **not** remove this extraction requirement. |
| `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, `OPENAI_TEXT_MODEL` | **VERIFIED** | Local config gives default `OPENAI_MODEL=gpt-5.1`; `OPENAI_FAST_MODEL` and `OPENAI_TEXT_MODEL` default to `OPENAI_MODEL`. B0 must set all three explicitly to `gpt-5.1` and include a configuration test; availability for the approved provider/account remains an approval-time operational test, not a fact proved by docs. |
| Local embeddings | **VERIFIED** | Defaults are provider `local`, model `Xenova/bge-base-en-v1.5`, dimensions `768`; the release says it locks an embedding plan and rejects incompatible switches. Set all three `SUPERMEMORY_EMBEDDING_*` values explicitly and test them as a single immutable tuple. |
| Data, key, and auth paths | **PARTIALLY VERIFIED** | `$SUPERMEMORY_DATA_DIR` contains graph data, auth secret, and model cache. The installer writes provider keys to `~/.supermemory/env`, which it loads on launch. The exact generated Local bearer-key filename/path and auth-file format are not documented. Deployment must stop until the pinned artifact proves these paths without printing contents. |
| First-boot generated key on stdout | **VERIFIED (behavior); UNVERIFIED (safe capture details)** | Local quickstart shows first boot printing an `sm_...` bearer key and the data directory. The docs do not document a no-stdout-key mode, exact stream (stdout vs stderr), exact key file, or rotation. The redacting PID-1 entrypoint and an empty-temp-volume first-boot test are mandatory B0 gates. |
| Health/readiness endpoint | **UNVERIFIED** | The API routes document `/v3/documents`, `/v3/search`, and `/v4/search`; no official Local health endpoint was found. Do not configure Railway `healthcheckPath` until the pinned artifact proves an unauthenticated, non-content endpoint returning HTTP 200. |
| Local persistence/encryption claim | **PARTIALLY VERIFIED** | Docs call storage “encrypted embedded storage,” but do not specify cipher, key custody, scope (corpus pages vs provider credentials), or recovery model. Do not claim application-level corpus encryption in security documentation. |
| Hosted/Local feature parity | **CONTRADICTED (full parity)** | Local has full Memory API, hybrid search, local/remote embeddings, and file ingestion. Official docs say Local excludes hosted connectors, managed MCP endpoints, hosted optimized extraction, and managed global scale/organizational controls. B1 must not depend on connectors/MCP/profile organization features. |

## SDK and API contract

### Constructor and Worker compatibility

**VERIFIED:** `new Supermemory({ apiKey, baseURL, timeout, maxRetries, fetch })` is the supported constructor shape. `baseURL` is the documented one-line switch for Local. npm explicitly lists Cloudflare Workers as supported; the package uses global `fetch` and has no runtime dependencies.

**Required B0 test:** compile a minimal import against the exact locked `supermemory@4.24.12` in the Worker typecheck and execute its mocked `fetch` transport in the Workers test runtime. This guards the package’s published compatibility claim and prevents Node-only imports from slipping into the edge bundle.

### Which add method to use

| Call | Status | Rule |
|---|---|---|
| `client.add(params)` | **VERIFIED** | SDK API index and public docs expose it; its add response is `{ id, status }`. Use it for B1’s initial write if the exact pinned package compiles in Workers. |
| `client.documents.add(params)` | **VERIFIED** | Generated SDK exposes `POST /v3/documents`; functionally equivalent document-oriented surface with `{ id, status }`. Keep it behind the adapter; do not expose either SDK shape to product code. |
| `client.memories.add(params)` | **CONTRADICTED / documentation drift** | One Local quickstart example shows it, but the generated SDK API index lists only `memories.forget` and `memories.updateMemory`, while `client.add`/`client.documents.add` are listed for creation. Do not code to `memories.add` unless the exact installed 4.24.12 declaration proves it. |

### Add, polling, mutation, errors, and status

- **VERIFIED:** `POST /v3/documents`/`client.add` returns an internal `id` plus `status: "queued"`; ingestion is asynchronous.
- **VERIFIED:** `GET /v3/documents/{id}`/`client.documents.get(id)` is the documented polling route. SDK types enumerate `unknown`, `queued`, `extracting`, `chunking`, `embedding`, `indexing`, `done`, `failed`.
- **VERIFIED:** only `done` is a successful terminal state; `failed` is terminal failure. All other enumerated values are non-searchable/non-indexed. The docs’ shorter public example that says `processing` is a generic simplification, not the pinned generated type.
- **VERIFIED:** `client.documents.update(id, params)` uses `PATCH /v3/documents/{id}` and returns `{id,status}`; `client.documents.delete(id)` uses `DELETE /v3/documents/{id}`. The generated comment says delete accepts “ID or customId,” but get/update are documented by internal ID.
- **UNVERIFIED:** whether Local `server-v0.0.5` resolves update/delete by `customId` identically to the hosted SDK; whether update returns a new ID; and whether replacement reaches the same status vocabulary. B3/B4 must block with `unsupported_update_contract`/`unsupported_delete_contract` rather than guessing.
- **VERIFIED:** SDK error classes cover 400 BadRequest, 401 Authentication, 403 PermissionDenied, 404 NotFound, 422 UnprocessableEntity, 429 RateLimit, 5xx InternalServer, connection failures, and timeout. The SDK retries connection/408/409/429/5xx twice by default and has a one-minute default timeout. The adapter must set bounded timeout and `maxRetries: 0`; OpenTag, not hidden SDK retries, owns durable retry/DLQ classification.

### `customId`, metadata, tags, and search

- **VERIFIED:** `customId` is the caller’s stable source identifier; same `customId` supports deduplication/updates. B1 sets it to exactly `slack:{teamId}:{channelId}:{threadTs}` and does not derive it from content revision.
- **VERIFIED:** add metadata is a flat object; metadata values are strings, numbers, or booleans, keys are case-sensitive, and nested objects are disallowed. B1’s metadata schema must stay flat (for example, scalar IDs, timestamps, revision, status, and ACL reference only).
- **VERIFIED:** `client.search.memories({ q, containerTag, searchMode: "hybrid", filters, limit })` sends `POST /v4/search`. Hybrid responses contain either `memory` or `chunk` records and can include metadata, document linkage, version, and similarity.
- **VERIFIED:** filters use `{ AND: [...] }` or `{ OR: [...] }`; equality has shape `{ key, value }`. Use exact channel/project/status filters, but independently revalidate returned metadata and current `WorkspaceConfigDO` policy before a result becomes a citation.
- **VERIFIED:** v4 search accepts the single string `containerTag`; docs state v3 `containerTags` array matching is exact and not a partial match. No official prefix/glob tag query is documented. B1 therefore sends exactly one v4 `containerTag` value, `workspace:{teamId}`, on every add/search, and rejects multi-tag/caller-tag input at the adapter boundary.
- **UNVERIFIED:** a live Local `server-v0.0.5` cross-workspace search proof. This is still a B5/B7 gate: add synthetic documents under two exact tags, prove each query sees only its own tag, then prove metadata filters cannot broaden the result set.

## Adapter boundary and contract tests

Implement a local `SupermemoryAdapter`, not SDK objects in Queue/turn code:

```ts
type LocalDocumentStatus =
  | "unknown" | "queued" | "extracting" | "chunking"
  | "embedding" | "indexing" | "done" | "failed";

type AddAccepted = { localDocumentId: string; status: LocalDocumentStatus };
type SearchResult = { localDocumentId?: string; contentRevision: string; metadata: SlackKnowledgeMetadata; excerpt: string; score?: number };

interface SupermemoryAdapter {
  addSlackDocument(input: { tag: string; customId: string; content: string; metadata: SlackKnowledgeMetadata }): Promise<AddAccepted>;
  getDocument(id: string): Promise<{ id: string; status: LocalDocumentStatus; customId: string | null; metadata: unknown }>;
  searchSlack(input: { tag: string; q: string; filters: MetadataFilter; limit: number }): Promise<SearchResult[]>;
  replace?: (id: string, input: unknown) => Promise<AddAccepted>;
  delete?: (id: string) => Promise<void>;
}
```

The adapter derives `tag` internally from a validated team ID; the public tool never accepts it. It must map transport/network/429/5xx/timeout to a structured degraded `knowledge_unavailable` result for `search_slack`, while queue operations classify retry/permanent outcomes in the ledger. It must disable SDK debug logging, because the SDK warns debug logging can include bodies.

Minimum mock/contract suite before B1/B3 handoff:

1. Reject disabled/unconfigured source before descriptor/outbox creation; ordinary turn imports have no reachable `add` call.
2. Assert exactly `workspace:{teamId}` appears on every add and v4 search; reject empty, array, prefix, or caller-supplied tag.
3. Assert stable `customId`, flat metadata, and no content revision used as identity.
4. Fixture add returns `queued`; fixtures for every non-terminal status never set `indexed_revision` or produce citations. `done` alone does.
5. Poll timeout records `processing_unconfirmed` with the same returned `localDocumentId`; reconciliation calls `getDocument` for that ID and never issues another add.
6. Verify add/search request bodies, filter shape, status parser, error mapping, bounded timeout/retry settings, and refusal of malformed/mismatched result metadata.
7. Make update/delete capabilities absent by default; tests require an explicit verified capability fixture before edit/delete code is enabled.
8. Prove a Local-down/429/invalid-response search returns structured degradation with no query/body logging and no fabricated citation.

## Railway build, volume, network, and health contract

| Contract | Status | B5 rule |
|---|---|---|
| Docker build context/Dockerfile | **VERIFIED** | Railway detects `Dockerfile` at source root by default; `RAILWAY_DOCKERFILE_PATH`/config-as-code can select a path. Set the service root directory to `infra/supermemory/` and use `Dockerfile`, or set an explicit path in approved service configuration. Do not assume a root-repository Dockerfile. |
| Persistent mount | **VERIFIED** | Railway exposes a mounted volume at the exact configured absolute mount path at runtime only. Mount one volume at `/var/lib/supermemory`; volume writes do not exist during build/pre-deploy. |
| One volume / one replica / deploy downtime | **VERIFIED** | Railway documents one volume per service, no replicas with volumes, and a small redeploy downtime to prevent concurrent mounts. B5 must use exactly one replica and a planned maintenance/rollback sequence. |
| Non-root image + volume permissions | **VERIFIED (risk)** | Railway documents volumes mounted as root and warns non-root images may need `RAILWAY_RUN_UID=0`. Do not blindly use that variable: first prove the upstream binary’s UID and permissions. If the reviewed image must run as root to initialize the volume, record and mitigate it; if it can chown/drop privileges safely, test that exact entrypoint. |
| Public HTTPS reachability | **VERIFIED** | Railway services require an explicit generated/custom public domain; Railway-managed/custom domains have TLS. Because Cloudflare Workers cannot use a Railway private network, use the approved public HTTPS hostname plus Local bearer authentication. |
| Railway healthcheck mechanics | **VERIFIED** | Railway waits for the configured path to return HTTP 200 and injects the `PORT` used for healthchecking; default timeout is 300 seconds. `railway.toml`/JSON supports `deploy.healthcheckPath` and `healthcheckTimeout`. |
| Local healthcheck path | **UNVERIFIED — blocker** | Railway can healthcheck, but Local’s official docs do not publish a suitable endpoint. Never set `/health`, `/`, or an authenticated data endpoint by inference. |
| Railway backup/restore suitability | **UNVERIFIED for this corpus** | Volumes support manual/automated backups, but no approved synthetic restore run was performed. B7 remains blocked until an approved synthetic backup restore, authenticated add→done→search, restart-persistence, and cross-workspace authorization proof all pass. |

## Deploy-blocker table

| Blocker | Affected stages | Required evidence to clear | Owner/gate |
|---|---|---|---|
| Exact Linux artifact bytes and installer/binary behavior not locally tested | B0, B5 | Approved temporary-directory checksum verification against the pinned release; no repository extraction | B0 file-only test; B5 build approval |
| No published Local host-bind and health endpoint contract | B0, B5 | Pinned-binary smoke test proving bind behavior and a safe 200 readiness endpoint | Explicit Railway/B5 approval before any hosted test |
| Generated key/auth filename, stream, rotation and log-redaction behavior undocumented | B0, B5 | Empty temporary-volume first boot proves owner-only paths, no key/secret-pattern leak, signal propagation, and redactor coverage | B0; deployment stops on failure |
| LLM provider/account availability and approved key/data-egress ownership not demonstrated | B0, B5–B9 | Named provider/key owner and approved model availability test, with no credential in logs | Explicit secret/provider approval |
| SDK documentation drift (`memories.add` vs generated 4.24.12 surface) | B0, B3 | Exact install declaration + Workers compile/mock fetch contract test | B0 file-only |
| Status mismatch (`processing` in plan vs `indexing` SDK enum) | B1, B3, B4 | Adapter status parser/test accepts documented enum; only `done` indexes; unknown status fails closed | B0/B3 file-only |
| Local update/delete-by-customId behavior unproven | B3, B4, B8 | Pinned Local contract test using synthetic corpus, internal IDs, and terminal polling; otherwise capability remains disabled | Explicit live/synthetic gate |
| Cross-workspace isolation and backup restoration unproven | B7–B9 | Approved synthetic add/search across two exact tags, then backup restore/restart proof | Named canary/backup approval |
| Cloudflare Queue binding, Railway service/domain, secrets, Slack scope/canary/backfill, or cleanup | B5–B9 | Separate named user approval immediately before each external mutation | Respective stop gates; none are granted by this audit |

## Implementation stops

1. **Stop B5 deployment** if artifact checksum differs, the exact binary cannot provide a non-leaking first boot, or a documented/smoke-proven readiness endpoint is unavailable.
2. **Stop B3/B4 mutation code** if a pinned Local test cannot prove update/delete semantics by internal ID and terminal status. Keep capability methods absent; do not emulate deletion by a new add.
3. **Stop B7 canary/backfill** until the synthetic backup-restore, restart-persistence, and two-workspace authorization tests have all passed under their named approval gates.
4. **Stop all external actions** unless the user expressly approves the named Railway, Cloudflare, Slack, secret, canary, backfill, or cleanup action. This audit grants none.
