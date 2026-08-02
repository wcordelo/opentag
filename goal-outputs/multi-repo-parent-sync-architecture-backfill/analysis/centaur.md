> **Historical snapshot.** This artifact was authored before the final merged OpenTag rollout. Read [the current reconciliation](../CURRENT-STATE-RECONCILIATION.md) and [the current OpenTag status](../../../docs/current-state.md) before treating any implementation or deployment statement as current.
>
> The Centaur report's OpenTag comparison predates the merged implementation and live rollout. Current status: runtime/capability evidence, native Nanocodex, connector/platform metadata, and router shadow work address the portable recommendations; Kubernetes/Rails/Postgres product infrastructure remains not applicable.

# Centaur parent-to-fork backfill and architecture deep dive

Review date: 2026-08-01. This is a read-only source, test, documentation, and history review for the Centaur parent/fork pair, with a parity comparison against the current OpenTag checkout.

## Scope and repository identity

- Parent: https://github.com/paradigmxyz/centaur.git
- Fork: https://github.com/wcordelo/centaur.git
- Default branch: main for both repositories.
- Parent remote: upstream, pointing at the parent URL.
- Fork remote: origin, pointing at the fork URL.
- Centaur repository history is not shallow.
- The reviewed fork ref is origin/main at acb5512ad4290e9d0e217fa295ba230915b353f9.
- The reviewed parent ref is upstream/main at 6d109198a4dccfdcd4c6f8a3ee0834722e54a877.
- The Centaur primary checkout is at an older local HEAD, 20e624c087276a7f0976cc2d094bd1b20afcce85, and is dirty. The current fork source was therefore inspected from the immutable origin/main remote tree with Git show/diff, while the primary checkout remained untouched.
- OpenTag comparison was made against origin/main at e10bd0d32d42d274d760c96941f941f04ccef50e and its current source, tests, HANDOFF.md, VISION-SPEC.md, ARCHITECTURE.md, PRODUCT.md, and docs/centaur-port.md.

## Ancestry, reviewed range, and sync outcome

The verified common ancestor is 6d109198a4dccfdcd4c6f8a3ee0834722e54a877. The ancestry checks were:

- git merge-base 6d109198a4dccfdcd4c6f8a3ee0834722e54a877 origin/main = 6d109198a4dccfdcd4c6f8a3ee0834722e54a877.
- Parent delta: 6d109198..upstream/main = 0 commits.
- Fork-only delta: 6d109198..origin/main = 64 commits.
- The complete reviewed fork-only range is 6d109198a4dccfdcd4c6f8a3ee0834722e54a877..acb5512ad4290e9d0e217fa295ba230915b353f9, inclusive of every commit in that range.
- The fork delta changes 100 files, adding 8,739 lines and deleting 76 lines.
- git diff --check passed for the complete fork delta, and an added-line scan found no conflict-marker lines.

The existing Centaur sync automation, not this report, had already merged parent tip 6d109198 into the previous fork sync checkpoint 5f20fe419c347d840f95cc4379eb9f0cba20dbd1 and pushed acb5512ad4290e9d0e217fa295ba230915b353f9 to fork origin/main. That sync was a one-file automatic merge; the recorded diff-check and conflict-marker validation passed. No synchronization, checkout mutation, staging, commit, push, deployment, PR creation, or Notion write was performed for this task.

## Dirty-tree preservation

The Centaur primary checkout was preserved exactly. Its pre-review status was:

- main...origin/main [behind 38]
- AGENTS.md modified
- docs/public/md/capabilities.md untracked

Neither file was edited, staged, committed, deleted, or included in any temporary write. The untracked capabilities file was read as a local capability inventory, but it is not treated as committed history authority. OpenTag’s existing untracked HANDOFF.md, ROUTER-SPEC.md, VISION-SPEC.md, knowledge-base documents, and goal-output files were also left untouched except for the assigned report path. No credentials or secret values were read into this report.

## Current Centaur capability surface

The current source describes a thin, fail-closed connector layer feeding a durable api-rs/Postgres control plane, Kubernetes sandbox and harness execution, approved tools and skills, iron-proxy credential mediation, and recovery-aware rendering. The local untracked docs/public/md/capabilities.md inventory matches this shape; the committed source and tests below are the evidence used for classification.

