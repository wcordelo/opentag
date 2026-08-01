# Multi-repository parent sync and architecture backfill

Status: complete for the 2026-08-01 one-time backfill and research pass.

This artifact records the complete-history backfill and architecture comparison for the forked `qm`, `nanocodex`, and Buzz repositories, plus the Centaur parity review that remains the reference workflow. It is intentionally source-first: repository history, current source, tests, and operational documentation are the evidence; Notion is an index and review surface, not the source of truth.

## Outcome

The requested one-time backfill ran immediately after the workflow was defined, using Pacific time for the review date.

| Project | Parent | Fork default | Common ancestor | History reviewed | Backfill result |
|---|---|---|---|---|---|
| qm | `yc-software/qm` | `wcordelo/qm:main` | `7f2c9163` | 0 parent commits, 0 fork-only commits | Already current; no push |
| Nanocodex | `gakonst/nanocodex` | `wcordelo/nanocodex:master` | `3d4548b0` | 53 parent commits, 3 fork-only commits | Parent merged and pushed as `e9ca9258cc00413bd0580e97979a9488fba9a67b` |
| Buzz | `block/buzz` | `wcordelo/buzz:main` | `acfbb1bb` | 276 parent commits, 1 fork-only commit | Parent merged and pushed as `40d1bebf5fefeeb57463973af9cd8a64026abc0c` |
| Centaur | `paradigmxyz/centaur` | `wcordelo/centaur:main` | `6d109198` | 0 parent commits, 64 fork-only commits | Parent tip already present; existing Centaur sync remains owner |

Nanocodex and Buzz were synced from detached temporary worktrees. Each merge passed whitespace validation and an exact remote-before-push check. Buzz also passed a conflict-marker scan that only treated actual `<<<<<<< `, `||||||| `, and `>>>>>>> ` prefixes as markers. The primary Centaur checkout had pre-existing `AGENTS.md` and `docs/public/md/capabilities.md` changes; those were preserved and not used as a write target.

## Reports

- [Source manifest and sync ledger](./source-manifest.md)
- [qm deep dive](./qm.md)
- [Nanocodex deep dive](./nanocodex.md)
- [Buzz deep dive](./buzz.md)
- [Centaur deep dive](./centaur.md)
- [OpenTag improvement plan](./opentag-improvement-plan.md)

Each report identifies the parent and fork remotes, default branches, common ancestor, complete reviewed range, current feature surface, source and test evidence, validation limits, and an explicit `Adopt`, `Adapt`, `Covered`, `Defer`, or `Not Applicable` classification. The reports do not infer a gap from filenames or commit titles alone.

## OpenTag baseline used for comparison

The comparison was made against `/Users/will/Documents/opentag/HANDOFF.md`, `VISION-SPEC.md`, `ARCHITECTURE.md`, `PRODUCT.md`, the existing Centaur port ledger, the knowledge-base implementation specification, current `edge/` source, and affected tests.

The baseline matters:

- Layers 1 and 2 are the current trust foundation. Durable admission, turn state, replay, Stop, HITL, render/effect fences, sentinel credentials, and harness egress policy are already implemented and tested.
- Layer 3 is not started. Tenancy shape and key custody are explicit product decisions and must not be guessed by importing another repository's deployment model.
- Layer 4 has B0–B4 work and a deployed B5 sidecar, but C1 secrets and the B6–B9 rollout gates remain outstanding.
- The router is specified but not implemented; its first intended step is heuristic shadow mode.
- The Buzz connector is substantially built but still needs a tenant locator and configured signer before it can be treated as production-connected.

## Cross-repository architectural findings

### 1. Durable lifecycle is the reusable narrow waist

qm, Buzz, Centaur, and Nanocodex all reinforce the same rule from different angles: state that controls retries, leases, terminal outcomes, permissions, audit, or recovery must be durable and tied to an authoritative identity. OpenTag already has strong turn-level equivalents in Durable Objects and its event/render fences. The next improvements should extend those contracts only where a real OpenTag path needs them, not add a second orchestration substrate.

### 2. Authority must be explicit at every boundary

Centaur's strongest portable feature is its bounded active-deployment/capability identity block. Nanocodex makes ownership explicit across typed transport, retry, and terminal result commits. Buzz makes tenant, channel, actor, ACL, and server-side key custody distinct concepts. qm separates harness capability, model/provider selection, tool provenance, and operator grants. OpenTag's improvement plan therefore treats live runtime facts, actor-bound knowledge access, provider capability, and effect authority as separate contracts.

### 3. Infrastructure parity is not product parity

Kubernetes, Rails, Postgres, LiteLLM, static-site hosting, media relays, general workflow engines, and extra ingress surfaces are valid features in their source repositories but are not automatically OpenTag requirements. OpenTag's Cloudflare Workers, Durable Objects, Queues, R2, Containers, and Slack-first product boundary remain authoritative.

### 4. Evidence and conformance are features

The reviewed repositories invest heavily in readiness, conformance fixtures, property tests, audit chains, release evidence, and operator preflight checks. OpenTag has strong focused tests and operational contracts, but the synthesis calls for a compact capability/preflight evidence format that can be checked in CI and shown to an operator without exposing secrets.

## Recommended order

1. Add a bounded, redacted live runtime/capability projection to the existing OpenTag runtime identity path. It must distinguish verified live deployment facts from repository-local instructions and make missing or stale facts explicit.
2. Reconcile the planned `KnowledgeActorTokenV1` design with the current admin-bearer `/mcp/knowledge` implementation before external MCP access or broader connector exposure. The current admin gate is a useful safety boundary; this is a contract decision, not permission to weaken it.
3. Consolidate provider/model capability and provenance evidence around the existing harness selection and access-bundle contracts. Keep provider-native Nanocodex history/retry/branching behind an explicit adapter boundary.
4. Add operator preflight/doctor evidence and conformance fixtures for the gates that already exist: sentinel credentials, egress allowlists, durable terminal delivery, tenant scope, and knowledge ACL enforcement.
5. Revisit Layer 3 only after the tenancy and key-custody decisions are made. Adapt grants, revocation, OAuth custody, connector scopes, and operator visibility from Centaur/Buzz/qm after those decisions.

The implementation status and gates are tracked in [the improvement plan](./opentag-improvement-plan.md). This first PR deliberately contains durable research and specifications; it does not silently activate external knowledge access, change key custody, deploy Workers, or merge into `main`.

## Review destinations

The research rows are isolated by project:

- [qm review database](https://app.notion.com/p/a6bec0130f794839892ea92370fe5b1c)
- [Nanocodex review database](https://app.notion.com/p/b8f80af8713840bb9be1b11c3c2ca268)
- [Buzz review database](https://app.notion.com/p/b98b3f7222a44872afeada6550cc2241)
- [Centaur review database](https://app.notion.com/p/3f174eb0c9b24c51aa28beeae39de4ef)

## Recurring sync policy

Three independent local Codex tasks run daily at 8:00 AM Pacific:

- `daily-qm-parent-sync`
- `daily-nanocodex-parent-sync`
- `daily-buzz-parent-sync`

Each task fetches the parent, merges it into the fork's default branch in an isolated temporary worktree, validates the result, and pushes directly to that fork default as requested. It never force-pushes, rebases, deploys, edits OpenTag, or claims a successful sync without a verified remote result. No-change runs return `NO_CHANGES`; blockers return concise evidence for review.
