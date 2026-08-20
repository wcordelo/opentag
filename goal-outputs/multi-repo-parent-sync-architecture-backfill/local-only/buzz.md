> **Historical snapshot.** This artifact was authored before the final merged OpenTag rollout. Read [the current reconciliation](../CURRENT-STATE-RECONCILIATION.md) and [the current OpenTag status](../../../docs/current-state.md) before treating any implementation or deployment statement as current.
>
> Current reconciliation: OpenTag has deployed server-owned tenancy and Buzz wake configuration. An empty live request reaches schema validation with `buzz_wake_unexpected_fields`; no authenticated relay/signature proof is claimed.

# Buzz parent-to-fork backfill and architecture deep dive

Date: 2026-08-01

## Result

The Buzz fork has now been source- and history-reviewed against the published parent merge. The published fork tip, 40d1bebf5fefeeb57463973af9cd8a64026abc0c, is a two-parent merge of the fork-only documentation commit 2a0367ee95dfdf35ab7f235970c703d7f7f07c5a and the parent tip ac4fa13b8e4d947071d57deb6918dcf12bf74961. The primary fork checkout was left at 2a0367ee because this assignment forbids checkout, merge, staging, commit, push, deployment, and PR changes.

The most useful OpenTag conclusion is narrower than “copy Buzz”: adopt Buzz’s server-resolved tenancy fence, exact NIP-29 scope semantics, durable-first event and audit ordering, result-level authorization after search, and conformance-test posture. Adapt those patterns to OpenTag’s Cloudflare Durable Object and knowledge-ledger architecture. Do not treat Buzz as proof that hosted key custody is already solved. The current Buzz source documents local OS-keyring and environment custody, and the remote-agent design explicitly hands a key to a trusted provider and Kubernetes Secret.

Classification tally for the 27 findings below:

- Adopt: 5
- Adapt: 11
- Covered: 4
- Defer: 5
- Not Applicable: 2

No OpenTag source, branch, PR, deployment, Notion page, or external system was changed by this report.

## Repository, ancestry, and sync facts

| Item | Verified value |
| --- | --- |
| Parent URL | https://github.com/block/buzz.git |
| Parent default branch | main |
| Fork URL | https://github.com/wcordelo/buzz.git |
| Fork default branch | main |
| Fork checkout | /Users/will/Documents/buzz |
| Fork remote | origin = https://github.com/wcordelo/buzz.git |
| Primary checkout branch and SHA | main at 2a0367ee95dfdf35ab7f235970c703d7f7f07c5a |
| Published fork remote tip | origin/main at 40d1bebf5fefeeb57463973af9cd8a64026abc0c |
| Parent tip | ac4fa13b8e4d947071d57deb6918dcf12bf74961 |
| Verified common ancestor | acfbb1bb6af54cb29cb152496ff43b8285dcb8cf |
| Parent reviewed range | acfbb1bb6af54cb29cb152496ff43b8285dcb8cf..ac4fa13b8e4d947071d57deb6918dcf12bf74961, 276 commits |
| Fork-only reviewed range | acfbb1bb6af54cb29cb152496ff43b8285dcb8cf..2a0367ee95dfdf35ab7f235970c703d7f7f07c5a, 1 commit |
| Merge reachability | acfbb1bb is an ancestor of 40d1bebf; the merged range contains 278 reachable commits, consisting of the 276 parent commits, the one fork-only commit, and the merge commit |
| Shallow status | false; repository is not shallow |

The parent range begins with bcc3e1306946528102bb26be9a7c41299e2f8e00, “feat(relay): make Redis pool size configurable,” and ends at ac4fa13b8e4d947071d57deb6918dcf12bf74961, “perf(relay): serve relay-membership checks from the read replica.” The fork-only commit is documentation-only: 2a0367ee adds Cursor Cloud setup and run caveats to AGENTS.md. It does not alter relay, auth, database, client, agent, workflow, media, or deployment behavior.

Sync outcome and preservation decision:

- The fork’s primary checkout was clean before inspection: git status showed only the branch line, with main behind origin/main by 277 commits and no dirty or untracked entries.
- origin/main already contains the published parent-to-fork merge. The merge parents are exactly 2a0367ee and ac4fa13b.
- I inspected the parent-tip and merged-tip objects directly; no temporary worktree was needed and the primary checkout was not moved.
- The OpenTag checkout was also preserved. Its pre-existing untracked HANDOFF.md, ROUTER-SPEC.md, VISION-SPEC.md, docs/knowledge-base-implementation-spec.md, docs/semantic-algos-integration.md, and goal-outputs/multi-repo-parent-sync-architecture-backfill/ were not touched except for this assigned analysis/buzz.md path.

## Review method and validation

The review used the non-shallow fork object database and the merged tree at 40d1bebf5fefeeb57463973af9cd8a64026abc0c. It verified remote identity, branch tips, merge parents, merge-base, commit counts, range edges, and status. It then reviewed every commit in both post-ancestor ranges with git log metadata and inspected the final merged source and tests rather than inferring gaps from titles.

The required documentation surfaces were reviewed at the merged tree: AGENTS.md, ARCHITECTURE.md, VISION.md, VISION_PROJECTS.md, VISION_REMOTE_AGENTS.md, SECURITY.md, CONTRIBUTING.md, RELEASING.md, NOSTR.md, and TESTING.md. Source and test review covered the relay, core, auth, database, search, audit, media, ACP, agent, developer MCP, persona, workflow, CLI, SDK, admin, desktop, mobile, web, migrations, deployment charts, and conformance/E2E suites listed below.

Validation performed was read-only:

- ancestry and range validation with merge-base and rev-list;
- complete commit-range enumeration, including all 276 parent commits and the one fork-only commit;
- final-tree path and source inspection at 40d1bebf;
- static inspection of unit, integration, conformance, and E2E test files;
- dirty-tree checks in Buzz and OpenTag.

No test suite was run. This task authorized an isolated report and explicitly prohibited implementation or other repository mutation; running Buzz integration/E2E tests would also require the Postgres, Redis, MinIO, and client toolchain described in CONTRIBUTING.md and TESTING.md. The report therefore distinguishes code and test evidence inspected from tests executed.

## Buzz architecture evidence

### Tenancy and request binding

