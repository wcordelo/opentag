> **Historical snapshot.** This artifact was authored before the final merged OpenTag rollout. Read [the current reconciliation](../CURRENT-STATE-RECONCILIATION.md) and [the current OpenTag status](../../../docs/current-state.md) before treating any implementation or deployment statement as current.
>
> Current reconciliation: the native typed Responses adapter is now source-complete and Slack-live for a one-turn canary. Durable checkpoint/replay code is tested; live reconnect and branching remain open/deferred.

# Nanocodex parent-to-fork backfill and architecture deep dive

Status: complete for the assigned read-only Nanocodex/OpenTag comparison. No source, Git, Notion, deployment, branch, PR, or automation mutation was performed.

## Scope and evidence basis

I inspected the Nanocodex fork checkout at `/Users/will/Documents/nanocodex`, and the published parent-inclusive fork tip in a detached temporary worktree at `/tmp/nanocodex-parent.1KhyRr` pinned to `e9ca9258cc00413bd0580e97979a9488fba9a67b`. The source claims below are based on the parent-tip tree and its tests, with each history claim tied to a commit SHA. I read:

- `/Users/will/Documents/nanocodex/AGENTS.md`, `PLAN.md`, `README.md`, `REFACTOR.md`, and `CHANGELOG.md`;
- every stable and experimental crate README under `crates/`, including `nanocodex-agent`, `nanocodex-oai-api`, `nanocodex-tools`, `nanocodex-observability`, `nanocodex-egress`, and `nanocodex-vm`;
- `/Users/will/Documents/nanocodex/scripts/check-crate-boundaries.sh`;
- public source in `crates/nanocodex-agent`, `crates/nanocodex-oai-api`, `crates/nanocodex-tools`, `crates/nanocodex-observability`, and the experimental VM/egress crates;
- agent, Responses, tool/MCP, shell/process, auth, rollout, observability, VM, and egress tests;
- consumer examples in `/Users/will/Documents/nanocodex/examples/`, including `minimal.rs`, `lifecycle.rs`, `follow_on.rs`, `resume.rs`, `fork_conversations.rs`, `custom_tool.rs`, `mcp.rs`, `subagents.rs`, `secret_egress.rs`, `vm_tools.rs`, `browser_agent.rs`, and `voice.rs`;
- the OpenTag architecture and product contracts plus current harness, agent, Durable Object, sandbox, MCP, and focused test paths in `/Users/will/Documents/opentag`.

The local Codex checkout required by Nanocodex’s `/Users/will/Documents/nanocodex/AGENTS.md` was checked at `/Users/will/github/openai/codex/codex-rs` and was unavailable; no matching checkout was found under `/Users/will`. Therefore this report does not claim that current Codex behavior matches Nanocodex. It records Nanocodex’s own source and documentation evidence only. Nanocodex documents its reviewed Codex checkpoint as `openai/codex@35eaf3ffb0bf2001486c68c47a3d946b34d16634`.

## Repository identity, ancestry, and sync outcome

| Item | Verified value |
| --- | --- |
| Parent URL | `https://github.com/gakonst/nanocodex.git` |
| Parent default branch | `master` |
| Parent reviewed tip | `47fd09cb31108f171561edd48ba8e30257f27f40` |
| Fork URL | `https://github.com/wcordelo/nanocodex` |
| Fork default branch | `master` |
| Initial fork checkpoint | `1970c4b15c9eb4913cf66a6eba04992e1a595b32` |
| Verified common ancestor | `3d4548b0c30f2ffbda686b16d7221ffd4faacbca` |
| Fork remote published merge | `e9ca9258cc00413bd0580e97979a9488fba9a67b` |
| Fork remote parent | `1970c4b15c9eb4913cf66a6eba04992e1a595b32` |
| Merge’s parent-side parent | `47fd09cb31108f171561edd48ba8e30257f27f40` |
| Parent delta reviewed | `3d4548b0c30f2ffbda686b16d7221ffd4faacbca..47fd09cb31108f171561edd48ba8e30257f27f40`, 53 commits |
| Fork-only delta reviewed | `3d4548b0c30f2ffbda686b16d7221ffd4faacbca..1970c4b15c9eb4913cf66a6eba04992e1a595b32`, 3 commits |
| Symmetric comparison | `git rev-list --left-right --count 47fd09cb...1970c4b1` returned `53 3` |
| Shallow status | `false`; the repository is not shallow |

