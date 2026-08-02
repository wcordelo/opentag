# Platform and routing foundation

Status: **source-complete metadata foundation; synthetic-live; credential-broker
boundary validated locally; external effecter and connector custody still gated**

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
- an authenticated identity/key-custody adapter protocol that returns only
  public-key metadata and opaque external receipts;
- curated connector marketplace entries and OAuth grants; active grants are
  bound to the exact curated marketplace version, provider, and allowed scopes;
- execution-linked, idempotent usage meter events for knowledge, agent,
  connector, and container tiers;
- versioned tenant billing plans with bounded period/limit decisions before
  meter acceptance;
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
  until an approved external deletion worker completes them; each requested
  source can now receive a durable `deleted`, `not_found`, or `failed` receipt
  and the request becomes `completed` only when every source has a successful
  terminal receipt.

## Tenant locator and provisioning boundary

The server-owned tenant locator registry now lives in the reserved platform
metadata object (`__platform_marketplace__`). It records the external platform
and tenant identifier, the canonical internal tenant UUID, a monotonic mapping
version, and active/revoked status. It stores no credentials, provider
payloads, or caller-selected Durable Object names.

`/admin/platform/provision` registers the derived mapping before forwarding the
idempotent provisioning request to the tenant metadata object. Direct admin
routes also expose `/admin/platform/tenant-locator`, `/resolve`, and `/revoke`
for controlled bootstrap and lifecycle operations. A mapping cannot be
silently rebound, skip a version, or reactivate after revocation. Resolution
returns `not_found`, `ambiguous`, or `inactive` instead of inventing a tenant.

`PlatformStateTenantLocatorReader` is the read-only application boundary, and
`adaptVerifiedSlackRequestContextFromRegistry` uses it before adapting the
legacy Slack request shape. The existing context and effect contracts retain
the locator version so a stale request cannot cross an authorization boundary.
This closes the source-level tenant-locator gap; production population still
requires an approved bootstrap authority, real provisioning receipts, and a
non-production install smoke.

### Identity-link boundary

Each tenant metadata object now has a metadata-only identity-link ledger. It
binds one external subject to one canonical internal principal and a verified
identity proof, with independent authorization and identity-link versions.
Writes require matching tenant/principal/subject relationships and contiguous
versions; a subject cannot be silently rebound to another principal, and
revocation is terminal. Expired or suspended links resolve as `inactive`.

The admin-only `/admin/platform/identity-link`, `/resolve`, and `/revoke`
routes are bootstrap/lifecycle seams. `PlatformStateIdentityLinkReader`
addresses only the tenant object selected by the already-resolved locator and
stores no private key or provider token. The Slack adapter can resolve both
the locator and identity link from these read-only boundaries before building
`PlatformRequestContext`. Identity/key generation, signing, custody, and proof
issuance remain the separate authenticated custody/provider responsibility.

## External effect handoff

`platform_effect_intents` is the only durable handoff between the metadata
ledger and an external provisioning, custody, OAuth, marketplace, billing, or
memory worker. An intent contains only a bounded target reference and sorted
metadata; recursive validation rejects provider tokens, OAuth codes, prompts,
queries, bodies, and other secret-shaped fields. Billing adapters should map a
`billing_meter` intent through
`edge/src/platform/billing-provider-contract.ts`: only usage identity,
quantity, unit, plan revision, and execution correlation cross the boundary,
and completion requires an opaque `billing:` receipt. Prices, payment methods,
cards, and provider credentials remain outside OpenTag.

The separate `edge/workers/billing-adapter/` Worker is the provider-independent
authenticated handoff for a future approved monetary operation. Its fixed
adapter envelope adds only plan ID, amount in minor units, and currency to the
existing meter correlation. `billingAdapterRequestFromIntent` requires the
charge tuple's plan revision to match the metadata-only meter intent, and the
provider receipt must echo tenant, intent/idempotency, event/execution, plan,
amount, and currency fields. The Worker forwards no arbitrary payload and
fails closed when either the internal caller token or provider service binding
is absent. It does not claim or complete platform effect leases; the generic
effect runner remains the only lease executor.

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

