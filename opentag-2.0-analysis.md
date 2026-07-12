# OpenTag 2.0 Architecture — Technical Audit

**Date:** 2026-07-11  
**Auditor:** Claude (claude-sonnet-4-6) via Cowork  
**Codebase reviewed:** `/Users/will/Documents/opentag` (Railway + Postgres + Node.js, v0.2.0)  
**Spec audited:** OpenTag 2.0 proposed Cloudflare-native multi-agent pipeline  
**Reference implementation:** WorkOS Project Horizon (May 2026, production)

---

## Legend

| Tag | Meaning |
|-----|---------|
| `FACTUAL_ERROR` | The spec states something that contradicts verified platform documentation |
| `ARCHITECTURAL_RISK` | The design is based on real platform features but will likely cause problems at runtime |
| `GAP` | A component or concern is entirely absent from the spec |
| `UNVERIFIED_CLAIM` | The spec makes an assertion that cannot be confirmed or denied from available evidence |
| **CRITICAL** | Blocks shipping; causes data loss, crashes, or security failure |
| **HIGH** | Requires a design change before production; degrades reliability or UX significantly |
| **MEDIUM** | Requires attention before scale; technical debt with a clear fix path |
| **LOW** | Good to fix eventually; does not block shipping |

---

## What's Right

The spec gets these things correct, and several are already validated by the existing `edge/` comparison track in the repository.

**1. Durable Objects + SQLite for per-session state.** The `edge/worker/src/index.ts` and `lib/research/adapters/storage-do.ts` already implement this cleanly. The `StorageAdapter` interface abstracts Postgres vs. DO SQLite, so the migration is an adapter swap, not a rewrite. Choosing DO SQLite over external KV for session state is the right call: consistent reads, transactional writes, and no extra network hops.

**2. Sandbox SDK as the container runtime.** `@cloudflare/sandbox` is GA and production-validated. The API surface (`getSandbox`, `sandbox.exec`, `sandbox.readFile`, `sandbox.writeFile`, `sandbox.tunnels.get`) maps directly onto the code-execution use cases (file I/O, shell commands, preview URLs). WorkOS chose this same stack specifically for egress control, which gives the choice strong third-party validation.

**3. Preview URLs for verification agents.** `sandbox.tunnels.get(port)` → `*.trycloudflare.com` is the right primitive for having a verification agent act as a true external client of the code-execution sandbox. This lets a verification agent drive a browser or hit an HTTP endpoint against running code without any VPN or tunnel configuration. WorkOS's experience confirms this pattern works in production.

**4. Orchestration logic separated from execution plane.** The spec correctly places orchestration in the Orchestrator DO (control plane) and code execution inside containers (data plane). WorkOS explicitly validated this separation: mixing orchestration into the sandbox creates lifecycle and security problems. The existing `edge/` code already demonstrates this separation.

**5. TinyGo as mandatory for WASM compilation.** Standard Go produces binaries well over the 10 MB gzip bundle limit for CF Workers. TinyGo is the correct choice. The `npm create cloudflare@latest -- --template github.com/syumai/workers/_templates/cloudflare/worker-tinygo` template and `wasm-opt` post-build step are correctly identified.

**6. Multiple sandbox flavors under one control plane.** The PM Agent / Implementation Agent / Verification Agent split maps directly onto WorkOS's planning sandbox / code-writing sandbox / verification sandbox pattern. Having different resource and security profiles per sandbox type (e.g., verification gets read-only filesystem, PM sandbox makes no outbound calls except to ticketing APIs) is sound security design.

**7. Hono as the router layer.** Hono is the de-facto standard for CF Workers HTTP routing. It is lightweight, TypeScript-native, and has first-class CF Workers types. No concerns here.

**8. R2 for blob storage.** The existing `edge/wrangler.jsonc` already binds an R2 bucket (`opentag-research-blobs`). R2 is the correct spill target for large agent outputs that exceed SQLite row limits. The existing `BlobAdapter` interface makes this adapter-swappable.