The ancestry was verified with `git merge-base`, not inferred from names or commit titles. The fork remote is already synchronized through a real two-parent merge: `e9ca9258…` has first parent `1970c4b1…` and second parent `47fd09cb…`, with subject `Merge commit '47fd09cb31108f171561edd48ba8e30257f27f40' into HEAD`. The primary fork checkout was intentionally not advanced: its local `master` and `HEAD` remain at the common ancestor `3d4548b0…`. This preserves the requested read-only boundary while retaining the fork-only commits in the remote history.

The fork checkout was clean at inspection and remained clean. The OpenTag checkout had existing untracked work, including `HANDOFF.md`, `ROUTER-SPEC.md`, `VISION-SPEC.md`, several docs, and the goal-output directory. None was edited, staged, stashed, deleted, or overwritten. The detached worktree was used only for inspection and isolated Rust build output was placed under `/tmp/nanocodex-target`.

## Nanocodex architecture findings

### 1. Public library contract versus consumers

The durable architectural boundary is the stable library graph, not the CLI or examples. `/Users/will/Documents/nanocodex/AGENTS.md:5-18` and `PLAN.md:5-15` define a headless, library-first Rust SDK: a consumer builds `(Nanocodex, AgentEvents)`, sends prompts through a cheap handle, and awaits typed `TurnResult` values. Follow-on prompts reuse retained history; callers do not pass prior messages, provider response IDs, or tool results back manually. The CLI under `bin/nanocodex`, Harbor adapter, language bindings, examples, browser/WASM hosts, and Rivet Actor sample are consumers and evaluation boundaries.

The crate ownership is explicit in `/Users/will/Documents/nanocodex/AGENTS.md:50-81` and the crate READMEs:

- `crates/nanocodex-oai-api` owns typed prompts/events/wire types, client-owned context, Responses transports, retry, telemetry, auth, and generic Tower service seams;
- `crates/nanocodex-tools` owns the caller-defined tool contract, registry, Code Mode, standard workspace tools, dynamic providers, and MCP;
- `crates/nanocodex-agent` owns the private driver, lifecycle, branching, snapshots, rollouts, and builders;
- `crates/nanocodex` is a thin facade/reexport crate with no runtime implementation;
- `crates/experimental/` contains unpublished VM, egress, browser, and voice infrastructure; stable crates cannot depend on it;
- `bin/` owns CLI, payment, Tempo, NanoUSD, and application policy.

`/Users/will/Documents/nanocodex/scripts/check-crate-boundaries.sh` is executable architecture policy rather than advisory documentation. It snapshots the public package set and dependency graph, rejects payment-package dependencies from public crates, and passed unchanged at the parent tip.

### 2. Library-first lifecycle and ownership

`crates/nanocodex-agent/src/agent/handle.rs` makes `Nanocodex` a cheap command capability around a private `mpsc` driver. `prompt()` validates and enqueues a prompt, then returns a `Turn` after acceptance; it does not wait for model completion. `crates/nanocodex-agent/src/agent/turn.rs` makes `Turn` both a per-turn event stream and a future for `TurnResult`. Dropping a `Turn` does not cancel accepted work; cancellation is explicit through `TurnControl`. The driver owns mutable conversation, model, tool runtime, process, and Tower state until all handles are gone, and `shutdown()` waits for model/tool cleanup and rollout flush.

`Nanocodex::spawn()` creates a clean sibling with a new session, conversation, driver, service, WebSocket, and tool runtime. `fork()` and `fork_from()` create independent agents from a committed model boundary. `crates/nanocodex-agent/src/agent/builder.rs` keeps model, thinking, fast mode, instructions, workspace, cache lineage, resume, rollout, service factory, and per-driver tool construction as builder policy. `tools_factory` receives a weak handle for the driver that owns that tool runtime, so child-agent tools do not retain or target their parent accidentally.

This is a strong reusable lifecycle contract, but it is not an app server, scheduler, or durable execution log. Nanocodex deliberately keeps queueing, socket tasks, replay bookkeeping, and mutable run state private. Its durable boundaries are completed typed snapshots and optional Codex-compatible rollouts, selected by the embedding application.

### 3. Typed Responses transport and result contracts

`crates/nanocodex-oai-api/src/session/response.rs` exposes typed `ResponseInput`, `Response`, `CompletedResponse`, `ResponseItem`, function/custom tool calls, usage, cost status, and `end_turn`. `Response` is simultaneously a typed event stream and an awaitable aggregate. `ResponseInput::items()` is the low-level contract for callers that execute tool calls themselves; the returned tool output must retain the exact model call ID.

