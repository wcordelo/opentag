# OpenTag current implementation and rollout status

Status: **current reconciliation record**

Updated: **2026-08-02**

This document is the evidence index for the merged connector/platform/router
work and the live rollouts performed on 2026-08-01 and 2026-08-02. It reconciles the older
backfill reports and design specs without rewriting their historical evidence.
When a historical report says that a feature was not implemented, read that
statement as true at its recorded review point and use this document for the
current status.

## Evidence anchors

| Evidence | Value |
| --- | --- |
| Merged OpenTag baseline at recorded deployment | `498164fd2f63540b14988f028a1d97efa3f9d47d` (`origin/main`, PR #33 merge; includes #27, #28, #35, and #34) |
| Current merged main | `d075431f25f886842aec5552314afea9d1c9c1dd` (`origin/main`, PR #40 merge; PRs #45–#53 remain open and are not deployed) |
| Narrow source hotfix | `9d4538c` — extract `identityRef` before `PlatformStateDO` identity reads |
| Bot deployment | `opentag-bot`, version `88615a84-1396-4298-bd76-95b423db496c` — deployed from merged main `d075431` on 2026-08-02 after typecheck, 1,226 unit tests, 55 Worker/e2e tests, deploy-config validation, and Wrangler dry-run validation; three repeated live `/health` probes returned HTTP 200 |
| Provider-independent effect boundaries | `opentag-credential-custody` `893d7042-d265-4f0d-8fea-06f8a65472f2`; `opentag-credential-broker` `8e15a914-c11b-4b8f-9f3b-04472af4dd82`; `opentag-platform-effecter` `a1a33e17-d5bc-4055-aa94-7fbf3d8ffb56`; `opentag-provisioning-adapter` `50455921-30fd-48e5-ae75-13d626d06ce9`; `opentag-identity-custody` `97704e53-bfd7-4dee-b463-0f19dfdf9c36`; `opentag-oauth-effecter` `70e4633a-d08a-4876-b824-2807aeb24d04`; `opentag-oauth-callback` `16e15e50-342f-4293-8501-5e42ff7df1e8`; `opentag-billing-adapter` `e1bd6ccb-0a50-4560-87d1-18b6971e3f30`; `opentag-memory-deletion` `6b20ab90-d176-46ac-a0ae-3b4a24b21abb` — deployed fail-closed from the same merged main; no provider adapter or caller credential was configured |
| Harness deployment | `opentag-harness-harnesscontainer`, version `58c47ab9-daf9-456b-b17c-73fc66e6b25d` |
| Harness image | `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880` |
| Bot health | `GET /health` returned HTTP 200 after the final redeploy; durable stores and service bindings are healthy, while `modelConfigured`, credential-broker auth, knowledge reconciliation, and OAuth redirect-origin configuration remain false |
| Slack canary thread | [final routing and concurrency canary](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785630816681659) |
| Slack passive-only canary | [top-level plus untagged `yo` remained silent](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785629853529029) |
| Stale-turn cleanup thread | [pre-fix thread stopped safely](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785626165915119) |
| Cloudflare origin | `https://opentag-bot.williamlopezc.workers.dev` |

The current deployment was performed from a clean isolated checkout of
`origin/main` at `d075431`. The bot and provider-independent effect boundaries
were deployed after the merged-main validation suite passed. The stacked
foundation PRs #45–#53 remain open and are not included in this
deployment. Provider adapters, custody mappings, OAuth origins, internal
caller secrets, and external credentials must not be treated as live solely
because their boundary Workers are deployed.
No secret value is recorded here.

## Status vocabulary

- **Source-complete** — implementation and focused tests exist; this is not a
  claim that an external provider or production canary is configured.
- **Live-verified** — the deployed Worker or harness performed the behavior
  against a real Slack or Cloudflare endpoint.
- **Synthetic-live** — the deployed admin/DO path performed the behavior with a
  synthetic tenant and opaque test metadata; no real provider or user data was
  touched.
- **Fail-closed** — the feature refuses to cross an unconfigured or
  unauthorized boundary; this is a safety result, not a completed integration.
- **Open gate** — a required external dependency, policy, or rollout proof is
  still missing.

## Feature-by-feature evidence

| Feature or contract | Current result | Evidence and boundary |
| --- | --- | --- |
| Slack Events API, HMAC verification, pre-admission, stable turn identity | Live-verified | The current bot accepted an untagged thread question, an untagged problem/action request, and an explicit mention; after the in-flight turn completed, an explicit marker was accepted without a stale-turn warning. |
| Flexible Slack response routing | Live-verified | The current bot read every threaded human message: a question and problem/action request routed to the normal turn lifecycle, while an untagged `yo` and conversational statement such as `I can't make standup today` produced no bot turn. Tags are optional for clear asks; passive chatter remains history. |
| Durable session events, render obligations, deduplication, recovery fences | Source-complete; live path exercised | Focused edge tests cover the DO contracts; the live Slack canary exercised normal admission and terminal delivery. Crash recovery and duplicate replay still require targeted fault injection rather than a normal canary. |
| Streaming/conflation, status/title, busy-turn feedback | Source-complete; live path exercised | The canary produced AG-UI progress and final renders. One busy warning appeared only when an explicit mention arrived during the preceding untagged investigation turn; after that turn rendered `Complete`, a later explicit marker succeeded without a stale warning. The duplicate Slack delivery that previously orphaned a lock is rejected before durable admission. A full transport-failure recovery drill remains open. |
| Stop and cancellation | Live-verified for stale-row cleanup; source-complete for lifecycle | Sending `<@U0BAK4AJ2Q1> Stop` to the earlier stale thread produced `Stopped.` and cleared the row. Full in-flight AG-UI/harness quiescence and late-output suppression still require a targeted canary. |
| Durable HITL and quick actions | Source-complete | Source and focused tests cover `choiceId`, DO polling, synthetic user turns, and exact fences. A live button-click canary remains open. |
| Native typed Nanocodex Responses adapter | Live-verified | Slack marker `OPENTAG_NANOCODEX_NATIVE_OK` returned from `--nanocodex`; the typed adapter, provider state, replay, and completed-only commit are source-tested. A live reconnect/checkpoint replay drill remains open. |
| Claudex model path through the private harness boundary | Live-verified | Slack marker `OPENTAG_CLAUDEX_HARNESS_OK` returned after the harness redeploy. This verifies the private Worker/service-binding path, not a public harness endpoint. |
| Harness sandbox, egress, sentinels, remote-git postconditions | Source-complete; harness deployed | Harness image and Worker are deployed with the expected binding. No live repository push or PR was performed in this canary. |
| Runtime/capability identity and deployment evidence | Live-verified with open configuration gates | The deployed `/health` returned HTTP 200 and reports durable bindings, service bindings, native Nanocodex, knowledge namespace/search/queue configuration, and platform state. It also correctly reports `modelConfigured: false`, `knowledge.reconciliationConfigured: false`, `credentialBroker.authConfigured: false`, and `oauth.allowedRedirectOriginsConfigured: false`. Configuration presence is not treated as proof of a provider or authenticated Buzz effect. |
| Actor-bound knowledge/MCP authorization | Source-complete; synthetic/admin path only | Token, replay, team/project, ACL, audit, and source-authorization contracts are focused-tested. External MCP remains operator-only; no actor token or real external MCP call was exposed in this rollout. |
| Slack knowledge search and ordinary retrieval | Live-verified with indexing caveat | An indexed historical marker returned four hits and a normal knowledge question returned a scoped answer. A newly posted marker returned zero exact hits immediately, so indexing latency/eventual consistency remains an explicit operational condition. |
| Connector labels, opaque credential references, bundle revisions, revocation, citations | Synthetic-live | The synthetic platform run exercised reference writes/reads, grants, marketplace metadata, revocation, and effect creation. Tokens never entered OpenTag state. |
| Google Drive search | Source-complete; fail-closed live gate | Drive connector and citation code are present and focused-tested. `CONNECTOR_CREDENTIALS` is not configured in the deployed bot, so no provider happy path was claimed. |
| Guarded Linear create | Source-complete; fail-closed live gate | Approval, requester attribution, project/milestone preservation, revalidation, and duplicate protection are source-tested. No broker, OAuth grant, test workspace, or live Linear mutation is configured. |
| Platform provisioning and idempotency | Synthetic-live | A synthetic tenant completed all required provisioning steps; repeat provisioning returned the same receipt and final status became `active`. This is metadata ledger evidence, not proof of external resource creation. |
| Identity custody references | Synthetic-live after hotfix | The deployed admin path put, read, and revoked a synthetic identity. The original live read exposed a route bug; `9d4538c` fixed it and the retest returned HTTP 200 before revocation. |
| Credential custody references and OAuth grants | Synthetic-live | Put/get/revoke and grant lifecycle calls returned successfully for synthetic metadata. No provider token, OAuth code, or external callback was used. |
| Marketplace and connector lifecycle | Synthetic-live | Curated entry, list, and revoke paths completed against the platform Durable Object. Trust review and provider execution are still external gates. |
| Usage metering | Synthetic-live; billing boundary deployed fail-closed | The live synthetic run recorded a meter event, repeated it idempotently, and listed it. The provider-independent billing adapter is deployed, but no billing provider adapter or caller credential is configured. |
| Memory policy and deletion request | Synthetic-live; executor deployed fail-closed | Policy and deletion request state were recorded and listed. The deletion intent remains pending until the deployed worker has an approved provider adapter and proves source-by-source completion. |
| Effect intents, leases, retries, completion, cancellation | Synthetic-live | Provisioning intent claim/complete and retryable fail/reclaim/cancel all completed in the deployed DO. This validates the handoff ledger, not a real provider side effect. |
| Router heuristic classification and measurement ledger | Live-verified in shadow mode | Admin summary/list showed a Tier 1 counterfactual record dispatched to Tier 2 and existing conservative command fallbacks. The separate Slack response-worthiness gate is live and does not enable a tier. `shadowOnly` remains true; Tier 1 and Tier 3 are not user-facing. |
| Buzz `/buzz/wake` admission | Live fail-closed | A live POST returned HTTP 503 `buzz_receive_not_configured` without touching relay or runtime admission. No local Buzz signer/private key or authenticated relay proof was available, so a valid NIP-OA wake is not claimed. |
| One-click/CLI secret configuration | Source-complete; deployment path not independently canaried | The secret-safe deploy script and Wrangler path exist. The rollout used existing Cloudflare secrets; a fresh one-click install dry run is not proof of an end-to-end new-tenant installation. |
| Trace correlation and structured delivery metrics | Source-complete | Correlation and metric contracts are focused-tested and emitted as structured Worker records. No external trace collector or dashboard is configured. |

## Routing and turn-finalization correction

The current Slack contract is intentionally more flexible than mention-only
admission:

1. The verified ingress normalizer retains human thread messages instead of
   discarding every unmentioned reply.
2. Slack's duplicate `message` delivery for an explicit `app_mention` is
   rejected before it can register a second active turn.
3. `response-routing.ts` applies a deterministic response-worthiness gate.
   DMs, explicit mentions, trusted triggers, files, questions, action
   requests, and problem reports proceed to the normal Tier 2 lifecycle.
   Passive thread conversation is observed and remains available through
   Slack history without waking the agent.
4. Only a response-worthy event reaches durable pre-admission, so an ignored
   event cannot orphan an `active_turns` row.
5. The normal final render confirmation remains the owner of cleanup. It
   deletes the exact active-turn row after Slack visibility is confirmed;
   the busy warning is reserved for a real distinct concurrent turn.

The routing gate is separate from Router Tier 1/Tier 3 dispatch. The current
router still records shadow measurements and sends admitted work to Tier 2.
The busy warning remains a real-concurrency signal: it is expected when a
second response-worthy message arrives before the first turn has rendered its
terminal state, not when an old duplicate row is left behind.

## Decisions now locked

These decisions supersede unresolved wording in the original handoff and
backfill reports:

1. OpenTag uses one shared Worker fleet with strict per-team Durable Object
   isolation. Caller input never chooses an arbitrary DO name; server-owned
   tenant resolution does.
2. Cloudflare Worker Secrets are the deployment/bootstrap credential mechanism,
   configured through a one-click Wrangler flow or the Cloudflare CLI. This does
   not mean that one global Worker Secret is a safe substitute for mutable,
   per-tenant OAuth/token custody in a shared fleet.
3. Internal knowledge/MCP uses actor-bound bot tokens. External MCP is
   operator-only, with synthetic validation first. The user authorized a live
   rollout without an additional approval gate, but missing provider/relay
   credentials still cause a fail-closed result.
4. Nanocodex has a native typed Responses adapter now. It remains behind the
   existing harness/wire boundary for coding turns and does not introduce a
   second shell or repository executor.
5. Router rollout begins with exact heuristic shadow measurement. Tier 2 is the
   safe dispatch floor until knowledge health, quality gates, cost attribution,
   and rollback evidence justify a Tier 1 change.
6. QM is a design reference for capability profiles, durable leases,
   serviceability/preflight evidence, typed tool provenance, grants, and
   operator/admin separation. OpenTag does not adopt QM's Node/Postgres/Fly/AWS
   spine, Socket Mode, or direct user-agent credential model.

## Remaining gaps and their owners

### 1. Per-tenant custody is not solved by Worker Secrets alone

The user decision names Worker Secrets for deployment configuration, while the
current Layer 3 contract still models `external_kms`, `wrapped_do_envelope`, and
`self_hosted` custody references. The safe interpretation is:

- Worker Secrets hold deployment-wide bootstrap/runtime values and are set by
  the one-click or CLI flow.
- Tenant Durable Objects hold only opaque references, versions, grants, and
  revocations.
- A real shared-fleet connector still needs a broker/effecter that can resolve
  an authorized tenant reference without turning a deployment-wide Worker
  Secret into cross-tenant ambient access.

This is an architecture gap, not a documentation omission. Do not add
`workers_secrets` as a per-tenant custody backend until the access, rotation,
revocation, and isolation semantics are specified and tested.

### 2. External effect execution remains provider-gated

The platform Durable Object is a durable metadata ledger. The provider-
independent provisioning, OAuth, connector custody, billing, and deletion
boundaries are now deployed with bounded request contracts and fail-closed
health states. They still need approved provider adapters, internal caller
credentials, bounded retries with external receipts, and reconciliation before
any real external effect is enabled. The admin effect routes remain diagnostic
and synthetic-test surfaces, not proof of provider execution.

### 3. Provider integrations remain deliberately gated

Drive and Linear must remain fail-closed until `CONNECTOR_CREDENTIALS`, provider
custody, grants, allowlists, and a synthetic/test workspace are all present.
No live external write, OAuth callback, billing call, or deletion call was
performed in this rollout.

### 4. Buzz needs authenticated admission evidence

Health-level relay and tenant-directory configuration does not prove a signed
NIP-OA admission, authenticated relay query, event signature verification, or
runtime callback. Configure the signer, distinct relay allow-origin, relay
membership, and channel-to-tenant map in a controlled environment, then run a
synthetic event through dedupe, authenticated fetch, event verification, and
tenant-scoped runtime admission.

### 5. Router and knowledge rollout gates remain open

Router Tier 1/Tier 3 stay dark. Knowledge reconciliation is not configured in
the deployed environment, and fresh Slack indexing is eventually consistent.
Before enabling a new tier or broadening sources, collect shadow volume,
outcome, feedback, ACL, latency, and cost evidence and prove rollback.

### 6. Live coverage still has targeted holes

The current canary proves flexible Slack routing, explicit-turn finalization,
stale-row cleanup, native Nanocodex, Claudex, knowledge retrieval, router
measurement, platform metadata, and fail-closed Buzz behavior. It does not yet
prove in-flight Stop quiescence/late-output suppression, live HITL button
persistence, delayed-file repair, attachment staging, live Drive/Linear
provider calls, authenticated Buzz wake, provider checkpoint reconnect, or a
fresh one-click installation. The deployed agent also reports
`modelConfigured: false`, so a model-backed answer requires configuring that
binding/secret before it can be called live. These are explicit next tests,
not implicit passes.

## Backfill and feedback reconciliation

The complete-history reports for qm, Nanocodex, Buzz, and Centaur remain
valuable evidence of their source trees and historical classifications. Their
current OpenTag comparisons are now accompanied by
[CURRENT-STATE-RECONCILIATION.md](../goal-outputs/multi-repo-parent-sync-architecture-backfill/CURRENT-STATE-RECONCILIATION.md),
which maps every old “not implemented” or “blocked” statement to the current
source/live status. The attached QM feedback is incorporated in the QM section
of that reconciliation and in the capability/custody decisions above.

Historical defer and Not Applicable items were not silently filtered. Durable
leases, audit, replay, tenant resolution, readiness, preflight, and source
authorization were retained where they fit the Cloudflare stack. Kubernetes,
Rails/Postgres product persistence, Redis topology, Socket Mode, and other
incompatible infrastructure remain explicitly out of scope while their
portable contracts are preserved.

## Revalidation commands

From `edge/`:

```bash
npm test -- --run test/platform-state-do.test.ts
npm test -- --run test/response-routing.test.ts test/pre-admit-turn.test.ts test/cloudflare-slack-adapter.test.ts test/slack-stream.test.ts
npm run typecheck
npm run validate:deploy-config
```

For a new rollout, verify `/health`, run a bounded Slack marker, inspect the
router admin summary without exposing secrets, and run only synthetic platform
operations until provider custody and external effect workers are proven.