### Product and reliability surface

Centaur’s durable request path is represented by the services/api-rs control plane and its session, event, serialization, recovery, workflow, and Postgres boundaries. The connector services are adapters, not alternate control planes. The service AGENTS files require durable append/execute/replay behavior, fail-closed admission, idempotency, terminal-render recovery, and explicit ownership of credentials and workflows.

Slack, Discord, GitHub, Linear, and Teams adapters are present under services/slackbotv2, services/discordbot, services/githubbot, services/linearbot, and services/teamsbot. Current Slack behavior is represented by the fork commits 33101e567554f91d54ca68b550a322ed6a7e8bec, c3fc76eddc21ca4dfee6874b25acca94843acbe6, 7b4c6a90, and 703dda3596a251c3527953ff66a78f179a61afe4, plus the Slack tests for action routing, requester attribution, readiness, and render-obligation recovery.

### Execution, security, and credentials

services/sandbox, services/api-rs/crates/centaur-sandbox-agent-k8s, services/api-rs/crates/centaur-iron-proxy, services/api-rs/crates/harness-server, and services/console implement the execution and credential path. The service instructions require placeholder credentials in the sandbox, matching a real request through a controlled proxy, no raw secret return, request-scoped grants, and recovery after process or deployment interruption. Current source also contains deny-by-default network policy, proxy readiness/acknowledgement barriers, sandbox limits and reaping, harness postconditions, and attachment validation.

The fork commit ad28c19d4d946673bfde5dca8ddaf364e2ed5625 reconciles Codex provider pinning and attachment-upload authorization. Commits 89725fde and 7bbc1c86 add or harden provider egress and credential injection. These are implementation-specific expressions of a portable contract: the agent gets a bounded capability and an auditable request path, never an ambient provider secret.

### Operator, connector, and lifecycle surface

The Rails Console under services/console owns operator/member views, principals, roles, grants, secrets, OAuth and MCP control, workflow visibility, and read-only thread observation. api-rs owns durable session/workflow state; the Console is not a second executor. The capability inventory also identifies Google, Slack, GitHub, Granola, Linear, and Attio connectors, scheduled ETL/context jobs, private-data RLS, MCP resource serving, and company-context retrieval.

Centaur has durable Python workflows with steps, sleeps, events, child workflows, tool calls, agent turns, schedules, cancellation, webhooks, and Console visibility. These are broader than a single Slack turn and are coupled to the api-rs/workflow-python/Postgres control plane.

### Quick static hosting and model gateways

The fork adds Quick, a static-site artifact tool, through b1186cc49e7957ffe5eabd85fd5cb2942042a615, 5fb8c84372d9c158600f72725d148c2073522f8c, d7c3c5d073b96eb74388ca38233b43a671855b1d, 7b4c6a90, c3fc76eddc21ca4dfee6874b25acca94843acbe6, 703dda3596a251c3527953ff66a78f179a61afe4, and 80c8e3ef. Its implementation is in tools/infra/quick, the deploying-static-sites skill, Slack cards, and Helm chart templates. It validates site IDs and relative paths, bounds file and total size, records ownership, stages and atomically swaps local deploys, writes an S3 manifest last, removes stale files, and serves only safe site paths. Its tests cover validation, ownership, lifecycle, stale cleanup, staging cleanup, S3 behavior, traversal, reserved paths, and static serving.

The fork also adds an in-cluster LiteLLM path through 7bbc1c86557f80368d9675cf42c21117e631d7f1, 26c051899f0cd9e418d8ab30e328ec048045f8f2, a33198b4d2047c308e5f64361ce1bc49082c3e3f, and f5f3936b01934378aea4d0e396a27d147bc8bdca. The relevant committed sources are contrib/chart/templates/litellm.yaml, contrib/chart/templates/networkpolicy.yaml, contrib/chart/files/litellm/config.yaml, contrib/litellm/config.yaml, bootstrap/verification scripts, and sandbox iron-proxy configuration. The feature includes readiness, provider aliases, secret isolation, direct-egress verification, and version tracking, but its deployment shape is Kubernetes-specific.