`crates/nanocodex-oai-api/src/session/state.rs` stores authoritative typed history in `ManagedSessionState`. A healthy request sends only the delta plus a private provider continuation ID. `reset_for_full_request()` drops that provider checkpoint and replays all client-owned typed history. `commit()` requires a completed response ID; `commit_interrupted()` forces full replay for an interrupted but retained client state; compaction replaces state atomically. The provider response ID is deliberately not an application session identity.

The critical transaction is in `run_create_inner()` at `crates/nanocodex-oai-api/src/session/response.rs:517-613`: it clones candidate state, appends/repairs input in the candidate, creates one replayable attempt, waits for the complete service response, then appends output and commits the candidate. A failed or partial service result therefore cannot mutate authoritative history, execute a tool, or be mistaken for a successful result. `Response` emits a terminal `Completed` event if the service result completed without one, and it propagates typed errors.

### 4. Replay, retry, reconnect, and compaction

`crates/nanocodex-oai-api/src/tower/attempt.rs` represents one logical operation as a replayable `ResponsesAttempt` containing full history, incremental history, delta start, the private continuation ID, model/policy, connection generation, logical turn, and attempt number. Large retained histories use shared/copy-on-write representation in `crates/nanocodex-oai-api/src/responses/request.rs`.

`crates/nanocodex-oai-api/src/tower/middleware/retry.rs` is the single SDK retry owner. It defaults to five total attempts, distinguishes typed failure phases and retry advice, retries missing provider checkpoints with immediate full history, emits `ModelAttemptRetrying`, applies bounded jitter/backoff, and can fall back from Responses WebSocket to HTTPS with a full replay. Caller Tower layers may add deadline, concurrency, tracing, metrics, circuit-breaking, or error mapping, but not a second retry loop. The repository’s integration tests explicitly cover checkpoint-miss replay, WebSocket reconnect, HTTPS fallback, retry scoping, and no duplicate completed tools.

At the agent layer, failed accepted prompts persist a safe boundary and the next turn replays the latest safe history. The tests under `crates/nanocodex-agent/tests/it/model/recovery/`, `model/persistence.rs`, `model/transport/session.rs`, and `model/transport/websocket.rs` make this behavior executable rather than merely documented.

### 5. Events, terminal results, and observability

`crates/nanocodex-oai-api/src/events/data.rs` defines a typed firehose containing raw provider frames, assistant deltas/messages, visible reasoning summaries, run lifecycle, model calls, context compaction, transport diagnostics, and tool calls/results. Tool events retain stable provider call IDs, raw arguments, status, duration, result, and metadata. Run terminals include status, model, transport, orchestration, durations, retries, connection measurements, token usage, and cost.

JSONL is only a process adapter. The public library event stream is typed and independent from `TurnResult`; tracing is diagnostic and must not replace contractual events. The observability README and `crates/nanocodex-observability/src/lib.rs` describe application-owned local/OTLP subscribers, explicit flush/shutdown, structural span attributes, and full-fidelity content. Nanocodex intentionally does not redact trace content based on its values, so prompts, reasoning, tool arguments, and tool results are sensitive stores requiring application access controls and retention.

### 6. Tools, Code Mode, MCP, and process cleanup

`crates/nanocodex-tools/src/runtime/registry.rs` keeps ordered tool definitions, direct handlers, and dynamic providers in one registry. `runtime/execution.rs` gives one agent driver a stateful `ToolRuntime` that retains Code Mode cells, shell sessions, current turn, working directory, and tool selection. Parallel execution is opt-in per tool definition; handler panics are converted into model-visible failures; nested Code Mode calls use the same registry contracts.

MCP is a native provider rather than a feature flag. `crates/nanocodex-tools/src/mcp/mod.rs` and `mcp/client.rs` support stdio and Streamable HTTP, background handshake/discovery, bearer or caller-owned OAuth persistence, same-origin redirect limits, reload, and provider-native deferred `tool_search`. Search initially exposes only a search definition; matching MCP namespaces and Code Mode metadata are activated when needed. The MCP unit tests cover shared background clients, reload, descendant cleanup, bounded concurrent startup, and tool-search dispatch.

`crates/nanocodex-tools/src/shell/process.rs` and `shell/mod.rs` sanitize inherited environments, collect sensitive values for output redaction, bound output, use `kill_on_drop`, and terminate process groups and descendants on timeout, cancellation, output overflow, or shutdown. These are tool-runtime guarantees, not agent-driver policy.

