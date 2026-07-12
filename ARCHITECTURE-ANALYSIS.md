# Architecture Analysis: Centaur UX → OpenTag, or Centaur Infra → Cloudflare?

**Question:** (A) recreate centaur's chatbot UX/harness capabilities inside opentag using Cloudflare-native primitives, or (B) rebuild centaur's Kubernetes infrastructure on Cloudflare?

**Date:** 2026-07-12. Based on reading both repos at their current state (opentag `edge/` + `lib/`, centaur `services/`, `crates/`, `contrib/chart/`, `harness/`).

---

## 1. Executive summary

**Recommendation: Option A** — port centaur's UX patterns into opentag as Cloudflare-native code, and do not attempt to move centaur off Kubernetes.

Rationale in one paragraph: centaur's chatbot quality lives almost entirely in **one ~7,300-line TypeScript service** (`services/slackbotv2/src/`) plus a **~2,700-line rendering package** — streaming render with conflation, durable render obligations with crash recovery, sticky `--model`/`--claude` flags, stop command, assistant status, quick-action cards, requester identity. All of that is portable logic with no Kubernetes dependency; several files (`conflate.ts`, `overrides.ts`, `quick-card.ts`) port nearly verbatim, and the durable-state parts map *better* onto Durable Objects than onto centaur's Postgres-rows-plus-startup-scan design. By contrast, centaur's infrastructure is deeply K8s-shaped where it matters: a ~60,000-line Rust control plane whose sandbox backend is generated from a K8s CRD (`centaur-sandbox-agent-k8s`, 4,500 lines of generated bindings alone), a Postgres StatefulSet running ParadeDB extensions (`pg_search`, `pg_cron`) that D1 cannot replace, a node-local repo-cache DaemonSet with hostPath mounts, a per-sandbox MITM credential proxy (`iron-proxy`) that requires a sidecar-and-network-policy model Cloudflare Containers do not have, and 714 lines of NetworkPolicies. Option B would be months of work, would degrade centaur's security model, would still require an external Postgres (i.e. it wouldn't actually be "Cloudflare instead of infra"), and would produce zero user-visible improvement. Option A gets users the UX they're missing in weeks.

---

## 2. What centaur's harness actually does

### 2.1 slackbotv2 — the chatbot UX layer (`services/slackbotv2/src/`, 7,256 LOC)

This is the service that makes centaur feel good in Slack. Concrete features, by file:

**Live streaming render with conflation** (`index.ts`, `conflate.ts`, `@centaur/rendering`).
The bot opens an SSE event stream from the session API (`session-api.ts:streamSessionNotifications`), maps harness events → chat-SDK chunks (`codexAppServerToChatSdkStream` in `packages/rendering/`, 2,658 LOC: markdown deltas, `task_update` cards, `plan_update`), and streams them into Slack. `conflate.ts` (110 LOC) is the key trick: Slack pays one rate-limited API call per chunk while a busy execution emits tens of thousands, so the wrapper drains the source eagerly into a pending snapshot — markdown deltas concatenated, task updates merged per-id newest-wins, plan keeps latest — so Slack call count is bounded by *distinct cards*, not event count. Task detail fields are truncated to 500 chars; fallback text to 35k; Block Kit's 50-block limit is respected everywhere.

**Durable render obligations + crash recovery** (`index.ts:1426–1960`).
Before executing, the bot persists a `renderObligation` (`{afterEventId, executionId, message}`) into per-thread Postgres state and indexes it under `slackbotv2:render:index`. If the pod dies mid-render, a startup recovery sweep re-scans indexed threads, takes a 2-minute lease (refreshed every 60s) so live renders and recovery never double-post, replays the session event stream from `afterEventId`, and posts the answer. Failures degrade in explicit tiers (`renderExecutionAttempt`): live stream → retry with backoff (250ms→5s) → durable "fallback final answer" post derived from the terminal event → divergence reconciliation (if the streamed message diverged from the recomposed answer, the truncated stream message is *replaced* by the durable answer). The invariant this buys: **the user never gets silence.** Every outcome is a named metric (`streamed`, `fallback_sent`, `answer_visible`, `error_visible`, `failed_size_limit`).

**Sticky message overrides** (`overrides.ts`, 165 LOC).
`--codex | --claude | --amp` pick the harness; `--model <id>`, `--fable/--opus/--sonnet/--haiku` shortcuts; `--bedrock/--meta` providers; `-rsn <effort>` per-turn reasoning. Flags are stripped before the agent sees the text, persist sticky at thread level (`SlackbotV2ThreadState.harnessType/model/provider`), and a harness flag on a thread pinned to another harness triggers a **session restart**: `harnessRestartPreamble` (`session-api.ts:582`) re-feeds the whole Slack thread transcript (capped at 24k chars) to the fresh harness because the old harness's conversation state died with its sandbox.

**Stop command** (`stop-command.ts` + `handleStopCommand`): "stop"/"cancel" in-thread calls the session API's `/interrupt`, clears the render obligation, and clears the assistant status.

**Assistant status + titles** (`index.ts:3071–3210`): Slack's assistant-thread status ("Thinking…", optionally live `session.activity_summary` events as status text, capped at 50 chars) and thread titles derived from the first message.

**Quick deploy cards** (`quick-card.ts`, `quick-actions.ts`, ~160 LOC).
Final answers containing a Quick site URL get an interactive card (`Re-generate | View files | Delete site`). The elegant part: button clicks are **converted into synthetic in-thread agent turns authored by the clicking user** (`handleQuickAction`) — no parallel "button API"; clicks inherit dedup, requester identity, and tool ownership checks for free.

**Console deep link** (`console-session-link.ts`, 125 LOC): first assistant message in a thread gets a context block "Open chat in Console · CLAUDE-OPUS-4-8 · Claude Code" linking to the Rails console's session view, with the effective model resolved from flags → deployment env → baked harness config (`harness/claude/settings.json`, `harness/codex/config.toml` are imported directly).

**Context & identity plumbing** (`session-api.ts`, 1,994 LOC).
Full Slack thread history collection on first execution (and re-collection for thread replies); attachments inlined as base64 up to 100MB with staged chunking (700KB chunks) when a single codex input line would exceed 900KB; requester identity resolution — Slack profile → GitHub handle extraction from profile custom fields (regexes for URL/`github:` prefix/bare handle forms), cached 6h — injected as a `# Requester Context` block so PRs carry `Prompted by:` attribution; conversation display names (DM partner or channel name) recorded as the session principal's name.

**Reliability plumbing** (`index.ts`).
Message-level dedup (`forwardedMessageIds`/`executedMessageIds`, capped at 1,000), execute idempotency keys, in-process handoff retries (5s/30s/120s — Slack's own 3s-timeout redelivery can't drive retries), "late Slack file" repair (files that arrive in a separate event within 15s of a file-less mention get re-attached as a synthetic message after the thread goes idle), external-team and trigger-bot allowlists (`slack-events.ts`), and ~30 Prometheus metrics (`metrics.ts`, 377 LOC).

### 2.2 The session control plane (`services/api-rs`, ~60,400 LOC Rust, 17 crates, 41 SQL migrations)

The bot never talks to a model. It talks to a **session API**: `POST /api/session/{thread_key}` (create, pinned to a harness; 409 + restart semantics on conflict), `/messages` (append), `/execute` (idempotent, `input_lines` as opaque NDJSON, idle timeout up to 3h), `/events?after_event_id=N` (replayable SSE), `/interrupt`. Postgres is the source of truth for sessions, events, executions, and workflow state (`absurd-sdk` durable workflows); process-local maps are recoverable caches. It owns sandbox lifecycle: agent-k8s Sandbox CRDs, a **warm pool** (default 3 pre-booted sandboxes), capacity manager, idle-pause, 3-day max-lifetime reaper, cleanup sweeps, ETL workflows (Slack/Linear/Drive sync).

### 2.3 The sandbox (`services/sandbox/`)

A full Ubuntu 24.04 image (Dockerfile ~14KB): Rust, Node 24, Python+uv, Foundry, texlive, ffmpeg, kubectl, `claude-code` + `codex` + pi + agent-browser CLIs pinned by version. `crates/harness-server` (Rust) wraps the harness CLIs behind one wire protocol ("Codex App Server V2 / blocks"), so slackbotv2 renders codex, Claude Code, and Amp identically. `centaur_tool_host.py` (106 LOC) is a trivially small stdin/stdout JSON loop that shells out to `centaur-tools call <tool> <method> <json>` — the tools themselves are repo-mounted CLIs delivered by the repo-cache, not baked into the image. `SYSTEM_PROMPT.md` (250 lines) encodes the behavioral contract: brevity gates, git-branch workflow for writable clones, `uv`-only Python, PR attribution from Requester Context, ephemeral-container rules, observability tools (`vlogs`/`vmetrics`), Slack upload/download discipline.

### 2.4 Supporting cast

- **iron-proxy**: per-sandbox MITM egress proxy with its own CA. Sandboxes hold **placeholder credentials**; the proxy injects real ones per the control plane's grants, allowlists headers/hosts/paths, and multiplexes Postgres DSNs through one listener. This is centaur's core security boundary.
- **console** (Rails, ~31,800 LOC): session viewer, OAuth sign-in (Google/Slack), encrypted secret storage, token-broker refresh worker, MCP OAuth issuer.
- **repo-cache**: DaemonSet keeping GitHub repos fresh on every node's hostPath; sandboxes get read-only mounts at `~/github/{org}/{repo}`; tools/overlays/skills ship via repo push, not image rebuild.

---

## 3. What opentag currently has, and the specific gaps

### 3.1 What exists (and is genuinely good)

- **Slack ingress** (`edge/src/worker.ts`, 247 LOC): Events/commands/interactions on Hono, 3s ack via `waitUntil`, signature verification.
- **Bot engine** (`edge/src/bot-engine.ts`, 292 LOC): CopilotKit `createBot` + `CloudflareSlackAdapter`, 15-min turn locks, pre-LLM fast paths (`trivial-ack.ts`, `react-intent.ts`), hourglass progress reaction, `research`/`remember` keyword routing.
- **Cross-isolate HITL** (`edge/src/hitl/durable-choice.ts`, 201 LOC): `choiceId` embedded in button values, clicks persisted to DO KV, waiter races in-memory resolution against a DO poll. This is a real distributed-systems fix and is the same *shape* as what centaur does with Postgres state — opentag already thinks in durable terms.
- **Per-turn context assembly** (`edge/src/agent-turn.ts`, 427 LOC): access bundles + policies (`workspace-config-do.ts`), requester profile/email/timezone, clock context, thread transcript merged from Slack history + a durable DO `threadmem:` log, Linear draft/assignee inference.
- **State** (`edge/src/store/`): DO + SQLite StateStore with kv/list/lock/dedup contracts; `KnowledgeDO` channel memory; `WorkspaceConfigDO` prompts/bundles.
- **Agent runtime**: AG-UI `HttpAgent` → `opentag-agent` CF Container (Node `runtime.ts` + `lib/triage-agent.ts` + optional Notion MCP sidecar process), reached over a service binding.
- **Research actors** (`lib/research/`, ~2,500 LOC): Orchestrator/Researcher/Verifier with storage adapters (DO, Postgres, memory) and Slack delivery.
- **Cards** (`edge/src/components/cards.ts`): issue/list/status/links/incident Block Kit components, `confirm_write` approval gate.

### 3.2 The gap list (what "rudimentary" means, concretely)

| # | Gap | Evidence in opentag | Centaur counterpart |
|---|---|---|---|
| 1 | **No live streaming.** `stream()` buffers the *entire* response, then posts once | `cloudflare-slack-adapter.ts:418-434`: `for await (const c of chunks) acc += c; postMessage(acc)` | Chunked streaming + conflation + segmentation |
| 2 | **No delivery guarantee.** If the Worker/container dies mid-turn, the thread gets a generic error or silence | `bot-engine.ts:268-279` catch-all posts "Something went wrong… retry in a few seconds" | Render obligations, leases, recovery sweep, fallback final answer |
| 3 | **No progress visibility.** One hourglass reaction after 2.5s is the whole story for a multi-minute turn | `bot-engine.ts:242-249` | Assistant status, activity summaries, task/plan cards streaming live |
| 4 | **No stop/interrupt.** A runaway turn can't be cancelled from Slack | no counterpart anywhere in `edge/src/` | `stop-command.ts` + `/interrupt` |
| 5 | **No model/harness selection.** One model env var on the container | `AGENT_MODEL` secret in agent-runtime | Sticky `--model/--claude/--codex/-rsn` flags + restart-with-transcript |
| 6 | **Agent conversation state is isolate-local.** `agentsByConversation` is an in-memory Map; a mid-thread turn on a new isolate loses AG-UI history (mitigated by re-injecting the Slack transcript into the prompt — `agent-turn.ts:398-417` explicitly works around "cannot claim amnesia") | `cloudflare-slack-adapter.ts:100-121` | Durable sessions: append/execute/replay event log in Postgres, harness state in sandbox |
| 7 | **No real coding harness.** The "brain" is a single triage prompt + MCP tools; no repo mounts, no git workflow, no Claude Code/codex CLI, no file artifacts | `lib/triage-agent.ts`, agent-runtime README | Full sandbox image + harness-server + repo-cache + git-branch |
| 8 | **Thin attachment handling.** Downloads files into content parts; no size tiers, no late-file repair, no staged chunking | `slack/download-files.ts` (183 LOC) | `session-api.ts` attachment pipeline (100MB, chunking, repair) |
| 9 | **No interactive follow-up cards** (quick-action pattern: buttons → synthetic agent turns) — buttons only resolve HITL waits | `durable-choice.ts` | `quick-card.ts`/`quick-actions.ts` |
| 10 | **No observability.** `console.error` only; no metrics, no delivery-status accounting | throughout | `metrics.ts` + vlogs/vmetrics story |
| 11 | **No session viewer / console link** | — | Rails console + `console-session-link.ts` |
| 12 | **No requester→GitHub identity, no PR attribution** | requester email/timezone only | GitHub-handle extraction, `Prompted by:` |

---

## 4. Option A deep-dive: bring centaur's UX into opentag (CF-native)

### 4.1 What ports directly (no runtime constraints — pure TS, copy-adapt)

These files have zero Node/K8s coupling and would be adapted mostly at the type level:

- `conflate.ts` (110 LOC) — async-iterator logic, Workers-safe as-is.
- `overrides.ts` (165 LOC) — pure regex parsing; drop the harness table to whatever opentag supports, keep `--model` + aliases + `-rsn`.
- `quick-card.ts` + `quick-actions.ts` (160 LOC) — pure Block Kit building + prompt synthesis; opentag's interaction route (`worker.ts:/slack/interactions`) already delivers the click, and the "synthetic turn authored by clicking user" pattern drops straight into `runBundledAgentTurn`.
- `console-session-link.ts` — the pattern (context block with model/harness), pointed at whatever viewer exists.
- `stop-command.ts` (27 LOC) — trivial; needs an interrupt target (§4.3).
- `slack-display-text.ts` (377 LOC) — raw-block → prompt-text rendering; Workers-safe.
- The dedup/idempotency/sticky-state shape of `SlackbotV2ThreadState` — opentag already has per-thread DO state; this is added fields, not new machinery.

Assistant status/titles are plain Slack Web API calls (`assistant.threads.setStatus/setTitle`) — opentag's `web-api.ts` already has `setStatus` in its transport.

### 4.2 What needs rethinking for CF (and mostly gets *simpler*)

**Render obligations → Durable Objects.** Centaur needs an index key, leases with TTL refresh, and a startup scan because its state is passive Postgres rows and any of N pods might recover them. On CF, a **per-thread DO** *is* the lease (single-threaded execution per thread key), and a **DO alarm** *is* the recovery sweep (set an alarm when an obligation is written; clear it on render completion; alarm fires → replay events → fallback post). An honest estimate is that centaur's ~500 lines of recovery/lease/index code become ~150 lines of DO code with stronger guarantees.

**The long-lived render loop.** A Worker request can't chew on a 3-hour SSE stream, but this is exactly what the DO + alarms model (or the CF Agents SDK, which opentag's skill set already covers) handles: the conversation DO owns the render loop, wakes on alarms, and survives eviction because progress (`lastEventId`, obligation) is in DO storage. The container running the agent can also push events to the DO instead of the DO pulling SSE — either direction works within CF primitives.