### Exploratory and local-development additions

Commits 7f0019eb06917e516e10c7c89693aebbcc3171ee, 674644dae24eedb3da26c3c0d39c8f3ebcbfe3d8, and 3b11d481bd2b1966c2a3a3a0f4713908a7bea672 add local vLLM/Gemma 4 guides, smoke tests, and a CUDA launcher correction. Commit 8ba84239653387d7d6fe391c17d63ad0ba7e6937 adds a Vercel Eve exploration, and 7131437ac3f656dd6a00357f82ca17180b7fa6fd adds a Block Goose exploration. These are documented research or local infrastructure paths, not additional production control-plane guarantees.

## Isolated findings and classifications

### 1. Adopt — authoritative live deployment and capability identity

Evidence: f6b98a06386cc568b9de087b7a3da66b590ae2ae adds the Active deployment block. services/sandbox/entrypoint.sh:422-489 writes and prepends a bounded block containing the selected harness, model, provider, and deployment facts. services/sandbox/SYSTEM_PROMPT.md:9-13 tells the agent to trust that block rather than probing shell environment variables; the same prompt distinguishes live capability answers from repository-local state at lines 59-69.

OpenTag already has a useful per-turn authority surface in edge/src/runtime-identity.ts:2-34, and its harness prompt avoids exposing real credentials. It does not yet project a verified, redacted live capability/deployment block or clearly separate live deployment facts from repository documentation. Adopt the behavior at the Cloudflare layer: produce a bounded per-turn runtime/capability projection from authoritative config and health state, label live versus repo-local facts, and make absence or staleness explicit. Do not copy Centaur’s environment probing, secret material, or Kubernetes details. This is the clearest portable reliability improvement missed by an incremental port review.

### 2. Adapt — Quick’s artifact lifecycle and security contracts

Evidence: tools/infra/quick/client.py:52-54 enforces file, per-file, and aggregate bounds; lines 73-114 validate site IDs and safe paths; lines 174-194 perform ownership checks and deployment; lines 303-447 implement staging, atomic swap, manifests, owner checks, S3 publication, and stale cleanup. tools/infra/quick/server.py:39-111 validates host/path routing, prevents traversal, hides reserved paths, and provides index fallback. The tests in tools/infra/quick/tests/test_ownership_and_server.py and test_s3_backend.py exercise the failure paths, not only the happy path.

OpenTag has bounded artifact/research cards in edge/src/slack/quick-card.ts and durable, deduplicated, requester-resolved action turns in edge/src/slack/quick-actions.ts, but no Quick static-site backend or deploy_artifact implementation. If artifact hosting becomes a product choice, adapt the contracts to R2/DO: immutable or versioned manifests, owner/tenant binding, path and size bounds, manifest-last publication, cleanup, effect fences, and safe serving. Do not port local filesystem, S3 SDK, Python CLI, Helm, or IAP implementation directly.

### 3. Defer — Quick static-site hosting as a product surface

Evidence: the Quick feature spans the commits listed above and its skill promises one-call static artifact deployment, Slack deploy cards, shared PVC support, stale cleanup, and gated serving. OpenTag’s edge/src/slack/quick-card.ts contains generic artifact and research cards, but source search finds no static-site deploy tool or serving backend. PRODUCT.md:33-49 lists OpenTag’s current surfaces without static hosting; HANDOFF.md and VISION-SPEC.md place the broader platform layer and one-click company-agent deployment ahead of this feature.

Defer the complete feature until OpenTag explicitly chooses artifact hosting. The lifecycle contracts in finding 2 remain useful if that decision is made. This avoids confusing a Centaur infrastructure feature for the OpenTag product promise, whose one-click deployment is a company agent workflow rather than a static web artifact.

### 4. Covered — durable session, replay, interruption, and render recovery

Centaur evidence is the current services/api-rs durable control plane, the service-level ownership instructions, and the current capabilities architecture. The parent is already the verified ancestor of the current fork, so this behavior is present in the reviewed base as well as the fork tree.