**9. Ephemeral container lifecycle (create-per-session, destroy-on-completion).** This is correct for isolation. Each agent session gets a clean filesystem, preventing cross-contamination of build artifacts or secrets between sessions.

**10. syumai/workers for Go → CF Workers mapping.** The package correctly exposes R2, KV, DO stubs, D1, env vars, FetchEvent, Cron, TCP, and Queues to TinyGo WASM. The runtime support list in the spec is accurate.

---

## Issues

---

### [FACTUAL_ERROR — CRITICAL] Egress Proxy: CF Workers cannot intercept container TCP traffic — the spec describes a capability the platform does not have

**Component:** Egress Proxy

The spec states: "Workers proxy that all container outbound traffic routes through (for allowlisting, logging, token injection)."

This implies that container TCP/HTTPS traffic is transparently intercepted by a CF Worker. **This is a factual error.** The CF Workers TCP Socket API is outbound-only (verified platform fact); Workers cannot `listen()` on a port as a TCP server and cannot accept incoming connections from any source, including CF Containers. There is no CF-native mechanism by which a Worker can intercept arbitrary TCP traffic originating from a Firecracker microVM.

Cloudflare Containers have their own network stack and make outbound connections directly to the internet. A CF Worker has no ability to sit in that path at the network level.

What IS achievable (and what WorkOS actually did) is an application-level proxy pattern:

- Agent code inside the container routes outbound API calls through a named Worker URL (e.g., `https://proxy.opentag.workers.dev/fetch`) instead of calling external services directly.
- The proxy Worker validates the destination against an allowlist, injects auth headers (model API keys, etc.), logs the call, and forwards it via `fetch()`.
- This requires all agent-authored HTTP calls to be written against an internal SDK that wraps the proxy Worker URL, not `http.DefaultClient` or raw `fetch`.

If the spec means transparent OS-level traffic interception, that is not achievable on CF Containers without external network policies. If it means application-level proxying, that is feasible but requires a deliberate SDK design that the spec does not describe.

**Recommended fix:** Replace the vague "proxy" description with one of:
1. **Application-level proxy (recommended):** Provide agents with a thin HTTP client SDK that routes all external calls to a proxy Worker endpoint. The SDK is injected into the container at startup via env var (`OPENTAG_PROXY_URL`). The proxy Worker allowlists destinations, injects model API keys from secrets, and logs all calls. Agent code never holds API keys; it only holds a short-lived session token for the proxy.
2. **CF-native egress filtering:** Use Cloudflare's outbound proxy / Gateway features at the account level to filter container egress by hostname. This is a network policy, not a Workers feature.

---

### [GAP — CRITICAL] Cold start latency is entirely unaddressed in the spec and UX

**Component:** Ephemeral Containers, UX

WorkOS explicitly reported that the first `npm run dev` inside a fresh container took 2–3 minutes before an agent could execute code. The spec makes no mention of cold start time, provides no mitigation strategy, and does not describe any Slack UX for "the container is booting."

For a Slack bot, a 2-3 minute wait between a user's message and the first meaningful response is a severe UX failure. Users will assume the bot is broken and re-send, which may spawn duplicate agent sessions.

The existing codebase already handles a similar latency issue: `runtime-research.ts` posts an interim Slack message ("🔍 Research started: ...") immediately via the delivery obligations system, before any long-running work begins. But this only works if the interim post happens before the container boots, which requires the orchestrator (not the container) to own the Slack acknowledgment.

**Recommended fix:**
1. **Prebuild container images.** Build base Docker images with all agent dependencies pre-installed (Node, npm deps, language runtimes) and push them to a container registry. The Sandbox SDK supports custom Docker images. Dependency installation at boot-time must be zero.
2. **Warm pool.** Keep 1-2 pre-booted idle containers per agent type. The orchestrator assigns an idle container to a new session rather than cold-booting one. Idle containers can be destroyed after 5 minutes without assignment.
3. **Immediate Slack acknowledgment.** The Orchestrator DO posts an interim Slack message before routing to a container, using the existing delivery obligations pattern. Users see "Working on it" within 1 second.
4. **Define the target.** Specify a p95 time-to-first-response SLO (e.g., <5 seconds for acknowledgment, <90 seconds for first code output) as a constraint that drives the above decisions.

