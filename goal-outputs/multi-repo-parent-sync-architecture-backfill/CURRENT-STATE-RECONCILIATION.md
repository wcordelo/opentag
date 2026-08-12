# Multi-repository backfill — current-state reconciliation

Status: **complete reconciliation of the 2026-08-01 backfill artifacts**

Updated: **2026-08-02 20:37 PDT**

This file is the bridge between the complete-history parent/fork reports and
the OpenTag implementation that landed afterward. The original reports are
point-in-time evidence: their repository ranges, source findings, tests
inspected, and “no deployment” statements are not rewritten. This record
classifies every material OpenTag conclusion as implemented, live-verified,
synthetic-live, fail-closed, deferred, not applicable, or still open.

## Scope and authority

The backfill reviewed the complete history after each fork's common ancestor:

| Repository | Parent → fork | Common ancestor | Backfill result |
| --- | --- | --- | --- |
| qm | `yc-software/qm` → `wcordelo/qm:main` | `7f2c9163` | Already equal; no push |
| Nanocodex | `gakonst/nanocodex` → `wcordelo/nanocodex:master` | `3d4548b0` | Parent history merged and pushed as `e9ca9258` |
| Buzz | `block/buzz` → `wcordelo/buzz:main` | `acfbb1bb` | Parent history merged and pushed as `40d1bebf` |
| Centaur | `paradigmxyz/centaur` → `wcordelo/centaur:main` | `6d109198` | Parent tip already present; existing sync owns ongoing updates |

Current OpenTag authority is, in order:

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `DECISIONS.md`
4. `docs/current-state.md`
5. source and tests

Notion is the isolated review index for each project, not implementation
authority. The four review destinations remain qm, Nanocodex, Buzz, and the
existing Centaur database.

## Current local provider-readiness correction — 2026-08-02 20:37 PDT

The upgraded Supermemory source now requires `/v3/openapi` to return a
successful `2xx` before the entrypoint creates the provider-ready sentinel or
the Worker lifecycle releases the Container health gate. A reachable
`4xx`/`5xx` response remains degraded. Focused boundary tests, shell syntax,
typecheck, and diff checks pass locally.

The fresh strict read-only rollout check still fails only the Supermemory and
Graphify Container health checks. Both query applications report
`active=1`, `assigned=0`, `healthy=0`, `failed=0`; instance listings report
`running`, which is not a healthy receipt. No deployment, provider or Queue
mutation, commit, push, or PR was performed.

## Current strict Supermemory recheck — 2026-08-02 20:24 PDT

The upgraded Cloudflare Sandbox Supermemory implementation remains the source
of record: Worker-owned `STATE_BUCKET` at `/var/lib/supermemory`, a disposable
local model-cache overlay at `/var/lib/supermemory/models`, and no R2
credentials in the Container environment. The local port gate now allows
bootstrap-only `GET /health` before lifecycle mounting, returns `503` for all
other traffic until R2 is mounted, and holds health at `503` until provider
startup completes. Focused tests, typecheck, full unit/e2e/policy checks,
artifact verification, and deploy-config validation pass.

Read-only live state is Supermemory Worker
`61370dc7-0f1b-4488-8e49-86eb18bc78f6`, Graphify Worker
`2b087539-65c8-40c3-be69-4773af3a9315`, Supermemory Container v18, and
Graphify query version 6. The strict rollout preflight passes all static,
resource, secret, pin, and artifact checks, then fails both query health
checks because Cloudflare reports `active=1`, `assigned=0`, `healthy=0`, and
`failed=0`. The local gate correction is not deployed; restart/remount,
provider CRUD/search, parity, Buzz admission, and complete-history coverage
remain open.

Read-only R2 metadata confirms the Supermemory `api-key` bootstrap object is
present without reading its value, while the Graphify bucket has no
`code-graphs/` artifact. Graphify is therefore configured but has no active
live artifact receipt.

## Current rollout anchors

