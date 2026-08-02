# Platform and routing foundation

Status: **source-complete metadata foundation; synthetic-live; external effecter and connector broker still gated**

Updated: **2026-08-01**

This document records the architecture that is now explicit in code and the
parts that remain product or infrastructure gates. It prevents a future
connector, OAuth flow, billing path, or memory policy from bypassing the
existing durable execution and authorization contracts.

See [current-state.md](./current-state.md) for deployment versions, live
Slack/Buzz checks, the synthetic platform run, and remaining gates.

## Request correlation

`edge/src/observability/trace-correlation.ts` treats the durable
`executionId` as the turn trace id. The same bounded record carries the
`threadKey` and optional workspace id across the Slack lifecycle, the
`AGENT_RUNTIME` service binding, the harness binding, connectors, and router
telemetry. The Worker sends only `x-opentag-*` correlation headers; prompts,
transcripts, provider payloads, tokens, and query text are not trace fields.

Trace events are category-level JSON lines. Attribute names that could contain
content or secret material are dropped. This is phase-one correlation, not a
claim that an external tracing backend or distributed span collector is live.

## Bounded raw company-context queries

The admin-only `/mcp/knowledge` endpoint now has a `query_template` tool. It
accepts only these server-owned templates:

- `recent_channel_memory`: bounded recent notes for one team/channel;
- `memory_record`: one exact memory record, optionally channel-scoped;
- `source_state`: one exact ledger source state, with lease tokens redacted.

There is no SQL, table, `where`, arbitrary filter, ordering, or caller-chosen
addressing field in the request. The Knowledge Durable Object owns the fixed
statements and verifies the requested team before returning state. The result
is an operator diagnostic/evidence surface, not a replacement for per-principal
OAuth authorization. Internal actor-bound knowledge tokens are the selected
Layer 3 direction; `ADMIN_SECRET` remains restricted to operator/admin routes
and diagnostic bootstrap operations.

## Router shadow mode

`edge/src/router/classifier.ts` implements the versioned v1 heuristic table
from `ROUTER-SPEC.md`: explicit `/ask` and `/task` signals, retrieval and
construction families, clause-boundary matching, code veto, mixed-signal
fallback, and long-running `tier3Flag` features. It is pure and has no model
or dispatch side effect.

`edge/src/router/shadow.ts` records the counterfactual tier, rule, confidence,
surface features, and classification latency while setting
`tierDispatched: 2` for every request. The Slack lifecycle invokes it after a
turn has a durable execution identity. No Tier 1 answer path, Tier 3 compute,
model classifier, billing charge, or user-visible routing change is enabled
by this implementation. `RouterMeasurementDO` now stores the category-only
dispatch record per workspace, idempotently records the eventual Tier 2
outcome, exposes bounded operator summaries/lists, and retains a separate
30-day, 4 KiB-bounded misroute-feedback ledger for future Tier 1 escalation
labels. It is measurement infrastructure only; it cannot dispatch a tier.

## Layer 3 contracts

`edge/src/platform/layer3-contract.ts` is deliberately a contract/validation
layer, not a fake provisioning service. The deployed `PlatformStateDO` is a
metadata ledger; a synthetic live run exercised its state transitions, but no
provider side effect is implied. It covers:

- idempotent provisioning requests and the complete DO/Slack/default-bundle
  footprint;
- opaque identity and credential custody references with public metadata only;
- curated connector marketplace entries and OAuth grants;
- execution-linked, idempotent usage meter events for knowledge, agent,
  connector, and container tiers;
- retention, channel opt-out, deletion-epoch, and explicit memory deletion
  request contracts; and
- secret-free external effect intents with idempotent leases, retries, and
  terminal completion/cancellation.

`edge/src/platform/platform-state-do.ts` now provides the durable metadata
ledger for those contracts. Tenant records are sharded by a deterministic
canonical internal tenant UUID; the platform-wide connector marketplace uses
one reserved object. The ledger provides:

- idempotent provisioning receipts and monotonic step advancement, becoming
  `active` only after every required footprint has an external receipt;
- versioned identity and credential custody references with terminal
  revocation;
- curated marketplace versions and terminal connector revocation;
- credential-linked OAuth grant versions with terminal revocation;
- execution-linked, idempotent usage-meter receipts with bounded listing; and
- monotonic memory policies plus deletion requests that remain `requested`
  until an approved external deletion worker completes them; each requested
  source can now receive a durable `deleted`, `not_found`, or `failed` receipt
  and the request becomes `completed` only when every source has a successful
  terminal receipt.

## External effect handoff

`platform_effect_intents` is the only durable handoff between the metadata
ledger and an external provisioning, custody, OAuth, marketplace, billing, or
memory worker. An intent contains only a bounded target reference and sorted
metadata; recursive validation rejects provider tokens, OAuth codes, prompts,
queries, bodies, and other secret-shaped fields.

The lifecycle is:

1. A state transition records its own metadata and an idempotent effect intent
   in the same SQLite transaction.
