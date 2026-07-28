# OpenTag Supermemory Local on Railway — repository and architecture audit

**Audit date:** 2026-07-18 (read-only except this file)
**Purpose:** implementation input for the replacement knowledge-base SPEC; it is
not authority to deploy, create a Railway project/service/volume/domain, set a
secret, ingest Slack, or delete data.

## Bottom line

The checked-in `KNOWLEDGE-BASE-SPEC.md` is an obsolete hybrid of a former
Cloudflare Vectorize/D1 design and a newly inserted Supermemory section. It is
not implementation-ready. The current product has no Supermemory client,
Railway configuration, Cloudflare Queue producer/consumer, tracked-source
configuration, queue/DLQ, ingest ledger, search API, citations, or reconciliation
job. `KnowledgeDO` is only a team-keyed SQLite note store with case-insensitive
`LIKE` search ([`edge/src/memory/knowledge-do.ts:18-29`](../../edge/src/memory/knowledge-do.ts),
[`edge/src/memory/knowledge-do.ts:93-125`](../../edge/src/memory/knowledge-do.ts)).

The corrected target is one **pinned Supermemory Local server process** in one
Railway service with one persistent Railway volume mounted at
`/var/lib/supermemory`; it is a retrieval sidecar, not OpenTag's product-state
spine or Slack ingress owner. The product spine remains Cloudflare Workers and
Durable Objects. Slack continues to terminate only at `opentag-bot`
([`PRODUCT.md:50-67`](../../PRODUCT.md), [`DECISIONS.md:49-56`](../../DECISIONS.md)).

## Evidence and audit boundary

### Repository facts

| Finding | Evidence | Planning consequence |
| --- | --- | --- |
| No queue is declared in production or local bot Wrangler config. | [`edge/wrangler.bot.toml:1-97`](../../edge/wrangler.bot.toml), [`edge/wrangler.toml:1-99`](../../edge/wrangler.toml) declare DOs/R2/services only. | Add a new producer binding to `opentag-bot`, a consumer binding to a distinct knowledge Worker, a DLQ, and explicit migrations/config; do not claim an existing `opentag-knowledge-ingest` queue. |
| Current knowledge is manual, in-turn and random-ID. | `memory_write` calls `memoryWrite` with `crypto.randomUUID()` after an exact turn-effect claim ([`edge/src/tools/index.ts:517-539`](../../edge/src/tools/index.ts)); a `remember:` shortcut does the same ([`edge/src/bot-engine.ts:313-333`](../../edge/src/bot-engine.ts)). | Preserve this lightweight feature or explicitly migrate it. It cannot serve as event-driven, idempotent Slack corpus ingestion. |
| Current search returns title/body, not source provenance. | [`edge/src/tools/index.ts:502-514`](../../edge/src/tools/index.ts); record schema only has id/team/channel/title/body/blob/updatedAt ([`edge/src/memory/knowledge-do.ts:8-16`](../../edge/src/memory/knowledge-do.ts)). | New API must return stable citation fields (`sourceType`, Slack permalink/channel/thread timestamps, source revision, excerpt) and never fabricate a citation. |
| Existing thread fetch is bounded and non-paginated. | `getThreadMessages` makes one `conversations.replies` call, default limit 100 ([`edge/src/slack/web-api.ts:549-584`](../../edge/src/slack/web-api.ts)); adapter keeps `slice(-100)` ([`edge/src/slack/cloudflare-slack-adapter.ts:1584-1620`](../../edge/src/slack/cloudflare-slack-adapter.ts)). | Build a separate, pagination-aware ingest fetcher. Do not reuse conversational context fetch as a claimed “entire thread” fetch. |
| The real configuration DO only stores channel prompt/policy/access-bundle/runtime defaults. | [`edge/src/config/workspace-config-do.ts:24-40`](../../edge/src/config/workspace-config-do.ts), [`edge/src/config/workspace-config-do.ts:164-199`](../../edge/src/config/workspace-config-do.ts). | Add a versioned project/tracked-channel configuration record and authenticated control path before automatic ingestion. This must not be hidden in the existing `policies_json`. |
| Existing `/config` and admin config can mutate current channel configuration. | [`edge/src/commands/index.ts:154-190`](../../edge/src/commands/index.ts), [`edge/src/worker.ts:315-355`](../../edge/src/worker.ts). | New KB configuration needs an explicit operator/admin authorization model, audit events, validation, and disable-before-delete semantics—not an implied Slack command. |
| Slack events are acknowledged then continued in `waitUntil`, and pre-admission occurs before async work. | [`ARCHITECTURE.md:85-102`](../../ARCHITECTURE.md), [`PRODUCT.md:115-125`](../../PRODUCT.md). | The only compatible event hook is `waitUntil -> KnowledgeDO -> Queue`; it must be nonblocking and must not change turn success/failure or Slack acknowledgement. |
| Ingress normalization accepts only current conversational inputs, not all edits/deletes. | It handles `app_mention`, DM, and threaded user messages ([`edge/src/slack/ingress-normalize.ts:188-266`](../../edge/src/slack/ingress-normalize.ts)); no knowledge ingestion hook exists. | Add an independent signed-event classification path after verification that recognizes `message_changed`, `message_deleted`, roots/replies, bot/self exclusions, and canonical root timestamps without sending them to the model. |
| The bot’s state/control invariants are strict. | Stable IDs/pre-admission are locked in [`DECISIONS.md:149-179`](../../DECISIONS.md); state is divided among conversation delivery, session events, and runtime ([`ARCHITECTURE.md:170-177`](../../ARCHITECTURE.md)). | Knowledge jobs must have their own stable IDs and ledger; do not overload active-turn IDs, session events, or turn effect fences for background corpus lifecycle. |