| Item | Evidence |
| --- | --- |
| Merged OpenTag baseline | `d075431f25f886842aec5552314afea9d1c9c1dd` (`origin/main`) |
| Working checkout | `main` with preserved user-owned knowledge/ACL/reaction/derived-index changes; no reset or force operation |
| Source hotfix | `9d4538c`, fixes `PlatformStateDO` `/identity/get` object forwarding |
| Bot deployment inspected | guarded current code version `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`; live health and authenticated knowledge readiness report the model, knowledge bindings, observer, index generation, relay allowlist, and broker auth configured |
| Derived-index deployments | Supermemory and Graphify are private and deployed; Supermemory version 18 has a live document write/poll/search receipt, while the singleton query instances are still reported as `running` rather than `healthy`; restart/remount, parity, Graphify artifact, and complete convergence evidence remain open |
| Harness deployment inspected | version `718af083-0b2d-4809-a878-7b98e7b3aef6`; Wrangler verifies image `sha256:2d9a0a10d718265b7ea331ba2de3b8fd309cb33cbdf6175d92036fc681004880` with seven healthy instances; source mapping remains open |
| Slack evidence | ACL cadence [`1785719827818089`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719827818089) and provider receipt [`1785719693438309`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785719693438309) are live; fresh marker [`1785725283.368069`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725283368069) plus explicit search [`1785725373.889899`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725373889899) returned `OPENTAG_SUPERMEMORY_SEARCH_OK`, while untagged search [`1785725304.390959`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785725304390959) remained silent on the deployed version |
| Buzz evidence | live empty `POST /buzz/wake` returns HTTP 400 `buzz_wake_unexpected_fields`; configuration/schema gate is live, signed admission remains open |

The deployment was authorized as part of the end-to-end rollout. Secret values,
private keys, OAuth codes, and provider tokens are intentionally absent from
all artifacts.

## Historical live continuation — 2026-08-02 19:45 PDT

The upgraded Cloudflare-only Supermemory path is now provider-reachable in the
deployed environment. Supermemory version 18 uses the Worker-owned R2 binding
and disposable local model-cache overlay; provider tail evidence records
document write/poll and `/v4/search` HTTP 200. The authenticated knowledge
readiness profile returns HTTP 200. This closes the immediate provider
reachability incident, not restart persistence, update/delete/tombstone
convergence, parity, or complete-history coverage.

The authoritative tenant readback is 77 ledger rows: 32 indexed, 19 leased, 2
pending, and 24 permanent failures. Outbox and DLQ work are empty. Thirty old
`local_add` rows were reopened under correction reference
`supermemory-v18-r2-model-cache-repair-da95429a`; three post-fix rows have
explicit `indexed` outcomes and four earlier recovery dispatches completed,
but the 19 leased rows still require a post-drain readback. The remaining 24
permanent outcomes are bounded to 23 `unsupported_update_contract` rows and
one Slack `thread_not_found` row.

Fresh Slack evidence includes a marker write and explicit-mention retrieval
that returned `Searching Slack` followed by `OPENTAG_SUPERMEMORY_SEARCH_OK`,
with the working reaction removed from the parent. The equivalent untagged
retrieval request stayed silent on the deployed version. The checkout now has
and tests a leading `search`/`look up`/`lookup`/`query` routing rule, but that
repair remains local-only pending the explicit deployment gate.

The strict read-only Container preflight still fails because both query
instances report `running`, not `healthy`; the local port gate returns `503`
for non-health traffic before R2, exposes bootstrap health for the lifecycle
mount, and waits for the provider-ready sentinel before returning health
success. Docker is
unavailable, so image rebuild, FUSE remount/restart, and clean
source-to-image provenance remain open. Buzz remains blocked at the deployed
Worker-to-relay HTTP 526 phase, and no valid signed admission is claimed.

