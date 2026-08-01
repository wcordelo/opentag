# OpenTag multi-repository architecture and implementation report

Status: implementation branch `codex/end-to-end-architecture-local`
Date: 2026-08-01 (Pacific)

This report is the durable OpenTag synthesis of the complete-history backfill
and source deep dives for `qm`, Nanocodex, Buzz, and Centaur. The repositories
remain separate products. Their useful contracts are adapted into the
OpenTag Workers/Durable Objects/Queues/R2/Containers stack; their deployment
substrates are not copied by analogy.

## Backfill result

The one-time sync ran immediately after the workflows were defined. The
comparison used the complete reachable history after each fork's common
ancestor, not a snapshot-only diff.

| Repository | Parent -> fork | Common ancestor | History reviewed | Backfill result |
| --- | --- | --- | --- | --- |
| qm | `yc-software/qm` -> `wcordelo/qm:main` | `7f2c9163` | 40 reachable commits; 0 parent-only, 0 fork-only | Already equal; no push |
| Nanocodex | `gakonst/nanocodex` -> `wcordelo/nanocodex:master` | `3d4548b0` | 53 parent-only, 3 fork-only, plus the merge tip | Parent merged and pushed as `e9ca9258cc00413bd0580e97979a9488fba9a67b` |
| Buzz | `block/buzz` -> `wcordelo/buzz:main` | `acfbb1bb` | 276 parent-only, 1 fork-only, plus the merge tip | Parent merged and pushed as `40d1bebf5fefeeb57463973af9cd8a64026abc0c` |
| Centaur | `paradigmxyz/centaur` -> `wcordelo/centaur:main` | `6d109198` | 64 fork-only commits; parent-only delta 0 | Parent tip already present; existing Centaur sync remains the owner |

The Nanocodex and Buzz merges were performed in isolated temporary worktrees
with whitespace checks and exact remote-before-push checks. The primary
Centaur checkout had unrelated dirty files and was not rewritten.

Three independent local sync tasks now run daily at 8:00 AM Pacific:

- `daily-qm-parent-sync`
- `daily-nanocodex-parent-sync`
- `daily-buzz-parent-sync`

Each fetches the canonical parent, merges into the fork default branch, runs
bounded validation, and pushes only to the fork default branch. It never
force-pushes, rebases, deploys, or edits OpenTag.

## Repository deep dives

### qm

qm is a private-forkable, interface-backed agent application. Its core
boundary is explicit: organization-specific material lives under
`deploy/layers/<org>/`; core runtime, plugins, CLI, docs, and CI remain
byte-identical to upstream. `AGENTS.md`, `README.md`, `src/wiring.ts`, and
`src/index.ts` make this separation operational.

The reusable architecture is durable lifecycle control. `src/runs/` supplies
idempotent run records, leases, heartbeats, reaping, delivery state, and
terminal callbacks. `src/sessions/` owns session/tape state; `src/tasks/`
owns compare-and-set task transitions; `src/cron/` owns deduplicated fire
claims. `src/harness/harness.ts` and `src/harness/harness-router.ts` define
typed harness capability and refuse unsupported runtime/model combinations.
`src/tools/`, `src/policy/`, `src/security/`, and `src/credentials/` keep
approval, denial, provider credentials, and tool provenance at shared
boundaries rather than inside one model adapter.

OpenTag already has stronger Slack turn admission, Stop, render/effect fences,
and per-thread DO serialization. The implementation therefore adapts qm's
lease/CAS/terminal-evidence vocabulary to existing OpenTag ledgers and DO
alarms instead of adding a Postgres run fleet. The qm private-fork boundary is
adapted as a product-core versus deployment/workspace configuration boundary.
Fly/AWS/Postgres, the full qm web/portal surface, and Socket Mode are not
OpenTag requirements.

### Nanocodex

Nanocodex is a Rust library and CLI with a private driver owning mutable
runtime state while consumers receive typed handles, events, and terminal
results. The primary architecture is visible in
`crates/nanocodex-agent/`, `crates/nanocodex-oai-api/`,
`crates/nanocodex-tools/`, `examples/`, and `docs/RESPONSES_TOWER.md`.

The important contracts are typed Responses input/output, streaming lifecycle
events, explicit tool and MCP boundaries, client-owned history, provider
continuation IDs as an optimization, full-history replay when a continuation
checkpoint is unavailable, and completed-only state commits. Diagnostics are
useful evidence, but OpenTag must retain its own redaction and durable event
authority rather than storing unrestricted prompt/tool traces.

OpenTag now contains a native typed adapter at
`edge/workers/sandbox/src/nanocodex-responses.ts`. It uses the existing
authenticated harness wire contract, streams typed Responses events, uses
`previous_response_id` only for a healthy checkpoint, replays full typed
history after a lost checkpoint, retries only checkpoint-specific failures,
and commits provider state only after `response.completed` with status
`completed`. `SessionEventDO` stores the provider checkpoint durably. Coding
tasks remain on the existing CLI path because the native adapter is currently
text-only and tool-free.