OpenTag has the same portable behavior in ConversationStateDO and SessionEventDO, the admission/append/execute/replay and effect-fence flow in ARCHITECTURE.md:77-105 and 430-443, and the corresponding coverage described in docs/centaur-port.md:53-169. PRODUCT.md:20-31 promises acknowledgement, durable continuity, no silent outcomes, Stop, and human gates. This is Covered; do not port Postgres, sqlx, Rails, or api-rs wholesale.

### 5. Covered — Slack streaming, status, Stop, Quick actions, and requester attribution

Centaur’s fork history shows the behavior being hardened and moved into Slack v2: 33101e567554f91d54ca68b550a322ed6a7e8bec ports Quick cards and button actions, c3fc76eddc21ca4dfee6874b25acca94843acbe6 adds per-turn requester attribution and card caps, 7b4c6a90 fixes readiness/ownership/button routing, and 703dda3596a251c3527953ff66a78f179a61afe4 hardens local deploy routing. Current Slack tests cover these boundaries and render recovery.

OpenTag’s edge/src/slack/quick-actions.ts parses bounded payloads, derives deterministic click IDs, and re-enters ordinary ingress as a synthetic user-authored turn. edge/src/slack/cloudflare-slack-adapter.ts supplies durable markers and effect fences; edge/src/slack/quick-card.ts bounds final cards. The focused tests include quick-actions.test.ts, quick-actions-identity.test.ts, and research-final-delivery.test.ts. docs/centaur-port.md:57-72 and 171-186 already record these adaptations. This is Covered, with no new OpenTag code justified by the Centaur backfill.

### 6. Covered at the contract level — sentinel credentials, exact approval scope, and harness postconditions

Centaur’s services/sandbox, services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs, services/api-rs/crates/centaur-iron-proxy, and services/console implement placeholder credentials, controlled request matching, proxy readiness, and grant boundaries. ad28c19d4d946673bfde5dca8ddaf364e2ed5625 restores attachment-upload authorization and provider pinning. The current tests cover attachment and provider boundaries, render recovery, and proxy fragments.

OpenTag already implements the portable behavior in edge/workers/sandbox/src/egress-policy.ts:3-24 and 66-267, edge/workers/sandbox/src/router.ts:329-341, and edge/workers/sandbox/harness-server.ts around the Nanocodex and Claude environment construction. edge/test/harness-egress-policy.test.ts and edge/test/harness-server.test.ts assert exact read/write scope, repository policy, sentinel-only exposure, postconditions, attachment behavior, and absence of real credentials. ARCHITECTURE.md:327-405 and docs/centaur-port.md:188-204 and 236-291 document the Cloudflare adaptation. Covered; do not add a literal iron-proxy or arbitrary Kubernetes NetworkPolicy clone.

### 7. Adapt — identity, grants, OAuth, connector, MCP, and operator control-plane behavior

Centaur’s current Console and connector surface provides a portable set of behaviors: explicit principals, roles and grants; revocation and audit boundaries; OAuth refresh-token custody outside sandboxes; MCP resource authorization; private connector scopes; and durable operator visibility. Evidence is in services/console, services/api-rs, connector-specific service AGENTS files, the capability inventory sections for credentials, permissions, MCP, and ETL, and the committed source under those directories.

OpenTag’s HANDOFF.md identifies the platform layer as not started: no web frontend, OAuth provisioning, connector marketplace, billing, or final tenancy/key-custody decision. VISION-SPEC.md describes those as future Layer 3 work. OpenTag does have access bundles, WorkspaceConfig/MCP and knowledge connector work, but those are not a complete operator identity plane. Adapt the contracts when Layer 3 is designed: tenant-scoped principals, progressive grants, revocation, audit, source-specific connector scopes, and credential custody. Do not port Rails models, Postgres schemas, Kubernetes service accounts, or Centaur’s internal Console layout as if they were product requirements.

### 8. Defer — general durable workflows, schedules, and child-agent orchestration

Centaur’s workflows/ and services/workflow-python surfaces, backed by api-rs, support durable steps, sleeps, events, child workflows, tool calls, agent turns, schedules, cancellation, and webhooks. This is a real capability, but it is broader than OpenTag’s current Slack turn and research task planes.