A repeat of `npm run check:knowledge-rollout -- --live
--require-healthy-instances` at 20:05 PDT passed every static, bucket, Worker,
secret, pin, and artifact check and failed only the Supermemory query instance
(`a8d7e9f4…`, version 18) and Graphify query instance
(`71c5e0ec…`, version 6) health-state checks. Both remain registered and
`running`; neither is claimed healthy until the gated health-probe rollout and
readback are complete.

## Historical live continuation — 2026-08-02 13:25 PDT

The guarded bot deployment `8fd0e0bb-7167-40b5-a223-c626f701f916` is live with
generation `cf-validation-2026-08-02`. `/health` is HTTP 200, while
authenticated `/ready?profile=knowledge` and `/ready?profile=full` remain HTTP
503. Knowledge readiness is blocked by the Supermemory and Graphify probes; the
full profile is additionally blocked by credential-broker, platform-effecter,
and OAuth readiness.

KnowledgeDO status is not healthy convergence: the ledger contains 40
`permanent_failure` rows, the outbox and DLQ have no pending work, the latest
reconciliation run scanned and skipped all 40 terminal rows, and there is no
completed backfill or inventory receipt. The current source identity still has
an explicit policy/source mismatch (`workspace-default` policy versus an older
`default` source row), so it must be corrected through an audited migration or
explicit compatibility decision rather than overwritten silently.

The current Slack controls prove explicit routing, no-mention routing, passive
silence, terminal reaction cleanup, and removal of the visible
`OpenTag AG-UI`/`Working…` surface from current-day messages. They do not prove
Slack reaction or lifecycle event delivery into KnowledgeDO, complete workspace
visibility, or derived-index convergence. The bot is confirmed in four visible
public channels; installed-manifest readback, private/DM/MPIM coverage, and
complete-history receipts remain open.

The deployed Supermemory and Graphify query containers currently report zero
healthy instances. No provider key is configured, no live add/poll/search
receipt exists, and the current harness image digest still lacks a verified
mapping to the dirty local source manifest. Buzz configuration reaches schema
validation, but valid signed relay admission and a tenant-scoped runtime
receipt remain unproven.

## Historical live continuation — 2026-08-02 11:37 PDT

The final inspected bot deployment is `bd19e926-b8c9-439c-a9e8-d01da0f6cbe2`.
Its health payload reports the model, native Nanocodex, knowledge bindings,
observer, index generation, broker, and Buzz configuration as present. The
broker and custody health probes correctly report `providerResolutionEnabled:
false` because custody still has no binding map; configuration presence is not
provider authorization.

The authenticated human Slack controls now prove the current deployment's
explicit routing, no-mention response routing, passive-message silence, and
working-reaction cleanup. A fresh retrieval request at
[`1785694376.778339`](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785694376778339)
entered `Searching Slack` and returned `Knowledge unavailable.` at
`1785694396.357459`. That is a live degraded knowledge/search result: it proves
request admission and error cleanup, not marker indexing, KnowledgeDO
ownership, or derived-index convergence.

The authenticated Slack surface then invited bot `U0BAK4AJ2Q1` to
`#new-channel` (`C0BADPYGSR3`), `#social` (`C0BAF3XC3AA`), and `#skills`
(`C0BGS7FNQUE`). Member readback includes the bot in all four visible public
channels, and the bot-token inventory reports `is_member:true` for all four.
This closes visible public-channel membership coverage; installed-manifest
readback, private/DM/MPIM coverage, reaction/lifecycle delivery, complete
backfill, and knowledge convergence remain open.

## Feature and gap ledger