---

### [GAP — HIGH] Slack delivery model: Socket Mode cannot run on CF Workers

**Component:** Orchestrator, Slack integration

The existing OpenTag bot uses Slack Socket Mode (`@slack/bolt` with `socketMode: true`), which is a WebSocket connection initiated outbound from the bot to Slack's infrastructure. CF Workers cannot maintain persistent outbound WebSocket connections in the background — they run only in response to incoming HTTP requests, and there is no always-on process.

The spec does not address this. Migrating to CF Workers requires switching to Slack's Events API (webhook mode), where Slack delivers events as HTTP POST requests to a public URL. This is a non-trivial change that affects:

- Slack app manifest (Socket Mode disabled, Request URLs added)
- Bot authentication (App-Level Token `xapp-` is Socket Mode-only; switch to signing secrets for webhook verification)
- Event deduplication (Slack retries failed webhook deliveries; the existing code already has idempotency via `isSlackEventProcessed`, but this must be wired to the new entry point)
- Local development (Socket Mode requires no public URL; webhook mode requires `wrangler dev` + a tunnel or `ngrok`)

The existing `docs/evaluation.md` already flags this: "Slack UX: Socket Mode streaming | Webhook posts."

**Recommended fix:** Explicitly specify the Slack delivery model in the 2.0 spec:
1. Migrate to Slack Events API (webhook). The Worker's `fetch` handler receives `POST /slack/events`, verifies the `X-Slack-Signature` header, and routes to the Orchestrator DO.
2. Deduplication: the Orchestrator DO's `isSlackEventProcessed` (already in `StorageAdapter`) handles Slack's 3x retry behavior.
3. Interactive payloads (Block Kit button presses for human-in-the-loop gates) go to a separate `POST /slack/interactive` handler. Specify this explicitly.
4. Update the Slack app manifest: disable Socket Mode, set Request URL to the Workers deployment URL.

---

### [ARCHITECTURAL_RISK — HIGH] WASM Core adds unjustified complexity with no stated benefit over TypeScript

**Component:** WASM Core (TinyGo + syumai/workers)

The spec proposes TinyGo WASM for "core agent dispatch logic, running inside Workers isolates via syumai/workers." The existing codebase has a fully functional TypeScript DO implementation (`edge/worker/src/index.ts`) that already handles Orchestrator dispatch. There is no stated reason why this logic must be rewritten in Go.

Specific risks of the WASM Core approach:

**Bundle size pressure:** TinyGo WASM for a non-trivial agent dispatcher will be large. The 10 MB gzip limit applies to the entire Worker bundle (WASM binary + JS glue). A complex dispatcher with JSON parsing, DO stub calls, and routing logic can easily approach this limit. TypeScript compiles to <100 KB.

**TinyGo goroutine cooperative scheduling in WASM:** TinyGo implements goroutines as a cooperative scheduler on a single OS thread. In WASM (single-threaded runtime), goroutines only yield at explicit `runtime.Gosched()` calls, channel operations, or I/O boundaries. If any goroutine in the dispatch loop makes a blocking call without properly yielding (e.g., a synchronous `time.Sleep`, or a long computation without yields), the entire WASM instance stalls and blocks the Worker isolate. CF Workers' single-threaded runtime cannot preempt the WASM module.

This is solvable but requires the Go code to be written with cooperative scheduling explicitly in mind — a non-obvious constraint for Go developers accustomed to OS thread preemption.

**WASI support is experimental:** If the dispatcher needs any syscalls (filesystem, clock, random), it depends on CF's experimental WASI support. Some syscalls are not implemented. The spec does not specify which WASI capabilities the dispatcher needs.

**Two build pipelines:** Adding TinyGo means maintaining a Go toolchain, `wasm-opt`, and a separate build step alongside the TypeScript build. This increases CI complexity and onboarding friction.

