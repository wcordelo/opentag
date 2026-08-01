# Platform and routing foundation

Status: local implementation on the goal worktree; no production deployment
or hosted-platform activation has been performed.

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
by this implementation.

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
  request contracts.

The validators reject secret-bearing fields. The following decisions are
still required before these contracts become live product surfaces:

1. shared per-tenant DO isolation versus Workers for Platforms;
2. external KMS versus wrapped DO envelopes versus self-hosted custody;
3. curated-only marketplace trust and OAuth callback ownership;
4. hosted billing boundary, plan/overage policy, and source-of-truth ledger;
5. retention/deletion guarantees and compliance requirements for hosted memory.

No code silently chooses one of those alternatives, provisions a tenant, runs
an OAuth callback, stores a provider token, charges a plan, or deletes live
customer knowledge.

## Remaining activation gates

- Drive search is implemented behind the connector authorization contract, but
  needs a deployed `CONNECTOR_CREDENTIALS` broker and approved Google OAuth/key
  custody path before it can run live.
- Knowledge MCP search still needs the existing Supermemory configuration and
  knowledge rollout gates. Raw templates use the local KnowledgeDO and do not
  imply that Supermemory ingestion is active.
- The router remains dark until the shadow dataset is measured and the Tier 1
  knowledge gate, Tier 1 synthesis/fallback path, escalation affordance, and
  misroute ledger are implemented.
- Cloudflare deployment is a separate explicit gate; local typechecks and
  tests do not authorize `wrangler deploy`.