| Backfill conclusion or requested feature | Current classification | Current evidence / next gate |
| --- | --- | --- |
| Durable Slack admission, session events, replay, render obligations, Stop, HITL, quick actions | Live-verified path; source-complete | Live Slack normal-turn/concurrency markers plus focused lifecycle tests. Live Stop and button-click drills remain targeted follow-ups. |
| Centaur streaming/conflation and never-silent delivery | Live-verified path; source-complete | Current bot path and Slack canaries; normal turns no longer publish Slack's `Thinking…` assistant status, while stale-status cleanup remains fenced; transport-failure recovery still needs fault injection. |
| Centaur authoritative runtime/capability identity | Live-verified | Bounded runtime evidence appears in health/configuration paths; `/health` exposes missing model/reconciliation readiness instead of claiming success. |
| QM capability profiles and serviceability evidence | Source-complete/adapted | Harness capability profiles, runtime evidence, and deployment preflight exist. A broader `check`/`doctor` operator surface remains a useful follow-up. |
| QM durable leases, heartbeats, reapers, and terminal delivery proof | Adapted/source-complete | OpenTag uses DO transactions, active-turn leases, alarms, event replay, and render/effect fences; no second Postgres run fleet is needed. |
| QM tool provenance, grants, admin/public separation | Adapted/source-complete | Access bundles, connector labels, actor tokens, permission snapshots, and effect fences exist; external provider grants remain gated. |
| Nanocodex typed Responses transport | Live-verified one-turn path; source-complete replay contract | Native adapter and harness wire path returned `OPENTAG_NANOCODEX_NATIVE_OK`; live checkpoint loss/reconnect remains untested. |
| Nanocodex provider state, retry, reconnect, completed-only commit | Source-complete | Focused adapter/session tests; no live provider fault injection in this rollout. |
| Buzz server-resolved tenancy and exact tenant/channel scope | Source-complete/adapted | `edge/src/tenancy.ts`, channel map, signed wake contract, explicit relay-origin vars in `wrangler.bot.toml`, and source tests. Authenticated relay/event canary remains open. |
| Buzz NIP-42/NIP-98/NIP-OA admission and provenance | Configuration gate live; signed admission open | Signer, relay, channel map, and independent relay allowlist are configured; an empty wake reaches schema validation with 400. No valid signed relay/event admission is claimed. |
| Buzz durable event/audit/dedupe and result authorization | Source-complete/adapted | Receive, query, verification, dedupe, and runtime-admit contracts are focused-tested; live relay proof is open. |
| Shared Worker fleet with strict per-team Durable Objects | Locked; synthetic-live metadata path | User decision is recorded in `DECISIONS.md`; platform synthetic tenant and deterministic tenant object naming pass. |
| Worker Secrets and one-click/CLI deployment | Locked bootstrap mechanism; source-complete | Secret-safe deploy script and Wrangler paths exist. Worker Secrets are not per-tenant OAuth custody. |
| Layer 3 provisioning, identity, credential, OAuth, marketplace, meter, memory contracts | Synthetic-live | Deployed `PlatformStateDO` exercised idempotency, reads/writes, revocation, grants, marketplace, meter, deletion request, and effect leases. |
| Layer 3 identity read defect | Fixed and live-verified | `9d4538c` extracts `identityRef`; focused test passes and post-fix admin read returned 200 for synthetic metadata. |
| External effect worker and provider custody | Fail-closed shells deployed; provider execution open | Effect/custody, OAuth, billing, provisioning, and memory-deletion Workers answer health checks. Broker/custody internal auth is configured, but custody has no approved Secrets Store binding map, provider adapters, credential resolution, receipts, retries, revocation, and reconciliation are not live-proven. |
| Google Drive search | Source-complete; fail-closed | No deployed `CONNECTOR_CREDENTIALS`; no provider happy path or real token was used. |
| Guarded Linear create | Source-complete; fail-closed | Approval/revalidation/project/milestone code and tests exist; broker, OAuth grant, test workspace, and live write are open. |
| Router heuristic classifier and measurement ledger | Live-verified shadow mode | Admin summary/list showed counterfactual Tier 1 with Tier 2 dispatch; Tier 1/Tier 3 remain dark. |
| Knowledge actor tokens and bounded MCP | Source-complete; operator/admin live only | Actor token, replay, ACL, audit, and query-template tests pass; external MCP remains operator-only. |
| Slack knowledge search | Live provider-backed canary; completeness/convergence open | A fresh marker write followed by explicit retrieval entered `Searching Slack` and returned `OPENTAG_SUPERMEMORY_SEARCH_OK`; the parent had no lingering working reaction. This proves one provider-backed search path, not complete workspace indexing, leased-row convergence, update/delete/tombstone behavior, or bounded completeness. |
| Cloudflare-only Supermemory and Graphify derived indexes | Deployed privately; provider reachability partially verified | Static architecture, service-boundary, registry, policy, and type tests pass; both dedicated R2 buckets and both private Workers/Container applications are provisioned. Supermemory has a live write/poll/search receipt, but both singleton query instances report `running` rather than `healthy`; restart/remount, parity, complete convergence, and Graphify artifact/citation evidence remain open. The server-owned Graphify catalog currently contains only `opentag`; adding qm, Nanocodex, Buzz, or Centaur requires an explicit repository-scope decision and catalog/build credentials. |
| Slack outbound knowledge observation | Deployed; live convergence open | The shared Slack Web API path now observes every committed write by default, including placeholders, progress/tool-status updates, terminal/control notices, and answer pages; local metadata is stripped and the observer requests a whole-thread refetch. A fresh marker write plus explicit retrieval now proves provider-backed search, while leased ledger rows, complete-history backfill, derived-index convergence, and bounded completeness remain open. |
| Slack bot-message indexing and response-loop prevention | Source-complete; live gate open | Inbound and outbound bot messages retain attribution in explicitly admitted or server-materialized sources while pre-admission rejects bot-authored triggers. Current human canaries prove delivery/routing/reaction cleanup, but a bot-message-to-KnowledgeDO receipt, workspace-wide admission, manifest readback, live ACL/reconciliation, and derived-index convergence remain open. |
| Slack installation lifecycle and replacement fencing | Source-complete; live gate open | The local manifest covers workspace uninstall, bot-token revocation, public-channel lifecycle events, and private-channel `group_*` lifecycle events. WorkspaceConfigDO persists per-team installation generations and per-channel status, fences `(team_id,event_id)`, disables sources/leases on revocation or channel loss, invalidates tenant-scoped ACL state, ignores user-only OAuth revocation, and requires explicit reinstall activation. Installed manifest readback, lifecycle canaries, and derived-index tombstone/reconciliation receipts remain open. |
| Knowledge reconciliation/backfill | Deployed trigger; execution/backfill open | The bot declares a 15-minute reconciliation trigger and current team scope; cron execution, live `all_delivered` policy readback, complete-history receipts, and source/budget/retention/ACL/backup/restore/rollback gates remain. |
| Billing | Metering only; open | Usage events and idempotency are synthetic-live; no billing provider or enforcement worker is deployed. |
| Memory deletion | Request ledger only; open | Deletion request and intent are synthetic-live; source-by-source executor proof is missing. |
| OAuth marketplace trust/callback | Metadata only; open | Curated metadata and revocation exist; callback ownership, nonce/state, trust review, and effect execution remain. |
| QM web/portal, Socket Mode, Fly/AWS/Postgres spine | Not applicable to OpenTag | Preserve grants/audit/serviceability ideas; retain Cloudflare Workers/DO/Containers and Slack Events API. |
| Centaur Kubernetes/Rails/Postgres, Buzz media/Mesh/mobile, Nanocodex VM/subscription auth | Not applicable to current spine | Product surfaces may be revisited only through a new product decision. |
| General multi-agent workflow fleet and Nanocodex conversation branching | Deferred | Keep durable lifecycle contracts; no second orchestration or branching product surface is required now. |