### 7. Credentials

`crates/nanocodex-oai-api/src/auth/mod.rs` separates static Platform API-key auth from managed native ChatGPT subscription auth. `auth/chatgpt.rs` reads Codex-compatible `auth.json`, reloads same-account rotations before refresh, serializes refreshes per handle, atomically replaces owner-only credential files while preserving unknown fields, redacts bearer tokens from `Debug`, and recovers one unauthorized request after refresh. The README explicitly says the credential file must remain outside source control.

This is a native desktop/library consumer boundary. It is not evidence that a Cloudflare coding container should receive ChatGPT OAuth credentials.

### 8. Sandbox, VM, and egress boundaries

`crates/experimental/nanocodex-vm` is unpublished and explicitly does not own agent scheduling, evaluation policy, payment providers, or secrets. An application retains one `VmWorkspace`, gives clone-cheap `VmTools` capabilities to agents, and keeps the guest alive across turns. The host/VMM/guest topology and private launch record are documented in `crates/experimental/nanocodex-vm/README.md`; the guest protocol bounds frames, requests, output, process groups, and cancellation. Only canonical workspace tools are projected into the guest; web/image/update-plan remain host-owned.

`crates/experimental/nanocodex-egress` is likewise unpublished. Its `SecretResolver` resolves host-side secrets only after exact-origin/method/path policy accepts a request. Children receive public URLs, placeholders, proxy variables, and a public CA, not resolved secret values. The default is deny; remote upstreams require HTTPS; metadata and loopback destinations are guarded; redirects, CONNECT, headers, body size, concurrency, and replayable requests are bounded. Payment and provider-specific policy remain in `bin/`.

### 9. Examples and experimental consumers

`examples/README.md` is explicit that examples are language and deployment consumers. `minimal.rs` proves the accepted-prompt then typed-result path; `follow_on.rs` proves retained follow-up history; `lifecycle.rs` proves steering, cancellation, event observation, and historical/latest forks; `resume.rs` proves caller-owned serialized snapshots; `fork_conversations.rs` proves concurrent branches from exact checkpoints; `custom_tool.rs` and `mcp.rs` prove tool/provider composition; `subagents.rs` proves generic model-selected spawn/fork tools without a host worker graph; and `secret_egress.rs` proves host/VM child egress separation.

`voice.rs`, `browser_agent.rs`, `react-vite/`, `browser-cdn/`, and `rivet-actors/` are not stable core contracts. The experimental README and each crate README label their APIs as unpublished and subject to revision.

## OpenTag comparison and classification

