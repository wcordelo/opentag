# B0–B2 repository integration audit

**Scope.** File-only audit on 2026-07-19. No application source, canonical document, deployment configuration, secret, Queue, Slack, Railway, or Cloudflare resource was changed. The pre-existing dirty worktree is preserved.

> **Current-state reconciliation (2026-08-02).** This historical audit records
> the earlier `waitUntil` scheduling design. The current source has moved the
> knowledge-event durability fence before acknowledgement into
> `DeferredIngressDO`; outbound observation and recovery also have durable
> ingress owners. Keep the findings and review history intact, but use
> [`docs/current-state.md`](../../docs/current-state.md) for current behavior.

## Confirmed current topology

`edge/src/worker.ts` is the sole bot module: it exports the five current DO classes and a Hono application as its default export (`ConversationStateDO` through `SlackRateLimitDO` at lines 65–70; `export default app` at line 849). Production `edge/wrangler.bot.toml` names that module `opentag-bot` (lines 1–8); Slack Events, commands, and interactions therefore already terminate at the right Worker. The signed Events route begins at `worker.ts:477`, Commands at `:713`, and Interactions at `:789`. `slackVerify()` reads and HMAC-verifies the raw body before it parses/sets request variables and calls the route (`edge/src/slack-verify.ts:44–79`).

For ordinary Events, the route returns a JSON acknowledgement at `worker.ts:710`; asynchronous turn work is attached with `c.executionCtx.waitUntil()` at `:700–706`. Commands have the same pattern at `:737–786`. Interactions intentionally differ: non-quick HITL actions persist before a 200 (`:818–829`), and quick actions persist a DeferredIngress alarm before 200 (`:831–846`). Do not move those durability fences or route Slack traffic to a Queue/another Worker.

The existing ownership split is compatible with the SPEC: `WorkspaceConfigDO` is per-team configuration (`DECISIONS.md:15–20`), `KnowledgeDO` is per-team longer-term memory, and the conversation/session DOs own turn/effect/Stop fences (`DECISIONS.md:149–193`). Existing `KnowledgeDO` is an SQLite-backed manual-note store only: `/write` upserts `knowledge` at `knowledge-do.ts:70–91`, `/search` queries it at `:93–126`, and `memoryWrite`/`memorySearch` use those exact RPCs at `:132–159`. The existing tools call those helpers at `tools/index.ts:502–541`; the mention shortcut calls `memoryWrite` at `bot-engine.ts:313–333`. B1 must leave all of these semantics and rows intact.

## B0: configuration and contracts

### Authoritative versus derived configuration

`WorkspaceConfigDO` is the only present authoritative configuration owner. Its `channel_config` schema is migrated by `workspace-config-do.ts:24–80`; `getConfig` has a channel-specific lookup **then falls back to `channel_id = ''`** (`:88–160`), and absent rows synthesize permissive defaults (`allowMemoryWrite: true`, `allowTasks: true`, `:153–160`). Its generic `/putConfig` upsert is at `:164–199`; `/admin/config` simply authenticates with `ADMIN_SECRET` and writes that generic shape (`worker.ts:315–357`).

That fallback/default is correct for existing turn settings but is unsafe for ingestion. Add a separate, schema-versioned `TrackedKnowledgeSource` contract in `edge/src/config/knowledge-config.ts`, with `enabled: false` as its only default, and a separate `tracked_knowledge_sources` table owned by `WorkspaceConfigDO`. It must use an exact primary key such as `(team_id, project_id, channel_id)` and retain a monotonically changed `config_version`; it must not be serialized into `WorkspaceChannelConfig.policies`, inherit the empty-channel row, or treat a missing row as enabled. Provide explicit DO RPCs such as `getTrackedKnowledgeSource({ teamId, projectId, channelId })` and `putTrackedKnowledgeSource(...)`; only the latter admin/configuration surface can enable a source.

`KnowledgeDO` may cache a versioned copy solely to cheaply reject stale descriptors. It is not an authority: before descriptor creation, the `waitUntil` scheduling function must load the exact source from `WorkspaceConfigDO`, reject missing/disabled/mismatched sources, and pass its version to `KnowledgeDO`. On a version mismatch the ledger consumer must no-op; it must never refresh from a caller-provided policy or enqueue anyway.