Nanocodex's libkrun VM, native ChatGPT subscription auth, arbitrary dynamic
MCP discovery, and conversation-branch product surface remain outside the
Cloudflare deployment contract.

### Buzz

Buzz is a multi-tenant Nostr relay and agent platform. Its architecture is
spread across `crates/buzz-relay/`, `crates/buzz-auth/`, `crates/buzz-core/`,
`crates/buzz-acp/`, `crates/buzz-search/`, `crates/buzz-audit/`,
`crates/buzz-workflow/`, and the NIP/specification documents.

The portable contracts are server-resolved tenant binding, distinct channel
and community scope, NIP-42/NIP-98 freshness/signature/URL binding, NIP-OA
owner-versus-agent provenance, access checks before paging and result
delivery, durable replay/idempotency, bounded network/tool output, fail-closed
revocation, and conformance fixtures for foreign-row and host/channel leaks.
Buzz's workflow executor, media system, desktop/mobile clients, Mesh, and
Kubernetes/Helm topology are real Buzz features but not OpenTag's product
spine.

OpenTag preserves the existing Buzz transport contracts and extends the
server-side tenant invariant to KnowledgeDO, WorkspaceConfigDO, connector
search, knowledge jobs, and MCP audit/replay paths. `edge/src/tenancy.ts`
centralizes validated team-scoped DO lookup. Knowledge actor tokens carry
team/project/ACL/resource scopes, are short-lived and HMAC-bound, are
single-use through a tenant DO replay table, and require durable audit before
actor results are returned. The existing NIP-98/NIP-OA path remains a
connector boundary, not a replacement for Slack or knowledge source truth.

### Centaur

Centaur is a Slack-first agent platform with a Rust API/control plane,
Postgres state, Kubernetes sandboxes, Rails operator console, Slack services,
provider gateways, and source-specific tools. The deep dive covered
`services/api-rs/`, `services/slackbotv2/`, `services/sandbox/`,
`services/console/`, `services/iron-proxy/`, workflow/tool packages, and the
deployment charts/docs.

The missed portable feature was authoritative runtime/capability identity:
the system must distinguish live deployment evidence from repository-local
instructions and make missing or stale configuration visible. OpenTag now
projects bounded redacted runtime capability evidence from the Worker health
path and passes configuration-only evidence into the agent context; it does
not represent source files as proof of a live deployment.

Centaur's Slack streaming, durable session/replay, Stop, quick-action,
requester attribution, sentinel/egress, and harness postcondition contracts
are already covered by OpenTag's existing DO/Container architecture. Quick
static hosting, Rails/Postgres/Kubernetes implementation, local CUDA/vLLM,
Eve/Goose experiments, and Centaur's extra ingress surfaces are intentionally
not imported. Their lifecycle and readiness lessons are represented in the
OpenTag runtime evidence, deployment script, and conformance tests.

## OpenTag decisions and implementation ledger

The user-approved decisions are binding for this branch:

| Decision | OpenTag contract |
| --- | --- |
| Tenancy | One shared Worker fleet; every team-scoped stateful path resolves to a team-named Durable Object. No caller-controlled DO IDs. |
| Credentials | Workers Secrets for deployment/runtime credentials. Containers see sentinel values; one-click and Wrangler CLI paths configure real secrets. |
| Knowledge/MCP | Internal actor-bound tokens; external operator bearer remains available; actor requests require scope, replay, durable audit, and final source authorization. Live rollout is permitted. |
| Nanocodex | Native typed Responses adapter now, beneath the current harness boundary. |
| Router | Exact heuristic table in shadow mode first; Tier 1 dispatch remains gated by workspace knowledge health, with Tier 2 as the safe floor. |
| Publication | Branches, PRs, secret configuration, deployment, and live canary are authorized. Secret values are never invented or written to source/logs. |

| Backfill finding | Action in this branch | Evidence |
| --- | --- | --- |
| Live runtime and capability identity | Implemented bounded redacted projection and health exposure | `edge/src/runtime-identity.ts`, `edge/src/runtime-evidence.ts`, `edge/src/worker.ts` |
| Harness capability negotiation | Implemented versioned profiles and explicit Nanocodex native capability limits | `edge/src/harness/capability-profile.ts`, `edge/src/harness/client.ts`, `edge/workers/sandbox/turn-contract.ts` |
| Native provider history/replay | Implemented durable provider state, typed streaming, checkpoint replay, and completed-only commit | `edge/workers/sandbox/src/nanocodex-responses.ts`, `edge/src/store/session-event-do.ts` |
| Actor-bound knowledge authorization | Implemented HMAC token, team/project/ACL checks, single-use replay, and fail-closed actor audit | `edge/src/mcp/knowledge-actor-token.ts`, `edge/src/mcp/knowledge-mcp.ts`, `edge/src/memory/knowledge-do.ts` |
| Strict team isolation | Implemented shared helper and migrated Knowledge, config, jobs, search, memory, and command paths | `edge/src/tenancy.ts` and affected callers |
| Router heuristic contract | Implemented versioned Tier 1/Tier 2 classifier with code/quote filtering and category-only shadow telemetry | `edge/src/router/heuristics.ts`, `edge/src/slack/cloudflare-slack-adapter.ts`, `edge/src/bot-engine.ts` |
| Deployment/preflight behavior | Implemented secret-safe one-click deploy script and health capability evidence | `edge/scripts/deploy-opentag.mjs`, `docs/operations.md`, `edge/wrangler.bot.toml` |
| Durable job/retry lessons | Reused existing KnowledgeLedger/outbox/lease/reconcile and research alarm contracts; no second queue was introduced | `edge/src/memory/knowledge-ledger.ts`, `edge/src/memory/knowledge-jobs.ts`, `edge/workers/orchestrator/` |
| Conformance/security budget | Preserved existing egress, dedupe, ACL, bounds, cancellation, and redaction fixtures; added tenancy/native/actor/router fixtures | `edge/test/` affected suites |