Buzz makes the community a server-resolved tenant selected by the connection host. ARCHITECTURE.md and NOSTR.md state that host binding happens before WebSocket AUTH/EVENT/REQ, REST, media, git, search, workflow, and pub/sub handling. Unknown or unmapped hosts fail closed. The same resolved TenantContext is carried into downstream calls, and NIP-98 URL binding must agree with the host-derived tenant.

The implementation is split deliberately:

- crates/buzz-core/src/tenant.rs defines the opaque CommunityId and TenantContext, one host-normalization rule, default-port handling, and the explicit “lint-and-review fence, not a compiler fence” limitation.
- crates/buzz-relay/src/tenant.rs resolves Host to the durable communities row and binds deployment-internal paths to the configured deployment community.
- crates/buzz-relay/src/router.rs routes WebSocket, NIP-11, health, bridge, media, git, operator, and workflow paths only after the relevant host/tenant boundary is established.
- migrations/0001_initial_schema.sql makes community_id the first column or leading key component for communities, channels, members, users, events, workflows, approvals, tokens, relay members, audit rows, and related tables.
- crates/buzz-test-client/tests/conformance_multitenant.rs and crates/buzz-conformance/tests/fixtures/bad_host_channel_mismatch.jsonl, bad_foreign_row_leak.jsonl, and bad_coverage_breach.jsonl exercise cross-tenant failure modes.

The parent history shows that this is an active reliability boundary, not a static design claim. 63496cc1d4c6f1b7c613801bdcc694169dcf391a added portable replica heartbeat fencing and snapshot-local reader routing. ac4fa13b8e4d947071d57deb6918dcf12bf74961 moved relay-membership checks to the read replica while retaining the fence. 2a051a404dcde42dddbff2a0b33f717ffe9cf999 made the per-owner community limit configurable. These changes are parent-only relative to the pre-merge fork checkout but present in the published merged tip.

### Nostr, NIP-29, authentication, and identity

Buzz is Nostr-first. AGENTS.md directs new feature work toward event kinds and the existing auth/ingest pipeline instead of endpoint-specific APIs. NOSTR.md describes direct NIP-29 relay use and explicitly says the old NIP-28 compatibility proxy is gone.

The important scoping rule is exact:

- channel/group events use h tags;
- addressable channel metadata and membership events use d tags;
- a channel identifier in a client event is not a substitute for the server-resolved community;
- global events such as profiles, lists, status, gift-wrapped DMs, and workflow/system streams are global only inside the connected community.

The rule is codified in AGENTS.md, crates/buzz-core/src/kind.rs, crates/buzz-relay/src/handlers/ingest.rs, crates/buzz-relay/src/handlers/req.rs, and the NIP-29 membership code. Parent commits 3d7712cc36e8da563cb1c121fc58bfc505d38496 and 756dd7f65d6f2995e9188a0ffe54294057f8ef4f document the d-versus-h distinction and the h requirement for live reaction subscriptions. This is an especially valuable source-backed warning against guessing scope from event names.

Authentication has separate WebSocket and HTTP paths:

- crates/buzz-auth/src/nip42.rs generates a random challenge and verifies kind 22242, challenge, relay URL, Schnorr ID/signature, and a roughly 60-second freshness window. AUTH events are not stored or logged.
- crates/buzz-auth/src/nip98.rs verifies kind 27235, exact normalized URL and method, freshness, and optional payload hash.
- crates/buzz-auth/src/nip98_replay.rs keeps a community-scoped replay guard.
- crates/buzz-auth/src/scope.rs and access.rs distinguish transport scopes from channel-membership authorization; a token or NIP-42 session does not bypass NIP-29 membership.
- crates/buzz-relay/src/api/bridge.rs rebinds the HTTP request to the resolved tenant before authentication and uses the tenant host when validating NIP-98.

NIP-OA is provenance, not impersonation. docs/nips/NIP-OA.md requires an independent owner key and agent key, an optional four-element auth tag, event signature verification first, and no author rewriting. crates/buzz-sdk/src/nip_oa.rs and crates/buzz-acp/src/lib.rs use the tag to resolve an owner and verify same-owner sibling agents. Parent commit cb42c8d5b60b15fd6ad47149c8785c7c863c8a37 tightened ACP DM turns to the owner and verified siblings.

Key custody is more nuanced than the product vision summary suggests. SECURITY.md says desktop nsec material is held in macOS Keychain, Windows Credential Manager, or Linux Secret Service, with a 0600 fallback file and environment-variable precedence for harnesses and CI. crates/buzz-acp/README.md says an agent key is printed once and supplied through BUZZ_PRIVATE_KEY. VISION_REMOTE_AGENTS.md says remote deployment hands the key to a trusted provider and that Kubernetes stores it as a Secret. The document explicitly calls provider and cluster trust a decision and disclaims an emergency kill switch. The current source therefore proves portable public-key identity and explicit custody choices, not server-side hosted custody with no raw-key exposure.

### Durable events, side effects, and auditability

The relay is the source of truth. crates/buzz-relay/src/handlers/event.rs and handlers/ingest.rs establish the ordering:

1. authenticate and bind the event to the authenticated pubkey;
2. reject AUTH and ephemeral events from persistent storage;
3. verify ID and signature, using bounded blocking work;
4. enforce kind scope, tag shape, channel membership, ownership, moderation, and specialized policy;
5. insert the durable event with community scope and conflict-safe idempotency;
6. perform Redis publication, local fan-out, search-visible behavior, audit enqueueing, and workflow triggering only after durable acceptance.

Ephemeral presence and typing use Redis and local fan-out. Persistent events use Postgres and the event/audit paths. The in-memory subscription registry, connection manager, and event-ID caches are accelerators or live connection state, not the durable source of truth. ARCHITECTURE.md calls out a bounded audit queue, post-commit side effects, per-tenant subscription registration, and an explicit exclusion of workflow-generated events from workflow triggers to prevent loops.

crates/buzz-db/src/event.rs builds EventQuery with community scope, channel scope, author/ID/tag/time constraints, visibility gates, and ordering before the limit. It uses community-leading keys and conflict handling. migrations/0001_initial_schema.sql creates partitioned events with a generated search_tsv column, event mentions, thread metadata, reactions, workflows, workflow runs, approvals, delivery records, and tenant-scoped audit tables. Later migrations 0009 through 0011 add database guards, exact replay handling, and tag-cardinality protections; 0021 through 0024 add created_at and TTL/lock safety; 0026 adds replica heartbeat fencing.