### Authorization seam requiring a decision

The current repository has no project entity, project-to-channel relation, requester identity on `/admin/config`, or Slack membership/authorization verifier. `WorkspaceChannelConfig` has only `teamId`, `channelId`, generic policies, bundle, and runtime defaults (`config/access-bundle.ts:16–27`); `requireAdminAuth()` protects the current admin routes with a shared bearer secret, not a workspace-scoped actor. Thus the SPEC requirement to validate the requesting admin's exact workspace/channel/**project** authorization cannot be implemented by reusing the current route alone.

**Stop before enabling any source unless the implementer obtains/records an authorization contract:** either a new administrator identity and authoritative project/channel policy source, or an approved definition that the authenticated workspace admin owns an explicit static project/channel mapping. B0 can safely add disabled schema, strict shape validation, and tests now, but must not claim this missing authorization proof exists or create a default mapping.

### B0 immutable contract module

Put all pure values and validators in `edge/src/memory/knowledge-contract.ts`, rather than in handlers:

```ts
export function workspaceTag(teamId: string): `workspace:${string}`;
export function slackSourceKey(teamId: string, channelId: string, threadTs: string): string;
// sourceKey === `slack:${teamId}:${channelId}:${threadTs}`
// customId === sourceKey; never accept a tag/customId from a tool or Queue body.
```

The only B1 tag is the exact opaque result `workspace:${teamId}`. Do not perform `startsWith`, prefix search, globbing, or a project/channel tag. Project/channel remain validated metadata and policy filters. The B0 contract should also own `SlackKnowledgeMetadata`, `KnowledgeCitation`, limits, canonical revision input shape, and the typed `KnowledgeJob` required by the SPEC (`KNOWLEDGE-BASE-SPEC.md:77–104, 114–124, 130–136`).

`edge/package.json` currently has no Supermemory SDK (lines 26–43). A B0 SDK addition must be an exact version in both `edge/package.json` and `edge/package-lock.json`; the public pin/API/artifact/key-path/first-boot proof is a B0 read-only verification gate, not something this repository can infer. The repository also contains no `infra/supermemory/` directory. Add its Dockerfile/entrypoint tests only after that verification identifies the supported artifact and key path. If the pinned release cannot prove `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, `OPENAI_TEXT_MODEL` = available `gpt-5.1`, local `Xenova/bge-base-en-v1.5` at 768 dimensions, asynchronous document status, redaction, and signal behavior, record the explicit stop—do not substitute a provider or `latest`.

### B0 tests

Use a pure `edge/test/knowledge-config.test.ts` for disabled/missing rejection, exact tag/source key/customId, metadata validation, and no-prefix cases. Add a `*.workers.test.ts` companion for real DO SQL migration/RPC behavior: the e2e configuration includes only `test/**/*.workers.test.ts` (`edge/vitest.workers.bot-store.config.ts:9–18`) and already binds `WORKSPACE_CONFIG`/`KNOWLEDGE` (`edge/wrangler.bot-store.toml:12–26`). `edge/test/store.workers.test.ts:21–83` demonstrates fresh named DO stubs and config round trips. Do not rely only on Node mocks for additive DO migration.

## B1: descriptor ledger, alarm outbox, and Queue

### Safe additive migration and transaction boundary

Keep `knowledge` untouched. `KnowledgeDO` currently runs only `CREATE TABLE IF NOT EXISTS knowledge` and an index (`knowledge-do.ts:18–29`), then guards a lazy migration with `migrated` (`:51–63`). Add new tables (for example `knowledge_ledger`, immutable `knowledge_events`/dedupe, and `knowledge_outbox`) rather than altering or repurposing legacy manual rows. If an additive column is unavoidable, follow the current `PRAGMA table_info` then `ALTER TABLE ADD COLUMN` pattern in `WorkspaceConfigDO` (`workspace-config-do.ts:49–80`). Prefer constructor-time `ctx.blockConcurrencyWhile` migration, as `SessionEventDO` does at `session-event-do.ts:528–546`, so no RPC observes half-migrated state.

Use `this.ctx.storage.transactionSync()` for the synchronous SQLite transaction that: validates descriptor identity, coalesces by `(team_id, channel_id, thread_ts)`, records desired revision/config version/dedupe, and persists an outbox row before marking it eligible to send. The repository's documented SQL seam confirms this is the crash-atomic runner (`store/sql.ts:21–39`), and the installed Workers type exposes `transactionSync` (`@cloudflare/workers-types/index.d.ts:717–754`). `setAlarm()` is asynchronous, so it cannot be awaited inside that synchronous SQL transaction. Commit the durable outbox first, then arm the earliest bounded debounce alarm; if arming/send fails, retain `outbox_pending`, surface retryable failure, and have every subsequent enqueue/alarm/constructor recovery re-arm the earliest pending row. Never mark an outbox row sent until `Queue.send()` resolves.

This is the required recoverability shape:

```text
waitUntil schedule -> WorkspaceConfigDO exact enabled lookup
  -> KnowledgeDO transactionSync(ledger + outbox pending)
  -> setAlarm(debounce)