## Defer and Not Applicable decisions

Defer and Not Applicable findings were not silently dropped. They were
checked against the chosen stack:

- Buildable infrastructure was retained: bounded durable leases, audit,
  replay, tenant lookup, runtime evidence, one-click secret provisioning,
  readiness checks, and source-authorization hooks.
- Kubernetes/Helm node fleets, Rails/Postgres product persistence, Redis
  topology, and custom sandbox orchestration do not fit the existing
  Workers/DO/Containers product and are ignored as infrastructure choices.
- Buzz Blossom media, Mesh/huddle transport, desktop/mobile parity, Nostr git
  forge, and remote-agent fleets remain separate product tracks. OpenTag keeps
  its Slack/R2 attachment and exact remote-git approval contracts.
- Full qm portal/web/Socket Mode, Nanocodex conversation branching, and a
  general multi-agent workflow engine remain deferred. Their durable
  lifecycle contracts are reused where an existing OpenTag job path needs
  them, without adding a second product surface.
- OAuth connector marketplaces, user keychains, and standing grants are not
  fabricated. The initial Layer 3 custody choice is Workers Secrets; a later
  grant/connector layer must add explicit operator identity, revocation, and
  audit rather than infer them from another repository.

## Review and validation record

The implementation uses focused tests for every new boundary. The initial
focused pass covered runtime evidence, router heuristics, actor tokens,
knowledge MCP, tenancy, health, capability profiles, harness behavior, and
Nanocodex Responses streaming/replay. A fresh-context security review found
and the implementation resolved four blockers: trusted team-boundary claims,
provider-state commit timing, actor-token revocation/audit linkage, and
deployment coverage for the Supermemory credential.

Current local validation:

- `npm test`: 96 files, 1,084 tests passed.
- `npm run test:e2e`: 4 files, 48 tests passed.
- `npm run typecheck` and `npm --prefix workers/sandbox run typecheck` passed.
- `npm run validate:deploy-config` passed.
- `git diff --check` passed.

Publication and deployment evidence:

- OpenTag PR [#28](https://github.com/wcordelo/opentag/pull/28) contains this
  implementation. The branch is `codex/end-to-end-architecture-local`; the
  implementation merge tip is
  `8025b6f02eb8d839fe639efff03497b22ad00e99`, followed by documentation-only
  publication commits.
- The harness container built successfully with the pinned toolchain and was
  applied to Cloudflare application
  `opentag-harness-harnesscontainer` as version
  `6327fccc-f016-4932-ac24-fc708a13299e`, image digest
  `sha256:dd6b31be13352b6c2b5c38921b1117c983c3a8781f315cc755eb0d963938309c`.
- The bot Worker was redeployed at the final branch tip as version
  `d88c65d3-1117-4fd9-9241-e932682b054c`.
- `GET https://opentag-bot.williamlopezc.workers.dev/health` returned HTTP 200.
  It reported all durable stores, the harness service binding, native
  Nanocodex capability, knowledge actor-token configuration, Buzz relay
  configuration, and tenant durability as ready. It correctly reported
  external reconciliation as not configured and trusted rich mentions as
  disabled.
- Cloudflare Secrets were configured for the authorized rollout, including
  the harness `OPENAI_API_KEY` and bot
  `KNOWLEDGE_ACTOR_TOKEN_SECRET`; secret values were never written to source
  or logs.

The live Worker health rollout is verified. A real Slack/model-response
canary was not executed because no designated test channel or public harness
route was supplied; the deployed harness is private and reachable through the
Worker service binding. The implementation therefore does not claim a
successful end-to-end provider turn until that bounded canary is run.

The source-only backfill reports and Notion destinations remain isolated by
project. Notion is a review index; this Markdown report and the OpenTag source
are authoritative for implementation:

- [qm review database](https://app.notion.com/p/a6bec0130f794839892ea92370fe5b1c)
- [Nanocodex review database](https://app.notion.com/p/b8f80af8713840bb9be1b11c3c2ca268)
- [Buzz review database](https://app.notion.com/p/b98b3f7222a44872afeada6550cc2241)
- [Centaur review database](https://app.notion.com/p/3f174eb0c9b24c51aa28beeae39de4ef)