**Recommended fix:** Do not use TinyGo WASM for the orchestrator dispatch logic unless there is a specific technical requirement that TypeScript cannot satisfy (e.g., a critical path algorithm that is genuinely faster in WASM). The existing TypeScript DO implementation is correct, tested, and does not hit the 128 MB memory or 10 MB bundle limits. If WASM is used for a genuinely performance-sensitive inner loop (e.g., a custom context compression algorithm), scope it tightly to that function and document why. Remove the "WASM Core" as an architectural component if the only benefit is language preference.

---

### [GAP — HIGH] Durable Object granularity is not specified

**Component:** Orchestrator, State

The spec says "SQLite Durable Objects (conversation state, task queue, agent logs)" but does not specify the DO naming scheme — i.e., what the `idFromName()` key is per DO class.

This is a critical design decision because it determines data isolation, cost, and cross-contamination risk:

- **Per Slack workspace:** One Orchestrator DO per workspace. All threads share one SQLite database. Risk: a large workspace with many concurrent tasks hits SQLite row lock contention. Benefit: cross-thread queries (e.g., "is this event already handled?") are cheap.
- **Per thread (existing `edge/` approach):** `idFromName(threadKey)`. Each thread gets its own DO. No cross-contamination. Cross-thread queries (workspace-level deduplication) require a second lookup or a global index DO.
- **Per agent session:** One DO per task ID. Finest-grained isolation, but creates N DOs per thread for multi-turn sessions.

The existing `edge/` implementation uses `idFromName(body.threadKey)` — one Orchestrator DO per thread. This is a reasonable default but the spec should make it explicit.

There is also a missing global index: Slack event deduplication (`isSlackEventProcessed`) needs to be workspace-scoped to catch the same event arriving before a thread-keyed DO exists. The existing Postgres implementation handles this with a global table. The DO implementation would need a separate "global index" DO or use KV.

**Recommended fix:** Specify the DO naming scheme in the spec for each class:
- `Orchestrator`: one per Slack thread (`idFromName(teamId + ":" + channelId + ":" + threadTs)`)
- `Researcher` / `Verifier`: one per task ID
- Add a `WorkspaceIndex` DO keyed by `teamId` for workspace-level deduplication and cross-thread queries

---

### [GAP — HIGH] No migration path from Railway + Postgres

**Component:** All

The spec describes the target 2.0 state but does not describe how to get from the current system (Railway + Postgres + Node.js + CopilotKit/AG-UI) to the new system. The existing system has production traffic and stored state (tasks, sessions, delivery obligations).

The `StorageAdapter` interface already abstracts Postgres vs. DO SQLite, which is the most important migration enabler. But several migration concerns are unaddressed:

- CopilotKit/AG-UI is the current agent-runtime protocol (`CopilotSseRuntime`, `BuiltInAgent`, `convertInputToTanStackAI`). The 2.0 spec replaces this with direct Sandbox SDK orchestration. No bridge or deprecation path is described.
- The existing `runtime.ts` and `runtime-research.ts` runtimes expose `POST /api/copilotkit/agent/*/run` endpoints that the Slack bot (`app/`) calls. The 2.0 architecture removes these in favor of DO-internal orchestration. The bot layer must be updated.
- Historical task and session data in Postgres is not addressable by the new DO SQLite system without a migration job.
- Railway-specific configuration (`railway.toml`, 3-service deployment) must be replaced with Wrangler deployment.

**Recommended fix:** Add a "Migration Plan" section to the spec with:
1. Phase 1 (parallel run): Deploy the CF edge track alongside the Railway track. Route new Slack workspaces to the edge track; existing workspaces stay on Railway. Evaluate via `docs/evaluation.md` criteria.
2. Phase 2 (Postgres → DO migration): Write a one-shot migration job that reads all active tasks/sessions from Postgres and writes them to the appropriate DO via the DO HTTP API. Only migrate non-terminal tasks (status = 'running' | 'pending').
3. Phase 3 (Railway shutdown): After all tasks drain and metrics confirm parity, decommission the Railway services and Postgres instance.
4. Define the CopilotKit/AG-UI deprecation: either keep the bot layer calling an AG-UI-compatible endpoint (a thin adapter in the Worker), or rewrite the bot to call DO stubs directly.