alarm -> transactionSync(select/lease outbox) -> KNOWLEDGE_QUEUE.send(descriptor)
  -> transactionSync(mark queued) | retain pending + backoff + re-arm
Queue consumer -> KnowledgeDO lease/stale/version decision -> ack/no-op or retry
```

The existing `DeferredIngressDO` is the closest alarm precedent: it persists a job then arms an alarm (`deferred-ingress-do.ts:31–62`), marks running before its external handoff (`:68–104`), and retains retry state/backoff (`:113–141`). Reuse the *shape*, not its one-job-per-DO storage model. Knowledge needs its separate SQL ledger/outbox because it coalesces many source keys in one per-team DO.

### Exact Event hook

Install a small `scheduleKnowledgeFromSlackEvent(...)` call only in the verified `/slack/events` route, after `slackVerify()` has run and after the event has been structurally narrowed to a candidate message/change/delete with exact `teamId`, `channelId`, and `threadTs`. Attach it with `c.executionCtx.waitUntil(...)` immediately before the successful acknowledgement path at `worker.ts:700–710`; it must not sit inside `run()` (`:623–667`), `adapter.handleEventsBody`, an agent tool, Commands, or Interactions. The scheduled function is allowed to call `WorkspaceConfigDO` then `KnowledgeDO`; it must never fetch Slack pages or call Supermemory.

Preserve pre-ack persistence paths for file turns/late files and interaction choices exactly as they are. A source that is absent, disabled, lacks an exact project/channel policy, or fails validation returns without a descriptor/Queue send. This both satisfies prompt acknowledgement and prevents automatic capture from the current permissive generic channel-config fallback.

### Queue interfaces and Worker export seam

There is no Queue binding or `queue()` export in the repository today (`Env` lists only DO/R2/Fetcher bindings at `env.ts:16–89`; `worker.ts` exports only Hono at `:849`). The installed Workers types provide `Queue<Body>.send` and `MessageBatch<Body>` with individual `ack()`/`retry()` at `@cloudflare/workers-types/index.d.ts:2353–2429`.

Add an optional `KNOWLEDGE_QUEUE?: Queue<KnowledgeJob>` binding to `Env` and the corresponding narrow `KnowledgeDO` environment type. Optional is important: a local/current production deployment without a Queue binding must leave ledger rows pending/disabled, not throw during normal Slack handling or silently use another service. The worker must expose a module `queue(batch, env, ctx)` alongside `fetch`. Hono itself is currently the default object and test code calls both `.request` and `.fetch` (for example `worker-deferred-ingress.test.ts:128–139`, `admin-permissions.test.ts:54–75`). The least-disruptive implementation is to attach a typed `queue` handler to the Hono app object, preserving its existing `request` and `fetch` methods; exporting a new `{ fetch, queue }` object instead would require updating all direct-import route tests. Validate the chosen Hono/TypeScript shape with `npm run typecheck`.

The Queue handler must process descriptors only. For each message, acquire a ledger lease; stale/duplicate/config-version-drift work is an explicit successful no-op and calls `message.ack()`. Retryable/lease-loss failures call `message.retry({ delaySeconds })`; malformed config/policy/unsupported capability receives classified permanent handling and is allowed to reach the configured DLQ. It must not call Supermemory in B1, and B2/B3 network work must remain reachable only from this handler—not Slack acknowledgement or an ordinary turn.

### Wrangler configuration and disabled-by-default strategy

Current production config is `edge/wrangler.bot.toml`, name `opentag-bot` (lines 1–8), with no `queues` section; local default is `edge/wrangler.toml` (lines 1–7). The installed Wrangler schema accepts this exact TOML form:

```toml
[[queues.producers]]
binding = "KNOWLEDGE_QUEUE"
queue = "<approved-knowledge-queue>"