OpenTag’s PRODUCT.md explicitly defers multi-agent behavior, while HANDOFF.md and ROUTER-SPEC.md say the sandbox tier and general router are not built. The current research path is not evidence that a general workflow engine should be added. Defer the product surface. Preserve the underlying lessons already Covered: durable state, leases, replay, idempotency, terminal render obligations, and explicit cancellation.

### 9. Adapt — provider gateway, model routing, readiness, and version evidence

Centaur’s 7bbc1c86557f80368d9675cf42c21117e631d7f1 introduces an in-cluster LiteLLM proxy with iron-proxy injection; 26c051899f0cd9e418d8ab30e328ec048045f8f2 adds direct sandbox-egress verification; a33198b4d2047c308e5f64361ce1bc49082c3e3f adds Gemini aliases; and f5f3936b01934378aea4d0e396a27d147bc8bdca tracks a pinned LiteLLM release. contrib/chart/templates/litellm.yaml, the LiteLLM config files, NetworkPolicy, secret bootstrap, readiness checks, and verification scripts provide source and operational evidence.

OpenTag already has model/harness validation and provider bundles in edge/src/config/access-bundle.ts, a private Claudex proxy in edge/workers/claudex-proxy, and native Nanocodex/OpenAI Responses support in edge/workers/sandbox/harness-server.ts. It does not have a generic LiteLLM service. Adapt only the portable concepts if provider count or tenancy requires them: an explicit provider boundary, health/readiness evidence, model alias/version provenance, and key isolation. Do not add a Kubernetes gateway solely for parity.

### 10. Not Applicable — Centaur’s Kubernetes, Rails, Postgres, and extra ingress implementation

Centaur’s K8s sandbox scheduling, warm pools, reapers, Helm toggles, Rails Console, Postgres/sqlx control plane, and additional Discord/GitHub/Teams adapters are real implementation details of its self-hosted architecture. OpenTag’s PRODUCT.md:9-16 and 108-118 define a Cloudflare Workers/DO/R2/Containers, Slack-first product; VISION-SPEC.md explicitly places Teams and Discord out of scope; docs/centaur-port.md:133-169 and 273-291 explicitly records the intentional omission of Rails/Postgres/K8s, full iron-proxy, and the broader harness matrix.

These should not be ported. Linear create and selected connector behavior already have OpenTag counterparts, so this classification applies to the extra ingress and infrastructure implementation, not to every named connector in Centaur.

### 11. Not Applicable — local vLLM/Gemma 4 CUDA and Kubernetes development path

7f0019eb06917e516e10c7c89693aebbcc3171ee, 674644dae24eedb3da26c3c0d39c8f3ebcbfe3d8, 3b11d481bd2b1966c2a3a3a0f4713908a7bea672, and 89725fde add local vLLM/Gemma guides, smoke harnesses, CUDA launch behavior, and local provider egress. They improve Centaur development and deployment operations but depend on local CUDA/Kubernetes shapes.

OpenTag’s model contract, native Nanocodex path, sentinel environment, and model-selection tests already cover the portable model behavior. The local CUDA operational path is Not Applicable to the current OpenTag product.

### 12. Not Applicable — Eve and Goose explorations

8ba84239653387d7d6fe391c17d63ad0ba7e6937 documents a Vercel Eve exploration and 7131437ac3f656dd6a00357f82ca17180b7fa6fd adds a Block Goose exploration. The changes are explicitly demos/research notes and do not establish production routing, storage, security, or lifecycle contracts. They are Not Applicable to OpenTag parity; their research may be revisited only as a separately scoped product investigation.

### 13. Not Applicable — Centaur fork synchronization scripts as runtime features

d096cd1c160d61c788e9a8a3ca257b594e2047e2 adds contrib/scripts/sync-upstream.sh, and 83bd0060d5af244e756be0065bd365d97f3f2b2e documents the fork synchronization workflow. This is useful repository governance and its current outcome is recorded above, but it is not a runtime or user-facing OpenTag capability. Existing Centaur sync automation already owns parent synchronization, and this report did not alter it.

### 14. Adapt — make docs/centaur-port.md a current parity ledger

