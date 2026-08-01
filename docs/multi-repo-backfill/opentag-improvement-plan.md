# OpenTag improvement plan from the multi-repository backfill

This is the decision and implementation ledger produced from the complete-history reviews. It is deliberately separate from the repository-specific reports so future daily sync runs can update source evidence without rewriting architectural decisions.

## Decision ledger

| Priority | Candidate | Evidence | Classification | OpenTag action | Gate | Status |
|---|---|---|---|---|---|---|
| P0 | Live runtime and capability identity | Centaur Active deployment block; OpenTag `edge/src/runtime-identity.ts` | Adopt | Add a bounded, redacted per-turn projection from authoritative runtime/config/health state. Label live facts separately from repository-local state; represent absence and staleness. | Define the authoritative source and prompt budget; add prompt-injection, redaction, and stale-state tests. | Specified; implementation not started |
| P0 | Actor-bound knowledge MCP contract | Buzz tenant/channel/ACL checks; OpenTag knowledge spec's `KnowledgeActorTokenV1`; current `edge/src/mcp/knowledge-mcp.ts` admin bearer | Adapt | Decide whether `/mcp/knowledge` remains operator-only or moves behind actor-bound tokens. Preserve the current admin boundary until the token issuer, audience, replay, ACL, and audit contract exists. | C1 secrets, knowledge rollout gates, and explicit external-MCP authorization decision. | Safety gap recorded; no auth weakening made |
| P1 | Durable worker lease and terminal delivery evidence | qm durable leases/idempotency/delivery; Buzz workflow claims and audit; OpenTag existing turn state | Adapt | Reuse existing OpenTag durable turn/DO primitives and add only missing worker/job evidence. Do not introduce a second queue or workflow engine. | Identify a concrete OpenTag job path with a missing recovery invariant; add race and alarm tests first. | Candidate; no new runtime code justified by this pass |
| P1 | Harness capability negotiation and result provenance | qm capability profiles; Nanocodex typed transport/events/ownership | Adapt | Define a small capability profile for each OpenTag harness and record provider/model/version/source with terminal results. Keep adapter ownership explicit and preserve complete-only result commits. | Freeze the profile schema and compatibility rules; validate against Claude Code, Claudex, and Nanocodex fixtures. | Candidate; no new runtime code justified by this pass |
| P1 | Provider readiness and release evidence | Centaur provider gateway/readiness/version evidence; qm doctor/check/release proofs | Adapt | Add read-only preflight/doctor output for configured harness/provider/egress/release facts, with redaction and machine-readable evidence. | Specify output contract and CI ownership; no secret values or live mutation. | Candidate; suitable for a follow-up implementation |
| P1 | Conformance fixture matrix | Buzz conformance/property tests; qm source/test harnesses; OpenTag focused tests | Adopt | Create fixtures for tenant scope, ACL recheck, sentinel credentials, egress policy, cancellation/quiescence, idempotency, and terminal delivery. | Keep fixtures deterministic and runnable without production credentials. | Candidate; suitable for a follow-up implementation |
| P2 | Centaur parity ledger refresh | Current `docs/centaur-port.md` predates this backfill | Adapt | Add current source paths, SHAs, and explicit classifications to the existing parity ledger after the research PR is reviewed. | Review against the current OpenTag source and avoid duplicating this report. | Deferred to focused docs follow-up |
| P2 | Layer 3 operator identity, grants, OAuth, and connectors | Centaur Console/connector contracts; Buzz provisioning/revocation; qm credential/connectors | Adapt | Port contracts only after tenancy and key custody are decided. Keep credentials outside model/harness processes and retain revocation/audit. | Product decisions in `VISION-SPEC.md` §10.1 and §10.4. | Blocked by explicit product gate |
| P2 | Nanocodex provider-native history, retry, and branching | Nanocodex typed Responses transport and ownership model | Adapt | Add only if OpenTag needs provider-native branching beyond the current harness boundary; model it as a typed adapter, not a generic app-server rewrite. | Demonstrate a product use case and define ownership/replay semantics. | Deferred |
| P3 | Quick static hosting and general workflow orchestration | Centaur features coupled to its deployment product | Defer | Preserve the portable lifecycle and security lessons, but do not import the product surface without an OpenTag decision. | New OpenTag product decision. | Deferred |
| P3 | Media, extra ingress, Mesh, and Kubernetes/Rails parity | Buzz and Centaur features coupled to their deployment products | Not Applicable | Preserve portable security lessons, but do not import these product or infrastructure surfaces into the current Slack-first Cloudflare architecture. | New OpenTag product decision. | Deferred |

## Current OpenTag invariants to preserve

- Slack traffic terminates at the bot Worker.
- Coding harness processes receive only sentinel credentials; the outer Worker controls real credential injection and egress for those harnesses. Other OpenTag runtime processes may receive configured runtime secrets under their existing bounded contracts, which future changes must preserve.
- Git pushes and other external effects remain behind durable, exact approval scope.
- Every turn ends in a visible answer, explicit error, or confirmed cancellation.
- Stop controls all in-flight work and waits for quiescence before acknowledging completion.
- Workspace isolation and `WorkspaceConfigDO` policy ownership remain absolute.
- Layer 3 tenancy and key custody are not inferred from any source repository.
- External knowledge exposure is not broadened until actor identity, ACL, replay, and audit contracts are proven.

## Validation bar for future implementation PRs

Any follow-up runtime change from this ledger must include:

1. A source-backed contract update naming the authoritative state and the failure behavior.
2. Focused tests for happy path, duplicate/retry, stale/expired state, unauthorized scope, cancellation, and redaction where applicable.
3. Typecheck and lint for the affected package, plus the relevant Worker tests.
4. A fresh-context review that tries to break the change.
5. A clean isolated worktree and a non-merge PR; deployment, secret changes, activation, and merge remain separate approval gates.
