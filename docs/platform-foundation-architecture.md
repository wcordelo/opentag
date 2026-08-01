# Platform and routing foundation

Status: local implementation on the goal worktree; the effect ledger, router
measurement ledger, and credential-broker boundary are validated, but no
provider custody adapter or hosted platform effecter is deployed.

This document records the architecture that is now explicit in code and the
parts that remain product or infrastructure gates. It prevents a future
connector, OAuth flow, billing path, or memory policy from bypassing the
existing durable execution and authorization contracts.

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
is an operator diagnostic/evidence surface, not a replacement for future
per-principal OAuth authorization; the global `ADMIN_SECRET` remains the
authorization boundary until Layer 3 tenancy is selected.

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
layer, not a fake provisioning service. It covers:

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
  `active` only after every required footprint is explicitly completed;
- versioned identity and credential custody references with terminal
  revocation;
- curated marketplace versions and terminal connector revocation;
- credential-linked OAuth grant versions with terminal revocation;
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

## Credential broker boundary

`edge/workers/credential-broker/` is the last-mile resolver for connector
tokens. It authenticates the bot service binding, derives the canonical Slack
tenant id, re-reads public credential metadata from `PlatformStateDO`, and
checks the credential version, tenant, provider, expiry, and connector scope
before contacting custody. It supports only explicitly registered connector
actions (`google_drive/search` and `linear/create_issue`) and fails closed for
unknown actions.

The broker forwards immutable labels and public credential metadata to an
external `CUSTODY` service binding. It never stores or logs the returned bearer.
The default Wrangler configuration intentionally omits that binding; until an
approved KMS, envelope, or self-hosted custody Worker is selected,
`credential_custody_unavailable` is the expected result. This makes the
architecture deployable and testable without pretending that Drive or Linear
credentials are live.

The Worker exposes these operations only behind the existing admin secret. The
ledger is an audit/state boundary, not the effecter: it does not perform a
Slack install, mint keys, run an OAuth callback, call a billing provider, or
delete knowledge.

The validators reject secret-bearing fields. The following decisions are
still required before these contracts become live product surfaces:

1. shared per-tenant DO isolation versus Workers for Platforms;
2. external KMS versus wrapped DO envelopes versus self-hosted custody;
3. curated-only marketplace trust and OAuth callback ownership;
4. hosted billing boundary, plan/overage policy, and source-of-truth ledger;
5. retention/deletion guarantees and compliance requirements for hosted memory.

No code silently chooses one of those alternatives, runs an OAuth callback,
stores a provider token, charges a plan, or deletes live customer knowledge.
The platform-state ledger records explicit bootstrap requests and externally
verified receipts without marking a tenant active until the required steps are
reported complete.

## Remaining activation gates

- Drive search is implemented behind the connector authorization contract, but
  needs the credential-broker Worker, an approved Google OAuth/key custody path,
  and a non-production validation workspace before it can run live.
- Knowledge MCP search still needs the existing Supermemory configuration and
  knowledge rollout gates. Raw templates use the local KnowledgeDO and do not
  imply that Supermemory ingestion is active.
- The router remains dark until the shadow dataset is measured and the Tier 1
  knowledge gate, Tier 1 synthesis/fallback path, escalation affordance, and
  product-facing feedback controls are implemented. The workspace-scoped
  measurement and misroute ledgers are now present, but Tier 1 is still not
  enabled and no feedback control currently routes a user turn.
- The platform-state migration, effect leases, admin routes, and
  credential-broker boundary are locally validated, but the production
  bootstrap authority, tenant locator integration, identity/key custody worker,
  Slack OAuth callback, marketplace trust review process, billing/plan
  enforcement, memory deletion executor, external custody binding, and
  provider adapters are not live.
- Cloudflare deployment is a separate explicit gate; local typechecks and
  tests do not authorize `wrangler deploy`.