### Platform facts verified during this audit

* Supermemory Local's current official changelog describes a self-hosted macOS/
  Linux server with local authentication and encrypted embedded storage, not a
  required Supabase/Postgres deployment ([Supermemory Local changelog](https://supermemory.ai/changelog/local/)).
  Its current release is `server-v0.0.5` (2026-07-10), with Linux x64/arm64
  binaries and SHA-256 manifests; pin this exact release and checksum before the
  first deployment rather than using an unbounded `latest` installer.
* The official installer says state is placed under `SUPERMEMORY_DATA_DIR` or
  `./.supermemory/` ([release installer, lines 303-316](https://github.com/supermemoryai/supermemory/releases/download/server-v0.0.5/install.sh)).
  The Local server is one process/machine and its embedded state requires one
  writer. The implementation contract must therefore use exactly one Railway
  replica and no multi-region/replica topology while the volume is attached.
* The deployment contract must assert verified current Local behavior: it reads
  Railway-provided `PORT`, binds `0.0.0.0`, persists all state beneath
  `SUPERMEMORY_DATA_DIR`, and ignores/removes `DATABASE_URL`. Treat this as a
  release-contract test against the pinned artifact—not an inference from the
  old document. Do **not** supply a Supabase connection string.
* Railway mounts volumes only when the container starts; they are unavailable at
  build and pre-deploy time ([Railway volumes](https://docs.railway.com/volumes)).
  A mounted path must therefore be `/var/lib/supermemory` at runtime, with
  `SUPERMEMORY_DATA_DIR=/var/lib/supermemory`; initialization/restore belongs in
  the entrypoint/start phase, not pre-deploy.
* Railway health checks govern when a deployment becomes Active, and its
  deployment history supports rollback only while retained ([Railway deployment
  reference](https://docs.railway.com/deployments/reference)). A singleton
  stateful service can still have brief deployment downtime; plan a maintenance
  window and a visible degraded retrieval mode. Health checks do not turn an
  embedded, volume-bound server into an HA service.
* Railway access was verified only to the account identity (`railway whoami`:
  William Lopez-Cordero); this checkout is **not linked to a Railway project**
  (`railway status`: “No linked project found”). Therefore no project/service,
  volume, environment, region, domain, deployment history, cost, or backup
  resource inventory is verified. Linking/selecting a project is a separately
  approved external-mutation/read-scope action; do not invent inventory values.

## Claims in the existing SPEC that must be replaced

The replacement SPEC must explicitly mark the following as superseded rather
than retain them as alternatives.

| Existing claim | Why false/superseded | Required replacement |
| --- | --- | --- |
| “Supermemory uses Postgres” and “use Supabase,” then `DATABASE_URL` ([`KNOWLEDGE-BASE-SPEC.md:84`](../../KNOWLEDGE-BASE-SPEC.md), [`:820-826`](../../KNOWLEDGE-BASE-SPEC.md), [`:835`](../../KNOWLEDGE-BASE-SPEC.md)). | Contradicts current Local encrypted embedded-store deployment contract. | One Railway service, one process/machine, pinned Local release, one `/var/lib/supermemory` volume; remove/ignore `DATABASE_URL`, Supabase and Cloudflare Container persistence claims. |
| `opentag-knowledge` Cloudflare Worker owns Queue consumer, Vectorize, D1, R2, MCP and `/kb/search` ([`:146-179`](../../KNOWLEDGE-BASE-SPEC.md)). | None exists; Supermemory owns retrieval/indexing and Railway is the sidecar. | Define a narrow `edge/workers/knowledge/` Worker as Queue consumer and authenticated Supermemory API client only; it owns no Slack ingress and no product-spine persistence. A separate search client can be in bot/agent surface after auth design. |
| D1 FTS/Vectorize/RRF/reranker/schema/cost-limit as retrieval implementation ([`:12-13`, `:32-33`, `:159`, `:871-931`](../../KNOWLEDGE-BASE-SPEC.md)). | These are the replaced backend, not additive requirements. | Supermemory Local API is retrieval backend. Retain only OpenTag source/ACL/provenance metadata required to make requests and citations safe. |
| `containerTag` is a prefix filter, so `workspace:{teamId}` sees `workspace:{teamId}:project:*` ([`:238-265`](../../KNOWLEDGE-BASE-SPEC.md)). | Tags are exact opaque namespaces, not prefix filters. | B1 writes/searches exactly `workspace:{teamId}` and includes `projectId`, `channelId`, Slack identifiers and ACL metadata. Future project isolation requires exact-tag fan-out plus merge, or deliberate duplicate writes—an explicit product decision. |
| Tracked channels/project-derived set, debounce table, queue, DLQ, ledger and consumer already have a design that maps to current code ([`:274-317`, `:674-809`](../../KNOWLEDGE-BASE-SPEC.md)). | The named tables, bindings, Worker and queue do not exist. | Treat all as new deliverables; configuration and authorization must precede the producer hook. |
| “re-fetch the entire thread” ([`:296-308`](../../KNOWLEDGE-BASE-SPEC.md)). | Current client fetches one page (100) and may return empty ([`edge/src/slack/web-api.ts:549-584`](../../edge/src/slack/web-api.ts)). | Implement paginated `conversations.replies`, ordered canonical normalization, hard caps and an explicit incomplete-thread error/retry state. |
| Slack edits/deletes directly map to D1/Vectorize updates ([`:192-199`](../../KNOWLEDGE-BASE-SPEC.md)). | Neither store/client/job exists and delete semantics are not defined for Local API. | Define revision/tombstone contract, idempotent `customId`, ingest/delete API calls, reconciliation, and evidence of eventual removal from search. |
| MCP endpoint and tools served by `opentag-knowledge` ([`:472-541`](../../KNOWLEDGE-BASE-SPEC.md)). | No endpoint, bot binding, caller authentication, caller ACL, or citations implementation exists. | Add only after source authorization and sidecar auth. Bot/agent must enforce workspace scope before sending a Supermemory request; Local must never receive a wildcard tenant tag. |
| B1 begins with service setup and immediate Slack push ([`:831-840`](../../KNOWLEDGE-BASE-SPEC.md)). | Dependency inversion: no tracked-channel/project config, consent, queue, source fetch, failure model, or restore proof first. | First build configuration/authorization and durable job control; no live ingestion until restore and exact-scope authorization gates pass. |

## Correct target contract

1. **Ingress/turn isolation.** Slack signs and posts only to `opentag-bot`.
   Its response remains immediate. After verification and normal handling, the
   bot schedules a best-effort `waitUntil` call that asks the team-keyed
   `KnowledgeDO` to mark a *configured tracked* root thread dirty and enqueue
   only a durable job descriptor. It must never call Railway or Supermemory on
   the turn path. This preserves the existing “no silent terminal outcome” and
   exact-turn contracts.
2. **State roles.** `KnowledgeDO` is a durable control ledger (tracked-source
   cache/version, dirty roots, job id/lease/attempt/outcome, backfill cursor,
   source revision/tombstone state), not a corpus/vector database. Supermemory
   Local holds its encrypted embedded retrieval state on Railway. `BOT_STATE`
   and `SESSION_EVENTS` retain their current delivery/execution roles.
3. **Exact workspace isolation.** B1 uses the sole exact opaque namespace
   `workspace:{teamId}`. Every request derives `teamId` from authenticated
   OpenTag context, never caller input alone. Source metadata carries team,
   project ids, channel ids, source keys and visibility. The API client rejects
   missing/mismatched team id and all tag strings except the canonical exact
   tag. Project filtering is metadata/reranking only in B1; it must not claim
   cryptographic isolation. Decide before B2 whether project queries fan out to
   exact tags and merge or duplicate a document into project tags.
4. **Source model.** Before auto-ingest, operators create and enable an
   immutable-audited tracked project/channel record: team, project id, exact
   Slack channel ids, enabled state, allowed source types, backfill horizon,
   retention/deletion policy, creator/approver, config version. Reject deleted,
   unconfigured, DM/private, or insufficiently authorized channels by default.
5. **Thread normalization.** A Queue consumer performs paginated Slack fetch,
   root/reply ordering, type/subtype filtering, rich text/attachments/files
   policy, attribution, timestamps, permalink construction, redaction and
   canonical serialization. It computes `customId = sha256("ot-kb-v1" +
   teamId + channelId + rootTs)`; content/revision hash is separate. The same
   `customId` is used for write/update/delete so retries are no-ops.
6. **Failure and convergence.** A durable ledger is source of truth, Queue is
   transport. Consumer claims a leased job; successful enqueue alone is not
   completion. Retry categorized transient failures with bounded attempts and
   `Retry-After`, route exhausted/validation failures to DLQ with redacted
   diagnostics, then reconcile queued/running leases and source watermarks on a
   cron. Edits regenerate same `customId`; deletes tombstone then remove or
   replace contents using the verified Local API contract. Reconciliation and
   a scoped re-index/backfill prove eventual convergence.
7. **Search and failure semantics.** Search has a 2–3 second bounded client
   deadline, authenticated sidecar credential, exact workspace tag, metadata
   filters, and source authorization re-check. Results are citations only when
   they include canonical Slack permalink/source key/revision/excerpt. On
   unavailable, unauthorized, stale, or malformed results, return a visible
   “knowledge search unavailable/no authorized evidence” status and continue a
   normal model answer without invented retrieval. Never block Slack delivery.

## Dependency-ordered work packages

Each package below is an implementation requirement, not authorization to make
an external change. `file-only` means safe code/docs/tests; `read-only
external` means inspect/verify existing external state; `external mutation`
requires a fresh, scoped operator approval.

| ID / owner surface | Deliverables and dependencies | Acceptance / validation | Rollback / autonomy |
| --- | --- | --- | --- |
| KB-0 / product + operator | Decision record selecting B1 exact-workspace metadata filtering vs later exact-tag fan-out/duplication; data classification, retention, delete, owner and incident SLO. **Before all.** | Signed decision names approver and rejects prefix-tag assumption. `grep -n 'prefix filter\|Supabase\|DATABASE_URL' KNOWLEDGE-BASE-SPEC.md` has no accepted old contract. | No external state. **file-only**. |
| KB-1 / `edge/src/config/`, `edge/src/commands/`, admin API | Versioned tracked-project/channel schema and migration in `WorkspaceConfigDO` or a new dedicated `KnowledgeConfigDO`; admin-auth control endpoints/commands; audit records; enable/disable/backfill authorization. Depends KB-0. | Unit/workerd tests: cross-team access denied, channel id validation, disabled configs never enqueue, config version is included in a job. Run `cd edge && npm run typecheck && npm test && npm run test:e2e`. | Disable config stops new jobs; retain ledger. **file-only**. |
| KB-2 / `edge/src/memory/knowledge-do.ts` | Expand/replace control DO with dirty-root, ingest-job lease, retry, DLQ reference, watermark/backfill cursor, revision/tombstone and reconciliation endpoints; deterministic job IDs. Depends KB-1. | Tests prove duplicate event/job is idempotent, lease expiry recovers, delete wins over stale update, team separation holds. Same edge validation. | Migration must be additive; disable producer before reverting reader. **file-only**. |
| KB-3 / `edge/src/slack/`, `edge/src/worker.ts` | Signed-event side hook for tracked source events; exact root normalization; `waitUntil -> KnowledgeDO -> Queue` producer. Do not alter conversational `ingress-normalize.ts` behavior. Depends KB-1/2. | Unit tests for reply/root/edit/delete/self/untracked/DM; ack remains fast; no sidecar call in HTTP handler. `cd edge && npm test`. | Feature flag off and config disabled halts production enqueue. **file-only**. |
| KB-4 / new `edge/workers/knowledge/`, Wrangler configs | New knowledge Worker, Queue producer/consumer/DLQ bindings, queue message schema/version, authenticated DO access and cron reconciliation. Depends KB-2/3. | Typecheck and worker integration tests prove at-least-once redelivery; Queue is not claimed as truth. `cd edge && npm run typecheck && npm test && npm run test:e2e`; add dedicated consumer tests. | Stop consumer/producer binding then rely on DO ledger; no data delete. **file-only**. |
| KB-5 / `edge/src/slack/web-api.ts`, knowledge Worker | Pagination-aware full-thread/history backfill fetch, normalization, Slack rate-limit handling, canonical source text, permalink/citation builder, `customId`/revision hash. Depends KB-4. | Fixtures >100 replies, edit/delete, malformed blocks/files, `Retry-After`, missing scope and paginated cursor; same canonical data yields same ID. | No write on failed/incomplete fetch; retry/reconcile. **file-only**. |
| KB-6 / `infra/supermemory/` + `railway.toml` | Pinned `server-v0.0.5` Linux artifact checksum, Dockerfile/build context/entrypoint, non-root permissions, `PORT`, `SUPERMEMORY_DATA_DIR=/var/lib/supermemory`, telemetry choice, no `DATABASE_URL`, health/readiness route probe. Depends KB-0. | Local container test proves `PORT` binding on `0.0.0.0`, persistent restart with mounted temp dir, data path only below configured directory, rejected/ignored `DATABASE_URL`, exact version/checksum. | Image is inert until deploy. **file-only**. |
| KB-7 / Railway operator | Read-only inventory first: project/env/service, region, plan, private/public networking, domain/TLS, volume size/mount, deploy history retention, backup ability, logs/metrics, cost limits. Then provision one named service and one volume at `/var/lib/supermemory`, one replica, selected region/sizing, domain/TLS only if necessary. Depends KB-6 and explicit approval. | Capture IDs/names (not secrets) in an operator runbook; health/readiness passes; replica count exactly 1; no `DATABASE_URL`; no live source ingestion. | Roll back deployment image/config; do not delete service/volume without separate cleanup gate. Inventory **read-only external**; provision **external mutation**. |
| KB-8 / Railway + security owner | Create/capture Supermemory Local initial API key once through an interactive secret-safe session; put it only in Railway/OpenTag secret stores; define dual-key rotation, revocation, access log and break-glass procedure. Depends KB-7. | Secret values never appear in repo/logs/transcript; staged client accepts current key, rotation proves old key revoked after cutover. | Restore prior key only under incident procedure; revoke leaked key. **external mutation**. |
| KB-9 / knowledge Worker + `edge/src/env.ts` | Supermemory API client, deterministic write/update/delete/search contract, per-request auth, exact canonical tag, metadata validation, timeout/circuit breaker and redacted errors. Depends KB-5/6/8. | Contract tests against local pinned server: write/search/update/delete; exact tag cannot see a second team; response maps citations; server failure does not fail Slack. | Disable client flag; ledger retains retryable state. **file-only** (uses local test runtime only). |
| KB-10 / bot/agent search surface | Authorized retrieval tool/API, caller-team derivation, allowed project/channel filtering, citation rendering, failure/degraded UX and audit metrics. Depends KB-1/9. | Tests: cross-workspace/tag injection denied, unauthorized citation filtered, no result/error visibly distinguished, normal turn still completes. `cd edge && npm run typecheck && npm test && npm run test:e2e`. | Feature flag off restores existing manual knowledge search; no corpus deletion. **file-only**. |
| KB-11 / backup + restore runbook | Encrypted volume backup schedule, retention, encryption/key custody, point-in-time metadata, restore into isolated service/volume, checksum/health/search verification, RPO/RTO and drill record. Depends KB-7/8/9. | A restore drill recovers a known fixture into an isolated instance and proves tag isolation/search, before any live ingestion. | Destroy only isolated drill artifacts with separate approval. Backup/restore configuration is **external mutation**; drill inspection is **read-only external** after approved creation. |
| KB-12 / staged activation | Local contract -> Railway smoke with synthetic team -> OpenTag staging -> limited explicitly tracked-channel canary -> approved backfill -> production activation -> monitoring. Depends KB-10/11. | Gate checklist: restore passed; exact-scope authorization passed; no DLQ/reconciliation threshold breach; citations valid; bounded cost/latency/error telemetry. | Disable tracked channel then producer, stop consumer, roll back client image/config; keep data/volume until cleanup approved. Canary/backfill/activation are **external mutation**. |
| KB-13 / operator cleanup (separate) | Data export/retention evidence, disablement confirmation, key revocation, backup disposition, service/domain/volume deletion plan and two-person confirmation. Depends a future approved decommission decision—not KB-12 completion. | Explicit written targets and successful export/retention proof before any delete. | No implicit rollback after volume delete; use approved backup only. **external mutation**. |

## Deployment, operations, and cost contract to carry into the SPEC

* **Release/build:** pin `server-v0.0.5`, Linux architecture and SHA-256 in a
  reviewed Dockerfile/lock manifest; no curl-to-latest in an image build.
  Build context must be the dedicated `infra/supermemory/` directory (or an
  explicitly reviewed monorepo subdirectory), with a `.dockerignore`. Record
  binary checksum and Local API contract version in deployment metadata.
* **Runtime:** one process, one machine, one replica, no replicas/multi-region
  while volume-backed. Railway supplies `PORT`; local server listens on
  `0.0.0.0`. Set `SUPERMEMORY_DATA_DIR=/var/lib/supermemory`; do not set
  `DATABASE_URL`. Define an explicit embedding/provider configuration and lock
  it before corpus data enters the instance—the current Local release locks
  embedding selection to prevent vector mixing ([Supermemory Local
  changelog](https://supermemory.ai/changelog/local/)).
* **Network/auth:** prefer private Railway networking plus OpenTag egress only;
  if a public domain is required, use Railway-managed TLS and a narrow endpoint
  allowlist. The sidecar API key is a secret, never Worker source/config. Run
  an authorization test from an untrusted caller and a same-workspace caller.
* **Readiness:** configure Railway healthcheck to an authenticated-safe,
  dependency-ready endpoint, separately assess liveness/readiness, and set
  timeout/startup budget. A passing TCP/process check is insufficient: it must
  prove volume writable, encrypted store loaded, key/auth configured, and the
  selected embedding plan compatible. Railway config supports healthcheck path,
  timeout and restart policy ([Railway config-as-code
  reference](https://docs.railway.com/config-as-code/reference)).
* **Backup/upgrade/rollback:** snapshot before upgrade; drain/stop consumer and
  preserve DO ledger; deploy new pinned image; health/search smoke; resume;
  observe. For failure, disable consumer/client, roll back the retained Railway
  deployment, and restore only after compatibility check. Railway rollback has
  retention limits, so it is not a data backup ([Railway deployment
  reference](https://docs.railway.com/deployments/reference)). Expect brief
  stateful deployment downtime and communicate degraded search semantics.
* **Observability:** structured redacted logs with job id/customId/team hash,
  config version, request outcome, retry class/attempt, queue age, reconciliation
  lag, sidecar latency/error, result/citation count, volume free space,
  backup/drill age and API-key rotation state. Alert on health failure, near-full
  volume, DLQ growth, stuck lease, cross-scope rejection spike, restore drill
  overdue, and cost cap approach. Do not log Slack text or keys.
* **Cost:** prior to mutation, select region close to OpenTag/Slack users, set
  RAM/CPU/volume ceilings, backup retention and egress/domain policy, and add
  alert thresholds. Record budget owner and hard stop rule. No estimate is
  credible until the missing Railway project inventory and representative
  synthetic-corpus load test exist.

## Deterministic staged acceptance gates

1. **Local file/contract gate:** all KB-1–10 code/tests pass; pinned server
   starts on an arbitrary `PORT` and `0.0.0.0`; restart retains data only through
   mounted `SUPERMEMORY_DATA_DIR`; `DATABASE_URL` has no dependency; cross-team
   exact-tag test returns zero foreign documents.
2. **Railway smoke gate (no production corpus):** approved isolated service
   inventory captured; one volume mounted at exact path; health/readiness,
   synthetic write/search/update/delete, backup and isolated restore drill pass;
   one key captured without exposure. No Slack producer enabled.
3. **OpenTag staging gate:** signed Slack fixtures prove event acknowledgement
   timing, `waitUntil -> KnowledgeDO -> Queue`, full pagination, deterministic
   IDs, retries/DLQ/reconciliation, edit/delete convergence and citation links;
   sidecar outage remains a visible retrieval degradation, not a turn failure.
4. **Canary gate:** operator enables exactly one approved tracked channel and
   project; verify ACL/tag isolation, queue age, cost, no unapproved source,
   citation correctness and restore proof. Automatic ingestion is otherwise
   disabled.
5. **Backfill/production gate:** scoped approved horizon only; rate limits and
   capacity headroom pass; reconciliation reaches zero eligible drift; alerting
   and rollback owner are live. Broader activation requires a separately recorded
   approval.

## Non-negotiable drafting checklist

The replacement canonical SPEC must say, without ambiguity: Supermemory Local
uses an encrypted embedded store on one Railway service/one volume; its current
process reads Railway `PORT`, binds `0.0.0.0`, persists under
`SUPERMEMORY_DATA_DIR`, removes/ignores `DATABASE_URL`, is one process/machine,
cannot use Railway replicas with that volume, and has brief deploy downtime.
It must say tags are exact opaque namespaces; B1 is exactly
`workspace:{teamId}` plus metadata; project isolation later needs exact-tag
fan-out/merge or intentional duplication. It must preserve Slack-at-bot,
`waitUntil -> KnowledgeDO -> Queue`, out-of-turn sidecar behavior, product-spine
separation, and the explicit no-deploy/no-delete gate.

The final SPEC should replace—not append to—the old D1/Vectorize/Supabase/DLQ
claims and should keep this audit's unverified Railway inventory fields marked
as operator inputs, not guessed facts.