The audit implementation is in crates/buzz-audit/src/hash.rs and service.rs. It chains each entry to the prior hash, includes tenant, sequence, timestamp at Postgres precision, action, actor/object, and canonical detail bytes, and uses a per-community PostgreSQL advisory lock for append ordering. The chain can detect accidental corruption and single-row edits, but SECURITY.md correctly says it is keyless and therefore not tamper-resistant against a database attacker. Parent commit 264a56a2260ac87350bfe1f5d3ec3d89615eb47c corrected timestamp hashing at the precision Postgres stores; that commit is good evidence that audit reproducibility is tested against storage semantics, not just nominal code.

### Search and visibility

crates/buzz-search/src/query.rs makes CommunityId mandatory and separates Any, channel-less, channel, and channel-or-channel-less scopes. The Postgres FTS query applies tenant, deleted, kind, author, channel, tag, and time constraints before paging. It is intentionally a candidate finder, not the authorization boundary.

crates/buzz-relay/src/handlers/req.rs performs access resolution before subscription registration and search, repairs cache-negative membership misses against the database, applies p-gated and author-only filters, and rechecks event visibility when historical results are emitted. Search hits are hydrated from canonical events and reauthorized. The implementation specifically prevents a stale access vector or an FTS result from broadening visibility or consuming the page limit with rows the reader cannot receive. crates/buzz-search/tests/fts_integration.rs and the multitenant conformance tests cover the boundary.

Parent history reinforces the pattern. cb2a265b5399426e808461c1a16713754c593258 added structured search filters. 114d40d9d37f05eff83ee90347ed93fb3da512c gated team-catalog reads behind an explicit shared tag and added a large E2E suite. ab3af828714ab699dfc87644d234014987a4fe6b added the author-only-unless-shared gate for persona events.

### Relay policy, provisioning, moderation, and workflows

NIP-29 role and membership operations are handled in crates/buzz-relay/src/handlers/relay_admin.rs and the corresponding database layer. Community provisioning is intentionally outside the event data plane:

- crates/buzz-relay/src/handlers/community_provisioning.rs uses the deployment-level RELAY_OPERATOR_PUBKEYS allowlist rather than a tenant member lookup, because creation is the act that creates tenancy;
- host input is normalized and bounded;
- create-only and convergence modes are distinguished;
- retries are idempotent on the host row;
- owner bootstrap and membership snapshot publication are separate, observable steps;
- an empty operator allowlist disables provisioning.

Operator REST surfaces are in crates/buzz-relay/src/api/operator.rs and api/invites.rs. Relay-member bans, roles, invites, archival, and identity lifecycle are durable rather than process-local. e2e007910114ddf7c5a4e93bb03f6afe13552e92 made community bans durable for NIP-43 admin kinds and added crates/buzz-test-client/tests/regression_relay_admin_ban_gate.rs.

The workflow engine in crates/buzz-workflow/src/schema.rs, executor.rs, lib.rs, and action_sink.rs stores canonical JSON definitions and durable workflow runs. It supports message, reaction, diff, schedule, and webhook triggers; message, DM, topic, reaction, webhook, approval, and delay actions; simple evalexpr conditions; and a one-minute scheduler. Scheduled fires use a durable claim keyed by community, workflow, and deterministic scheduled time so multiple relay instances converge at most once. The engine rechecks current owner/admin authority before a run, applies channel overrides only within the workflow’s authorized scope, and rejects private/reserved webhook targets using DNS resolution, no proxy, pinned address, no redirects, a ten-second timeout, and a one-megabyte response limit.

The important negative evidence is in the same source. SendDm and SetChannelTopic are NotImplemented. RequestApproval returns a suspension token but the approval record and resume path are still TODO; the current run finalization marks the path failed. Delay is capped at 270 seconds until a scheduled-resume design exists. NOSTR.md and ARCHITECTURE.md call this out as partial rather than shipped end-to-end behavior. OpenTag should not infer a complete approval architecture from Buzz’s schema or UI.

### Agent, ACP, MCP, persona, and memory surfaces

The ACP surface is a relay-to-stdio bridge:

- crates/buzz-acp/README.md and src/lib.rs authenticate the harness to the relay, discover member channels, apply an owner/allowlist/anyone/nobody inbound policy, and consume owner-only controls such as shutdown, cancel, and rotate;
- src/queue.rs keeps per-channel event queues and batches mentions;
- src/pool.rs and pool_lifecycle.rs bound the subprocess pool, reuse or replace sessions, handle crash/respawn, and expose lifecycle state;
- the normal path permits one prompt in flight per channel and reconnects with a since cursor;
- ACP process state itself is not durable; durable agent memory is put on the relay as encrypted engrams.

The base agent in crates/buzz-agent/src/agent.rs and mcp.rs is intentionally small and ACP-compliant. Tool calls have explicit pending, in-progress, completed, and failed terminal states. Tool concurrency, timeouts, result-size budgets, cancellation, and MCP-server killing are bounded. Hook output is represented as lower-trust structured tool results rather than user text.

crates/buzz-dev-mcp/src/paths.rs, read_file.rs, str_replace.rs, shell.rs, tree.rs, view_image.rs, and todo.rs form a separate developer-tool server with path containment and output limits. ACP transport, the model loop, and developer tools are distinct boundaries. Parent commits 95fdf978800982389b120c66ff5e766d785419c7 introduced generic BYOH harness configuration; b0503d80c298b1ece3b0a43b41d316829a3379e7 added inline custom harness setup; 6300a6b1d03e32c473c7b6568df663c8927565cf isolated per-runtime environment defaults; and 4e3998f36e36d68b9a93dcbd85f0864450bb8f5f gated Codex discovery on a supported version.

NIP-AE engrams are a separate encrypted memory substrate. crates/buzz-core/src/engram.rs, docs/nips/NIP-AE.md, crates/buzz-acp/src/engram_fetch.rs, and crates/buzz-cli/src/commands/mem.rs define owner/agent conversation-key encryption, HMAC-derived address tags, tombstones, strict envelope validation, and owner-side recovery. b1b283cd4c7f926e12eeee8ae1f38c7471922b16 extended ACP usage publication with cache-read token information. This is a portable private-agent-memory pattern, not a substitute for OpenTag’s searchable, ACL-governed company knowledge corpus.

