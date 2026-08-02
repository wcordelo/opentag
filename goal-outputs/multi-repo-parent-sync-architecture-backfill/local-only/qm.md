> **Historical snapshot.** This artifact was authored before the final merged OpenTag rollout. Read [the current reconciliation](../CURRENT-STATE-RECONCILIATION.md) and [the current OpenTag status](../../../docs/current-state.md) before treating any implementation or deployment statement as current.
>
> Current reconciliation: QM's durable runs, capability profiles, serviceability, grants, provenance, and operator separation are design inputs. OpenTag has adapted the portable parts without adopting QM's Node/Postgres/Fly/AWS spine or direct credential model; per-tenant custody and external effects remain open.

# qm parent-to-fork backfill and architecture deep dive

As of 2026-08-01, this report covers the `qm` fork at `/Users/will/Documents/qm`, its upstream parent, the complete reachable history in the checkout, and a source-level comparison with the current OpenTag architecture. Current-implementation evidence is separated from recommendations. No qm source, branch, deployment, PR, Notion page, or unrelated OpenTag file was changed.

## Repository and sync provenance

| Item | Verified value |
| --- | --- |
| Parent | `https://github.com/yc-software/qm.git` |
| Parent default branch | `main` |
| Fork | `https://github.com/wcordelo/qm.git` |
| Fork default branch | `main` |
| Local remote | `origin` points to the fork URL for fetch and push |
| Local branch and HEAD | `main`, `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` |
| Live parent `main` | `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` from `git ls-remote` |
| Live fork `main` | `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` from `git ls-remote` |
| Verified common ancestor | `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; both heads and the local checkout resolve to it |
| Parent delta since ancestor | `7f2c916360f1797a8ff2a77ce2ce40c5fabab087..7f2c916360f1797a8ff2a77ce2ce40c5fabab087`: 0 commits |
| Fork-only delta since ancestor | `7f2c916360f1797a8ff2a77ce2ce40c5fabab087..7f2c916360f1797a8ff2a77ce2ce40c5fabab087`: 0 commits |
| Complete architecture-history range reviewed | Root `57b51916f479fd642b4c0c89fb07961fd3f862b4` (`Fresh repo history`) through `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`, inclusive: 40 reachable commits, 39 descendants after the root |
| Shallow status | Not shallow (`git rev-parse --is-shallow-repository` returned `false`) |
| Sync outcome | No fetch, merge, rebase, branch update, or push was needed; the parent and fork are already identical at the verified head |

The parent was checked directly with `git ls-remote`; no parent remote was added to the checkout. The parent/fork comparison range is therefore complete and empty, while the root-to-HEAD range above supplies the architecture and hardening history available in this repository.

### Dirty-tree preservation

`qm` was clean before inspection (`main...origin/main`, with no modified or untracked paths) and remained unmodified. No stash, temporary worktree, stage, commit, push, deploy, or destructive command was used. An existing `/Users/will/Documents/qm/.git/index.lock` path was observed and left untouched. OpenTag already contained unrelated untracked handoff/spec/goal-output artifacts; they were preserved. The only planned write was this report path.

## Review method and history evidence

The current tree was inspected across `src/`, `plugins/`, `cli/`, `deploy/`, `test/`, `cli/test/`, `.github/workflows/`, and the repository documentation. The governing private-fork rules are in `AGENTS.md:68-102`: core includes runtime, plugins, CLI, docs, and CI; organization-specific material belongs only under `deploy/layers/<org>/`; upstream sync merges and never rebases. `README.md:62-78` describes the interface-backed core and Postgres-backed durable state, while `README.md:125-167` defines the standalone private-fork boundary.

The recent history is unusually concentrated: the reachable root is a new `Fresh repo history` commit on 2026-07-29, followed by 39 commits through 2026-07-31. The following exact commits were used as historical evidence for the findings below:

| Historical signal | Commit and evidence |
| --- | --- |
| Auth claims and durable system-write classification | `07e001b6494c4ca3316573401282a17b6d433b4f`, `src/api/user-scoped-routes.ts`, `test/portal-identity-gate.test.ts` |
| From-scratch deployment contract hardening | `efd41489c236f011a8247052c446984264cc4d6c`, `cli/src/config.ts`, `cli/src/secrets.ts`, `deploy/core/fly.toml`, `cli/test/secrets.test.ts` |
| Published-image hygiene | `b27c78b11538a16a0f6ac2e65c77913996ab4954`, all service Dockerfiles; `d98a91427cf07ab38527545ce64dc2314ea4929f`, `.github/workflows/publish-cli.yml`, CLI package and release tests |
| Secret and model-provider boundaries | `a2e752f25ac2ccc1e88233f54b0e3b157db9f047`, deployment secret schema/CLI/provider scaffolding; `9bf77f7de12aa8265867cbf0cf3c392fac21a229`, `src/model/*`, `src/config.ts`, provider routes and tests |
| Auth-gate and operator-surface hardening | `f23b36544cbbb943c054bf477eb21cd26082be1b`, web UI auth gate; `bdfa74f991fc835b57cdb8e9f00458e5bdd60bb2`, auth-gate fixes; `8ca1b120233dcddbce9348a6bae7c730252a2ab9`, first-admin onboarding; `35c47a3fcbd83dca8f640bdba7fa47fa2d6ec271`, portal playground sessions |
| Deployment preflight and diagnostics | `783715c714e7dc0c1ffd25395659ac42165ff53e`, `qm check`; `8da464cbcbe8458f14085a4097b6c4a6a859efa3`, `qm doctor`; `a44e2dd02b0825ba0728247f7c0b7fc0247dd399`, immutable sandbox base digests and architecture |
| Runtime policy and cost controls | `ebc2e10558a9875957270c9ab9a104312d840476`, opt-in fast mode; `e455cba7f7b8f10ecb383e83874836e172936b1c`, org fast-mode toggle; `7893008bfb5dfb02afde3d8b47ccb028e8309f79`, org allowed-model picker |
| Release and bootstrap correctness | `b80f9c629bbce74be4aff16307011bb2dca2a393`, one release dispatch with pinned artifacts; `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`, `qm init` bootstrap using `@latest` |

This history supports a system that is currently converging on explicit deployment contracts, provider allowlists, auth gates, immutable artifacts, and operator diagnostics. It does not provide older ancestry before the fresh-history root, so claims about pre-root qm history would be unsupported by this checkout.

## Current feature and architecture inventory

| Capability | Current qm implementation evidence | OpenTag comparison |
| --- | --- | --- |
| Central application composition | `src/index.ts`; the 1,427-line `src/wiring.ts` builds stores, policies, adapters, services, workers, Slack, and admin; `src/core/orchestrator.ts` is the central turn application service | OpenTag distributes ownership intentionally across Worker, `ConversationStateDO`, `SessionEventDO`, harness Workers/Containers, and research task actors in `ARCHITECTURE.md:6-90` |
| Sessions, runs, tasks, and delivery | `src/sessions/`, `src/runs/`, `src/tasks/`, `src/delivery/`; durable stores have leases, idempotency, result/delivery state, activity, and terminal callbacks | OpenTag has durable active turns, event cursors, render obligations, and research outboxes, but should borrow qm's worker-lease contract for cross-key tasks |
| Harness abstraction | `src/harness/harness.ts` defines turn, detection, compaction, model utility, tool, and adapter-profile contracts; `src/harness/harness-router.ts` resolves approved harness/model pairs | OpenTag's `edge/src/harness/client.ts` and `edge/workers/sandbox/harness-server.ts` use an NDJSON wire contract for Claude, Claudex, and Nanocodex; the transport is different but the capability-registry idea is portable |
| Model/provider boundary | `src/model/pi-models.ts`, `src/model/model-catalog.ts`, and `src/model/model-credential-store.ts` cover harness support, Anthropic/OpenAI/OpenRouter serviceability, bounded OpenRouter discovery, and encrypted provider credentials | OpenTag keeps real keys outside the harness and currently selects explicit Claude/Claudex/Nanocodex modes; provider catalog and allowlist behavior is a useful next adaptation, not a reason to place keys in containers |
| Tool boundary | `src/tools/primitives.ts` exposes scoped execute, files, memory, background jobs, crons, and surface operations; `src/harness/pi-tools.ts` applies approvals, command policy, and external/tool-result screening | OpenTag has `edge/src/tools/`, MCP/AG-UI paths, exact effect fences, and Worker-enforced egress; adopt contracts and provenance, not qm's entire tool list |
| Credentials and connectors | `src/credentials/keychain.ts`, `src/connectors/`, and `plugins/auth/` provide encrypted durable values, scoped grants, OAuth/token refresh, brokered sign-in, and replay-deduped claims | OpenTag has sentinel credentials, host/method/repository gates, and pending key-custody decisions in `HANDOFF.md`; connector marketplace and user keychain are not ready to port directly |
| Durable state | `src/persistence/durable-map.ts`, Postgres stores, leases, advisory locks, run queues, cron fire claims, audit/metrics sinks, and session tapes; memory implementations exist for local/test modes | OpenTag uses DO serialization, DO alarms, R2, event logs, and service bindings. `ARCHITECTURE.md:430-443` already has the required durable-state inventory |
| Security posture | `src/security/security-posture.ts` has dangerous/auto/strict; `src/policy/command-policy.ts` has predeclared allow/approval/deny rules; `src/auth/source-auth.ts` and capability tokens bind signed requests and replay windows | OpenTag's stronger boundary is outer-Worker credential injection, sentinel keys, exact execution fences, and durable HITL in `DECISIONS.md:34-50`, `154-220` |
| Operator surfaces | `plugins/web-ui`, `plugins/admin`, `plugins/portal`, and `plugins/auth` separate browser/portal/admin concerns while core owns authorization and audit; Slack is an optional in-process plugin | OpenTag is Slack-first and deliberately has no current web frontend/OAuth/connector marketplace/billing surface; product state and deployment decisions are in `PRODUCT.md`, `HANDOFF.md`, and `VISION-SPEC.md` |
| Deployment | `cli/` owns `init`, `check`, `doctor`, `plan`, `up`, secrets, provider backends, immutable image selection, and live proofs; `deploy/` supplies templates, with `deploy/layers/` empty in public qm | OpenTag uses Wrangler, Workers, Durable Objects, R2, service bindings, and Containers. Port the contract/preflight discipline, not Fly/AWS/Postgres topology |
| CI and release | `.github/workflows/cicd.yml` shards root, plugin, CLI, package, Postgres, and e2e checks; release workflows build/publish pinned images and npm artifacts with provenance | OpenTag has broad edge tests and product-spine tests; its equivalent should be Worker/DO/Container contract matrices plus deployment smoke checks |

## Deep dive and recommendations

### 1. Agent lifecycle, orchestration, and exact execution identity

**Current qm evidence.** `src/index.ts` loads strict configuration, builds the application, starts the HTTP server, optionally starts background work, reconciles Slack runtime state, and drains on shutdown. `src/wiring.ts` injects Postgres or memory implementations for sessions, runs, tasks, configuration maps, memory, credentials, sandbox backends, harnesses, delivery, cron, directories, projects, monitoring, and the orchestrator. `src/core/orchestrator.ts` owns scope resolution, membership, session leases, transcript/tape, sandbox provisioning, execution, memory, tools, approvals, output delivery, background jobs, metrics, retries, and cleanup. This is a deliberate application-service boundary, but it is large.

`src/runs/run-store.ts` defines pending/running/done/failed state, idempotency, attempts, leases, delivery state, and reaping. `src/runs/postgres-run-store.ts:140-252` claims with `FOR UPDATE SKIP LOCKED`, enforces one running run per session, heartbeats lease tokens, and requeues or parks expired/crash-looped work. `src/runs/worker.ts` heartbeats during execution and aborts after repeated lost heartbeats. Sessions have leases, tape, and captured model requests in `src/sessions/postgres-session-store.ts`; tasks use event rows and compare-and-set transitions in `src/tasks/postgres-task-store.ts`; crons use deduplicated fire claims in `src/cron/cron-store.ts`.

**OpenTag comparison.** OpenTag already carries the most important turn invariants: `edge/src/slack/pre-admit-turn.ts` registers the exact active turn and initial render obligation before asynchronous enrichment; `edge/src/slack/turn-lifecycle.ts`, `edge/src/store/active-turn-engine.ts`, `edge/src/store/conversation-state-do.ts`, and `edge/src/store/session-event-do.ts` preserve execution identity, event cursors, output-before-render ordering, duplicate suppression, and recovery. The exact Stop/quiescence contract is implemented in `edge/src/store/session-handoff-engine.ts`, the sandbox router, and the research task plane. `ARCHITECTURE.md:221-262` describes the render-obligation equivalent of qm's durable delivery state, and `ARCHITECTURE.md:264-300` requires definitive quiescence before Stop succeeds.

**Recommendation.** Mark exact admission, render/effect fences, durable HITL, and Stop as Covered. Adapt qm's explicit run lease/heartbeat/reaper/idempotency contract for OpenTag research, outbox, and future agent jobs, but implement it with DO serialization, Queues, and bounded alarms. Do not reproduce a Postgres worker fleet or move OpenTag's exact per-thread state back into a monolithic orchestrator.

### 2. Harness lifecycle, model selection, and provider boundaries

**Current qm evidence.** `src/harness/harness.ts:44-176` defines a typed `HarnessTurnInput`, result, detection/compaction contracts, model utilities, and `HarnessAdapterProfile`. The profile records control transport, tool transport, transcript format, and capabilities such as abort, steering, images, thinking level, fast mode, and provider sessions. `src/harness/harness-router.ts:7-104` resolves approved harnesses and durable org/scope runtime selection, checks explicit requests, and refuses unsupported or unavailable choices rather than silently changing the requested runtime. `src/model/pi-models.ts` contains built-in model/harness/provider serviceability and aliases; `src/model/model-catalog.ts` bounds OpenRouter discovery to a small response and short cache; `src/model/model-credential-store.ts` encrypts provider values in a durable map. Configuration rejects invalid harnesses, invalid provider/harness combinations, SQLite stores, mock production runtime, and missing production sandbox selection in `src/config.ts:470-587`.

The current model/provider behavior was hardened by `a2e752f25ac2ccc1e88233f54b0e3b157db9f047` (secret schema and provider scaffolding), `9bf77f7de12aa8265867cbf0cf3c392fac21a229` (OpenRouter support across config, credentials, models, routes, and tests), `ebc2e10558a9875957270c9ab9a104312d840476` and `e455cba7f7b8f10ecb383e83874836e172936b1c` (fast-mode cost controls), and `7893008bfb5dfb02afde3d8b47ccb028e8309f79` (org model allowlist in the web picker).

**OpenTag comparison.** `edge/src/harness/client.ts` sends a bounded `/turn` request with session/execution IDs, transcript, model, repository, and requester, and mirrors NDJSON output into `SessionEventDO`. `edge/workers/sandbox/harness-server.ts` selects Claude, Claudex, or Nanocodex, applies model-specific environment/arguments, holds terminal completion until postconditions and cleanup, and waits for process-group quiescence on interrupt. OpenTag's `ARCHITECTURE.md:302-385` makes sticky runtime choice explicit, forbids provider-qualified IDs, fails visibly for unavailable coding modes, and forbids silent fallback to AG-UI. This is stricter than a generic adapter fallback.

**Recommendation.** Adapt the qm capability-profile idea into the OpenTag harness wire contract and tests: advertise interrupt, image, thinking, tool, transcript, and provider-session capabilities; reject unsupported explicit requests with a stable visible error; and keep durable thread choice authoritative. Add a bounded provider/model catalog and workspace allowlist behind `WorkspaceConfigDO`, but preserve Worker-side credential injection and OpenTag's no-fallback rule. Do not copy Pi's internal model registry or make OpenTag depend on the qm package.

### 3. Tools, connectors, skills, and operator-controlled effects

**Current qm evidence.** `src/tools/primitives.ts:103-211` defines `NeedsApproval`, `CommandDenied`, and a `ToolContext` spanning scoped execution, files, publishing, memory, history, background process control, cron lifecycle, artifact sharing, and surface actions. Command checks happen at the shared tool layer, not only in one harness. `src/harness/pi-tools.ts:30-66` supplies tool-result and external-content screen hooks; its execution path records calls, applies scope/timeout checks, and converts approval/denial outcomes to explicit results. Background processes, watches, and crons are first-class tools, with scope-aware delivery and credential behavior. Connector and skill filtering is covered in `src/connectors/`, `src/skills/`, and related tests. `plugins/chassis/` is the sanctioned plugin/core boundary: signed HTTP core client, source-auth signing, env/error/http helpers, and no core imports from plugins.

**OpenTag comparison.** OpenTag has Worker-owned tool/effect boundaries in `edge/src/tools/`, AG-UI/MCP tool paths, `edge/src/permissions/`, and harness egress handlers. The active-turn engine and execution fences govern Slack and non-Slack side effects. `DECISIONS.md:168-184` makes quick actions synthetic turns and requires every effect to claim the exact active turn; `DECISIONS.md:200-213` binds remote git approval to execution, repository, branch, operation, expiry, and requester attribution. This is the right enforcement location for a multi-isolate system.

**Recommendation.** Adapt qm's typed tool contract and provenance-labeled result model where OpenTag currently has loosely shaped tool/MCP output. Keep approval and denial in the shared Worker/effect boundary, add contract tests for every external side effect, and do not import qm's broad `ToolContext` surface wholesale. Adapt the chassis principle to service bindings or signed internal HTTP rather than letting a plugin import core modules.

### 4. Authentication, credentials, and security posture

**Current qm evidence.** `src/auth/source-auth.ts` signs requests with timestamp/replay protection and a replay-dedupe store; capability tokens carry audience-bound claims. `src/api/server.ts` checks capability, portal identity, active scope, route audience, strict posture, and admin constraints. `src/credentials/keychain.ts` stores encrypted environment/file/service/OAuth material in durable maps, models owners/scopes, supports `once` and `standing` grants, records pending/approved/declined/expired asks, and materializes credentials only for an authorized operation. `src/security/security-posture.ts:3-41` defines dangerous/auto/strict; `src/policy/command-policy.ts` applies org and scope floors, hard denials, and approval rules even in dangerous mode. `plugins/auth/README.md:27-36` documents durable single-use link/code claims through core Postgres replay dedupe, and `plugins/portal/README.md:35-59` makes the portal a thin public SSO front door while core remains the authority.

**OpenTag comparison.** OpenTag's current harness boundary is stronger for coding credentials: the Container receives sentinels, internet is disabled/intercepted, and the outer Worker injects real credentials only after host, method, execution, repository, branch, operation, expiry, and attribution validation. `DECISIONS.md:34-50` explicitly keeps OAuth state out of the harness and limits Nanocodex to Worker-injected OpenAI HTTPS Responses. Durable remote-git approval and Stop revocation are already in place. However, `HANDOFF.md:47-84` leaves tenancy and key custody unresolved and identifies Cloudflare secret configuration as a current blocker for the knowledge layer.

**Recommendation.** Mark sentinel credentials, outer-worker egress authorization, exact remote-git approval, and durable HITL Covered. Adapt the qm security-posture lattice and command-policy vocabulary for workspace policy, but keep OpenTag's sentinel/outer-Worker model and never expose real credentials to a coding process. Defer a user keychain, OAuth connector marketplace, and standing grants until tenancy/key-custody decisions are resolved; qm's direct credential model must not be treated as portable by default.

### 5. Durable state, memory, audit, and background work

**Current qm evidence.** `src/persistence/durable-map.ts:3-228` provides a common map interface with Postgres JSONB/versioned implementations and memory implementations for local/test use. `src/persistence/leader-lease.ts` uses Postgres advisory locks. Session tables retain transcripts, leases, tape, and model requests; runs retain requests/results/attempts/leases/delivery; tasks retain events; cron stores retain schedule fire claims. `src/model/model-gateway.ts` has a small in-memory model-call ring for cache/observability, but durable session, metrics, audit, and credential-usage sinks are wired by `src/wiring.ts`; the ring must not be mistaken for the durable audit source. QM also has scoped memory/notebook and workspace files, with shared skills and background jobs persisted through their respective stores.

**OpenTag comparison.** `ARCHITECTURE.md:430-443` names durable active-turn, Stop-continuation, render-obligation, session-execution, HITL, thread-override, thread-memory, workspace-config, knowledge, and research-task state. `SessionEventDO` is the canonical execution event log, while `ConversationStateDO` owns thread/turn state and alarms recover obligations. `KnowledgeDO` and `edge/src/memory/` own channel knowledge. This already satisfies the most important qm durability lesson: state needed after a restart is not an isolate-local map.

**Recommendation.** Mark exact turn/session/HITL/knowledge durability Covered. Adapt qm's lease-token, CAS-transition, bounded retry, terminal delivery, and audit-record contracts for OpenTag's research and future cross-key task plane. Keep disposable caches and transcript windows as caches only; do not duplicate qm's Postgres memory service or turn tape in the OpenTag product spine.

### 6. Deployment, private-fork boundary, and release operations

**Current qm evidence.** `cli/README.md:12-77` defines `init`, `check`, `doctor`, `plan`, `up`, secrets, deployment proofs, and provider behavior. The CLI is a deployment tool, not the runtime; it generates a deployment directory, validates a contract, uses Docker/Fly/AWS backends, and expects immutable image/base pins. `deploy/README.md:1-32` says checked-in templates are not production and the public `deploy/layers/` is empty. `README.md:158-167` and `AGENTS.md:68-92` require organization-specific configuration, sandbox tools/skills, images, and infrastructure to remain under `deploy/layers/<org>/`; all core files stay byte-identical to upstream. `.github/workflows/cicd.yml`, `publish-cli.yml`, `release-package.yml`, and `release.yml` split typecheck, sharded tests, Postgres tests, package tests, image publishing, npm provenance, and release tagging.

The history shows repeated operational hardening rather than a one-off deployment script: `efd41489c236f011a8247052c446984264cc4d6c` fixed from-scratch Fly configuration; `783715c714e7dc0c1ffd25395659ac42165ff53e` added preflight checks; `8da464cbcbe8458f14085a4097b6c4a6a859efa3` separated absent deployment from secret drift; `a44e2dd02b0825ba0728247f7c0b7fc0247dd399` pinned sandbox base behavior; `b80f9c629bbce74be4aff16307011bb2dca2a393` unified release publication; and `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` removed a bootstrap version placeholder in favor of `@latest`.

**OpenTag comparison.** OpenTag intentionally deploys Cloudflare Workers, Durable Objects, R2, service bindings, and Containers in an explicit dependency order. `PRODUCT.md:110-118` and `ARCHITECTURE.md:461-490` reject Postgres/Kubernetes/Rails as the product spine and make deployment an operator action. The OpenTag equivalent of qm's CLI contract must be Wrangler/config validation, secret preflight, binding checks, immutable asset/version evidence, and post-deploy smoke checks. Fly/AWS providers, Docker image topology, and qm's `deploy/layers` filesystem shape are not OpenTag runtime requirements.

**Recommendation.** Adopt the behavior of read-only `check`/`doctor`, contract validation, immutable artifact pins, provenance, and explicit target-before-caller deployment order; adapt the implementation to Wrangler and Cloudflare bindings. Adapt the private-fork principle as a separation between product core and deployment/workspace configuration, but do not introduce a qm-style multi-cloud provider abstraction into OpenTag. No deployment was performed in this task.

### 7. Operator UX and surface separation

**Current qm evidence.** `README.md:7-42` makes each person and room a scope for memory, files, keychain, permissions, crons, web apps, and sandbox; it supports Slack and web with shared identity/configuration. `plugins/web-ui`, `plugins/admin`, `plugins/portal`, and `plugins/auth` are separate surface packages over the core HTTP API. The admin README requires core-owned `admin_grants`, scope authorization, and audit for sensitive reads; the portal README requires one public entry point, private upstream surfaces, verified OIDC identity, and core re-checks on every admin action. Auth-gate changes (`f23b36544cbbb943c054bf477eb21cd26082be1b`, `bdfa74f991fc835b57cdb8e9f00458e5bdd60bb2`, `8ca1b120233dcddbce9348a6bae7c730252a2ab9`) show that failure and first-admin onboarding are treated as product behavior, not only infrastructure.

**OpenTag comparison.** OpenTag's implemented product surface is Slack: bounded streaming, status/title updates, quick actions, durable HITL, Stop, and never-silent recovery. `PRODUCT.md:41-47` and `PRODUCT.md:110-124` explicitly say Slack Events API only, no Socket Mode, and no current web/portal parity requirement. `HANDOFF.md` says web frontend, OAuth, connector marketplace, and billing are not present; Layer 3 tenancy/key custody is still open.

**Recommendation.** Adapt qm's separation of public routing, operator authorization, and core-owned audit when OpenTag reaches its tenancy/admin layer. Defer the full qm web UI, admin service, portal, browser SSO, web apps, and playground parity; they would expand OpenTag beyond the Slack-first product contract. Do not replace OpenTag's durable Slack UX with qm's Socket Mode or browser-first flow.

### 8. Testing, review, and release evidence

**Current qm evidence.** The checkout contains 348 `src` files, 203 plugin files, 109 CLI files, 25 deploy files, 401 root test files, 46 CLI test files, and four workflow files. Root scripts include typecheck, lint, format checking, sharded test selection, Postgres-backed tests, e2e, and live smoke paths. Relevant test families include `test/runtime-selection.test.ts`, `test/harness-adapter.test.ts`, `test/claude-harness*.test.ts`, `test/codex-harness.test.ts`, `test/run-store.test.ts`, `test/run-stale.test.ts`, `test/run-result-delivery.test.ts`, `test/credential-broker.test.ts`, `test/connectors.test.ts`, `test/cron-*.test.ts`, `test/deployment-layer-*.test.ts`, `test/release-workflows.test.ts`, and plugin/CLI equivalents. CI deliberately separates root shards, typechecks, package/artifact tests, Postgres durability tests, plugin tests, CLI tests, format, and e2e.

**OpenTag comparison.** OpenTag has focused tests for pre-admission, active-turn and render obligations, SessionEventDO replay/interrupt, HITL durability, tool/effect fences, harness client/router/container/egress, runtime selection, product spine, platform contracts, and admin behavior. `ARCHITECTURE.md:127-262` and `DECISIONS.md:154-220` describe the contracts that those tests enforce.

**Recommendation.** Adopt qm's test taxonomy and release-evidence discipline: test the shared contract at each adapter, test durable failure/recovery paths, test packaged/deployed artifacts, and keep a read-only deployment proof. Adapt CI to Worker/DO/Container matrices. A green unit suite is not sufficient for cross-isolate Stop, egress, or deployment behavior; OpenTag's existing product-spine and harness integration tests should remain the primary gate.

## Prioritized classification

`Adopt` means carry the behavior or contract with only substrate-specific implementation changes. `Adapt` means the architectural idea is useful but must be redesigned for Workers/DOs. `Covered` means current OpenTag evidence already satisfies the useful requirement. `Defer` means it is plausible but blocked by product or custody decisions. `Not Applicable` means OpenTag should explicitly reject the qm shape for this product.

| Priority | Finding or capability | Classification | Evidence and decision |
| --- | --- | --- | --- |
| P0 | Stable execution identity, pre-admission, render/effect fences, duplicate handling | Covered | OpenTag `edge/src/slack/pre-admit-turn.ts`, `edge/src/store/active-turn-engine.ts`, `edge/src/store/session-event-do.ts`; qm current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`, rooted at `57b51916f479fd642b4c0c89fb07961fd3f862b4`, in `src/runs/` and `src/sessions/`. Preserve OpenTag's exact-ID and output-before-render rules. |
| P0 | Durable Stop, HITL cancellation, process/task quiescence | Covered | OpenTag sandbox router, `edge/src/store/session-handoff-engine.ts`, `ARCHITECTURE.md:264-300`; qm current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` in `src/runs/worker.ts` and approval paths. No qm behavior should weaken OpenTag's visible-stop contract. |
| P0 | Sentinel credentials and outer-boundary egress authorization | Covered | OpenTag `edge/workers/sandbox/src/container.ts`, `edge/workers/sandbox/src/router.ts`, `DECISIONS.md:34-50`; qm current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` and secret-boundary hardening commit `a2e752f25ac2ccc1e88233f54b0e3b157db9f047`. OpenTag's boundary is stricter than direct qm credential injection into a user-agent process. |
| P0 | Harness adapter profile and capability negotiation | Adapt | qm `src/harness/harness.ts:44-176`, `src/harness/harness-router.ts`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag `edge/src/harness/client.ts`, `edge/workers/sandbox/harness-server.ts`. Add a capability contract to the NDJSON/Worker boundary without importing qm. |
| P0 | Durable run queue with lease, heartbeat, reaper, idempotency, and terminal delivery | Adapt | qm `src/runs/postgres-run-store.ts:140-252`, `src/runs/worker.ts`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag research/outbox task plane. Use DO/Queues/alarms, not a Postgres queue. |
| P0 | Provider-neutral model catalog, serviceability, and org allowlist | Adapt | qm `src/model/pi-models.ts`, `src/model/model-catalog.ts`, `src/model/model-credential-store.ts`, commits `9bf77f7de12aa8265867cbf0cf3c392fac21a229` and `7893008bfb5dfb02afde3d8b47ccb028e8309f79`; OpenTag `edge/src/config/workspace-config-do.ts` and runtime selection. Keep real keys in the Worker/proxy. |
| P0 | Typed tool contract, output provenance, approval, and denial at the shared boundary | Adapt | qm `src/tools/primitives.ts`, `src/harness/pi-tools.ts`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag `edge/src/tools/`, `edge/src/permissions/`, effect fences. Port the contract, not all qm tools. |
| P0 | Encrypted user keychain, OAuth connector tokens, once/standing grants | Defer | qm `src/credentials/keychain.ts`, `src/connectors/`, `plugins/auth/`, secret-boundary commit `a2e752f25ac2ccc1e88233f54b0e3b157db9f047`; OpenTag `HANDOFF.md` still has tenancy/key-custody decisions. Do not implement until custody and revocation are explicit. |
| P1 | Signed plugin-to-core client with no core imports | Adapt | qm `plugins/chassis/src/core-client.ts`, `source-auth-sign.ts`, `http.ts`, auth-gate hardening commit `bdfa74f991fc835b57cdb8e9f00458e5bdd60bb2`; map this to OpenTag service bindings and internal signed contracts. |
| P1 | Security-posture lattice and organization/scope command policy | Adapt | qm `src/security/security-posture.ts`, `src/policy/command-policy.ts`, fast-mode policy commits `ebc2e10558a9875957270c9ab9a104312d840476` and `e455cba7f7b8f10ecb383e83874836e172936b1c`; OpenTag has exact Worker policy and HITL but not the same named lattice. Keep hard denials and add policy state only through `WorkspaceConfigDO`. |
| P1 | Durable session/model/tool/audit telemetry | Adapt | qm `src/sessions/postgres-session-store.ts`, `src/audit/`, `src/model/model-gateway.ts`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag `SessionEventDO` is canonical. Adapt durable event fields; do not promote a memory ring buffer to truth. |
| P1 | Scoped memory and source/visibility contracts | Adapt | qm `src/memory/`, workspace scope stores, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag `edge/src/memory/`, `KnowledgeDO`, and thread memory. Reuse scope/visibility rules without duplicating storage. |
| P1 | Scope-owned shared skills, git skill packs, and admin promotion | Adapt | qm `src/skills/`, `plugins/web-ui/src/skill-*`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag currently has MCP/knowledge but no equivalent skill governance. Use R2/DO and explicit grants if/when adopted. |
| P1 | User-facing crons, background jobs, watches, and retargeted delivery | Adapt | qm `src/cron/`, `src/connectors/background-exec-broker.ts`, `src/tools/primitives.ts`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag has alarms/research tasks. Start with bounded durable tasks, not a broad cron UX. |
| P1 | Read-only preflight/doctor, immutable artifact pins, provenance, and explicit deployment order | Adopt | qm `cli/src/commands/check.ts`, `cli/src/backends/doctor.ts`, `.github/workflows/*`, commits `783715c714e7dc0c1ffd25395659ac42165ff53e`, `8da464cbcbe8458f14085a4097b6c4a6a859efa3`, `a44e2dd02b0825ba0728247f7c0b7fc0247dd399`, and `b80f9c629bbce74be4aff16307011bb2dca2a393`; OpenTag should preserve the behavior through Wrangler/Cloudflare checks. |
| P1 | Private fork versus organization deployment-layer boundary | Adapt | qm `AGENTS.md:68-102`, `README.md:125-167`, `deploy/layers/README.md`, commits `57b51916f479fd642b4c0c89fb07961fd3f862b4` and `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; apply the separation principle to OpenTag config/workspaces without adding qm's fork mechanics. |
| P2 | Separate admin/portal/web processes with core-owned grants and audit | Defer | qm `plugins/admin/`, `plugins/portal/`, `plugins/auth/`, commits `f23b36544cbbb943c054bf477eb21cd26082be1b`, `8ca1b120233dcddbce9348a6bae7c730252a2ab9`, and `35c47a3fcbd83dca8f640bdba7fa47fa2d6ec271`; useful for future Layer 3, but OpenTag product scope is Slack-first and tenancy/auth is unresolved. |
| P2 | Sharded CI, adapter contract tests, packaged-artifact tests, and release proofs | Adopt | qm `.github/workflows/cicd.yml`, `publish-cli.yml`, `release-package.yml`, `release.yml`, commits `d98a91427cf07ab38527545ce64dc2314ea4929f` and `b80f9c629bbce74be4aff16307011bb2dca2a393`; OpenTag should keep equivalent edge/harness/deployment gates. |
| P2 | Postgres/Node/Fastify as the product persistence and HTTP substrate | Not Applicable | qm `README.md:44-78`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag `PRODUCT.md:110-118`, `DECISIONS.md`, and `ARCHITECTURE.md` explicitly choose Workers/DO/R2/Containers and reject Postgres/Kubernetes/Rails as the product spine. |
| P2 | Slack Bolt Socket Mode as ingress | Not Applicable | qm optional Socket Mode/in-process Slack plugin in `src/slack/`, current snapshot `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`; OpenTag `PRODUCT.md:53-57`, `DECISIONS.md:54-61` require Slack Events API on `opentag-bot` and reject Socket Mode. |

Classification count: Adopt 2, Adapt 11, Covered 3, Defer 2, Not Applicable 2.

## OpenTag follow-ups, not implemented here

The most justified follow-ups for a later OpenTag branch/PR are:

1. Add an explicit harness capability schema and adapter contract tests around `edge/src/harness/client.ts`, the sandbox router, and `edge/workers/sandbox/harness-server.ts`.
2. Specify a DO/Queue-backed worker lease and terminal-delivery contract for research and future cross-key tasks, including stale-claim recovery and idempotency.
3. Add workspace model serviceability/allowlist state to `WorkspaceConfigDO`, with visible unsupported-model errors and no runtime fallback.
4. Add typed tool-result provenance and policy metadata at the existing Worker/effect boundary, with one test per external side-effect fence.
5. Translate qm's `check`/`doctor`/release-proof behavior into Cloudflare binding, secret, artifact, and post-deploy smoke checks.

These are recommendations only. This assignment prohibited OpenTag implementation, branches, PRs, deployment, Notion changes, and writes outside the assigned report.

## Validation performed and limitations

Read-only validation performed:

- `git status --short --branch`, `git remote -v`, `git branch -vv`, `git rev-parse`, `git log`/`git rev-list` history inspection, and direct `git ls-remote` checks for both parent and fork.
- Full reachable-history review from `57b51916f479fd642b4c0c89fb07961fd3f862b4` through `7f2c916360f1797a8ff2a77ce2ce40c5fabab087`, plus current source, tests, docs, CI, plugins, CLI, and deployment templates.
- `node --test test/source-auth.test.ts test/capability-token.test.ts test/command-policy.test.ts test/config.test.ts test/cron-store.test.ts`: 35 test cases passed; three test files could not load because dependencies were absent (`lru-cache`, `croner`; capability tests also reached the missing dependency path).
- A harness/model/auth selection run: source-auth cases passed; `test/auth-gate.test.ts`, `test/harness-adapter.test.ts`, and `test/model-registry.test.ts` could not load because `fastify`, `@aws-sdk/client-s3`, and `@earendil-works/pi-ai` were absent.
- `npm run typecheck`, `npm run lint`, and `npm run format:check` were attempted and could not start because `tsc`, `eslint`, and `prettier` are not installed in the checkout. No dependency installation was attempted because the task allowed writes only to the assigned OpenTag report path.

No live qm instance, Postgres-backed test, deployment, external credential, Notion write, OpenTag test run, branch, or PR was used. The report is source/history-backed, but its executable validation is necessarily partial until the repository dependencies are installed in an authorized environment.


## Current-state addendum — 2026-08-01

Current reconciliation: QM's durable runs, capability profiles, serviceability, grants, provenance, and operator separation are design inputs. OpenTag has adapted the portable parts without adopting QM's Node/Postgres/Fly/AWS spine or direct credential model; per-tenant custody and external effects remain open.

The original evidence, classifications, and validation limits above are intentionally preserved. The canonical feature/gap ledger is [CURRENT-STATE-RECONCILIATION.md](../CURRENT-STATE-RECONCILIATION.md).