**Session/event log — the "mini api-rs".** Opentag needs the *contract* of api-rs, not its implementation: per-thread session row, append-only event log, execute idempotency, replay-from-event-id, interrupt. On a DO with SQLite that is one table (`events(id INTEGER PRIMARY KEY, execution_id, kind, payload)`) plus ~10 RPC methods. The 60k LOC of api-rs is overwhelmingly K8s sandbox orchestration, warm pools, capacity management, multi-tenant perms, ETL workflows, and iron-control integration — none of which opentag's product needs. Estimate: **1.5–3k LOC** TS for a session DO that gives you replayable events, idempotent execute, and interrupt.

**Harness in CF Containers.** Centaur's sandbox image is a normal Linux image; CF Containers run arbitrary images. Opentag already runs a container brain (`TriageContainer`, always-on, port 8200) and has a scaffolded Sandbox SDK worker (`edge/workers/sandbox/`) and egress proxy. Running Claude Code (or codex) headless inside a CF Container with a small HTTP/WS shim that emits centaur-style events is feasible today. What CF Containers give you vs. centaur's K8s sandbox:
  - ✅ Per-session container instances addressed by DO id (the DO-per-sandbox pattern is *native*), sleep-on-idle, no CRD controller needed.
  - ✅ No cluster to run; image push via `wrangler deploy`.
  - ⚠️ Instance ceilings (vCPU/memory/disk per instance type; account-level concurrent instance caps) — fine for a team bot, not for centaur-scale fleets with warm pools.
  - ⚠️ Cold starts measured in seconds for big images; centaur's warm pool has no first-class equivalent (you can keep N instances warm yourself, at cost).
  - ❌ No sidecars, no hostPath/RWX volumes → no repo-cache mounts. Repos must be cloned per-session (slow for big repos) or synced to R2 and pulled. This is the single biggest capability loss and is why opentag's research/tooling should stay tool-API-shaped rather than "mount the monorepo" shaped, at least initially.
  - ❌ No enforced egress control. Centaur's iron-proxy model (placeholder creds + MITM injection + NetworkPolicy forcing all egress through it) cannot be replicated — a CF Container has open egress and you can only *configure* (not enforce) an HTTP proxy inside it. Acceptable for self-hosted single-tenant with real keys in Worker secrets (opentag's current model, DECISIONS §2/§4); not acceptable if you ever host untrusted tenants.