Personas and teams use event kinds and explicit read gates. crates/buzz-core/src/kind.rs, crates/buzz-persona/src/manifest.rs, crates/buzz-persona/src/merge.rs, crates/buzz-persona/src/pack.rs, crates/buzz-persona/src/persona.rs, crates/buzz-persona/src/resolve.rs, crates/buzz-persona/src/validate.rs, and crates/buzz-persona/PERSONA_PACK_SPEC.md distinguish owner-private, shared, and catalog-visible definitions. 114d40d9d37f05eff83ee90347ed93fb3da512c added the shared-tag gate for kind 30178 and the E2E coverage in crates/buzz-test-client/tests/e2e_team_catalog.rs; the source also protects private persona/system-prompt material from broad device-sync reads.

### Media, git, clients, deployment, and operator experience

Media is a complete subsystem rather than a generic file upload:

- crates/buzz-media/src/auth.rs verifies Blossom kind 24242 verb, freshness, server/tenant host, and body hash;
- upload.rs computes SHA-256, uses content-addressed object names, performs idempotent blob/sidecar checks, writes moderation/upload attribution before publishing the sidecar serve gate, and leaves orphan blobs for bounded garbage collection instead of deleting a blob that a concurrent uploader may need;
- validation.rs rejects active content and executable formats, checks magic bytes rather than trusting Content-Type, bounds dimensions and file sizes, and runs separate image/video pipelines;
- storage.rs, thumbnail.rs, bucket_index.rs, and the MinIO/S3 configuration provide durable object storage and derived thumbnails;
- crates/buzz-media/tests/static_creds_minio.rs, crates/buzz-test-client/tests/e2e_media.rs, crates/buzz-test-client/tests/e2e_media_extended.rs, and crates/buzz-test-client/tests/e2e_media_video.rs cover storage and client behavior.

Git is a first-class smart-HTTP surface in crates/buzz-relay/src/api/git/transport.rs, crates/buzz-relay/src/api/git/policy.rs, crates/buzz-relay/src/api/git/binding.rs, crates/buzz-relay/src/api/git/manifest.rs, crates/buzz-relay/src/api/git/cas_publish.rs, crates/buzz-relay/src/api/git/hydrate.rs, and crates/buzz-relay/src/api/git/store.rs. NIP-34 events and NIP-OA owner authorization connect repository identity, branch/channel binding, protected pushes, approvals, and object storage. 788b3c002bd2509455444f57f8a03a054b4b496a added binding/remediation tooling and E2E coverage in crates/buzz-test-client/tests/e2e_git.rs. The NIP-MP kind 30621 project grouping is newer and still largely a forge design: cb9701cd30fb344bf134585634a09007f3155bfb added ingest and E2E acceptance, while VISION_PROJECTS.md still marks project binding and merge coordination as designed work around the shipped git transport.

The clients are intentionally multiple:

- desktop/ is Tauri 2 plus React and includes identity, keyring, agent lifecycle, workflow, media, project, and E2E surfaces;
- mobile/ is Flutter with pairing, relay validation, channels, search, media, profile, and community switching;
- web/ supplies a relay-served browser surface;
- crates/buzz-cli is JSON-first and mirrors or extends MCP operations;
- crates/buzz-admin, buzz-sdk, buzz-ws-client, buzz-test-client, and the admin-web support operator and interoperability workflows.

CONTRIBUTING.md requires Rust, Node, pnpm, Flutter, Docker, Postgres, Redis, and MinIO setup; just test-unit is self-contained, just test runs relay integration, and just ci includes formatting, clippy, unit tests, desktop checks, and mobile checks. TESTING.md separates unit, integration, conformance, relay, media, Nostr interop, managed-agent, persona, project, mesh, and client tests. Desktop and mobile UI changes require screenshots in PRs.

Deployment is concrete but split across lanes. docker-compose.yml and deploy/compose provide local Postgres, Redis, MinIO, Prometheus, and related services. deploy/charts/buzz provides Helm deployment, PVC-backed git storage, secrets, network policies, health probes, HPA/PDB, ServiceMonitor, and bundled MinIO options; chart tests live under deploy/charts/buzz/tests. .github/workflows/ci.yml, docker.yml, helm-chart.yml, and the release workflows establish CI and relay image publication. RELEASING.md separates immutable desktop candidate PRs/tags, relay image releases, and mobile immutable RC tags. Parent commits 19d57b0d46baa55814ac737041a36d0b405c9f64 and 36cf932ff0105a4cf574fc687deb4c1cb01bc0d1 document a one-click Railway path and a corrected ArgoCD OCI chart example, but those documents do not prove a production deployment was executed in this review.

### Security and reliability patterns

The source and docs enforce or document:

- NIP-42 and NIP-98 freshness and signature verification;
- per-tenant replay guards and database conflict/idempotency paths;
- bounded frames, subscriptions, body sizes, image dimensions, response sizes, evalexpr time, webhook redirects, and subprocess/tool work;
- SSRF checks including IPv6 transition targets, DNS rebinding avoidance, no proxy, and no redirects;
- no unsafe Rust and cargo audit in CI;
- durable bans, owner/admin rechecks, private-event read gates, and keyring round-trip migration;
- graceful relay restart and authoritative reconnect backoff, tested in parent history by 1911c69aa2912c1408bd6b21759b657458fb43af, 499c5d349dab13bc906b1af5fe1fcb09ce2afa81, and cca8839034eb571a7ce943c3ace7f85a82330898.

The review also found limits that matter for recommendations: SECURITY.md describes the hash chain as keyless; ARCHITECTURE.md notes that the rate-limit implementation is still a test stub, huddles have no recording/tracks, and workflow approval plus some actions are incomplete. These are not omissions to conceal in a parity ledger.

## Complete history review

The full parent range was not reduced to a handful of interesting titles. All 276 parent commits from the common ancestor through ac4fa13b were enumerated, and the final merged tree was searched and read. The following history groups are representative source-backed anchors for the architecture findings:

