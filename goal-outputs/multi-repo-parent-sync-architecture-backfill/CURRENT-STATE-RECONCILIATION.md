# Multi-repository backfill — current-state reconciliation

Status: **complete reconciliation of the 2026-08-01 backfill artifacts**

Updated: **2026-08-01 Pacific**

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

## Current rollout anchors

| Item | Evidence |
| --- | --- |
| Merged OpenTag baseline | `ff8d649ff91e35b7c428de1a45f5e892bcc747a7` |
| Reconciliation branch | `codex/docs-live-reconciliation` |
| Source hotfix | `9d4538c`, fixes `PlatformStateDO` `/identity/get` object forwarding |
| Bot deployment | version `45c11f66-c22a-4032-a13a-b18706656f05` |
| Harness deployment | version `58c47ab9-daf9-456b-b17c-73fc66e6b25d` |
| Slack evidence | [post-fix canary thread](https://berendo.slack.com/archives/C0BA1MKPRE3/p1785626165915119) |
| Buzz evidence | live `POST /buzz/wake` returned HTTP 503 `buzz_receive_not_configured` |

The deployment was authorized as part of the end-to-end rollout. Secret values,
private keys, OAuth codes, and provider tokens are intentionally absent from
all artifacts.

## Feature and gap ledger

| Backfill conclusion or requested feature | Current classification | Current evidence / next gate |
| --- | --- | --- |
| Durable Slack admission, session events, replay, render obligations, Stop, HITL, quick actions | Live-verified path; source-complete | Live Slack normal-turn/concurrency markers plus focused lifecycle tests. Live Stop and button-click drills remain targeted follow-ups. |
| Centaur streaming/conflation and never-silent delivery | Live-verified path; source-complete | Current bot path and Slack canaries; transport-failure recovery still needs fault injection. |
| Centaur authoritative runtime/capability identity | Live-verified | Bounded runtime evidence appears in health/configuration paths; `/health` exposes missing model/reconciliation readiness instead of claiming success. |
| QM capability profiles and serviceability evidence | Source-complete/adapted | Harness capability profiles, runtime evidence, and deployment preflight exist. A broader `check`/`doctor` operator surface remains a useful follow-up. |
| QM durable leases, heartbeats, reapers, and terminal delivery proof | Adapted/source-complete | OpenTag uses DO transactions, active-turn leases, alarms, event replay, and render/effect fences; no second Postgres run fleet is needed. |
| QM tool provenance, grants, admin/public separation | Adapted/source-complete | Access bundles, connector labels, actor tokens, permission snapshots, and effect fences exist; external provider grants remain gated. |
| Nanocodex typed Responses transport | Live-verified one-turn path; source-complete replay contract | Native adapter and harness wire path returned `OPENTAG_NANOCODEX_NATIVE_OK`; live checkpoint loss/reconnect remains untested. |
| Nanocodex provider state, retry, reconnect, completed-only commit | Source-complete | Focused adapter/session tests; no live provider fault injection in this rollout. |
| Buzz server-resolved tenancy and exact tenant/channel scope | Source-complete/adapted | `edge/src/tenancy.ts`, channel map, signed wake contract, and source tests. Authenticated relay/event canary remains open. |
| Buzz NIP-42/NIP-98/NIP-OA admission and provenance | Fail-closed live | `/buzz/wake` returned 503 without signer/relay configuration; no valid admission is claimed. |
| Buzz durable event/audit/dedupe and result authorization | Source-complete/adapted | Receive, query, verification, dedupe, and runtime-admit contracts are focused-tested; live relay proof is open. |
| Shared Worker fleet with strict per-team Durable Objects | Locked; synthetic-live metadata path | User decision is recorded in `DECISIONS.md`; platform synthetic tenant and deterministic tenant object naming pass. |
| Worker Secrets and one-click/CLI deployment | Locked bootstrap mechanism; source-complete | Secret-safe deploy script and Wrangler paths exist. Worker Secrets are not per-tenant OAuth custody. |
| Layer 3 provisioning, identity, credential, OAuth, marketplace, meter, memory contracts | Synthetic-live | Deployed `PlatformStateDO` exercised idempotency, reads/writes, revocation, grants, marketplace, meter, deletion request, and effect leases. |
| Layer 3 identity read defect | Fixed and live-verified | `9d4538c` extracts `identityRef`; focused test passes and post-fix admin read returned 200 for synthetic metadata. |
| External effect worker and provider custody | Open | Pending intents are a durable handoff only. Need broker/effect worker, scoped credentials, receipts, retries, revocation, and reconciliation. |
| Google Drive search | Source-complete; fail-closed | No deployed `CONNECTOR_CREDENTIALS`; no provider happy path or real token was used. |
| Guarded Linear create | Source-complete; fail-closed | Approval/revalidation/project/milestone code and tests exist; broker, OAuth grant, test workspace, and live write are open. |
| Router heuristic classifier and measurement ledger | Live-verified shadow mode | Admin summary/list showed counterfactual Tier 1 with Tier 2 dispatch; Tier 1/Tier 3 remain dark. |
| Knowledge actor tokens and bounded MCP | Source-complete; operator/admin live only | Actor token, replay, ACL, audit, and query-template tests pass; external MCP remains operator-only. |
| Slack knowledge search | Live-verified with indexing caveat | Historical marker search and ordinary retrieval passed; fresh marker was not immediately indexed. |
| Knowledge reconciliation/backfill | Open gate | Deployed health reports reconciliation unconfigured; source, budget, retention, ACL, backup/restore, and rollback gates remain. |
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

- OpenTag focused platform test: 4 tests passed.
- OpenTag TypeScript typecheck: passed.
- Bot deployment: successful; `/health` returned HTTP 200.
- Slack post-fix marker: `OPENTAG_POSTFIX_E2E_OK` returned.
- Buzz negative wake probe: HTTP 503 `buzz_receive_not_configured`.
- No secret values, private keys, OAuth codes, or external provider writes are
  recorded in the artifacts.