## Attached QM feedback incorporated

The QM feedback describes QM as a broader company agent operating system with
typed harnesses, durable runs/sessions/memory/files/audits/crons, connectors and
OAuth/keychain grants, web/admin/portal surfaces, and a Node/Fastify/Postgres/
Fly/AWS substrate. The OpenTag response is deliberately contract-level:

- adopt capability profiles, explicit provider/model provenance, durable
  leases/heartbeats/reapers, terminal delivery evidence, serviceability
  allowlists, typed tool-result provenance, and read-only check/doctor/deploy
  proofs;
- adapt grants, OAuth, connector scopes, admin/public separation, audit, and
  personal/shared workspace concepts to team-named Durable Objects and the
  existing access-bundle/effect-ledger model;
- keep QM beside OpenTag behind a signed adapter only if a concrete product
  requirement needs the broader workspace/control-plane surface; and
- do not move OpenTag to Node/Postgres/Fly/AWS, add Socket Mode, or copy QM's
  direct credential injection model into a user-agent process.

This resolves the feedback's “what should we add?” question without turning
QM's infrastructure into an unbounded parity checklist.

## Document-by-document reconciliation

| Artifact | Treatment |
| --- | --- |
| `PROGRESS.md` | Historical goal ledger retained; current status and deployment authority are superseded by this file and `docs/current-state.md`. |
| `analysis/source-manifest.md` | Historical repository heads/ranges retained; current OpenTag deployment anchors are recorded here because the manifest is a backfill snapshot. |
| `analysis/qm.md` | Historical QM source/history report retained; old “Layer 3 unresolved/no deployment” wording is true at review time and superseded by the current ledger. |
| `analysis/nanocodex.md` | Historical Nanocodex/OpenTag report retained; native adapter and Slack canary now close the previously planned adapter gap, while reconnect/provider gates remain. |
| `analysis/buzz.md` | Historical Buzz report retained; tenancy/receive plumbing is source-complete but valid signed relay admission remains unproven. |
| `analysis/centaur.md` | Historical Centaur parity report retained; runtime evidence, platform foundation, and router shadow work now address its missed portable recommendations. |
| `local-only/README.md` | Local synthesis retained and linked to this current-state record. |
| `local-only/opentag-improvement-plan.md` | Historical implementation plan retained with current status addendum; no Defer/Not Applicable item is silently removed. |
| `local-only/qm.md` | Historical QM synthesis retained with current custody/capability reconciliation. |
| `local-only/nanocodex.md` | Historical Nanocodex synthesis retained with native adapter/live marker reconciliation. |
| `local-only/buzz.md` | Historical Buzz synthesis retained with fail-closed live wake result. |
| `local-only/centaur.md` | Historical Centaur synthesis retained with live runtime/platform/router reconciliation. |
| `local-only/source-manifest.md` | Historical local source snapshot retained; do not use it as a current deployment ref. |
| `validate.py` | Structural validator retained; it validates artifact shape, not production readiness. |

