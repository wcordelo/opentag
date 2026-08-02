# Platform and routing foundation

Status: **source-complete metadata foundation; synthetic-live; external effecter and connector broker still gated**

Updated: **2026-08-01**

The OAuth state/marketplace gates and authenticated provider-adapter protocol
are locally validated but remain fail-closed without approved provider custody.
The effect ledger, router measurement ledger, marketplace trust gates, and
replay-safe OAuth state store are validated in code; no hosted platform effecter,
connector credential broker, or live provider OAuth exchange is deployed.

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
- curated connector marketplace entries and OAuth grants; active grants are
  bound to the exact curated marketplace version, provider, and allowed scopes;
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
- credential-linked OAuth grant versions with terminal revocation; revoking a
  marketplace version revokes its dependent grants and emits revocation
  effects;
- execution-linked, idempotent usage-meter receipts with bounded listing; and
- monotonic memory policies plus deletion requests that remain `requested`
  until an approved external deletion worker completes them.

## External effect handoff

`platform_effect_intents` is the only durable handoff between the metadata
ledger and an external provisioning, custody, OAuth, marketplace, billing, or
memory worker. An intent contains only a bounded target reference and sorted
metadata; recursive validation rejects provider tokens, OAuth codes, prompts,
queries, bodies, and other secret-shaped fields.

The lifecycle is:

1. A state transition records its own metadata and an idempotent effect intent
   in the same SQLite transaction.
2. An effect worker claims the intent with a short lease and receives the
   validated intent metadata plus an opaque lease token.
3. The worker performs the provider call outside the Durable Object, then
   reports `complete` with a bounded external receipt reference or `failed`
   with a safe error code and retry policy.
4. A revoked or superseded operation can cancel the intent; an expired lease
   is reclaimable, while an active lease cannot be double-claimed.

Provisioning, identity/credential revocation, OAuth grant rotation/revocation,
marketplace curation/revocation, billing meter events, and memory deletion
requests now create these intents automatically.
The ledger still does not perform the external effect. That boundary must be
implemented by a separately authenticated worker after custody, provider, and
billing decisions are approved.

The Worker exposes these operations only behind the existing admin secret. The
ledger is an audit/state boundary, not the effecter: it does not perform a
Slack install, mint keys, run an OAuth callback, call a billing provider, or
delete knowledge.

## OAuth state and marketplace activation

`edge/src/platform/oauth-state-do.ts` is a separate SQLite Durable Object for
browser-flow state. It stores only SHA-256 state/nonce hashes plus bounded
tenant, principal, connector-version, redirect, scope, issue, expiry, and
consumption metadata. `/issue` returns the random state and nonce once;
`/consume` atomically marks a matching pair consumed and refuses replay. The
state contract rejects authorization-code/token-shaped fields, requires an
explicit HTTPS redirect-origin allowlist, and bounds state lifetime to 60–900
seconds.

The bot's `/admin/platform/oauth/state/issue` and `/consume` routes are
admin-only architecture seams. They first require the exact marketplace
version to be curated and OAuth-enabled. They are not public provider
callbacks: no OAuth code, access token, refresh token, or provider exchange is
accepted by the bot or its Durable Objects.

`edge/workers/oauth-callback` is the public callback boundary and forwards a
bounded one-request handoff to the authenticated `oauth-effecter` Worker. The
effecter can call an optional separately authenticated provider adapter using
the protocol in `edge/src/platform/oauth-provider-contract.ts`. The adapter
owns provider exchange, state correlation, marketplace/scope validation, and
external custody, and may return only a bounded receipt with an opaque
`credential:` reference and exact marketplace/grant metadata. The effecter and
callback Worker remain fail-closed when that adapter binding or its separate
bearer is absent; no provider token is stored or returned by OpenTag.

Marketplace curation now requires a `review:` trust reference, at least one
action, and auth-mode-consistent scopes. OAuth grants carry the exact
`marketplaceVersion`; the ledger rejects uncurated/non-OAuth entries, provider
mismatches, and scopes outside the reviewed entry. This is a durable safety
gate, not proof that any provider OAuth integration is live.

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

No code silently chooses one of those alternatives, runs an OAuth callback,
stores a provider token, charges a plan, or deletes live customer knowledge.
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