## Credential broker boundary

`edge/workers/credential-broker/` is the last-mile resolver for connector
tokens. It authenticates the bot service binding, derives the canonical Slack
tenant id, requires a server-owned platform binding in the immutable label,
and composes the active principal's OAuth grant, curated marketplace version,
and public credential metadata from `PlatformStateDO`. It checks the grant,
credential, tenant, principal, marketplace version, provider, expiry, and
connector scope before contacting custody. It supports only explicitly
registered connector actions (`google_drive/search` and
`linear/create_issue`) and fails closed for unknown or legacy unbound labels.

The composed metadata-only snapshot lives in
`edge/src/connectors/authorization-snapshot.ts`. Its version fences are
included in the signed connector label, so a rotated grant, marketplace
revocation, credential revocation, or scope change cannot silently reuse an
older authorization at the custody boundary.

The runtime seam is `edge/src/connectors/platform-authorization.ts`. Slack HMAC
verification emits only a digest-bound ingress record; the bot copies that
record into the immutable request context and preserves it through deferred
file turns and quick-action jobs. Before Drive or Linear asks
`WorkspaceConfigDO` for labels, the seam resolves the server-owned tenant
locator and identity link, composes the current OAuth/marketplace/custody
snapshot, and supplies only the resulting version fence to the DO. Missing
platform state, missing ingress evidence, stale identity versions, and record
drift fail closed. Deferred retries reuse the signed Slack timestamp and body
digest, so the durable job identity is stable across replay.

The broker forwards immutable labels and public credential metadata to a
separately authenticated `CUSTODY` service binding. The optional
`opentag-credential-custody` Worker reads only explicitly mapped
Cloudflare Secrets Store bindings; its configuration contains reference,
version, binding-name, and expiry metadata, never provider token values. The
broker and custody Worker remain fail-closed until both internal auth tokens,
the approved mapping, and the non-production smoke are configured. This makes
the architecture deployable and testable without pretending that Drive or
Linear credentials are live.

## Identity custody adapter boundary

`edge/src/platform/identity-custody-contract.ts` defines the authenticated
boundary for the `identity_custody` effect. It accepts only a tenant-scoped
`identity:` reference, custody backend, version, operation, idempotency key,
requested timestamp, and optional public key. It rejects private-key-shaped
values and unknown fields. The `opentag-identity-custody` Worker authenticates
its internal caller, forwards the bounded request to an optional separately
authenticated `IDENTITY_PROVIDER_ADAPTER`, and validates that the returned
opaque receipt matches the tenant, identity, backend, operation, and version.

The provider adapter owns key generation, signing, storage, rotation, and
revocation. Provisioning/rotation receipts must return the public key needed by
the metadata ledger; revocation receipts need not return a key. With no
provider adapter binding or bearer configured, the Worker returns an explicit
configuration error and performs no custody operation. No private key enters
OpenTag Durable Objects, queues, Worker variables, or logs.

The Worker exposes these operations only behind the existing admin secret. The
ledger is an audit/state boundary, not the effecter: it does not perform a
Slack install, mint keys, run an OAuth callback, call a billing provider, or
delete knowledge.

Billing plans are a separate metadata boundary. A tenant plan carries an
explicit revision, half-open UTC billing period, per-metric bounded limits, and
an `allow`/`block` overage policy. Meter writes re-check the current plan in
the same SQLite transaction after idempotency checks; suspended plans, stale
revisions, out-of-period events, and blocked overage fail closed. An absent
plan remains explicitly `plan_unconfigured` and allows metering for migration
compatibility. This is entitlement and reconciliation infrastructure only: no
card, invoice, payment provider, or charge is performed.
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
mismatches, scopes outside the reviewed entry, and any grant whose scope set
differs from the custody reference. This is a durable safety gate, not proof
that any provider OAuth integration is live.