docs/centaur-port.md is a valuable source-backed ledger at tracked revision 568f17740246d1565aa583f66592460dd737f5ed, but its stated update predates the current fork backfill, the Nanocodex/Buzz additions at OpenTag e10bd0d, and the current Centaur feature delta. The document already records the central Cloudflare adaptations and intentional omissions, so the right action is to extend it with the findings above, exact source paths, current SHAs, and explicit Adopt/Adapt/Covered/Defer/Not Applicable outcomes.

No ledger edit was made in this assignment because the task scope permits only the assigned report path. The durable recommendation is an Adapt/update to the parity artifact, not an unreviewed runtime change.

## Classification summary

The 14 isolated candidates classify as:

- Adopt: 1 — verified live deployment/capability identity.
- Adapt: 4 — artifact lifecycle contracts, operator/identity/connectors, provider gateway concepts, and parity-ledger maintenance.
- Covered: 3 — durable session/replay/recovery, Slack interaction semantics, and sentinel/approval/harness security contracts.
- Defer: 2 — complete Quick static hosting and a general workflow/child-agent control plane.
- Not Applicable: 4 — Kubernetes/Rails/Postgres and extra ingress implementation, local vLLM/Gemma operations, Eve/Goose explorations, and fork-sync scripts as product features.

These counts are for the isolated deep-dive candidates in this report. They are not the daily review row counts and should not be merged with the separate daily automation’s incremental classification.

## Validation performed

Read-only validation performed for this report:

- Confirmed both remotes and their URLs, both default branch names, the non-shallow repository state, current remote refs, and the dirty primary checkout status.
- Verified the common ancestor and the complete 0-parent/64-fork commit split.
- Reviewed every commit in 6d109198a4dccfdcd4c6f8a3ee0834722e54a877..acb5512ad4290e9d0e217fa295ba230915b353f9 using reverse chronological inventory, source diffs, and high-signal file/test inspection.
- Reviewed the current Centaur service instructions and nearer AGENTS files for api-rs, sandbox, Slack, Console, Discord, GitHub, Iron, Linear, Teams, and workflow areas.
- Inspected current Centaur source, tests, skills, architecture/configuration docs, and the untracked local capability inventory without changing it.
- Inspected OpenTag HANDOFF.md, VISION-SPEC.md, ARCHITECTURE.md, PRODUCT.md, docs/centaur-port.md, current sandbox/egress/harness/Slack/knowledge/config source, and affected tests.
- Ran git diff --check over the complete fork delta and an added-line conflict-marker scan; both passed.
- Inspected, but did not execute, language/runtime test suites because this report was output-only and all primary checkouts had to remain untouched. No deploy, live Slack QA, branch, PR, or external write was authorized or performed.

## Complete fork-only history reviewed

The following is the complete 64-commit inventory in 6d109198..origin/main, in chronological order. Merge and formatting/sync commits are retained so the range is auditable rather than reduced to feature titles.

