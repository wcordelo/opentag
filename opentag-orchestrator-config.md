=== ORCHESTRATOR CONFIG START ===
# HISTORICAL — see PRODUCT.md for Claude Tag on CF. Research is a task flavor.
CONFIG VERSION: 1.1
PROJECT: OpenTag
OBJECTIVE: Migrate OpenTag from Railway + Postgres + Node.js to a fully Cloudflare-native multi-agent pipeline (Hono + Durable Objects + Containers via Sandbox SDK + TinyGo WASM), with lib/research/ actor core reused unchanged and all Slack integration migrated from Socket Mode to Events API.

STACK: TypeScript, Hono, Cloudflare Workers, Durable Objects (SQLite), @cloudflare/sandbox (CF Containers), TinyGo WASM via syumai/workers, wasm-opt, R2 (blobs), Workers KV (workspace registry), Workers Queues (async dispatch), Slack Events API + Web API (chat.postMessage), Anthropic API (Claude), OpenAI API (optional), Parallel API (web search), Egress Proxy Worker (application-level HTTP proxy for containers), MCP server Worker (shared context), Wrangler

CONSTRAINTS: none

REQUIRED CONNECTORS: none

INVARIANTS (copied verbatim into every subagent brief — never from memory):
  1. Socket Mode is forbidden — all Slack communication uses Events API (HTTP endpoint) and Slack Web API (chat.postMessage); Socket Mode is architecturally incompatible with CF Workers and must never be used.
  2. Egress proxy must be application-level — agent code in containers routes all outbound HTTP through a named CF Worker URL; the Worker proxies the external call and returns the response; transparent OS-level TCP interception is impossible and must not be attempted.
  3. Actor code targets the adapter interface only — lib/research/ (Orchestrator, Researcher, Verifier, DurableObjectStorageAdapter) is reused unchanged; actor code never imports pg, DurableObject, or any storage primitive directly.
  4. TinyGo is mandatory for the WASM core — CF Workers enforce a 10 MB gzip bundle limit; wasm-opt must run on every CI build; no goroutines, no system threads, no WASI syscalls in the WASM module.
  5. Container cold start is asynchronous — every code path that could boot a new container must (a) send an immediate Slack acknowledgment before awaiting the container, and (b) deliver the final result via chat.postMessage when complete; no synchronous HTTP request must block on a cold boot (first-boot latency is 2–3 min per WorkOS production data).
  6. DO naming is per workspace — each Slack workspace gets exactly one Orchestrator DO identified by its workspace ID; changing this granularity after deployment requires an explicit data migration and must not be altered ad hoc.

PARALLELIZATION FLOOR (minimum independent tracks to fan out):
  - Gate 0 (decisions, must complete first): DO naming granularity confirmation + egress proxy design document + Socket Mode → Events API webhook shape
  - Track A: Orchestrator DO + DurableObjectStorageAdapter integration + DO SQLite schema (after Gate 0)
  - Track B: Slack Events API webhook handler + signature verification + slash command routing (after Gate 0)
  - Track C: Egress Proxy Worker implementation + Sandbox SDK integration + container lifecycle (after Gate 0)
  - Track D: TinyGo WASM core via syumai/workers + wasm-opt CI pipeline (parallel, decoupled from above)
  - Track E: Testing infrastructure + CI pipeline + integration test harness (parallel, starts immediately)
  - Track F: Agent framework (PM/Implementation/Verification agents + LLM provider integration) (after A+B+C)
  - Track G: Data migration script (Postgres → DO SQLite) + validation tooling (after A schema is frozen)