---

### [GAP — HIGH] Context-Hardening Loop is a name without an implementation spec

**Component:** Context-Hardening Loop

The spec describes this as "iterative refinement loop where context is compressed and validated before agent handoff" but provides no implementation details. As a result, it is not implementable.

The existing codebase has a partial implementation of context compression: `shouldCompactContext(data, threshold = 80_000)` in `fiber.ts` triggers when estimated tokens exceed 80,000. But "compression" is not implemented — the function returns a boolean; the caller decides what to do with it.

The spec's concept appears to combine two distinct operations that need separate specs:

**Context compression:** Reducing the token count of the context passed between agents. Missing: What compression algorithm? Options include sliding window (drop oldest messages), semantic summarization (LLM-generated summary of prior turns), or structured extraction (pull only facts and decisions, discard reasoning chains). Who runs the compressor (the orchestrator, or the sender agent)? What is the target token budget post-compression?

**Context validation ("hardening"):** Verifying that the compressed context is sufficient for the receiving agent to proceed correctly. Missing: What does "valid" mean? Options include: verifier LLM checks the summary against the original objective; structural checks (required fields present); or acceptance criteria matching. What happens if validation fails — retry compression, abort the task, or pass with a warning?

**Recommended fix:** Specify the following for each loop iteration:
1. Trigger condition (e.g., `estimatedTokens >= 80_000` before handoff to next agent)
2. Compression strategy (recommendation: LLM-generated structured summary preserving: objective, decisions made, code written, tests run, open questions)
3. Validation check (recommendation: re-run the Verifier on the compressed summary; if verdict = 'reject', abort with error; if 'revise', retry compression once)
4. Maximum iterations before giving up (recommendation: 2 compression rounds, then abort)
5. Token budget target (recommendation: <20,000 tokens post-compression)
6. Wire to the existing `Verifier` class, which already implements the pass/revise/reject loop

---

### [GAP — MEDIUM] No cost model or resource budget

**Component:** All

The spec proposes a system that bills on multiple dimensions simultaneously, with no cost projections. The combination of CF Workers (per-request), Durable Objects (per-request + storage), CF Containers (container-minutes), and R2 (operations + storage) can produce unexpected bills.

Specific cost traps:

**Container-minutes:** If each agent session (PM + Implementation + Verification) requires 3 separate containers and each container runs for 5 minutes minimum (due to cold start + work), a single user request consumes ~15 container-minutes. At scale, this is the dominant cost. The spec does not specify container timeout/destruction policy.

**DO requests:** The delivery polling loop in `runtime-research.ts` calls `getPendingDeliveries()` every 5 seconds. On the CF track, this is a DO request on every poll. With many active sessions, this becomes a large number of DO reads. The fix is DO Alarms (already supported in the existing `edge/` code) instead of polling.

**Subrequest budget:** CF Workers allow 10,000 subrequests per invocation. An orchestrator that fans out to 3 agents per task and each agent makes 20 tool calls could approach this limit in a single Worker invocation if not properly sequenced through DO alarms.

**Recommended fix:** Add a "Cost Model" section to the spec with:
1. Estimated container-minutes per task (worst case, p50, p95)
2. Maximum container run time before forced shutdown
3. Transition all delivery polling to DO Alarms (already in the existing `AlarmQueueItem` system)
4. A budget cap per task: the existing `TaskBudget` type (`maxAlarms`, `maxLlmCalls`, `maxToolCalls`) is already in the codebase; bind it to a dollar estimate and add `maxContainerMinutes`

---

### [GAP — MEDIUM] MCP server as shared context surface is absent

**Component:** Agent architecture

WorkOS Project Horizon explicitly identified a shared MCP server as a critical component: agents use it to access Datadog, Sentry, Slack, and other services without per-agent credential setup. The spec describes per-agent tool access but has no equivalent component.