### 4.3 What can be dropped outright

- **`api-rs` as a service** — replaced by the session DO above. No Rust.
- **`console` (Rails, 31.8k LOC)** — not needed for chatbot UX. If a session viewer is wanted later, a read-only Worker page over the session DO's event log is a weekend project, not a Rails app.
- **`iron-proxy`, NetworkPolicies, repo-cache, agent-sandbox controller, litellm, quick-server infra** — either replaced by CF-native equivalents (R2 for artifacts + a wildcard Worker replaces quick-server almost embarrassingly well) or out of scope.
- **Multi-harness parity (Amp/codex/providers)** — keep the flag *syntax* but implement one harness first.

### 4.4 Irreducible complexity / what can't be done on CF at all

1. **Enforced sandbox egress isolation** (iron-proxy grade). Not possible; documented trade-off.
2. **Shared RWX repo mounts.** Not possible; clone-per-session or R2 sync.
3. **Very long uninterrupted compute in the Worker tier.** Solved by putting loops in DOs/Containers, but it's a design constraint that touches everything (opentag already lives with it).
4. **Warm pools with sub-second attach.** Approximable, not native.

### 4.5 Effort estimate & sequencing

| Phase | Work | New/ported LOC (est.) | Time (1 experienced dev) |
|---|---|---|---|
| A1 | Streaming render into Slack (chunked post/update, conflation, 50-block/size segmentation), assistant status, hourglass → status upgrade | ~1,200 (conflate ports; renderer written against CopilotKit adapter) | 1–2 wks |
| A2 | Session/event DO: append/execute/replay, idempotency, interrupt; stop command; render obligation + alarm recovery + fallback final answer | ~1,800 | 2–3 wks |
| A3 | Message overrides (`--model`, aliases, `-rsn`), sticky thread state, per-thread model plumbed to container | ~500 | 3–5 days |
| A4 | Quick-action pattern (buttons → synthetic turns) generalized over opentag's cards; late-file repair; attachment size tiers | ~900 | 1–2 wks |
| A5 | Harness container: Claude Code headless in CF Container emitting session events; git clone-per-session; requester→GitHub attribution | ~2,000 + Dockerfile | 3–4 wks |
| — | **Total** | **~6–7k LOC** | **~2–3 months to full parity; A1–A3 (the felt UX) in ~1 month** |

