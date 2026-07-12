# OpenTag 2.0 — Goal Prompt for `/goal` skill

> **Superseded for product direction.** Use [`PRODUCT.md`](PRODUCT.md) /
> [`DECISIONS.md`](DECISIONS.md) “Product supersession”. This file remains the
> *research task migration* goal (Track A/B/C). Claude Tag on CF = bot +
> StateStore spine; research is one TaskRuntime flavor.

Paste this as the goal when you run `/goal` in Claude Code inside the opentag repo
**for the research-task migration track only**.

---

## Goal

Migrate OpenTag **research task workers** from Railway + Postgres + Node.js to a
Cloudflare-native pipeline: Hono + Durable Objects (SQLite) + CF Containers via
@cloudflare/sandbox + optional TinyGo WASM. The `lib/research/` actor core
(Orchestrator, Researcher, Verifier, DurableObjectStorageAdapter) is reused
UNCHANGED. Slack for research uses Events API + chat.postMessage (invoked from
the bot TaskRuntime — not as the sole product surface).

**Acceptance (research track):** research task suite passes; a `/research` (or
bot-enqueued research) request completes and posts back to the Slack thread.

---

## Stack

TypeScript, Hono, Cloudflare Workers, Durable Objects (SQLite), @cloudflare/sandbox, TinyGo WASM via syumai/workers, wasm-opt, R2 (blobs), Workers KV (workspace registry), Workers Queues (async dispatch), Slack Events API + Web API (chat.postMessage), Anthropic API, OpenAI API (optional), Parallel API (web search), Egress Proxy Worker (app-level HTTP proxy for containers), MCP server Worker (shared context), Wrangler.

---

## Hard invariants — enforce in every subagent brief

1. **Socket Mode is forbidden.** All Slack comms use Events API (HTTP endpoint) + Slack Web API (chat.postMessage). Socket Mode is architecturally incompatible with CF Workers.
2. **Egress proxy must be application-level.** Agent code in containers routes all outbound HTTP through a named CF Worker URL. Transparent OS-level TCP interception is impossible — do not attempt it.
3. **Actor code targets the adapter interface only.** `lib/research/` is reused unchanged. Actor code never imports `pg`, `DurableObject`, or any storage primitive directly.
4. **TinyGo is mandatory for the WASM core.** CF Workers enforce a 10 MB gzip bundle limit. `wasm-opt` must run on every CI build. No goroutines, system threads, or WASI syscalls in the WASM module.
5. **Container cold start is asynchronous.** Every code path that could boot a new container must: (a) send an immediate Slack ack before awaiting the container, and (b) deliver the final result via chat.postMessage when complete. No synchronous HTTP request may block on a cold boot (first-boot latency is 2–3 min per WorkOS production data).
6. **DO naming is per workspace.** Each Slack workspace gets exactly one Orchestrator DO identified by its workspace ID. Changing this granularity after deployment requires an explicit data migration.

---

## Sequencing

**Gate 0 first (must complete before any Worker code):**
- Document DO naming granularity decision
- Write egress proxy design doc (app-level HTTP proxy, not transparent TCP)
- Document Events API webhook shape (endpoint, signature verification, slash command routing)

**After Gate 0, these tracks are independent:**
- Track A: Orchestrator DO + DurableObjectStorageAdapter integration + DO SQLite schema
- Track B: Slack Events API webhook handler + signature verification + slash command routing
- Track C: Egress Proxy Worker + Sandbox SDK integration + container lifecycle
- Track D: TinyGo WASM core via syumai/workers + wasm-opt CI pipeline *(parallel, decoupled)*
- Track E: Testing infrastructure + CI pipeline + integration test harness *(parallel, starts immediately)*

**After A + B + C:**
- Track F: Agent framework (PM / Implementation / Verification agents + LLM provider integration)

**After A schema is frozen:**
- Track G: Data migration script (Postgres → DO SQLite) + validation tooling

---

## Milestones

- **M1 Foundation:** `wrangler dev` boots without errors; GET /health → 200; test Slack Events API POST with valid signature → 200; `wrangler.toml` declares `durable_objects + r2_buckets + queues` bindings; Gate 0 decisions in DECISIONS.md.
- **M2 Orchestrator Core:** test event creates per-workspace DO instance; `lib/research/` Orchestrator called via DurableObjectStorageAdapter; task record persisted to DO SQLite; fresh DO read returns correct state; all DurableObjectStorageAdapter unit tests pass.
- **M3 TinyGo WASM Core:** TinyGo builds in CI in <3 min; wasm-opt output verifiably ≤10 MB gzip; WASM module loads in CF Worker via `wrangler dev`; test HTTP request returns valid response end-to-end.
- **M4 Egress + Sandbox:** agent code inside Sandbox container routes test HTTP call through egress Worker URL and gets correct response; getSandbox()/exec() lifecycle completes in `wrangler dev`; cold-start path sends Slack ack before container is ready (verified by test).
- **M5 Agent Framework:** PM/Implementation/Verification agents complete full research loop (start → tool calls → structured result) in `wrangler dev`; `lib/research/` Researcher and Verifier run without modification; all agent unit tests pass.
- **M6 Slack Integration:** real `/research` slash command in test Slack workspace triggers full pipeline and posts structured result back to correct thread via chat.postMessage; event handler is idempotent (duplicate Slack retries don't create duplicate tasks, verified by test).
- **M7 Data Migration:** migration script reads all Postgres task/blob records, writes to DO SQLite + R2, runs idempotently (second run produces no changes); validation query over both sources returns identical task counts and checksums for 100% of records.
- **M8 Production Deploy:** `wrangler deploy` succeeds to CF production account; all integration tests pass against production environment; real end-to-end research request completes in production Slack workspace.

---

## Autonomy & HITL

**Default: fully autonomous.** Proceed through all milestones without stopping for check-ins. Do not ask for approval between M1–M7.

**Pause and wait for explicit confirmation only at these gates:**

1. **Gate 0 sign-off** — before writing any Worker code, show the DO naming decision + egress proxy design + Events API webhook shape as a single summary and wait for a "looks good / proceed" before starting Track A/B/C.
2. **Before any external action** (all four below require a fresh explicit yes every time — silence is never a yes):
   - `wrangler deploy` to CF production account
   - DB migration (Postgres → DO SQLite — irreversible)
   - GitHub push / PR creation
   - Live Slack messages to real workspaces
3. **Architectural surprise mid-build** — if you discover something that contradicts the invariants or requires a design decision not covered here (e.g., a CF platform limitation that changes the egress proxy approach, a DO SQLite API gap that affects schema design), stop, describe the finding and your proposed resolution, and wait for a yes before proceeding.
4. **M8 final deploy** — present the full test results and ask for final sign-off before `wrangler deploy` to production.

Everything else — implementation choices, file structure, retry logic, test coverage decisions, milestone ordering within the tracks — make the call and proceed.

---

## Notes

Full technical audit (16 findings, 2 critical) and 35-task implementation spec are at:
- `~/Documents/opentag/opentag-2.0-analysis.md`
- `~/Documents/opentag/opentag-2.0-impl-spec.md`

The existing `edge/` Worker is the starting point. `wrangler.jsonc` → `wrangler.toml` is the first file change.