[[queues.consumers]]
queue = "<approved-knowledge-queue>"
max_batch_size = <approved-bounded-size>
max_batch_timeout = <approved-seconds>
max_retries = <approved-count>
retry_delay = <approved-seconds>
max_concurrency = <approved-limit>
dead_letter_queue = "<approved-knowledge-dlq>"
```

This matches the installed schema (`edge/node_modules/wrangler/config-schema.json:580–635`) and current Cloudflare Queue documentation ([configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/), [handler/delivery semantics](https://developers.cloudflare.com/queues/reference/how-queues-works/)). A single Worker may be producer and consumer, and a queue has one active consumer; `opentag-bot` is therefore the correct configured consumer. The DLQ must be an approved named queue: current documentation says a missing named DLQ can be auto-created when consumer configuration is deployed, so adding this section is an external Cloudflare mutation.

**Do not add live Queue names/sections to `wrangler.bot.toml` until the Queue/DLQ names, retention, retry, and C1 deployment approval are explicit.** For B1 local code, retain the absent production section and optional Env binding; unit/workerd tests use fakes or a local-only test configuration. A commented non-deployable template may document the exact future shape, but it is not proof of a configured resource and must not be enabled by default. This reconciles the B1 deliverable's configuration file reference with its own dependency/gate.

### B1 tests

Create `edge/test/knowledge-ledger.test.ts` around a pure ledger engine with a Node SQLite executor, and `edge/test/knowledge-ledger.workers.test.ts` for migration/transaction/alarm recovery against the actual DO binding. The existing `test/sqlite-state-store.ts:1–60` is the model for a `node:sqlite` SQL adapter and transactional test seam; `store.workers.test.ts` is the model for real workerd isolation. `edge/test/knowledge-queue.test.ts` should call the exported queue handler with `MessageBatch`/message fakes and assert: duplicate/out-of-order descriptor = one desired effect; version drift = ack/no-op; `send` failure leaves outbox recoverable; Queue handler execution is the only consumer entry point. Add a signed `/slack/events` test modeled on `worker-deferred-ingress.test.ts:17–105` that captures `waitUntil`: disabled/unconfigured candidates create no descriptor and never call Queue, while enabled candidates schedule only the DO descriptor handoff.

## B2: Slack pagination and canonical normalization

`SlackWebClient.getThreadMessages` is deliberately unsuitable for ingestion. Its interface returns only an array (`web-api.ts:47–63`), calls `conversations.replies` exactly once with default `limit = 100` (`:549–567`), and catches every failure to log/return `[]` (`:568–584`). That erases `has_more`, `response_metadata.next_cursor`, HTTP 429, error code, and ambiguity; an ingestion path using it could falsely treat a partial/failed thread as complete.

Build `edge/src/slack/knowledge-thread-fetcher.ts` as a separate injected page reader. It should call `conversations.replies` with `{ channel, ts: threadTs, cursor, limit }`, preserve the full page envelope (`ok`, `messages`, `has_more`, `response_metadata?.next_cursor`), and return a discriminated outcome:

```ts
type CompleteThread = { status: "complete"; messages: SlackThreadMessage[]; pages: number; bytes: number };
type IncompleteThread = { status: "incomplete"; reason: "page_cap" | "message_cap" | "byte_cap" | "cursor_missing" | "cursor_loop" | "slack_error" | "retry_exhausted" | "transport_error"; cursor?: string; pages: number; messages: number; bytes: number };
```

Keep `getThreadMessages` unchanged for normal agent turns. Its low-level `api()` does form-urlencode correctly (`web-api.ts:283–345`), retries a 429 twice by default using `Retry-After` (`:324–344`), and its existing test proves identical-body retry (`test/slack-web-api.test.ts:62–116`). Reuse or extract that low-level scheduler/retry discipline, but expose typed terminal failures to the B2 fetcher rather than swallowing them. The production scheduler is a per-channel DO reservation when `SLACK_RATE_LIMIT` is bound (`web-api.ts:156–205`); use it for every page attempt, including retries. Do not download private file contents; normalize only an explicitly approved limited message representation.

Put deterministic normalization in `edge/src/memory/normalize-slack-thread.ts`. Sort chronological by Slack timestamp and deterministic tie-breaker, deduplicate repeated `ts`/`client_msg_id`, normalize Unicode and newline/whitespace policy, remove volatile transport fields, apply documented bot/system/deleted/unsupported markers, then hash a stable serialized canonical value with SHA-256. The hash input must contain policy-visible metadata and not request/page order. This module returns no `complete` result when the fetcher says incomplete; only complete canonical content can become a desired revision or eventual write.

### B2 tests

`edge/test/knowledge-thread-fetcher.test.ts` should inject scripted page responses and assert a 101+ message fixture consumes all permitted cursors in order. Include: cursor repeat/missing while `has_more`, 429 after retry budget, non-`ok` Slack envelope, transport throw, page/message/byte cap, and a duplicate timestamp/client ID across pages. Every one must return `incomplete`, with no normalizer/write invocation. `edge/test/normalize-slack-thread.test.ts` should permute equivalent pages/messages and vary Unicode/newlines/whitespace to prove identical revisions, then modify permitted text or policy-visible metadata to prove a changed revision. Existing global-fetch tests use `vi.stubGlobal`/`vi.unstubAllGlobals` (`test/slack-web-api.test.ts:1–30`); prefer injected fetch/page seams so pagination tests do not couple to ordinary-turn behavior.

## Required implementation order and risk register

1. **Resolve B0 authorization and pinned Local contracts first.** Add only disabled exact-source config and pure contracts until the project/channel authorization and upstream API/first-boot facts are proved. This is the highest-risk seam because the present generic config fallback is permissive and has no project authorization model.
2. **Add B1 ledger engine and additive DO migration next.** Preserve `/write`, `/search`, and the `knowledge` table; prove transaction/outbox/alarm recovery before adding a live Queue binding.
3. **Add the verified Events `waitUntil` descriptor hook and optional Queue handler.** Keep all Slack pre-ack durability/fence routes intact and prove the queue handler is isolated from turns.
4. **Implement B2 as an independent paginated reader and canonicalizer.** Do not extend normal `getThreadMessages`; incomplete is a non-write outcome.
5. **Stop before any Wrangler Queue/DLQ deployment/configuration, secret, Railway, Slack scope, canary, backfill, or cleanup action.** Queue names/policy and the C1 gate are not present in this checkout; B5–B9 remain separately gated.

## Contradictions and explicit stops

- The SPEC requires exact project/channel authorization before enablement, but the current code has neither project ownership data nor actor-scoped admin identity. A shared `ADMIN_SECRET` route cannot prove that claim. Disabled schema is safe; live source enablement is blocked pending the authorization decision.
- B1 names `edge/wrangler.bot.toml` but no Queue/DLQ names or retry/retention policy have been approved. A real consumer configuration can provision/configure resources at deploy time. Keep it absent until the named Cloudflare gate; do not mistake file-only code for an approved binding.
- The current default export is Hono, not a module object with `queue()`. Adding a Queue handler changes the export/type/test seam and must preserve direct `.request`/`.fetch` callers or update tests deliberately.
- Current one-page Slack retrieval collapses failure to `[]`; it cannot be reused for ingestion without violating the SPEC's incomplete/no-write rule.
- No checked-in Supermemory release/API/key-path/model/first-boot evidence exists in the audited source. B0 must verify it read-only and stop explicitly if it cannot prove the required pin/behavior.