OpenTag is not missing the Nanocodex lifecycle wholesale. It has a different ownership split: Cloudflare Durable Objects own durable admission, event replay, cancellation, render/effect fences, and recovery, while AG-UI and coding runtimes perform model work. The relevant current sources are `/Users/will/Documents/opentag/PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `edge/src/slack/turn-lifecycle.ts`, `edge/src/store/session-event-do.ts`, `edge/src/agent-turn.ts`, `edge/src/harness/client.ts`, `edge/workers/sandbox/src/router.ts`, `edge/workers/sandbox/src/container.ts`, and `lib/triage-agent.ts`.

| Nanocodex finding | OpenTag evidence | Classification and disposition |
| --- | --- | --- |
| Private driver owns mutable lifecycle, while the public consumer receives a cheap handle, independent events, and a typed terminal result. | `PRODUCT.md:51-70` and `ARCHITECTURE.md:72-85` split ingress, lifecycle, Durable Objects, AG-UI, and harness ownership. `edge/src/agent-turn.ts:182-207` exposes an adapter-level `runAgent` contract, while the coding path is selected separately. | **Adapt.** Preserve private runtime ownership if OpenTag adds a library-native adapter, but do not replace DO durability with an in-memory driver or add a generic app server. |
| Typed Responses input/output and completed-only state commit. | `edge/src/harness/client.ts:7-24,400-407` has a typed TypeScript harness envelope and terminal `done`, but the provider-native Responses item history stays inside the Nanocodex CLI/container. `agent-turn.ts:1186-1257` re-feeds a bounded transcript. | **Adapt.** Keep OpenTag’s public harness wire contract and SessionEventDO authority; only introduce a typed Responses adapter if it has an explicit owner and tests for call-ID pairing, completed-only commit, and restart replay. |
| Events are optional observation; typed result/checkpoint is the completion authority. | `SessionEventDO` stores append-only `input/output/error/done/context/progress` rows. `harness/client.ts:518-585` mirrors each line in order, and `:703-725` synthesizes a terminal failure when `done` is missing. | **Covered.** OpenTag already has the system-level equivalent, including a durable terminal event and a separate final Slack answer. No direct port is justified. |
| Client-owned typed history is authoritative; private provider continuation IDs are an optimization; retries/reconnects replay safely. | `edge/src/agent-turn.ts:362-383,496-510` embeds Slack history or passes a max-24,000-character harness transcript. `SessionEventDO` is authoritative for execution/event recovery, but OpenTag does not expose provider-native typed history or continuation IDs. | **Adapt.** If a native Responses integration grows beyond the CLI consumer, add the provider history/replay contract beneath the current durable execution layer. Do not add a second retry owner to `runSlackTurnLifecycle()`. |
| Exact historical conversation branching with fresh services, tools, event streams, and session IDs. | OpenTag’s repository branch/PR workflow is an approved coding side effect, not a conversation branch API; `PRODUCT.md:47-49` defers a multi-agent product. | **Defer.** There is no current user-facing requirement for `fork_from`-style conversation branches. |
| Per-driver tool runtime, explicit parallel safety, dynamic MCP catalog, deferred search, reload, and caller-owned OAuth. | `lib/triage-agent.ts:14-28,202-236,309-405,446-475` creates MCP clients per turn and filters exact read-only tool names. OpenTag intentionally keeps writes behind explicit tools/approvals. | **Adapt.** The allowlist and read-only policy are already covered. Consider Nanocodex-style deferred discovery only for a separately scoped MCP product; do not import native MCP OAuth or arbitrary dynamic tools into Slack by analogy. |
| API-key and ChatGPT `auth.json` credentials with same-account refresh. | `DECISIONS.md:35-49` and `PRODUCT.md:90-106` require the coding harness to use sentinel credentials, Worker-injected real credentials, and no ChatGPT subscription OAuth in the container. `container.ts:53-73,113-151` enforces this for OpenAI. | **Covered.** Nanocodex’s managed auth is a native consumer feature and is not an OpenTag adoption candidate. |
| Full-fidelity diagnostic tracing, including prompt/tool content, with application-owned retention. | OpenTag sanitizes/redacts harness events before durable append (`harness/client.ts:532-574`), protects permission snapshots, and uses requester/evidence fields rather than raw secrets. | **Adapt.** Adopt structural run/model/tool metrics only if needed; do not adopt Nanocodex’s unredacted trace-content policy in OpenTag’s durable or exported surfaces. |
| Host-owned secret egress, process-group cleanup, bounded child execution, and retained VM workspace. | `PRODUCT.md:90-106`, `ARCHITECTURE.md:296-300`, `container.ts`, `edge/workers/sandbox/src/router.ts`, and `edge/test/harness-egress-policy.test.ts` cover sentinel credentials, exact host/endpoint policy, approvals, process groups, interrupt, quiescence, and mechanical coding postconditions. | **Covered.** OpenTag has a Cloudflare-native equivalent with stronger product-specific approval and redaction constraints. Do not port the unpublished libkrun crate. |
| Examples make acceptance/result, resume, forks, tools, MCP, and egress contracts executable. | OpenTag has focused lifecycle/harness tests rather than a Rust consumer-example package; current tests cover admission, replay, missing `done`, interruption, policy snapshots, model precedence, and no fallback. | **Adapt.** Keep examples/tests as evidence-bearing contract fixtures if a native adapter is changed; no implementation was authorized in this report-only task. |
| Retained libkrun VM is a reusable isolation boundary. | OpenTag’s deployed isolation boundary is Cloudflare Container plus Worker-controlled egress and credentials. | **Defer.** Revisit only for a local/native runtime requirement that cannot be served by the existing harness Container. |

The 11 architecture findings classify as: Adopt 0, Adapt 6, Covered 3, Defer 2, Not Applicable 0. Adopt is zero deliberately: every apparently portable behavior is either already present in OpenTag’s durable system layer, requires a provider-specific adaptation, or belongs to a deferred/native/experimental surface. No OpenTag improvement, branch, or PR was created under the task’s explicit no-mutation constraint.

## Complete history classification ledger

Every commit reachable in the two stated deltas is listed below. SHAs are full-length. Merge commits are retained in the ledger so the review is graph-complete rather than a first-parent title scan.

### Parent delta: 53 commits

| Classification | Commits and material evidence |
| --- | --- |
| **Adapt** | `da6d555ea95d3cc82037aca1f4dcb41343c18dbc` (`feat: support Luna`) changed `crates/nanocodex-agent/src/agent/builder.rs`, driver/rollout/session paths, Responses config, tests, and consumers; `3062e15ce8b4d789286d8e7954714fb6854bf8e3` (`refactor: fix the model for each thread`) made model identity thread-specific across `agent`, session, bindings, and tests; `745f5c5f423cd83f89aedfadd728bb4cf91d17f1` (`fix: preserve Codex rollout model compatibility`) changed `crates/nanocodex-agent/src/rollout/{load,store,wire}.rs` and persistence tests; `37b6e7dc27c7761af12a4a989c4ccfdaaeda3b0b` (`fix: build Tower services from effective agent config`) changed `crates/nanocodex-agent/src/agent/{builder,driver,spawn}.rs` and executor factories; `fe4a2f0431637599feb3973e359639376c981428` (merge PR #80); `0771a502e82087b8ff732c557268bd13b90e314e` (`fix(agent): preserve model in adapter checkpoints`); `d49713c82e8dda02efa1adae1fb1efb376d7ebf5` (`fix(agent): retain model in fork checkpoints`); `a7fff7603f365b1b1c0ce460cec68063c3992ad4` (merge PR #84); `07616220f01baa5908737cc30d9840ced21f59c7` (merge PR #83). These establish a useful model/checkpoint invariant, but OpenTag’s TypeScript runtime and DO-backed session state need an adaptation rather than a Rust driver port. |
| **Defer** | `66c9f38413dd701dca9e6753fe7b9a9671a57f2c` (`feat: expose reusable WASM host transport`) changed `js/bindings/browser/*`, host bindings, and browser-host tests; `3f522fc72969d8907bb1bb6834b10d51f5840733` (`fix(wasm): harden host socket upgrades`); `e52dc627117010d988b387e3d37e608bc704a0ec` (`feat(wasm): support CSP-safe direct host tools`); `8516800b78a804796031dc73fa88c1f000804709` (`fix(agent): dispatch unnamespaced hosted tools`); `2d3a57821f94e168a79f5cb7538f39916a41ce66` (merge PR #75, `crates/nanocodex-tools/src/hosted/*` and JS bindings). These are useful evidence for a future browser host seam, not a current OpenTag Cloudflare harness requirement. |
| **Not Applicable** | `efd203414e723ab6de0bb72472dbb9509a8fcce6` (`feat(voice): add Codex realtime parity`) added experimental realtime/voice; `72e7b565951b586c496915549ab17e8e22cd9ade` (merge PR #82); `14a9801161e72e69f5fd8da5acbe426f4cd4a9e1` (`fix(examples): handle realtime transcript tails`); `568ea7b23523c5437a6b03ba4f5aeb44998d39f6` (`fix(examples): remove duplicate transcript-tail arm`); `e2f1effb4f6047d374aa0f83e374f919f7d1b241` (merge PR #85). OpenTag has no realtime voice product surface. |
| **Not Applicable** | `837f955d310dc87deaa164124a881d97016e8efd` (`fix(tls): standardize rustls on ring`); `87ea73d773f3476e9c493cb9dd8cd5e13c7474b8` (`test(observability): consume OTLP request bodies`, `crates/nanocodex-observability/src/lib.rs`); `4fd42ec168dce5b1dbacc1612055bc8755dc6505` (merge PR #86); `120a30be89333b85e40eb95fdea5efa2c3e183cd` (`fix(tui): inherit terminal foreground colors`); `07a30023abe7d003e756491bacab689834fdce38` (merge PR #87). These are Rust TLS, OTLP test plumbing, and TUI behavior, not OpenTag runtime architecture. |
| **Covered** | `a5c7524f634f7eeeff74fc572f621fa3e7b7ad91` (`refactor(mpp): extract composable egress transport`) extracted `crates/experimental/nanocodex-egress/src/lib.rs`; `00014f696a6e342f37ed3b0838a88810c2a173e6` (merge PR #70); `23a3e8846ee028d85c138fde08bd749431fc7d27` (`feat(egress): harden secret policy and VM routing`) added `experimental/nanocodex-egress/src/{policy,secret}.rs` and the secret-egress example; `b1314ebcd602b77af7d2ab5153286f3a1795bbfe` (merge PR #88). OpenTag already has exact Worker/Container egress, sentinel credentials, approval scope, redaction, and process cleanup. |
| **Not Applicable** | `4afa615174adee2b7646b78c94ea7529942f7c84` (`feat: add Rivet Actors and AgentOS example`) added `examples/rivet-actors`; `c7d36a44f018386b50b771d259a47743465bff86` (`feat(rivet): add detachable actor REPL`); `69c11792911f18daa822b5976a39663524cdc4fa` (`refactor(rivet): remove AgentOS and Pi dependencies`); `f6a4a6d20cb1238a046c99cc779e9337be79eebe` (`feat(rivet): run locally with Codex subscription auth`); `068d0657a36d6d2262a41a03c278fb7b1d0da9a4` (`feat(rivet): add resumable browser client`); `39653c6b69b503a13f94aceb1cc9522b0fd2a23f` (`fix(rivet): own local server lifecycle`); `467e255e17ef07d80b934f5665878ad3daf72ad6` (`docs(rivet): remove stale AgentOS reference`); `d32707b6619bf1f18274df63b207fb01f9b9ad20` (`feat(rivet): package demo for Rivet Compute`); `2e4d0830b1051d0a11194d7bc7d9f12e84c27145` (merge PR #74); `398a525abc49f3966e63f5deff3de8ae3872c3dc` (`feat(rivet): deploy subscription demo to Compute`); `696f1c200ccaf25b2b33fc6755b263c34ed0723b` (merge PR #90); `7ca3656703a1dd24d767b724beed3cf7786499b0` (`feat(rivet): synchronize actor clients`); `53aee06b731c6f98a911d6bb321a2a3004614f0b` (merge PR #94). These are example/deployment consumers, not Nanocodex stable library contracts. |
| **Covered** | `d9e68b2170dd7464a0421b8cd7c85635a447a8a3` (`fix(rivet): reserve turns before replay lookup`, `examples/rivet-actors/src/actors.ts`) is example-specific, but its reserve-before-replay race shape is already covered at the OpenTag system boundary by pre-admission and atomic `SessionEventDO.execute()` in `edge/src/store/session-event-do.ts:206-298`. |
| **Not Applicable** | `0ca4f6904af35cbaf2d6122d441a405b416d8dc8` (`fix(mpp): prefer NanoUSD via provider policy`); `9e10a57059fea55990699fb8b60a5b354554494c` (`chore(mpp): pin merged challenge selection`); `0b1f7979037fdaf680f4dd6dba8567ad2c9f5d68` (merge PR #92). Payment policy is explicitly kept under Nanocodex `bin/`, outside the public library, and OpenTag has no MPP/NanoUSD surface. |
| **Defer** | `ede3640ea2625abc5c1616a01e281fc2ad2abd54` (`feat(browser): import Brave profile cookies`); `b231084f6d9c2bd3b8fc88e8be9e2c6943942c57` (`fix(browser): decouple cookies from executable`); `91b3c5d13835d9c909391a175453051f36ff958c` (`feat(browser): select cookie source profiles`); `ff4e10a6db079f24c983ddff15fcc60a1c953864` (`feat(browser): import Firefox and Safari cookies`); `b9c77e8995f98e03ba528d35cc90000336cec665` (`fix(browser): gate Safari discovery by platform`); `fbca09670325834644fd16febc91c97913567046` (merge PR #93). The browser row’s complete six-commit set is `ede3640…`, `b231084…`, `91b3c5…`, `ff4e10…`, `b9c77e…`, `fbca096…`; OpenTag deliberately has no personal-browser cookie or tab-attachment surface. |
| **Not Applicable** | `3118d9de5e01960d6e0164519dd1caa8028f9fbe` (`docs: refresh project roadmap`, `PLAN.md`); `47fd09cb31108f171561edd48ba8e30257f27f40` (merge PR #101, docs refresh). Documentation was read as current parent intent, but it is not an OpenTag runtime behavior. |

The browser row above intentionally includes the six browser commits as a complete set; the parent ledger has 53 commits total. The row totals are: 9 + 5 + 5 + 5 + 4 + 13 + 1 + 3 + 6 + 2 = 53.

### Fork-only delta: 3 commits

| Classification | Commits and finding |
| --- | --- |
| **Not Applicable** | `e1722ce5f1ad25ae8c4f9ceef4d225c67f2eb5cd` (`docs: add Cursor Cloud environment setup notes to AGENTS.md`); `2b0f9ee253a50361ed23b97c192f92e99f8f3e87` (merge `origin/master` into the Cursor setup branch); `1970c4b15c9eb4913cf66a6eba04992e1a595b32` (merge PR #1 from `wcordelo/cursor/setup-dev-environment-dbb0`). These are fork-specific environment documentation and merge topology, with no Nanocodex public behavior for OpenTag to adopt. |

## OpenTag implementation decision

No OpenTag improvement was implemented or claimed in this task. The evidence-backed candidate list for a separately authorized implementation pass is:

1. If OpenTag embeds a native Responses library rather than invoking the Nanocodex CLI, define a typed provider adapter beneath the existing `SessionEventDO` execution boundary. Require completed-only history commit, exact function-call output pairing, full replay after provider checkpoint loss, one retry owner, and durable terminal projection tests.
2. Preserve the current OpenTag sentinel/Worker-injection credential model. Do not import Nanocodex ChatGPT subscription auth into the Cloudflare harness.
3. If OpenTag needs richer MCP discovery, adapt the allowlisted/deferred-search idea behind an explicit read/write policy and durable approval boundary; do not treat Nanocodex native MCP OAuth as authorization for Slack-side writes.
4. Add structural model/transport/tool metrics only if a current operational gap is demonstrated. Do not copy Nanocodex’s full-fidelity unredacted tracing into OpenTag’s durable event log or external trace path.
5. Keep conversation branching and libkrun VM work deferred until a concrete product surface requires them.

These are recommendations only. No branch, PR, deployment, Notion entry, or daily automation was created because this assigned task explicitly restricted external and repository mutations to the single report path.

## Validation performed

Nanocodex validation ran against the detached parent-tip worktree with `CARGO_TARGET_DIR=/tmp/nanocodex-target` and no credentials or live model calls:

- `bash scripts/check-crate-boundaries.sh`: passed with `crate boundaries match the public SDK architecture`;
- `cargo test -p nanocodex-oai-api --lib --quiet`: 120 passed, 0 failed, 1 ignored;
- `cargo test -p nanocodex-agent --lib --quiet`: 29 passed, 0 failed;
- `cargo test -p nanocodex-tools --lib --quiet`: 140 passed, 0 failed, 1 ignored;
- `cargo test -p nanocodex-oai-api --test it --quiet`: 11 passed;
- `cargo test -p nanocodex-agent --test it --quiet`: 97 passed;
- `cargo test -p nanocodex-tools --test it --quiet`: 6 passed;
- `git diff --check` passed for both complete common-ancestor ranges.

The focused Nanocodex commands above exercised 403 tests in total, with no failures.

OpenTag validation was read-only against the existing checkout:

- `npm run check-types` in `/Users/will/Documents/opentag/edge`: passed;
- 12 focused lifecycle/harness/security/history test files: 181 passed, 0 failed. The set covered `active-turn-engine`, `session-event-do`, `pre-admit-turn`, `harness-client`, `agent-turn-harness`, `harness-egress-policy`, `control-surfaces`, `stop-command-routing`, `permission-snapshot`, runtime defaults/model override, and session history.

These checks validate the inspected source and current behavior; they do not validate an unimplemented OpenTag change, production deployment, live Cloudflare bindings, live MCP, or live model credentials.

## Dependent-synthesis summary

Nanocodex parent delta: 53 commits; fork-only delta: 3; fork remote is already parent-inclusive at `e9ca9258…`; local fork checkout was intentionally left at the common ancestor. Architecture classification: Adopt 0, Adapt 6, Covered 3, Defer 2. Parent-history classification: Adapt 9, Covered 5, Defer 11, Not Applicable 28; the three fork-only commits add three more Not Applicable entries. The useful portable lesson is the separation of authoritative typed completion/history from optional event observation and retry transport mechanics. The surprising result is that OpenTag already has a durable, stricter system-level analogue for admission, terminal events, replay, Stop/quiescence, credential injection, and egress; the remaining gaps are provider-native history/typed transport, conversation branching, and native/experimental surfaces rather than missing durability.


## Current-state addendum — 2026-08-01

Current reconciliation: the native typed Responses adapter is now source-complete and Slack-live for a one-turn canary. Durable checkpoint/replay code is tested; live reconnect and branching remain open/deferred.

The original evidence, classifications, and validation limits above are intentionally preserved. The canonical feature/gap ledger is [CURRENT-STATE-RECONCILIATION.md](../CURRENT-STATE-RECONCILIATION.md).
