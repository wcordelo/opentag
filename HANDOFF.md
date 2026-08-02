# OpenTag — current session handoff

Status: **reconciled with merged `origin/main`, the 2026-08-01 rollout, and
the live feature checks**

Updated: **2026-08-01 Pacific**

Read [PRODUCT.md](./PRODUCT.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
[DECISIONS.md](./DECISIONS.md), and
[docs/current-state.md](./docs/current-state.md) first. The last document is
the evidence index: it distinguishes source-complete, live-verified,
synthetic-live, fail-closed, and open-gate states.

## Current release anchors

| Item | Value |
| --- | --- |
| Merged baseline | `498164fd2f63540b14988f028a1d97efa3f9d47d` (`origin/main`) |
| Working branch | `main` |
| Source hotfix | `9d4538c`, identity read forwarding; focused test added |
| Bot Worker | version `fbecbc00-2789-4d8f-ba3d-3552265e0165` |
| Harness Container | version `58c47ab9-daf9-456b-b17c-73fc66e6b25d` |
| Slack routing smoke | [current routing and concurrency canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785630816681659) |
| Passive-only smoke | [top-level plus untagged `yo` stayed silent](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785629853529029) |
| Stale-turn cleanup | [pre-fix thread stopped safely](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785626165915119) |

The bot was deployed from a clean detached checkout of merged `origin/main`
after the provisioning-receipt and memory-deletion-receipt merges. The
effecter, custody, OAuth, and billing feature branches remain review-ready but
are not part of this deployment.

## What is implemented now

### Layer 1 — Slack agent spine

Slack Events API ingress, HMAC verification, stable identities,
pre-admission, session/event replay, render obligations, exact effect fences,
Stop continuation, durable HITL, quick actions, channel/thread memory,
requester attribution, and fail-closed authorization rules are source-complete
and deployed. Thread routing now reads every human reply: explicit mentions,
DMs, files, questions, action requests, and problem reports may wake the bot
without a tag, while passive conversation remains history-only. Duplicate
Slack `message` delivery for an `app_mention` is discarded before admission,
so it cannot leave a stale active-turn row. The live canary verified all of
those routing decisions, exact explicit-turn finalization, and follow-up
delivery after the preceding turn reached its terminal state. The same canary
showed the busy warning when a second response-worthy message arrived during
a genuinely running first turn; that is expected concurrency feedback, not
the stale duplicate-admission bug.

### Layer 2 — coding and model plane

The private harness Worker and Container are deployed with sentinel credentials,
egress policy, remote-git postconditions, native Claude, Claudex, and the
native typed Nanocodex Responses adapter. Slack canaries returned exact markers
for Claudex and native Nanocodex. A live repository push/PR, live Stop, and
checkpoint reconnect were not run in this rollout.

### Layer 3 — platform foundation

The user decisions are locked:

- one shared Worker fleet with strict per-team Durable Object isolation;
- Worker Secrets for deployment/bootstrap configuration, through one-click
  Wrangler or the Cloudflare CLI;
- actor-bound internal knowledge tokens, operator-only external MCP, synthetic
  validation first, and live rollout permitted; and
- native typed Nanocodex Responses now, behind the existing harness boundary.

`PlatformStateDO` and `layer3-contract.ts` provide metadata-only provisioning
with external step receipts, identity/credential references, OAuth grants,
marketplace metadata, metering, memory governance/deletion receipts, and a
secret-free effect-intent ledger. A synthetic tenant completed provisioning,
idempotent reads/writes, revocation, grants, metering, memory requests, effect
leases, retries, completion, and cancellation.

The review-ready follow-on branches are:

- [#29](https://github.com/wcordelo/opentag/pull/29): authenticated platform
  effect dispatch and queue-backed runner;
- [#30](https://github.com/wcordelo/opentag/pull/30): tenant/provider/scope
  revalidated credential broker and optional Secrets Store custody adapter;
- [#31](https://github.com/wcordelo/opentag/pull/31): replay-safe OAuth state,
  marketplace gates, and provider-adapter receipt contract; and
- [#32](https://github.com/wcordelo/opentag/pull/32): versioned billing
  entitlement and provider-receipt contract.

They are all non-draft and passing review checks, but no unmerged branch is in
the deployed release.

Worker Secrets are not a per-tenant OAuth/token database in a shared fleet.
Tenant DOs retain opaque references and grants; a real credential broker/effect
worker must provide tenant-scoped resolution, rotation, revocation, and audit.
Do not add a `workers_secrets` custody backend to the Layer 3 enum until those
semantics are specified and tested.

### Layer 4 — knowledge and MCP

KnowledgeDO, actor-token validation, source authorization, bounded raw query
templates, queue/ledger contracts, and Slack retrieval are source-complete.
An indexed historical marker and an ordinary knowledge question succeeded in
Slack. Fresh indexing is eventually consistent; reconciliation is not
configured in the deployed environment. No external MCP/provider canary is
claimed beyond the operator/admin and synthetic paths.

### Router

The versioned heuristic classifier and `RouterMeasurementDO` are deployed in
shadow mode. Live admin summary/list data showed counterfactual Tier 1
classification with Tier 2 dispatch. Tier 1 and Tier 3 remain dark until
knowledge health, quality/fallback, cost, feedback, and rollback gates are
proven.

### Buzz

`POST /buzz/wake` is present with signer, relay-origin, tenant-directory,
authenticated fetch, event verification, dedupe, and runtime-admit plumbing.
The live endpoint returned HTTP 503 `buzz_receive_not_configured` for an empty
probe without contacting the relay. No Buzz signer/private key or authenticated
relay proof was available, so valid NIP-OA admission is not claimed.

## Open gaps

1. Deploy a tenant-scoped credential broker/effect worker before enabling Drive,
   Linear, OAuth callbacks, billing, or deletion effects.
2. Provide controlled provider/test-workspace credentials and run Drive and
   guarded Linear happy paths, including revocation and ambiguous-failure tests.
3. Configure a controlled Buzz signer and relay, then prove NIP-OA admission,
   authenticated fetch, local event verification, dedupe, and tenant-scoped
   runtime admission.
4. Run in-flight live Stop quiescence/late-output suppression, HITL button
   persistence, delayed-file/attachment staging, Nanocodex checkpoint
   reconnect, and one-click installation canaries. Stopping an already stale
   row was live-verified; the deployed health response still reports
   `modelConfigured: false`, so model-backed answers require that binding to be
   configured.
5. Keep router tiers dark until the shadow evidence and rollout gates pass.
6. Configure knowledge reconciliation only with an approved source, budget,
   retention, ACL, backup/restore, and rollback plan.
7. Add an external trace/metrics collector only if operations needs durable
   cross-service dashboards; structured Worker logs are the current authority.

## QM/Centaur/Buzz/Nanocodex guidance

Adapt portable contracts from the backfill reports: durable leases and
heartbeats, capability profiles, serviceability checks, typed tool provenance,
server-resolved tenancy, source/result authorization, replay, audit, and
terminal delivery evidence. Keep OpenTag's Cloudflare/Slack spine. Do not copy
QM's Node/Postgres/Fly/AWS platform, Centaur's Kubernetes/Rails/Postgres
control plane, Buzz's Nostr/media/workflow product surfaces, or Nanocodex's
native subscription-auth/VM/branching surfaces without a separate product
decision.

The complete-history source reports remain under
`goal-outputs/multi-repo-parent-sync-architecture-backfill/`. Historical
“not implemented” claims are point-in-time evidence; use
`CURRENT-STATE-RECONCILIATION.md` and `docs/current-state.md` for current truth.

## Safe validation

```bash
cd edge
npm run typecheck
npm test -- --run test/platform-state-do.test.ts
npm test -- --run test/response-routing.test.ts test/pre-admit-turn.test.ts test/cloudflare-slack-adapter.test.ts test/slack-stream.test.ts
npm run test:e2e
npm run validate:deploy-config
```

Do not print or commit secrets. Do not turn a health binding into proof of
provider authorization. For any future external effect, record the exact
tenant, provider, scope, release, receipt, and rollback evidence without
recording secret material.