2. The bot publishes a queue wakeup containing only the internal
   `PlatformStateDO` object name. A bounded admin wake route remains available
   for recovery when the queue is unavailable.
3. An effect worker claims the intent with a short lease and receives the
   validated intent metadata plus an opaque lease token.
4. The effecter performs the provider call outside the Durable Object, then
   reports `complete` with a bounded external receipt reference or `failed`
   with a safe error code and retry policy.
5. A revoked or superseded operation can cancel the intent; an expired lease
   is reclaimable, while an active lease cannot be double-claimed.

Provisioning, identity/credential revocation, OAuth grant rotation/revocation,
marketplace curation/revocation, billing meter events, and memory deletion
requests now create these intents automatically.
The ledger still does not perform the external effect. The isolated branch now
contains a separately authenticated baseline effecter Worker for this boundary;
it registers no provider adapters and therefore fails closed until custody,
provider, and billing decisions are approved. The queue and effecter service
binding are dispatch architecture only; they do not imply that an external
provider or credential custody system is configured.

The Worker exposes these operations only behind the existing admin secret. The
ledger is an audit/state boundary, not the effecter: it does not perform a
Slack install, mint keys, run an OAuth callback, call a billing provider, or
delete knowledge.

Memory deletion receipts are source-scoped and epoch-bound. The external
executor may record only a requested source, and duplicate receipt retries are
idempotent. `not_found` is treated as a successful absence proof; any
`failed` receipt makes the request terminally failed rather than silently
claiming completion. The receipt ledger stores bounded metadata and an opaque
external receipt reference, never memory contents or deletion payloads. The
executor still owns the actual deletion and must report receipts through the
admin/effect boundary.

Provisioning step advancement is receipt-bound. Each required step must carry
an opaque external receipt reference and observed timestamp; completion without
that evidence is rejected. The ledger retains the bounded receipt per step and
does not treat a tenant as active until every required step has a terminal
`complete` receipt. Failed steps remain retryable only when the external
executor explicitly marks them retryable; the ledger never fabricates a
successful Slack install, Durable Object creation, key-custody operation, or
access-bundle result.

The validators reject secret-bearing fields. The following decisions are
still required before these contracts become live product surfaces:

1. production tenant locator and per-team DO onboarding;
2. tenant-scoped custody broker semantics alongside deployment Worker Secrets;
3. curated-only marketplace trust and OAuth callback ownership;
4. hosted billing boundary, plan/overage policy, and source-of-truth ledger;
5. retention/deletion guarantees and compliance requirements for hosted memory.

The baseline effecter does not silently choose one of those alternatives, run
an OAuth callback, store a provider token, charge a plan, or delete live
customer knowledge.
The platform-state ledger records explicit bootstrap requests and externally
verified receipts without marking a tenant active until the required steps are
reported complete.

## Current deployment evidence

The current Worker returned HTTP 200 from `/health`. A synthetic tenant
completed the idempotent provisioning plan, custody references, OAuth and
marketplace metadata, metering, memory governance, effect leases, retry/reclaim,
completion, and cancellation. The identity read path was corrected after the
first live probe passed the request wrapper an object instead of its
`identityRef`; the focused test and the post-fix live read both pass.

The platform effect ledger is intentionally not an effect worker. Its pending
intents are the durable handoff to a separately deployed provisioning,
credential, OAuth, billing, or deletion worker. The admin forwarding routes are
not a replacement for that worker.

## Remaining activation gates

- Drive search is implemented behind the connector authorization contract, but
  needs a deployed `CONNECTOR_CREDENTIALS` broker and approved Google OAuth/key
  custody path before it can run live.
- Knowledge MCP search still needs the existing Supermemory configuration and
  knowledge rollout gates. Raw templates use the local KnowledgeDO and do not
  imply that Supermemory ingestion is active.
- The router remains dark until the shadow dataset is measured and the Tier 1
  knowledge gate, Tier 1 synthesis/fallback path, escalation affordance, and
  product-facing feedback controls are implemented. The workspace-scoped
  measurement and misroute ledgers are now present, but Tier 1 is still not
  enabled and no feedback control currently routes a user turn.
- The platform-state migration, effect leases, and admin routes are deployed
  and synthetic-live, but the production bootstrap authority, tenant locator
  integration, identity/key custody worker, Slack OAuth callback, marketplace
  trust review process, billing/plan enforcement, memory deletion executor,
  and credential broker are not live.
- Worker Secrets are the approved deployment/bootstrap mechanism. They are not
  a complete per-tenant custody backend for a shared Worker fleet; the broker
  must preserve tenant isolation, rotation, revocation, and audit.
- Cloudflare deployment is an explicit operator action. The current deployment
  evidence is recorded in `docs/current-state.md`; local tests alone never
  authorize a deploy or prove an external side effect.
- The queue-backed baseline effecter is locally validated and remains
  fail-closed with no registered provider adapters or credentials.