- b1186cc4 feat: add Quick static-site deploy tool and skill
- 425b9520 docs: add local verification flow to deploying-static-sites skill
- 702e8a30 Merge pull request #1 from wcordelo/devin/1781146303-quick-static-deploy
- 5fb8c843 feat(quick): ownership, atomic deploys, stale cleanup, s3 parity, static server
- d7c3c5d0 feat(quick): Slack deploy cards + chart serving module with IAP gating
- 26605242 chore(chart): bump version to 0.1.52 for quick-server module
- ce0be1ee Merge branch 'main' into upstream-sync
- b730c4b3 fix(slackbot): type Quick action payload and config test fixtures
- 2f7d29a1 Merge branch 'main' into upstream-sync
- edd3e901 Add local Slack dev workflow and iron-proxy 1Password setup.
- 89725fde Add hardened vLLM sandbox egress and default local Slack to OpenAI.
- 7b9d627c Merge origin/upstream-sync into upstream-sync
- 33101e56 feat(slackbotv2): port Quick deploy cards + button actions
- 58549b9d style(api-rs): cargo fmt args.rs and iron_proxy.rs
- 7b4c6a90 Fix Quick deploy readiness, ownership, and Slack button routing.
- c3fc76ed Inject per-turn QUICK_REQUESTER and cap Quick deploy cards.
- ba0d4e88 docs: add Cursor Cloud environment setup instructions to AGENTS.md
- 703dda35 fix(quick): mount shared PVC in sandboxes and harden local deploy path
- 35339646 Merge pull request #3 from wcordelo/cursor/setup-dev-environment-358b
- e589a429 style(api-rs): satisfy clippy collapsible_if and rustfmt for vLLM authority parsing
- a94d6f58 Merge pull request #2 from wcordelo/upstream-sync
- 7f0019eb docs: add vLLM Gemma 4 local model development guide and test harness
- 674644da docs: add local vLLM Gemma 4 development guide and smoke tests
- 3b11d481 fix(vllm): set Gemma 4 eos_token_id override on CUDA launcher
- 8ba84239 docs: add Vercel Eve exploration demo and research notes
- 499f89e2 Merge pull request #4 from wcordelo/cursor/vllm-gemma-4-local-development-ec42
- 8994729b fix(docs): escape MDX control tokens in Gemma 4 guide
- 0c87b7cb fix(docs): escape < and > in tables to fix MDX parser error
- 17613325 merge: resolve main into feature/gemma-4-local-dev-guide
- f6818303 test(slackbotv2): harden render obligation recovery startup tests
- 7faf4579 Merge pull request #5 from wcordelo/feature/gemma-4-local-dev-guide
- 569e7151 Merge pull request #6 from wcordelo/cursor/vercel-eve-exploration-add6
- 7131437a feat: add Block Goose exploration under contrib/goose-exploration/
- bf5d42f7 Merge pull request #7 from wcordelo/contrib/goose-exploration-branch
- 8526f7c5 merge: sync paradigmxyz/centaur main into wcordelo fork
- ad28c19d fix: reconcile Codex provider pinning and restore attachment upload auth
- 7f85f965 docs: expand Cursor Cloud setup (pg_cron, harness-server, workflows, docs, helm, ruff pin)
- 37b7fc9b Merge pull request #10 from wcordelo/cursor/setup-dev-environment-358b
- 5c2b6fe8 Merge remote-tracking branch 'upstream/main'
- d096cd1c chore: add upstream sync script for paradigmxyz/centaur
- 83bd0060 docs: document upstream sync workflow for fork checkouts
- 7bbc1c86 feat: add in-cluster LiteLLM proxy with iron-proxy credential injection
- 26c05189 fix: direct sandbox egress to in-cluster LiteLLM
- a83f08ef feat: local Quick overlay and LiteLLM direct-egress verify script
- a33198b4 feat: add Gemini models to LiteLLM overlay and bootstrap
- f6b98a06 fix: inject [Active deployment] block so agents skip env shell probes
- f5f3936b fix: upgrade LiteLLM to v1.90.0 and track latest stable releases
- 8c016026 merge: sync upstream/main from paradigmxyz/centaur
- 80c8e3ef fix: map quick wheel sources for CLI packaging validation
- e4a3b66e chore: sync upstream main
- 02b16d40 chore: sync upstream main
- 14c6577d chore: sync upstream main
- 0ad4fc56 chore: sync upstream main
- 4d301389 chore: sync upstream main
- 0bec1533 chore: sync upstream main
- 33ea7b4a chore: sync upstream main
- 77aee46e chore: sync upstream main
- ce50b3d2 chore: sync upstream main
- 20e624c0 chore: sync upstream main
- cb8b7caa chore: sync upstream main
- bd066ee3 chore: sync upstream main
- d74baf07 Merge remote-tracking branch 'upstream/main' into HEAD
- 5f20fe41 chore: sync upstream main
- acb5512a chore: sync upstream main


## Current-state addendum — 2026-08-01

The Centaur report's OpenTag comparison predates the merged implementation and live rollout. Current status: runtime/capability evidence, native Nanocodex, connector/platform metadata, and router shadow work address the portable recommendations; Kubernetes/Rails/Postgres product infrastructure remains not applicable.

The original evidence, classifications, and validation limits above are intentionally preserved. The canonical feature/gap ledger is [CURRENT-STATE-RECONCILIATION.md](../CURRENT-STATE-RECONCILIATION.md).