Without a shared MCP surface:
- Every agent type must independently manage credentials for every external service
- Adding a new integration (e.g., Linear for ticket creation) requires updating every agent's credential set
- Verification agents cannot query the same observability tooling that the implementation agent used without separate credential injection

**Recommended fix:** Add a Worker-hosted MCP server as a named component in the 2.0 architecture. It should:
- Expose tools for all external services (Linear, Notion, Sentry, Datadog, Slack API)
- Accept a short-lived session token (injected by the orchestrator into each container at startup via env var `MCP_SESSION_TOKEN`)
- Validate the session token against the orchestrator DO before serving any tool call
- Be the only component that holds long-lived API keys for external services

---

### [GAP — MEDIUM] Container lifecycle management is underspecified

**Component:** Ephemeral Containers, Sandbox SDK

The spec says containers are "destroyed after completion" but does not specify:
- What "completion" means (agent returns success? agent errors out? timeout?)
- Who is responsible for destruction (the orchestrator? an alarm? the container itself?)
- What happens to containers whose parent session is marked 'superseded' (the existing code marks older tasks as superseded when a newer mention arrives on the same thread — the container must also be stopped)
- What happens if the orchestrator DO crashes or restarts while a container is running
- Maximum container wall-clock lifetime (failsafe TTL)

The Sandbox SDK does not automatically destroy sandboxes; the caller must call the appropriate lifecycle API. If the orchestrator fails to call it (e.g., due to a DO restart), containers can leak and accumulate billing.

**Recommended fix:** Specify the lifecycle contract:
1. Container TTL: 30 minutes maximum wall-clock time. The orchestrator DO sets a DO Alarm at `startTime + 30min` that calls the sandbox destruction API regardless of agent status.
2. Superseded task cleanup: when `updateTaskStatus(taskId, 'superseded')` is called, the orchestrator immediately calls the sandbox destruction API for the superseded task's container.
3. Container handle storage: the sandbox ID is stored in the session's `SessionStateData` (add a `sandboxId?: string` field) so the orchestrator can destroy it even after a restart.

---

### [GAP — MEDIUM] No observability or agent session inspection strategy

**Component:** All

The existing system has no observability beyond console logs and Postgres tables. The 2.0 spec mentions agent logs in DO SQLite but does not describe how engineers will inspect a failed agent session, replay a failed step, or understand why a container produced wrong output.

The existing `ResearchLogEntry` type and `research_log` table in the DO SQLite adapter provide a step-by-step log of every tool call, but there is no UI, query interface, or alerting on this data.

WorkOS's self-improving loop (agent sessions surface friction → another agent ingests session logs → platform improvements) requires that session logs be accessible and queryable. This is entirely absent from the spec.

**Recommended fix:**
1. Add a `GET /admin/sessions/:taskId` Worker endpoint that reads logs from the session's DO and returns them as JSON (protected by a static bearer token in a Worker secret).
2. Specify that session logs are written to an R2 key (`sessions/<taskId>/log.jsonl`) at completion for long-term retention and batch analysis.
3. Add a `logLevel` env var to containers so agent log verbosity can be increased without redeployment.
4. Consider a lightweight self-improving loop: after task completion, an asynchronous Worker Queue consumer reads the session log, identifies tool calls that took >10s or returned errors, and appends a summary to a `friction_log` R2 object.

---

### [GAP — MEDIUM] No error handling or retry strategy for container failures

**Component:** Ephemeral Containers, Orchestrator

The spec does not describe what happens when:
- A container fails to start (boot error)
- A container's `sandbox.exec()` returns a non-zero exit code
- The network connection between the orchestrator DO and the container times out
- An agent inside the container hits the LLM API rate limit and throws

The existing Railway system has no container layer, so this is an entirely new failure domain. The existing Orchestrator/Researcher/Verifier code handles LLM failures at the adapter level (`DirectLlmAdapter` propagates errors) but not container-level failures.