MILESTONES (each a deterministic, checkable stop condition — never "none"):
  M1: Foundation — DONE WHEN wrangler dev boots without errors, GET /health returns 200, a test Slack Events API POST with valid signature returns 200, wrangler.toml declares durable_objects + r2_buckets + queues bindings, and Gate 0 decisions are documented in DECISIONS.md.
  M2: Orchestrator Core — DONE WHEN a test event creates a per-workspace DO instance, lib/research/ Orchestrator is called via DurableObjectStorageAdapter, a task record is persisted to DO SQLite, and a fresh DO read returns the correct task state; all DurableObjectStorageAdapter unit tests pass.
  M3: TinyGo WASM Core — DONE WHEN TinyGo binary builds in CI in under 3 minutes, wasm-opt output is verifiably ≤10 MB gzip, the WASM module loads in a CF Worker via wrangler dev, and a test HTTP request returns a valid response end-to-end.
  M4: Egress + Sandbox — DONE WHEN agent code inside a Sandbox container routes a test HTTP call through the egress Worker URL and receives the correct response; getSandbox()/exec() lifecycle completes in wrangler dev; cold-start path sends a Slack ack message before the container is ready (verified by test).
  M5: Agent Framework — DONE WHEN PM/Implementation/Verification agents complete a full research loop (start → tool calls → structured result) in wrangler dev; lib/research/ Researcher and Verifier execute without modification; all agent unit tests pass.
  M6: Slack Integration — DONE WHEN a real /research slash command in a test Slack workspace triggers the full pipeline and posts a structured result back to the correct thread via chat.postMessage; the event handler is idempotent (duplicate Slack retries do not create duplicate tasks, verified by test).
  M7: Data Migration — DONE WHEN migration script reads all Postgres task/blob records, writes them to DO SQLite + R2, runs idempotently (second run produces no changes), and a validation query over both sources returns identical task counts and checksums for 100% of records.
  M8: Production Deploy — DONE WHEN wrangler deploy succeeds to CF production account, all integration tests in the test suite pass against the production environment, and a real end-to-end research request completes successfully in a production Slack workspace.

CHECK-IN CADENCE: autonomous (check in at milestones M1, M4, M8 only — trust the runner to proceed between)

BUDGET CAP: 30 subagent calls (hard safety limit — NOTE: this build is large; runner should flag at 22 calls used so user can decide whether to extend)

EXTERNAL ACTIONS (require explicit user confirmation before executing):
  - Cloudflare Workers deploy (wrangler deploy to production)
  - DB migration (Postgres → DO SQLite, irreversible)
  - GitHub push / PR creation
  - Live Slack messages sent to real workspaces

SUBJECTIVE ACCEPTANCE: no

NOTION HUB: no
=== ORCHESTRATOR CONFIG END ===

---

## Stack deep-dive notes (Q2 reasoning)

Beyond the initial framing, these are the components requiring explicit decisions:

**LLM routing in containers**: The Researcher agent calls Anthropic/OpenAI APIs. Inside a Sandbox container, outbound calls go through the egress proxy Worker. The proxy must handle API key injection (so keys never reach the container directly). Decision needed: inject via headers or environment variable in the container?

**Workers Queues vs DO alarms**: The current system uses `alarm_queue` (a Postgres-backed queue) to dispatch research jobs. CF replacement options: (a) Workers Queues (push-based, reliable delivery, separate from DO) or (b) DO `alarm()` (pull-based, simpler but single-DO-scoped). Recommendation: Workers Queues for cross-workspace fan-out, DO alarms for per-workspace retry logic.

**Web search in container environment**: The existing Parallel API integration (Node.js) must run inside the Sandbox container. Since containers run Node.js, the existing code should work — but egress routing must be verified.

**KV for workspace registry**: Multi-workspace support requires knowing which workspace ID maps to which CF account/config. Workers KV is the natural fit for this lookup table.

**MCP server Worker**: Per WorkOS Horizon pattern, a shared MCP server provides agents a common context surface (tools, workspace config, shared memory). This is a separate Worker that agents call via fetch().

## Build track deep-dive notes (Q4 reasoning)

Two tracks from the original list need splitting:

**State/SQLite** should be split into:
- Schema design (part of Orchestrator track, M2)
- Data migration (separate Track G, gates on M2 schema being frozen)

**Testing infrastructure** should be an explicit track (Track E), not left as an afterthought. Acceptance is "test suite passes" — you need the harness to know when you're done.

**Strict sequencing enforced by architecture**:
1. Gate 0 must complete before any Worker code is written — the egress proxy design and Events API shape determine the interface contracts everything else depends on.
2. Data migration (Track G) cannot start until the DO SQLite schema (Track A) is frozen — migrating to a moving target breaks the migration script.
3. Agent framework (Track F) cannot start until Tracks A, B, C all have working interfaces — agents need the orchestrator, the Slack handler, and the egress proxy to run end-to-end.