| History area | Parent-only commits reviewed and checked against source/tests | Backfill conclusion |
| --- | --- | --- |
| Multi-tenant isolation and replica correctness | 63496cc1d4c6f1b7c613801bdcc694169dcf391a; ac4fa13b8e4d947071d57deb6918dcf12bf74961; 2a051a404dcde42dddbff2a0b33f717ffe9cf999 | Tenant-leading keys, fenced reads, and membership read-replica routing are real current architecture |
| Auth and protocol hardening | c26bf5945d8f2ef19746a78e80a7c1dae2ef3db9; 31e2de1966672e73e026af3c54f3a1a9a2f5e103; 047533c56c2a2d03f23ef3edb990e58405767aac | SSRF, NIP-44 dependency, and invite TLS changes are source/test-backed security work |
| Audit and durable records | 264a56a2260ac87350bfe1f5d3ec3d89615eb47c; 264a56a2’s tests and hash/service changes were inspected with the audit source | Hashing depends on storage precision; audit is tamper-evident, not tamper-resistant |
| Agent identity and policy | cb42c8d5b60b15fd6ad47149c8785c7c863c8a37; 7ca0bbd946fd82a7008132f94d069a97bb53f94b; 1b3ff96a5764303998fa629ff852e81f1a88d7ad | Owner/sibling authorization, identity profile propagation, and preset harnesses evolved together |
| ACP and harness boundaries | 95fdf978800982389b120c66ff5e766d785419c7; b0503d80c298b1ece3b0a43b41d316829a3379e7; 6300a6b1d03e32c473c7b6568df663c8927565cf; f25e6dd6aa4a1c5eff0facc260b8e25d05a2b02a | BYOH, inline custom harnesses, per-runtime env, and steering are implemented at explicit seams |
| Search and visibility | cb2a265b5399426e808461c1a16713754c593258; 114d40d9d37f05eff83ee90347ed93fb3da512c5; ab3af828714ab699dfc87644d234014987a4fe6b | Search syntax and privacy gates were changed with matching source and E2E coverage |
| Git, projects, and NIP-29 scope | 788b3c002bd2509455444f57f8a03a054b4b496a; cb9701cd30fb344bf134585634a09007f3155bfb; 3d7712cc36e8da563cb1c121fc58bfc505d38496; 756dd7f65d6f2995e9188a0ffe54294057f8ef4f | Git transport ships; project grouping and exact tag semantics need separate classifications |
| Durable moderation and operator control | e2e007910114ddf7c5a4e93bb03f6afe13552e92; d500c2d5cf5d9aabe0ca4ebebfcafdbe5f5b7fd3; 24d90d1280a9325c6cbcf8eea30ac54db5afd2cb | Bans, invite limits, and relay-admin regression gates are durable policy, not UI-only features |
| Release and deployment reliability | 1dfd89ea67b4ebce0c4d10390f280ed4e7ddde8a; db7e84d4f815127236b9cb080c5d374f48eaac09; 54c8ef30a9bb9c59a4415a8a7ee84c7c5454b48a; 36cf932ff0105a4cf574fc687deb4c1cb01bc0d1 | Exact-head, immutable-tag, chart, and environment contracts are part of the architecture |
| Fork-only divergence | 2a0367ee95dfdf35ab7f235970c703d7f7f07c5a | Documentation-only Cursor Cloud caveats; no fork-specific runtime behavior to adopt or reconcile |

The complete-range conclusion is therefore: the fork’s only independent behavior is no behavior at all, while the parent’s 276-commit delta materially changes the relay’s tenancy, security, agent, client, deployment, search, audit, and operator surfaces. The published merge preserves the fork’s AGENTS.md addition while bringing in those parent changes.

## OpenTag comparison and classifications

The comparison uses OpenTag HEAD e10bd0d32d42d274d760c96941f941f04ccef50e plus the preserved working-tree documents. Buzz evidence is always tied to the merged Buzz tree or a parent commit. OpenTag paths are current source/spec evidence and were not modified.