**Recommended fix:** Define the retry contract in the spec:
1. Container boot failure: retry once after 5 seconds, then mark task as 'failed' and post error to Slack via delivery obligations.
2. `sandbox.exec()` non-zero exit: capture stderr, append to session log, and decide retry vs. abort based on exit code semantics (e.g., exit code 1 = agent logic error = retry once with revised prompt; exit code 137 = OOM = abort with error).
3. Orchestrator → container timeout: treat as container boot failure (same retry policy).
4. LLM rate limit: exponential backoff inside the container, max 3 retries, then abort.

---

### [UNVERIFIED_CLAIM — MEDIUM] PM Agent can reliably decompose tasks into trackable tickets without human review

**Component:** PM Agent

The spec describes the PM Agent as something that "plans tasks, creates implementation tickets" — implying that ticket creation happens automatically before any human review. In agentic coding pipelines, automated ticket creation without a human-in-the-loop gate is a known failure mode: LLMs frequently misinterpret ambiguous requirements, creating tickets for the wrong feature or at the wrong scope.

The existing codebase has a well-designed human-in-the-loop gate (`confirm_write` in `runtime.ts`) that blocks all write operations until a user presses Approve in Slack. The spec does not mention whether the PM Agent's ticket creation goes through a similar gate.

**Recommended fix:** Specify explicitly: ticket creation by the PM Agent must display a Slack confirmation card (with the proposed ticket title, description, and acceptance criteria) and block on user approval before writing to Linear or any issue tracker. Use the existing `confirm_write` tool pattern. Do not allow fully autonomous ticket creation without a human-in-the-loop gate.

---

### [UNVERIFIED_CLAIM — LOW] "One container per agent session, destroyed after completion" can be cost-effectively sustained under load

**Component:** Ephemeral Containers

The spec treats one-container-per-session as a simple architectural fact. The cost and lifecycle implications of this at scale are unverified. If OpenTag 2.0 serves a large Slack workspace with 50 concurrent engineering tasks, each of which requires 3 agent containers (PM + Implementation + Verification), that is 150 simultaneous containers. Container startup latency compounds: if a verification agent must wait for an implementation agent's container to complete before its own container boots, total latency can exceed 10 minutes for a single task.

This is not necessarily a blocker — but the claim that ephemeral-per-session containers are the right granularity for all scenarios has not been verified in the OpenTag context.