### 4.6 Risks

- **Slack streaming API surface.** Centaur streams via the chat-SDK's Slack adapter (Slack's assistant streaming / `chat.stopStream` with appended blocks). If opentag's app can't use the assistant streaming APIs in its surfaces, fall back to `chat.update`-based incremental rendering (rate-limited ~1/s — the conflation logic is exactly what makes that acceptable). Low risk, but validate first.
- **CopilotKit `channels` friction.** Opentag is already on a vendored tarball (`edge/vendor/`) working around upstream Workers incompatibility. The streaming renderer must be written against (or around) `createRunRenderer`; budget for fighting the framework or bypassing it for the streaming path (centaur's `chat` SDK is a different, non-portable dependency — port *patterns*, not imports).
- **DO eviction/limits during multi-hour renders.** Mitigated by event-log + alarm resumability — the same discipline centaur already proved out on Postgres.
- **Scope creep toward api-rs.** The session DO must stay a contract-sized object; the moment it grows warm pools and capacity managers, you're rebuilding centaur badly.

---

## 5. Option B deep-dive: replace centaur's K8s with Cloudflare

### 5.1 What the chart actually provisions (from `contrib/chart/`)

| K8s resource | Purpose | CF mapping |
|---|---|---|
| `workloads.yaml`: Postgres **StatefulSet** (paradedb/paradedb pg16, `shared_preload_libraries=pg_search,pg_cron`, 20Gi PVC, /dev/shm volume, 500 conns) | Source of truth for api-rs sessions/events/workflows, slackbotv2 thread state, console DB | ❌ **No mapping.** D1 is SQLite (41 PG migrations, sqlx, RLS tests, `pg_search` full-text ETL search, `pg_cron` don't port). Hyperdrive only proxies to an *external* Postgres — meaning Option B still runs a database somewhere else. This alone breaks "Cloudflare instead of K8s". |
| `apirs.yaml`: Deployment + ServiceAccount + **Role/RoleBinding** (api-rs creates/deletes Sandbox CRs, pods, per-sandbox iron-proxy resources) | Control plane | ⚠️ api-rs is Rust/tokio/sqlx — runs only as a CF Container, not a Worker. But its **sandbox backend is the K8s API itself** (`centaur-sandbox-agent-k8s`, incl. 4,567 lines of generated CRD bindings). CF Containers have **no external orchestration API** — containers are spawned via DO classes inside Workers. You'd have to write a new `centaur-sandbox-core` backend that calls a bespoke Worker shim which fronts container DOs: an inversion of the architecture and a full new backend implementation + e2e suite (`centaur-sandbox-e2e` exists precisely because this layer is subtle). |
| `agentSandbox` subchart (agent-sandbox controller + CRDs, warm pool of 3, capacity manager, reaper) | Sandbox lifecycle | ⚠️ Partially reproducible in DO logic; warm pools and capacity control are hand-rolled. |
| `repo-cache.yaml`: **DaemonSet** + hostPath (or RWX PVC), 30s sync; sandboxes mount `~/github/{org}/{repo}` read-only | Tools/overlays/repos without image rebuilds | ❌ No nodes, no hostPath, no RWX volumes, no sidecars. Would become R2 sync + per-boot copy — slower and a rewrite of `repo_cache_sync.py` + `install_tool_shims.py` assumptions. |
| iron-proxy (per-sandbox proxy pods + CA secrets) + `networkpolicy.yaml` (**714 lines**: deny-by-default, IMDS/pod-CIDR deny, per-component allow) | Security boundary: placeholder creds in sandbox, real creds injected at proxy, forced egress | ❌ **Unreproducible.** No CF equivalent of forcing a container's egress through a policy proxy. Real credentials would live in the sandbox. This is a security *regression*, not a migration. |
| slackbotv2/console/githubbot/linearbot/discordbot/teamsbot Deployments + Services + Ingress/HTTPRoutes | Stateless services | ✅/⚠️ Run fine as CF Containers (they're Node/Rails processes; slackbotv2 uses `pg`, `AsyncLocalStorage`, Bun — not Workers-compatible without rewrite). So "migrate to Cloudflare" = "run the same containers on a different, more constrained scheduler". |
| quick-server (RWX PVC shared writer/reader, wildcard Ingress, IAP) | Artifact hosting | ✅ Genuinely better on CF (R2 + Worker + Access) — but this is one leaf feature. |
| litellm, 1Password Connect, VictoriaLogs/Metrics egress policies | Gateway/secrets/observability | ⚠️ Replaceable (AI Gateway, Worker secrets, Workers Analytics) but each is its own migration with operational retraining. |

### 5.2 What breaks or gets harder

1. **Postgres stays external** → you keep a non-CF stateful dependency forever; you've moved the cluster, not eliminated it.
2. **The control plane's core abstraction (K8s API as sandbox scheduler) must be rewritten**, in Rust, against an API surface (container-DOs) that only exists inside Workers.
3. **Security model downgraded** (iron-proxy + NetworkPolicies have no equivalent).
4. **Warm pools / capacity / idle-pause / reaper** — all re-implemented against weaker primitives; sandbox attach latency worsens.
5. **Repo-cache and tool delivery** — redesigned end to end.
6. **Observability** — vlogs/vmetrics + the deployment-metrics exporter (which the agent itself queries per `SYSTEM_PROMPT.md`) don't transplant.

### 5.3 Effort and payoff

Realistic estimate: **4–6+ months** (new Rust sandbox backend + shim Workers + repo/tool delivery redesign + secrets/egress redesign + re-validation of the recovery/idempotency invariants api-rs's AGENTS.md insists on), with **zero user-visible improvement** — Slack UX is identical after the migration — and a permanently weaker security posture. The only scenario where B makes sense is "we must stop operating K8s at all costs," and even then the honest answer is a managed K8s (or keeping `just up` on k3s, which the repo already optimizes for) rather than Cloudflare.

---

## 6. Decision matrix

| Criterion | A: Centaur UX → opentag (CF-native) | B: Centaur infra → CF |
|---|---|---|
| User-visible payoff | **High** — streaming, recovery, stop, model flags, cards | None (UX unchanged) |
| New code | ~6–7k LOC TS (A1–A3 felt-parity slice: ~3.5k) | Rust sandbox backend + shim Workers + delivery/secrets redesign; ~15–25k LOC touched |
| Reuse | conflate/overrides/quick-card port near-verbatim; patterns for the rest; all of opentag kept | slackbotv2/console reused as containers; api-rs core reused; **chart, iron-proxy, repo-cache, networkpolicy, agent-k8s backend thrown away** |
| Thrown away | centaur untouched (it keeps running) | 714-line NetworkPolicy security model, warm pools, repo mounts |
| Unknowns | Slack streaming API in opentag's app config; CopilotKit renderer flexibility | CF container caps vs. fleet size; DO-fronted orchestration semantics; PG hosting |
| Post-migration ops | Wrangler-only; DOs + 2 containers; no cluster | CF **plus** external Postgres **plus** re-learned observability |
| Risk of silent regression | Low (additive to a working bot) | High (recovery/idempotency invariants re-proven from scratch) |
| Time to "good chatbot UX" | **~1 month** (A1–A3), ~2–3 months to A5 | Never via this path (B doesn't target UX) |
| Security | Same as opentag today (keys in Worker secrets; documented no-iron-proxy trade-off) | Strictly worse than centaur today |

---

## 7. Recommendation and implementation path

**Do Option A. Do not do Option B.** The two options aren't really alternatives — B doesn't even address the stated problem ("opentag's chatbot UX is rudimentary"). Centaur's UX is a portable TypeScript pattern library sitting on a session contract; its K8s infra is the part that *isn't* portable and *isn't* what opentag lacks.

Concrete path (matches §4.5 phases):

1. **A1 — Streaming + status (the felt upgrade).** Port `conflate.ts`; write a Slack incremental renderer for opentag's adapter (replace the buffering `stream()` at `cloudflare-slack-adapter.ts:418`); wire assistant status/titles. Validate Slack's streaming/status APIs against opentag's app scopes first — it's the one external unknown.
2. **A2 — Session DO + never-silent guarantee.** Per-thread session DO with an events table (append/execute/replay/interrupt, idempotency keys); render obligation stored in the DO with an alarm as the recovery sweep; fallback final-answer post. This also fixes gap #6 (isolate-local agent state) properly instead of via transcript re-injection.
3. **A3 — Overrides.** Port `overrides.ts`; sticky `model` in thread state; pass through AG-UI to the container. Cheap, high-delight.
4. **A4 — Quick-action pattern + attachment hardening.** Buttons → synthetic turns via `runBundledAgentTurn` (the `handleQuickAction` pattern, `index.ts:688`); apply it to opentag's existing issue/incident cards ("Retry", "Create follow-up", "Delete").
5. **A5 — Real harness container.** Claude Code headless in a per-session CF Container (extend the `edge/workers/sandbox/` scaffold), emitting events into the session DO; adopt `SYSTEM_PROMPT.md`'s discipline sections (brevity gate, artifact verification, requester attribution) into opentag's system prompt immediately — that file is pure prompt engineering and costs nothing to borrow today.

Borrow shamelessly from centaur's *specs*: the delivery-status taxonomy (`deliveryStatusForRenderOutcome`), the retry ladders, the restart-preamble trick, and the "buttons are just user turns" principle are the distilled lessons of a production system — the cheapest part of centaur to take is its judgment.