| # | Class | Finding and justified OpenTag action | Buzz evidence | OpenTag evidence and boundary |
| ---: | --- | --- | --- | --- |
| 1 | Adopt | Make server-resolved tenant binding a row-zero invariant for every Buzz connector, knowledge query, job, and operator path. A client-supplied tenant must never select storage or policy. | ARCHITECTURE.md; NOSTR.md; crates/buzz-core/src/tenant.rs; crates/buzz-relay/src/tenant.rs; crates/buzz-test-client/tests/conformance_multitenant.rs; 63496cc1d4c6f1b7c613801bdcc694169dcf391a | OpenTag already has server-side channel-to-tenant binding in edge/src/buzz/wake.ts, edge/src/buzz/wake-bindings.ts, and edge/src/buzz/signer-secret.ts, and teamId checks in edge/src/request-context.ts and edge/src/permissions/snapshot.ts. Preserve and extend that invariant to every knowledge and connector entry point. |
| 2 | Adapt | Split OpenTag’s tenant and channel types. edge/src/buzz/contract.ts currently validates canonicalInternalTenantId with CHANNEL_ID_RE, so the type name suggests a tenant but the shape is a channel UUID. Buzz’s CommunityId and channel UUID are distinct. | crates/buzz-core/src/tenant.rs; crates/buzz-core/src/channel.rs; crates/buzz-relay/src/handlers/ingest.rs; 40d1bebf5fefeeb57463973af9cd8a64026abc0c | Change planning should introduce distinct opaque tenant and channel identities before the connector becomes multi-channel or host-derived. This is a justified design correction, not an instruction to implement in this isolated report. |
| 3 | Adapt | Preserve durable-first admission and post-commit side effects in the Buzz connector and knowledge path. Treat wake/delivery, canonical event, admission, response, index mutation, and audit as separate durable stages with retry semantics. | crates/buzz-relay/src/handlers/event.rs; crates/buzz-relay/src/handlers/ingest.rs; crates/buzz-db/src/event.rs; migrations/0001_initial_schema.sql; 63496cc1d4c6f1b7c613801bdcc694169dcf391a | OpenTag’s edge/src/buzz/receive.ts and runtime-admit.ts already separate pre-fetch and authoritative dedupe; edge/src/memory/knowledge-ledger.ts has ledger, outbox, leases, DLQ, and reconcile state. The improvement is to ensure every new connector follows this contract rather than inventing a second effect fence. |
| 4 | Adapt | Use signed events as the Buzz connector’s transport contract, but do not turn OpenTag into a Nostr relay or replace Slack/knowledge source truth with Nostr. Keep event-kind, signature, and reply idempotency boundaries narrow. | AGENTS.md; crates/buzz-core/src/kind.rs; crates/buzz-relay/src/handlers/event.rs; crates/buzz-relay/src/api/bridge.rs; cb9701cd30fb344bf134585634a09007f3155bfb | OpenTag HEAD e10bd0d already has edge/src/buzz/events-publisher.ts, edge/src/buzz/receive.ts, and a text-only kind-9 contract. Extend only where the connector needs it; source-specific Slack and knowledge ledgers remain authoritative for those systems. |
| 5 | Adopt | Encode NIP-29 scoping explicitly: h tags scope channel content, d tags scope addressable group/channel state, and neither tag replaces host/community binding. Add tests for the distinction before adding more event kinds. | AGENTS.md; NOSTR.md; crates/buzz-core/src/kind.rs; crates/buzz-relay/src/handlers/ingest.rs and req.rs; 3d7712cc36e8da563cb1c121fc58bfc505d38496; 756dd7f65d6f2995e9188a0ffe54294057f8ef4f | edge/src/buzz/contract.ts correctly requires exactly one h tag for kind 9. The gap is future-proofing: do not generalize this parser to d-tagged addressable events without a separate scope test and type. |
| 6 | Covered | NIP-42/NIP-98 signature, URL/method/payload binding, freshness, replay, and secret-redaction are already represented in the OpenTag Buzz connector. | crates/buzz-auth/src/nip42.rs, nip98.rs, nip98_replay.rs; crates/buzz-relay/src/api/bridge.rs; 31e2de1966672e73e026af3c54f3a1a9a2f5e103 | edge/src/buzz/nip98-auth.ts, nostr-crypto.ts, signer-secret.ts, query-fetcher.ts, and tests/buzz-nip98-fetcher.test.ts cover the client seam and failure taxonomy. Production credential binding remains a separate deployment gate, not a source parity gap. |
| 7 | Covered | NIP-OA’s independent agent key plus owner attestation is already implemented as an optional, provenance-only connector path. Do not rewrite event authorship or collapse owner and agent keys. | docs/nips/NIP-OA.md; crates/buzz-sdk/src/nip_oa.rs; crates/buzz-acp/src/lib.rs; cb42c8d5b60b15fd6ad47149c8785c7c863c8a37 | edge/src/buzz/signer-secret.ts, receive.ts, query-fetcher.ts, and tests/buzz-nip98-fetcher.test.ts validate the attestation seam. Preserve the explicit NIP-98-only mode and fail closed on malformed configured auth tags. |
| 8 | Adopt | Keep access checks before paging and before treating search or query results as deliverable. Candidate retrieval must not be the authorization boundary. | crates/buzz-db/src/event.rs; crates/buzz-relay/src/handlers/req.rs; crates/buzz-search/src/query.rs; crates/buzz-search/tests/fts_integration.rs; 114d40d9d37f05eff83ee90347ed93fb3da512c5 | This is directly relevant to OpenTag knowledge search and connector reads. edge/src/tools/search-knowledge.ts, edge/src/mcp/knowledge-mcp.ts, edge/src/memory/knowledge-contract.ts, and docs/knowledge-base-implementation-spec.md already require team/project/channel scope and final authorization; keep those checks ahead of result limits. |
| 9 | Adapt | Make the final canonical fetch and actor/ACL recheck executable and observable for every knowledge source, including an external Buzz result. A search index may provide IDs and scores but not permission. | crates/buzz-relay/src/handlers/req.rs; crates/buzz-search/src/query.rs; crates/buzz-db/src/event.rs; cb2a265b5399426e808461c1a16713754c593258 | The OpenTag spec says “final authorization check” in docs/knowledge-base-implementation-spec.md, while current edge/src/mcp/knowledge-mcp.ts uses an ADMIN_SECRET bearer seam. Reconcile the implementation with the actor-bound KnowledgeActorTokenV1 design before broadening production MCP access. |
| 10 | Adapt | Add hash-linked or equivalent tamper-evident evidence records only where OpenTag needs auditability, and document the trust model. Do not claim a keyless chain resists a database administrator. | crates/buzz-audit/src/hash.rs and crates/buzz-audit/src/service.rs; SECURITY.md; migrations/0001_initial_schema.sql; 264a56a2260ac87350bfe1f5d3ec3d89615eb47c | edge/src/memory/knowledge-ledger.ts already records durable lifecycle, approval, retry, tombstone, and backfill state, and edge/test/knowledge-ledger.test.ts plus edge/test/knowledge-ledger.workers.test.ts exercise it. The justified improvement is an auditable evidence/event digest and trust statement, not a duplicate Buzz audit subsystem. |
| 11 | Adapt | Keep private agent memory separate from searchable company knowledge. If OpenTag adds a portable agent-memory channel, borrow NIP-AE’s encrypted owner/agent envelope and tombstone semantics without indexing ciphertext as ordinary knowledge. | crates/buzz-core/src/engram.rs; docs/nips/NIP-AE.md; crates/buzz-acp/src/engram_fetch.rs; crates/buzz-cli/src/commands/mem.rs; b1b283cd4c7f926e12eeee8ae1f38c7471922b16 | OpenTag’s edge/src/memory/knowledge-ledger.ts and docs/knowledge-base-implementation-spec.md are designed for ACL-governed, citable workspace knowledge. They are not an encrypted agent-private memory protocol; preserve the distinction. |
| 12 | Covered | Bounded per-channel agent turns, durable admission, cancellation, render obligations, and recovery are already stronger in the OpenTag control path than a direct ACP copy would provide. Use Buzz’s one-prompt-per-channel rule as a compatibility test, not a new subsystem. | crates/buzz-acp/src/queue.rs, pool.rs, pool_lifecycle.rs; crates/buzz-acp/tests/pool_lifecycle_state.rs; 95fdf978800982389b120c66ff5e766d785419c7 | edge/src/store/active-turn-engine.ts, edge/src/agent-turn.ts, edge/src/store/session-event-do.ts, edge/test/render-obligation.test.ts, and edge/test/deferred-admission-concurrency.test.ts already model durable single-thread turn ownership and loss recovery. |
| 13 | Covered | Keep ACP, model loop, and developer MCP as separate capability boundaries with bounded tools, cancellation, result sizes, and secret filtering. | crates/buzz-agent/src/agent.rs and mcp.rs; crates/buzz-dev-mcp/src/paths.rs, shell.rs, read_file.rs, str_replace.rs; 95fdf978800982389b120c66ff5e766d785419c7; b0503d80c298b1ece3b0a43b41d316829a3379e7 | OpenTag edge/src/harness, edge/src/harness-client.ts, edge/src/tool-execution-fence.ts, edge/src/permissions/snapshot.ts, and related tests already enforce sentinel-only credentials, denied-by-default network, and tool snapshots. Avoid coupling Buzz connector auth to sandbox tool authority. |
| 14 | Adapt | For any future OpenTag scheduled or event-triggered workflow, use a durable deterministic claim key, lease/retry state, and current-authority recheck. Treat in-memory scheduler state as a cache only. | crates/buzz-workflow/src/lib.rs, schema.rs, executor.rs; crates/buzz-db/src/workflow.rs; migrations/0001_initial_schema.sql; 1d4f97b959a0d91f7bac0e1f97189e5c10347712 | edge/src/memory/knowledge-reconcile.ts, knowledge-jobs.ts, worker/research-alarm.ts, and edge/test/knowledge-reconcile.test.ts already use durable claims and cursors. The improvement is to apply the same exact claim/authority rule to any new direct-push or connector automation. |
| 15 | Defer | Do not adopt Buzz’s workflow approval design as a completed reference. Buzz’s schema and UI exist, but executor persistence/resume is not complete. OpenTag should continue using its own durable HITL contract until a full external proof exists. | crates/buzz-workflow/src/executor.rs; ARCHITECTURE.md; NOSTR.md; current parent tree 40d1bebf5fefeeb57463973af9cd8a64026abc0c | edge/src/hitl/durable-choice.ts, edge/src/hitl/remote-git-approval.ts, edge/src/store/active-turn-engine.ts, and edge/test/hitl-durability.test.ts are the stronger local reference. |
| 16 | Adapt | Add an explicit deployment-root provisioning contract for any hosted OpenTag workspace/connector: allowlisted operator identity, normalized authority, idempotency, owner bootstrap, and observable partial-failure recovery. | crates/buzz-relay/src/handlers/community_provisioning.rs; crates/buzz-relay/src/api/operator.rs; migrations/0001_initial_schema.sql; 19d57b0d46baa55814ac737041a36d0b405c9f64 | OpenTag VISION-SPEC.md identifies provisioning, platform tenancy, and key custody as Layer 3 work. The current Buzz connector map/secret seam is not a hosted provisioning system; this is a design backlog item, not a claim of existing parity. |
| 17 | Adapt | Make moderation, ban, revoke, and source disable paths durable and fail closed, with audit-only evidence of the principal that matched an owner/agent authorization. | crates/buzz-relay/src/handlers/relay_admin.rs, moderation_authz.rs, identity_archive.rs; migrations/0006_moderation.sql; e2e007910114ddf7c5a4e93bb03f6afe13552e92 | OpenTag has admin permissions and knowledge-source disable/tombstone paths in edge/src/permissions, edge/src/config/knowledge-source-authorization.ts, edge/src/memory/knowledge-ledger.ts, and related tests. The improvement is cross-surface revocation/reconciliation evidence, not a Buzz-specific ban protocol. |
| 18 | Defer | Defer Blossom/media parity. Buzz’s content-addressed, magic-byte-validated, sidecar-gated media system is valuable but outside the current Slack/knowledge/Buzz connector MVP. | crates/buzz-media/src/auth.rs, crates/buzz-media/src/upload.rs, crates/buzz-media/src/validation.rs, crates/buzz-media/src/storage.rs, crates/buzz-media/src/thumbnail.rs; crates/buzz-media/tests/static_creds_minio.rs; crates/buzz-test-client/tests/e2e_media.rs, e2e_media_extended.rs, and e2e_media_video.rs; 788b3c002bd2509455444f57f8a03a054b4b496a | OpenTag has Slack/R2 attachment and file-repair paths, but no evidence in the current platform scope requires a second Blossom storage protocol. Revisit only with a product decision and a storage threat model. |
| 19 | Defer | Defer Buzz’s git forge, NIP-34/NIP-MP, branch-channel, and repository policy model as a separate product track. Borrow exact approval/audit concepts only for existing OpenTag remote-git operations. | crates/buzz-relay/src/api/git/transport.rs, crates/buzz-relay/src/api/git/policy.rs, and crates/buzz-relay/src/api/git/binding.rs; VISION_PROJECTS.md; crates/buzz-test-client/tests/e2e_git.rs and crates/buzz-test-client/tests/e2e_project.rs; 788b3c002bd2509455444f57f8a03a054b4b496a; cb9701cd30fb344bf134585634a09007f3155bfb | OpenTag’s edge/src/hitl/remote-git-approval.ts, edge/test/remote-git-approval.test.ts, and edge/src/permissions/snapshot.ts already cover a narrower remote-git boundary. Do not expand scope from commit titles or forge vision. |
| 20 | Defer | Defer remote-agent deployment as a recommendation. Buzz’s VISION_REMOTE_AGENTS.md is a thoughtful provider contract, but it is explicitly a design with trusted-provider, Kubernetes Secret, self-reaper, and emergency-control limits rather than a proven hosted implementation. | VISION_REMOTE_AGENTS.md; crates/buzz-acp and remote deployment docs; 19d57b0d46baa55814ac737041a36d0b405c9f64 | OpenTag’s harness and worker/container routing are currently scoped to Cloudflare and controlled remote-git/research tasks. A remote-agent plan needs a separate custody, liveness, kill, and substrate conformance review. |
| 21 | Adapt | Adapt Buzz’s operational evidence: readiness/liveness separation, replica fences, trace IDs, bounded restart behavior, immutable release identities, and explicit health ownership. Do not copy its Postgres/Redis/Helm topology into Cloudflare. | crates/buzz-relay/src/router.rs and crates/buzz-relay/src/state.rs; migrations/0026_replica_heartbeat.sql; .github/workflows/ci.yml, .github/workflows/docker.yml, and .github/workflows/release.yml; 63496cc1d4c6f1b7c613801bdcc694169dcf391a; 005b5b819a98ce85d4d80cd81b258fb6f9b8d51e | OpenTag has worker/research-alarm.ts, DO state stores, health/readiness docs, and durable recovery tests. Use the operational principles to close production gates, not to add Buzz’s infrastructure dependencies. |
| 22 | Not Applicable | Do not treat Buzz desktop, mobile, web, huddle UI, or multi-client parity as an OpenTag improvement for this task. They are real Buzz capabilities but not part of OpenTag’s current Slack-native product boundary. | desktop/, mobile/, web/, crates/buzz-relay/src/audio/, desktop E2E and mobile test trees; VISION.md; 85edc0572a8540dedfa6562d40f0f875af0b5f61 | OpenTag’s current product and harness surfaces are Slack, web/admin, knowledge MCP, Workers, DOs, and sandbox/container adapters. A second user client requires a separate product decision. |
| 23 | Not Applicable | Do not adopt Buzz Mesh or huddle transport as parity work. These are optional Buzz compute/voice surfaces with their own capacity, trust, and media concerns. | crates/buzz-relay/src/audio/, audio/mesh.rs, mesh_boot.rs, mesh examples; VISION_MESH.md; 4933672eb4589e7208b312829ebddcd10dfa9dd3 | No OpenTag platform, agent, harness, knowledge, or Buzz connector requirement calls for relay voice or pooled GPU transport. |
| 24 | Adopt | Adopt the conformance posture: fixtures for foreign-row leaks, host/channel mismatch, replay, coverage gaps, and property-based checks, plus E2E tests for each cross-surface admission path. | crates/buzz-conformance/tests/fixtures/bad_coverage_breach.jsonl, crates/buzz-conformance/tests/fixtures/bad_foreign_row_leak.jsonl, crates/buzz-conformance/tests/fixtures/bad_host_channel_mismatch.jsonl, crates/buzz-conformance/tests/proptest_checker.rs, and crates/buzz-conformance/tests/replay_fixtures.rs; crates/buzz-test-client/tests/conformance_multitenant.rs, crates/buzz-test-client/tests/nip42_host_binding_live.rs, crates/buzz-test-client/tests/e2e_nostr_interop.rs, and crates/buzz-test-client/tests/e2e_managed_agent.rs; AGENTS.md | OpenTag already has edge/test/buzz-contract.test.ts, buzz-receive.test.ts, buzz-wake.test.ts, buzz-nip98-fetcher.test.ts, knowledge authorization/ledger tests, and harness tests. The next improvement is a durable cross-product fixture matrix, not another unverified implementation. |
| 25 | Adopt | Adopt Buzz’s explicit security budget: deny unsafe, dependency audit, body/result limits, DNS/IPv6 SSRF checks, redirect and proxy controls, cancellation, and secret-shaped error redaction. | SECURITY.md; crates/buzz-core/src/network.rs; crates/buzz-workflow/src/executor.rs; crates/buzz-agent/src/agent.rs; c26bf5945d8f2ef19746a78e80a7c1dae2ef3db9; 31e2de1966672e73e026af3c54f3a1a9a2f5e103 | OpenTag already has edge/src/buzz/signer-secret.ts redaction, edge/src/permissions/snapshot.ts, edge/src/tool-execution-fence.ts, and harness tests. Keep each bound in a test and preserve opaque failure codes. |
| 26 | Adapt | Replace or constrain the current admin-secret-only knowledge MCP path with the actor-bound token and final authorization contract before exposing it to ordinary users or external connectors. | Buzz’s NIP-42/NIP-98 and channel access in crates/buzz-auth/src/nip42.rs, crates/buzz-auth/src/nip98.rs, and crates/buzz-auth/src/access.rs; crates/buzz-relay/src/handlers/req.rs; NOSTR.md | OpenTag docs/knowledge-base-implementation-spec.md specifies KnowledgeActorTokenV1 and mandatory team_id/project/source ACL checks, but edge/src/mcp/knowledge-mcp.ts currently authorizes with ADMIN_SECRET. Treat that as an implementation/spec reconciliation gap. |
| 27 | Defer | Defer the key-custody claim until OpenTag chooses and implements a hosted custody design. Correct the comparison language: Buzz is a reference for portable identity and explicit custody boundaries, not evidence that a server can safely hide every raw key today. | Buzz SECURITY.md; crates/buzz-acp/README.md; VISION_REMOTE_AGENTS.md; VISION.md; 468647a51f858b29d27eaf9fd07bf90294f99d39 | OpenTag VISION-SPEC.md currently calls Buzz the pattern reference and says hosted key custody is unresolved. Keep that decision gate; do not infer “server-side custody” from the existence of NIP-OA or a relay. |