**Recommended fix:** Validate the container-per-session model with a load test before committing to it. Consider container reuse within a session (the implementation agent's container continues running while the verification agent boots, rather than the implementation agent destroying its container first), which allows the verification agent to inspect the live filesystem instead of relying only on exported artifacts.

---

### [ARCHITECTURAL_RISK — LOW] TinyGo cooperative goroutines require explicit yield discipline in dispatcher code

**Component:** WASM Core

(Conditional on the WASM Core component being retained after addressing the HIGH-severity concern above.)

TinyGo goroutines in WASM operate on a cooperative scheduler. A goroutine that performs a long synchronous computation — even one that looks purely CPU-bound — must call `runtime.Gosched()` periodically to yield to other goroutines. In the CF Workers single-threaded runtime, a stalled goroutine blocks the entire isolate, preventing other requests from being handled.

This is not a CF constraint; it is a TinyGo-in-WASM constraint. Standard Go uses OS thread preemption; TinyGo in WASM does not. Any Go developers writing dispatcher logic must be explicitly aware of this.

**Recommended fix:** Add a code review checklist item: all goroutines in the WASM dispatcher that execute more than ~1ms of synchronous computation must include `runtime.Gosched()` yield points. Consider adding a CI lint rule that flags goroutines without yield points above a code-complexity threshold.

---

### [GAP — LOW] Self-improving loop (WorkOS validated) is absent from the spec

**Component:** All

WorkOS identified a self-improving feedback loop as one of the highest-leverage components of their architecture: agent sessions surface friction (slow steps, tool errors, failed verifications), another agent ingests the session logs, and the platform improves (better prompts, faster tool calls, added retries). This loop was not possible until session logs were reliably persisted.

The spec does not mention any equivalent mechanism.

**Recommended fix:** Add the self-improving loop as a Phase 2 feature (post-launch). Prerequisites: session logs in R2 (see observability gap above). Implementation: a Worker Queue consumer that triggers after every task completion, reads the session log, and writes a structured "friction summary" to a `platform_improvements` DO or R2 prefix. Periodically, a human reviews the friction summaries and updates prompts or tool configurations.

---

## Summary Table

| # | Tag | Severity | Component | One-line summary |
|---|-----|----------|-----------|-----------------|
| 1 | `FACTUAL_ERROR` | **CRITICAL** | Egress Proxy | CF Workers TCP API is outbound-only; Workers cannot intercept container TCP traffic — spec describes a nonexistent capability |
| 2 | `GAP` | **CRITICAL** | Containers, UX | 2–3 min cold start not addressed; no Slack acknowledgment, no pre-warm strategy |
| 3 | `GAP` | **HIGH** | Orchestrator, Slack | Socket Mode cannot run on CF Workers; Events API (webhook) migration not specified |
| 4 | `ARCHITECTURAL_RISK` | **HIGH** | WASM Core | TinyGo adds unjustified complexity over existing TypeScript DO code; cooperative goroutine risks |
| 5 | `GAP` | **HIGH** | Orchestrator, State | DO granularity (per-thread? per-workspace?) not specified; workspace-level deduplication missing |
| 6 | `GAP` | **HIGH** | All | No migration path from Railway + Postgres; CopilotKit/AG-UI deprecation unaddressed |
| 7 | `GAP` | **HIGH** | Context-Hardening Loop | Compression algorithm, validation criteria, iteration limit, token budget all absent |
| 8 | `GAP` | **MEDIUM** | All | No cost model; container-minute accumulation and DO polling are cost traps |
| 9 | `GAP` | **MEDIUM** | Agent architecture | No shared MCP server; credentials must be duplicated per agent type |
| 10 | `GAP` | **MEDIUM** | Containers | Container destruction triggers, superseded-task cleanup, and leak prevention unspecified |
| 11 | `GAP` | **MEDIUM** | All | No observability strategy; no way to inspect failed agent sessions |
| 12 | `GAP` | **MEDIUM** | Containers, Orchestrator | No container failure or retry policy defined |
| 13 | `UNVERIFIED_CLAIM` | **MEDIUM** | PM Agent | Autonomous ticket creation without human-in-the-loop gate is likely a UX/trust failure |
| 14 | `UNVERIFIED_CLAIM` | **LOW** | Containers | One-container-per-session at load not validated; may hit latency compounding |
| 15 | `ARCHITECTURAL_RISK` | **LOW** | WASM Core | Cooperative goroutine yield discipline required; must be enforced in code review |
| 16 | `GAP` | **LOW** | All | Self-improving feedback loop (WorkOS-validated) absent from spec |

---

## Recommended Priority Order

**Do first (before any implementation starts):**
- Issue 3 (Slack delivery model) — must decide between Socket Mode and Events API before writing any Worker handler code
- Issue 5 (DO granularity) — determines the data model for everything else
- Issue 1 (Egress Proxy) — design the application-level proxy SDK before writing any agent code that makes outbound calls
- Issue 6 (Migration path) — without this, 2.0 cannot ship alongside the existing system

**Do during implementation:**
- Issue 2 (Cold start) — prebuild images and warm pool before any UX testing
- Issue 7 (Context-Hardening Loop) — spec must be complete before the loop is coded
- Issue 10 (Container lifecycle) — implement the 30-minute TTL alarm on day one; container leaks are silent and costly
- Issue 12 (Error handling) — define retry policy before writing any integration tests

**Do before production:**
- Issues 8, 9, 11, 13 (Cost model, MCP server, Observability, PM Agent HITL)

**Defer to Phase 2:**
- Issues 4 (WASM Core — consider dropping), 14, 15, 16

---

*Document generated 2026-07-11. Verified platform facts used as ground truth: CF Workers memory 128 MB, CPU 30s/5min max, WASM single-threaded (no Web Workers), DO wall time unlimited (15 min alarms), Sandbox SDK GA, Firecracker microVMs for containers, subrequest limit 10,000/invocation.*