## Validation of this reconciliation

- OpenTag full Vitest suite: 144 files / 1,368 tests passed at the latest full-suite checkpoint; the bot-store Worker suite is 8 files / 67 tests and the Graphify Worker suite is 1 file / 5 tests.
- The current actor/MCP retrieval slice passed 27 tests, and the provider/effecter
  contract slice passed 16 files / 85 tests.
- OpenTag bot-store Worker suite: 8 files / 59 tests passed at the earlier
  reconciliation checkpoint; the full current suite supersedes that count.
- Graphify Worker suite: 1 file / 4 tests passed at the earlier reconciliation
  checkpoint; the full current suite supersedes that count.
- OpenTag and derived-worker TypeScript typechecks: passed.
- Graphify policy tests and deploy-config validation: passed.
- Live bot deployment inspected: guarded current code version `764a18ea-bda9-4209-bdbc-0b9cc81a6cba`; `/health` and authenticated knowledge readiness returned HTTP 200. The strict Container health preflight still fails because the two query instances are `running`, not `healthy`.
- Slack post-fix marker: `OPENTAG_POSTFIX_E2E_OK` returned.
- Buzz configuration probe: empty `/buzz/wake` returned HTTP 400 `buzz_wake_unexpected_fields`; signed admission remains unproven.
- No secret values, private keys, OAuth codes, or external provider writes are
  recorded in the artifacts.