## Parent-only and fork-only behavior

Parent-only behavior relative to the initial fork checkout is substantial and is now present in the published merge: tenant and replica fencing, read-replica membership checks, durable moderation and identity lifecycle, search and shared-tag privacy gates, ACP/BYOH/runtime policy, NIP-49 backups, media and git hardening, mobile/desktop changes, release contracts, and the latest NIP-29 documentation. The source paths and parent SHAs above are the evidence.

Fork-only behavior is limited to 2a0367ee95dfdf35ab7f235970c703d7f7f07c5a changing AGENTS.md with Cursor Cloud startup, Docker cgroup, local test, and system-package caveats. It has no OpenTag architecture recommendation beyond preserving the documentation during sync. It is Not Applicable as product behavior and must not be counted as a fork runtime divergence.

## OpenTag implementation handoff

This report intentionally does not implement the five Adopt or eleven Adapt recommendations. A dependent synthesis task can turn them into scoped work, in this order:

1. Make tenant/channel identity types and server-side scope binding explicit across the Buzz connector and knowledge MCP.
2. Add the cross-surface conformance matrix for wake, canonical fetch, event admission, search result authorization, reply publish, knowledge ingestion, and operator actions.
3. Reconcile actor-bound knowledge authorization with the current admin-secret implementation and record final authorization evidence.
4. Extend the existing durable ledger/effect-fence contracts rather than adding a parallel event store.
5. Decide hosted key custody and remote-agent substrate trust before claiming platform parity.

No branch, PR, deployment, Notion mutation, or OpenTag source edit was authorized or performed in this isolated report.


## Current-state addendum — 2026-08-01

Current reconciliation: OpenTag has deployed server-owned tenancy and Buzz wake configuration. An empty live request reaches schema validation with `buzz_wake_unexpected_fields`; no authenticated relay/signature proof is claimed.

The original evidence, classifications, and validation limits above are intentionally preserved. The canonical feature/gap ledger is [CURRENT-STATE-RECONCILIATION.md](../CURRENT-STATE-RECONCILIATION.md).