Memory deletion receipts are source-scoped and epoch-bound. The external
executor may record only a requested source, and duplicate receipt retries are
idempotent. `not_found` is treated as a successful absence proof; any
`failed` receipt makes the request terminally failed rather than silently
claiming completion. The receipt ledger stores bounded metadata and an opaque
external receipt reference, never memory contents or deletion payloads. The
executor still owns the actual deletion and must report receipts through the
admin/effect boundary. The provider-independent `opentag-memory-deletion`
Worker now accepts one source-scoped request at a time, forwards only bounded
tenant/source/epoch metadata to a separately authenticated adapter, and rejects
successful provider responses without an opaque receipt reference. It remains
fail-closed until a reviewed provider adapter, custody path, and non-production
test namespace are configured.

Provisioning step advancement is receipt-bound. Each required step must carry
an opaque external receipt reference and observed timestamp; completion without
that evidence is rejected. The ledger retains the bounded receipt per step and
does not treat a tenant as active until every required step has a terminal
`complete` receipt. Failed steps remain retryable only when the external
executor explicitly marks them retryable; the ledger never fabricates a
successful Slack install, Durable Object creation, key-custody operation, or
access-bundle result.

The provider-independent `opentag-provisioning-adapter` Worker now provides a
step-scoped boundary for that executor. It accepts only the selected required
step, tenant/request metadata, isolation/custody modes, and requester subject;
it forwards no credentials or generic resource payload. It validates the
returned step receipt against the request's idempotency key and remains
fail-closed until a reviewed tenant/bootstrap adapter and non-production
namespace are configured.

The validators reject secret-bearing fields. The following decisions are
still required before these contracts become live product surfaces:

1. shared per-tenant DO isolation versus Workers for Platforms;
2. production tenant locator and per-team DO onboarding;
3. whether the optional Cloudflare Secrets Store adapter is the approved
   custody implementation, or whether an external KMS/envelope/self-hosted
   Worker should replace it;
4. tenant-scoped custody broker semantics alongside deployment Worker Secrets;
5. curated-only marketplace trust and OAuth callback ownership;
6. hosted billing boundary, plan/overage policy, and source-of-truth ledger;
7. retention/deletion guarantees and compliance requirements for hosted memory.

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
  needs the credential-broker and custody Workers, an approved Google
  OAuth/key mapping, and a non-production validation workspace before it can
  run live.
- Knowledge MCP search still needs the existing Supermemory configuration and
  knowledge rollout gates. Raw templates use the local KnowledgeDO and do not
  imply that Supermemory ingestion is active.
- The router remains dark until the shadow dataset is measured and the Tier 1
  knowledge gate, Tier 1 synthesis/fallback path, escalation affordance, and
  product-facing feedback controls are implemented. The workspace-scoped
  measurement and misroute ledgers are now present, but Tier 1 is still not
  enabled and no feedback control currently routes a user turn.
- The platform-state migration, tenant-locator and identity-link
  registry/readers, effect leases, admin routes, credential-broker boundary,
  optional Secrets Store custody adapter, and identity custody protocol are
  locally validated, but the production bootstrap/proof authority, configured
  identity provider/key custody adapter, Slack OAuth callback, marketplace
  trust review process, billing/plan enforcement, memory deletion executor,
  configured custody mapping, and provider adapters are not live.
- Worker Secrets are the approved deployment/bootstrap mechanism. They are not
  a complete per-tenant custody backend for a shared Worker fleet; the broker
  must preserve tenant isolation, rotation, revocation, and audit.
- Cloudflare deployment is an explicit operator action. The current deployment
  evidence is recorded in `docs/current-state.md`; local tests alone never
  authorize a deploy or prove an external side effect.
- The queue-backed baseline effecter is locally validated and remains
  fail-closed with no registered provider adapters or credentials; no custody
  mapping, provider token, or external provider adapter is live.
