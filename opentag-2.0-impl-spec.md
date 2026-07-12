# OpenTag 2.0 — Cloudflare Implementation Spec

**Status:** Draft v1.0 · July 2026  
**Scope:** Full migration from Railway + Postgres + Node.js to Cloudflare-native multi-agent pipeline  
**Target readers:** Coding agents and engineers executing this build

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Build Order (Critical Path)](#build-order-critical-path)
3. [Dependency Graph](#dependency-graph)
4. [Codebase Baseline](#codebase-baseline)
5. [Platform Constraints Reference](#platform-constraints-reference)
6. [Phase 1 — Foundation](#phase-1--foundation)
7. [Phase 2 — Orchestrator Core](#phase-2--orchestrator-core)
8. [Phase 3 — Sandbox Integration & Egress Proxy](#phase-3--sandbox-integration--egress-proxy)
9. [Phase 4 — Agent Framework & MCP Server](#phase-4--agent-framework--mcp-server)
10. [Phase 5 — WASM Core](#phase-5--wasm-core)
11. [Phase 6 — Context-Hardening Loop](#phase-6--context-hardening-loop)
12. [Phase 7 — State Layer](#phase-7--state-layer)
13. [Phase 8 — Integration & Migration](#phase-8--integration--migration)
14. [Appendix A — Environment Variables](#appendix-a--environment-variables)
15. [Appendix B — File Layout](#appendix-b--file-layout)

---

## Executive Summary

OpenTag 2.0 replaces three Railway Node.js services (bot, research runtime, alarm worker) and a Postgres database with a Cloudflare-native multi-agent pipeline. The new architecture runs entirely on Cloudflare's edge: Hono + Durable Objects as the orchestration plane, Cloudflare Containers (Sandbox SDK) as the ephemeral execution plane for agents, a Workers egress proxy that controls all container outbound traffic, a TinyGo WASM core for hot dispatch logic, and SQLite-backed Durable Objects for all persistent state.

The Slack integration switches from Socket Mode (long-running TCP connection, incompatible with Workers) to an Events API webhook handled by the Hono router.

**What already exists and can be reused:**
- `lib/research/` — adapter-agnostic Orchestrator, Researcher, Verifier, fiber, types
- `lib/research/adapters/storage-do.ts` — DurableObjectStorageAdapter (complete)
- `lib/research/migrations/001_initial.sql` — full SQLite schema
- `edge/worker/src/index.ts` — thin DO shells (Orchestrator, Researcher, Verifier)
- `edge/wrangler.jsonc` — DO bindings + R2 bucket + SQLite migrations

**Net-new work (this spec):**
- Hono router replacing the raw `fetch()` handler
- Slack Events API webhook verification and routing
- Sandbox SDK container lifecycle (start, kill, preview URL negotiation)
- Egress proxy Worker (allowlist + token injection)
- PM / Implementation / Verification agent role classes
- MCP server stub (Slack, logs, errors as MCP tools)
- TinyGo WASM core via `syumai/workers`
- Context-hardening loop (compress → validate → hand off)
- SQLite schema extensions for agent execution logs
- Migration tooling and dual-run period

---

## Build Order (Critical Path)

```
P1  Foundation ──────────────────────────────────────────────────────────────────────────────────▶
     │
     ├─▶ P7  State Layer ─────────────────────────────────────────────────────────────────────────▶
     │                                                                                              │
     ├─▶ P2  Orchestrator Core ────────────────────────────────────────────────────────────────────▶
     │                          │                                                                   │
     ├─▶ P3  Sandbox + Egress ──┤                                                                   │
     │                          │                                                                   │
     │                          ├─▶ P4  Agent Framework ──▶ P6  Context-Hardening ─────────────────▶
     │                          │                                                                   │
     ├─▶ P5  WASM Core ─────────┘ (parallel, no blocking dep on P2/P3/P4)                         │
     │                                                                                              │
     └──────────────────────────────────────────────────────────────────────────────── P8  Integration & Migration
```

**Critical path (longest blocking chain):**
P1 → P2 → P4 → P6 → P8

**Parallelizable after P1:**
- P3 (Sandbox + Egress) — requires only P1
- P5 (WASM Core) — requires only P1
- P7 (State Layer) — requires only P1; can largely be done in parallel with P2

---

## Dependency Graph

| Phase | Depends on | Unlocks |
|-------|-----------|---------|
| P1 Foundation | — | P2, P3, P5, P7 |
| P2 Orchestrator Core | P1 | P4, P8 |
| P3 Sandbox + Egress | P1 | P4 |
| P4 Agent Framework | P2, P3 | P6 |
| P5 WASM Core | P1 | P8 (optional perf path) |
| P6 Context-Hardening | P4, P7 | P8 |
| P7 State Layer | P1 | P6, P8 |
| P8 Integration + Migration | P2, P4, P6, P7 | — (ship) |

---

## Codebase Baseline

All paths relative to repo root (`/Users/will/Documents/opentag`).

### Existing files that are reused unchanged

| File | Role |
|------|------|
| `lib/research/types.ts` | All shared types (TaskRecord, SessionState, etc.) |
| `lib/research/fiber.ts` | Step scheduling, budget, deadline helpers |
| `lib/research/mutex.ts` | In-memory serialization |
| `lib/research/occ.ts` | Optimistic-concurrency helpers |
| `lib/research/orchestrator.ts` | Core Orchestrator class |
| `lib/research/researcher.ts` | Core Researcher class (fiber-step runner) |
| `lib/research/verifier.ts` | Core Verifier class |
| `lib/research/adapters/storage.ts` | StorageAdapter interface |
| `lib/research/adapters/storage-do.ts` | DurableObjectStorageAdapter |
| `lib/research/adapters/storage-postgres.ts` | PostgresStorageAdapter (Railway keep-alive) |
| `lib/research/adapters/llm.ts` | LLM adapter |
| `lib/research/adapters/blob.ts` | Blob adapter |
| `lib/research/migrations/001_initial.sql` | SQLite schema (applied via DO migrations) |

### Existing files that are modified

| File | Modification |
|------|-------------|
| `edge/wrangler.jsonc` | Expand to full multi-worker wrangler.toml; add Sandbox, egress, WASM, KV, secrets |
| `edge/worker/src/index.ts` | Replace raw `fetch()` handler with Hono router; add Slack webhook; wire Sandbox |
| `edge/package.json` | Add hono, @cloudflare/sandbox, wasm-opt deps |
| `slack-app-manifest.json` | Switch from Socket Mode to Events API request URL |
| `slack-app-manifest.yaml` | Same |

### New files (this spec creates)

See [Appendix B — File Layout](#appendix-b--file-layout).

---

## Platform Constraints Reference

> These constraints must be respected in every phase. Tasks that touch a constrained surface call it out explicitly.

| Constraint | Value | Impact |
|-----------|-------|--------|
| Workers bundle size | 10 MB gzip max | TinyGo mandatory; standard Go toolchain too large. Enforce with `wasm-opt`. |
| Workers memory | 128 MB per isolate | Keep WASM binary + runtime heap under ~90 MB headroom. |
| Workers CPU (default) | 30 s wall time | Dispatch logic must be fast. Long-running work lives in DOs or containers. |
| Workers CPU (max) | 5 min via `cpu_ms: 300000` | Already set in `edge/wrangler.jsonc`. |
| DO wall time | Unlimited while HTTP connection is open | Orchestrator DO can hold long-running sessions as long as a request is connected. |
| Goroutines in WASM | IMPOSSIBLE | No goroutines in Workers WASM context. Use separate Worker invocations for concurrency. Never use `go func()` in TinyGo WASM. |
| WASM SIMD | OK | Can use SIMD for compression/hashing in WASM core. |
| WASM WASI | Experimental — avoid | Do not use WASI syscalls (file I/O, sockets) in WASM core. |
| Container cold start | 2–3 min first boot | Pre-warm containers; cache dependencies in container image. Accept cold-start latency in UX messaging. |
| Container preview URLs | Via `sandbox.tunnels.get()` | URLs do not survive container restart; re-negotiate on reconnect. |
| Sandbox SDK bootstrap | `npm create cloudflare@latest -- --template=cloudflare/sandbox-sdk/examples/minimal` | Use exact template for correct bindings. |
| syumai/workers template | `npm create cloudflare@latest -- --template github.com/syumai/workers/_templates/cloudflare/worker-tinygo` | Use exact template. |
| wasm-opt | Required build step | Run `wasm-opt -O3 main.wasm -o main.opt.wasm` before `wrangler deploy`. |
| Slack Socket Mode | Incompatible with CF Workers | Must switch to Events API + HTTPS webhook. Update Slack app manifest. |

---

## Phase 1 — Foundation

**Objective:** Scaffold the full Cloudflare project structure, wire all bindings in `wrangler.toml`, and get `wrangler dev` running end-to-end locally with stubs returning 200s.

**Exit criteria:** `wrangler dev` starts without errors. `curl http://localhost:8787/health` returns `{"ok":true,"version":"2.0"}`. All bindings resolve without "unbound" errors in dev console. TypeScript compiles clean (`tsc --noEmit`).

**Parallelism:** Tasks 1.1, 1.2, 1.3 can be done concurrently once there is an initial `wrangler.toml`. Task 1.4 (type generation) depends on 1.1–1.3.

---

### Task 1.1 — Convert `edge/wrangler.jsonc` to `wrangler.toml` with full bindings

**Description:**  
Replace the existing minimal `edge/wrangler.jsonc` with a complete `edge/wrangler.toml`. The new file must declare all Workers, DO classes, KV namespaces, R2 buckets, secrets, and WASM module bindings needed by the entire 2.0 system.

**Deliverable:** `edge/wrangler.toml` (replaces `edge/wrangler.jsonc`)

**Acceptance criteria:**
1. File is valid TOML (`npx wrangler deploy --dry-run` exits 0).
2. Contains `name = "opentag-orchestrator"` as the default worker (entry: `edge/workers/orchestrator/src/index.ts`).
3. Contains `[[services]]` or `[[workers]]` entries for each named sub-worker: `opentag-egress-proxy`, `opentag-wasm-dispatch`.
4. Declares `[durable_objects]` bindings for `OrchestratorDO`, `AgentSessionDO`, `TaskQueueDO` with correct class names.
5. Declares `[[migrations]]` with tag `v2` adding new SQLite classes `AgentSessionDO` and `TaskQueueDO` (preserving existing `v1` migration).
6. Declares `[[kv_namespaces]]` with binding `AGENT_STATE` (for fast session reads).
7. Declares `[[r2_buckets]]` with binding `BLOBS` (bucket name `opentag-research-blobs`, matching existing `edge/wrangler.jsonc`).
8. Declares `[[wasm_modules]]` with binding `WASM_DISPATCH` pointing to `edge/wasm/main.opt.wasm`.
9. Declares `[vars]` for `ENVIRONMENT = "development"`.
10. Declares `[[secrets]]` names for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`.
11. Sets `compatibility_date = "2026-04-01"` and `compatibility_flags = ["nodejs_compat"]`.
12. Sets `[limits] cpu_ms = 300000`.

**Dependencies:** None.  
**Complexity:** S

---

### Task 1.2 — Scaffold directory structure for all new workers

**Description:**  
Create the directory skeleton for the three Workers that don't yet exist. Each directory needs a minimal `src/index.ts` that exports a `fetch` handler returning `Response.json({ok: true})`, so `wrangler dev` can start. Real implementations come in later phases.

**Deliverable:** 
- `edge/workers/orchestrator/src/index.ts` (stub, replaces `edge/worker/src/index.ts`)
- `edge/workers/egress-proxy/src/index.ts` (stub)
- `edge/workers/wasm-dispatch/src/index.ts` (stub)

**Acceptance criteria:**
1. Each `index.ts` exports a `default` object with a `fetch(request, env, ctx)` method.
2. Each stub returns `Response.json({ ok: true, worker: "<name>" })` for any request.
3. Each stub compiles with `tsc --noEmit` using `@cloudflare/workers-types`.
4. `Env` interface in each stub declares the bindings that worker will use (from Task 1.1).
5. Old `edge/worker/` directory is kept intact until Phase 2 cutover (do not delete yet).

**Dependencies:** Task 1.1.  
**Complexity:** S

---

### Task 1.3 — Update `edge/package.json` with all required dependencies

**Description:**  
Add all npm packages required by the 2.0 build. Do not install them — just update `package.json` so a subsequent `npm install` pulls them all in.

**Deliverable:** `edge/package.json` (updated)

**Acceptance criteria:**
1. `dependencies` includes: `hono` (≥4.x), `@cloudflare/sandbox` (latest sandbox SDK), `zod` (≥3.x).
2. `devDependencies` includes: `wasm-opt` (or `binaryen`, used to run `wasm-opt`), `tinygo` instructions noted in a `scripts.build:wasm` script, `@cloudflare/workers-types` (≥4.x), `vitest`, `wrangler` (≥4.x), `typescript`.
3. `scripts` includes:
   - `"dev": "wrangler dev"`
   - `"deploy": "npm run build:wasm && wrangler deploy"`
   - `"build:wasm": "cd ../wasm-core && tinygo build -o ../workers/wasm-dispatch/src/main.wasm -target wasm -no-debug . && wasm-opt -O3 ../workers/wasm-dispatch/src/main.wasm -o ../workers/wasm-dispatch/src/main.opt.wasm"`
   - `"typecheck": "tsc --noEmit"`
   - `"test": "vitest run"`
4. No `pg` dependency (Postgres is Railway-only; DO storage replaces it on CF).
5. `npm install` succeeds without errors.

**Dependencies:** None.  
**Complexity:** S

---

### Task 1.4 — Generate TypeScript types from wrangler bindings

**Description:**  
Run `wrangler types` to generate a `worker-configuration.d.ts` from the wrangler.toml bindings and wire it into the TypeScript project so all `env.*` accesses are type-safe.

**Deliverable:** `edge/worker-configuration.d.ts` (generated) + `edge/tsconfig.json` (updated)

**Acceptance criteria:**
1. `npx wrangler types --env-interface CloudflareEnv` exits 0 and produces `worker-configuration.d.ts` with all binding types present.
2. `edge/tsconfig.json` references the generated types file via `"include": [..., "worker-configuration.d.ts"]`.
3. `tsc --noEmit` in `edge/` passes cleanly after running `wrangler types`.
4. `CloudflareEnv` interface exposes correctly typed properties for: `ORCHESTRATOR` (`DurableObjectNamespace`), `AGENT_SESSION` (`DurableObjectNamespace`), `TASK_QUEUE` (`DurableObjectNamespace`), `BLOBS` (`R2Bucket`), `AGENT_STATE` (`KVNamespace`), `WASM_DISPATCH` (`WebAssembly.Module`), `ANTHROPIC_API_KEY` (`string`), `OPENAI_API_KEY` (`string`), `SLACK_BOT_TOKEN` (`string`), `SLACK_SIGNING_SECRET` (`string`).

**Dependencies:** Tasks 1.1, 1.2, 1.3.  
**Complexity:** S

---

### Task 1.5 — Verify local dev stack boots end-to-end

**Description:**  
`npm install` in `edge/`, then `wrangler dev`. Verify all stubs respond and no binding errors appear.

**Deliverable:** No file change. This is a verification task.

**Acceptance criteria:**
1. `npm install` in `edge/` exits 0.
2. `wrangler dev` starts and outputs "Ready on http://localhost:8787".
3. `curl http://localhost:8787/health` returns HTTP 200 (will be a stub until Phase 2 adds the real health route).
4. No `Error: Unbound service` or `Error: Unknown variable` messages in wrangler dev output.
5. `tsc --noEmit` in `edge/` exits 0.

**Dependencies:** Tasks 1.1–1.4.  
**Complexity:** S

---

## Phase 2 — Orchestrator Core

**Objective:** Replace the raw `fetch()` handler in the Orchestrator Worker with a Hono router, implement the Durable Object lifecycle for `OrchestratorDO`, and wire Slack event routing (Events API, not Socket Mode).

**Exit criteria:** A real Slack `app_mention` event POSTed to `POST /slack/events` is verified, parsed, and dispatched to `OrchestratorDO`. The DO persists a new task record in SQLite. A health check at `GET /health` returns version info. All existing unit tests pass.

**Parallelism:** Tasks 2.1 (Hono router) and 2.2 (Slack verification middleware) can be done concurrently. Task 2.3 (DO lifecycle) can start in parallel with 2.1 and 2.2 but must integrate with both before Task 2.4 (routing integration).

---

### Task 2.1 — Install Hono and build the base router in the Orchestrator Worker

**Description:**  
Replace the current minimal `export default { fetch }` pattern in the Orchestrator Worker with a Hono app. Wire all existing routes and add a typed health route.

**Deliverable:** `edge/workers/orchestrator/src/index.ts` (full rewrite from stub)

**Acceptance criteria:**
1. File imports `Hono` from `"hono"` and instantiates `new Hono<{ Bindings: CloudflareEnv }>()`.
2. `GET /health` returns `Response.json({ ok: true, version: "2.0", env: env.ENVIRONMENT })` with HTTP 200.
3. `POST /research` proxies to `OrchestratorDO` (same logic as existing `edge/worker/src/index.ts` `/research` route).
4. `app.notFound(...)` returns HTTP 404 JSON.
5. `app.onError(...)` catches all unhandled errors, logs them, and returns HTTP 500 JSON.
6. `tsc --noEmit` passes.
7. `wrangler dev` starts; `curl http://localhost:8787/health` returns the expected JSON.
8. Existing Verifier and Researcher DO stubs from `edge/worker/src/index.ts` are exported from this file (or a co-located `dos.ts`) so wrangler can register all DO classes.

**Dependencies:** Phase 1 complete.  
**Complexity:** S

---

### Task 2.2 — Implement Slack Events API signature verification middleware

**Description:**  
Cloudflare Workers cannot use `@slack/bolt`'s Socket Mode (requires long-running TCP). Instead the bot will expose an HTTPS webhook at `POST /slack/events`. All Slack events are delivered via HTTP POST with an HMAC-SHA256 signature in the `X-Slack-Signature` header.

Implement a Hono middleware that:
1. Reads the raw request body (must happen before JSON parsing).
2. Validates `X-Slack-Signature` and `X-Slack-Request-Timestamp` against `SLACK_SIGNING_SECRET` using the Web Crypto API (not Node `crypto`).
3. Rejects stale timestamps (>5 min old).
4. Attaches the parsed body to `c.set("slackBody", ...)` for downstream handlers.

**Deliverable:** `edge/workers/orchestrator/src/slack-verify.ts`

**Acceptance criteria:**
1. Uses `crypto.subtle.importKey` and `crypto.subtle.sign` (Web Crypto API) — no `require("crypto")`.
2. Correctly handles Slack's signature format: `v0=<hex-hmac>` over `v0:<timestamp>:<raw_body>`.
3. Returns HTTP 401 JSON `{"error": "invalid_signature"}` on bad signature.
4. Returns HTTP 401 JSON `{"error": "stale_request"}` when timestamp is >300 seconds old.
5. On success, `c.set("rawBody", string)` and `c.set("slackPayload", parsedJSON)` are available to downstream handlers.
6. Unit test in `edge/workers/orchestrator/src/__tests__/slack-verify.test.ts` covers: valid signature → passes, bad signature → 401, stale timestamp → 401, URL verification challenge → 200 with `challenge` value echoed.
7. All tests pass (`vitest run`).

**Dependencies:** Task 2.1.  
**Complexity:** M

---

### Task 2.3 — Build `OrchestratorDO` with SQLite lifecycle and task dispatch

**Description:**  
The existing `Orchestrator` class in `edge/worker/src/index.ts` is a thin shell. Expand `OrchestratorDO` into a fully functional Durable Object that:
1. On first access, runs SQL schema migrations using the existing `lib/research/migrations/001_initial.sql` plus the Phase 7 additions.
2. Uses `DurableObjectStorageAdapter` (already exists at `lib/research/adapters/storage-do.ts`).
3. Instantiates `OrchestratorCore` from `lib/research/orchestrator.ts` using the DO's SQLite storage.
4. Exposes internal HTTP routes (`/handleMention`, `/getDeliveries`, `/markDelivered`) consumed by the outer Worker.
5. Implements `alarm()` to process the outbox and schedule fiber steps.

**Deliverable:** `edge/workers/orchestrator/src/OrchestratorDO.ts`

**Acceptance criteria:**
1. Class implements `DurableObject` interface with `fetch(request)` and `alarm()` methods.
2. Constructor creates `DurableObjectStorageAdapter` using `this.state.storage.sql`.
3. `fetch()` dispatches on `url.pathname`:
   - `POST /handleMention` → calls `OrchestratorCore.handleMention(body)`, returns JSON.
   - `GET /deliveries` → returns pending delivery obligations as JSON array.
   - `POST /deliveries/:id/delivered` → marks the obligation delivered.
4. `alarm()` calls `OrchestratorCore.processOutbox(sessionId)` for any pending outbox items.
5. Schema migration runs idempotently on every cold start (INSERT INTO schema_migrations … ON CONFLICT DO NOTHING).
6. An integration test using `@cloudflare/vitest-pool-workers` verifies that a POST to `/handleMention` creates a task record retrievable by `GET /tasks/:taskId` (use miniflare in test).
7. `tsc --noEmit` passes.

**Dependencies:** Tasks 2.1, Phase 7 schema (can run with existing schema — Phase 7 adds columns).  
**Complexity:** M

---

### Task 2.4 — Wire Slack Events API route and event fan-out

**Description:**  
Add `POST /slack/events` to the Hono router. This route handles all Slack event types:
- `url_verification` → echo challenge immediately (no signature check needed per Slack docs, but apply it anyway for defense in depth).
- `event_callback` with `app_mention` → extract text, channel, thread_ts, user; build `threadKey`; dispatch to `OrchestratorDO`.
- `event_callback` with `message.im` → same fan-out as app_mention.
- All other event types → return HTTP 200 (Slack requires ack within 3 s; do not block).

Slack requires a response within **3 seconds**. The DO dispatch must be fire-and-forget (use `ctx.waitUntil`) so the 200 ack returns immediately.

**Deliverable:** `edge/workers/orchestrator/src/slack-events.ts` (handler function) + updated `index.ts` (route registration)

**Acceptance criteria:**
1. `url_verification` event: returns HTTP 200 JSON `{"challenge": "<value>"}` within 3 s.
2. `app_mention` event: returns HTTP 200 immediately; DO dispatch is fired via `ctx.waitUntil(stub.fetch(...))`.
3. The `threadKey` is built as `slack:<channelId>:<threadTs>` (matches `buildThreadKey` in `app/research-agent.ts`).
4. The `OrchestratorDO` is addressed by `env.ORCHESTRATOR.idFromName(threadKey)`.
5. A stub response from OrchestratorDO is posted back to Slack as a thread reply using `SLACK_BOT_TOKEN` and the `chat.postMessage` API (fire-and-forget via `waitUntil`).
6. Unrecognized event types return HTTP 200 `{"ok": true}` without error.
7. End-to-end test: POST a fake `app_mention` event with valid HMAC signature to `POST /slack/events` in a miniflare test — verify HTTP 200 returned synchronously and a `handleMention` call was queued on the DO.
8. `tsc --noEmit` passes.

**Dependencies:** Tasks 2.2, 2.3.  
**Complexity:** M

---

## Phase 3 — Sandbox Integration & Egress Proxy

**Objective:** Integrate Cloudflare Sandbox SDK to spawn ephemeral containers for agent sessions, implement the egress proxy Worker that intercepts all container outbound HTTP, and establish the preview URL negotiation protocol for inter-container calls.

**Exit criteria:** A container can be started, a preview URL retrieved, an HTTP call through the egress proxy logged, and the container killed — all via the Orchestrator DO. Container traffic to non-allowlisted hosts is rejected by the proxy.

**Parallelism:** Tasks 3.1 (Sandbox SDK bootstrap) and 3.4 (Egress proxy Worker) can be done fully in parallel. Task 3.2 (container lifecycle API) depends on 3.1. Task 3.3 (preview URL negotiation) depends on 3.2. Task 3.5 (proxy integration in containers) depends on 3.4.

---

### Task 3.1 — Bootstrap Sandbox SDK worker using the official template

**Description:**  
Use the official Cloudflare template to scaffold the Sandbox SDK worker, then merge it into the existing project structure.

```bash
# Run in a temp directory, then manually merge files:
npm create cloudflare@latest -- sandbox-worker --template=cloudflare/sandbox-sdk/examples/minimal
```

**Deliverable:** 
- `edge/workers/sandbox/src/index.ts` (merged from template)
- `edge/workers/sandbox/Dockerfile` (from template, adapted for agent container image)
- Updated `edge/wrangler.toml` to include sandbox worker entry

**Acceptance criteria:**
1. The sandbox Worker compiles with `tsc --noEmit`.
2. `wrangler dev` with sandbox worker shows the sandbox binding is available.
3. A basic test: POST to `POST /sandbox/start` in the sandbox Worker returns a container ID (miniflare mock or live CF account).
4. The `Dockerfile` installs: Node.js 22 LTS, git, curl. Does NOT install Go/TinyGo (WASM runs in Workers, not in containers).
5. The Dockerfile ends with `CMD ["node", "agent-runner.js"]` — the agent runner that the Orchestrator will invoke via the container's HTTP interface.
6. Template source acknowledged in file header comment.

**Dependencies:** Phase 1 complete.  
**Complexity:** M

---

### Task 3.2 — Implement container lifecycle API in `OrchestratorDO`

**Description:**  
Add methods to `OrchestratorDO` (or a co-located `ContainerManager.ts`) for starting, tracking, and killing containers. A single container corresponds to a single agent session.

**Deliverable:** `edge/workers/orchestrator/src/ContainerManager.ts`

**Acceptance criteria:**
1. `ContainerManager.start(sessionId: string, flavor: "pm" | "impl" | "verify"): Promise<ContainerHandle>` — spawns a container via Sandbox SDK with the `flavor` passed as an environment variable `AGENT_FLAVOR` inside the container. Returns `{ containerId, previewUrl }`.
2. `ContainerManager.kill(containerId: string): Promise<void>` — terminates the container and marks its session as `terminated` in SQLite.
3. `ContainerManager.getPreviewUrl(containerId: string): Promise<string>` — fetches the current preview URL from `sandbox.tunnels.get()`; re-negotiates if stale.
4. Container metadata (`containerId`, `previewUrl`, `startedAt`, `flavor`, `sessionId`) is stored in SQLite in the `agent_containers` table (see Phase 7, Task 7.3).
5. If a container fails to start within 240 s (cold start buffer), the method throws `ContainerStartTimeoutError`.
6. Unit test mocking the Sandbox SDK verifies: successful start records metadata, kill removes container, preview URL is re-fetched if container has restarted.
7. `tsc --noEmit` passes.

**CONSTRAINT:** Container cold start is 2–3 min. Post a "🔄 Agent starting up…" Slack message immediately on `start()` call, before awaiting the container.

**Dependencies:** Tasks 2.3, 3.1.  
**Complexity:** L

---

### Task 3.3 — Preview URL negotiation protocol

**Description:**  
Preview URLs from `sandbox.tunnels.get()` do not survive container restarts. Implement a negotiation protocol that:
1. Stores the current preview URL in the `agent_containers` table.
2. Before any inter-container call, validates the URL is still alive (HTTP HEAD with 5 s timeout).
3. If the HEAD fails, re-fetches via `sandbox.tunnels.get()` and updates the stored URL.
4. If re-fetch fails, marks the container as `zombie` and alerts the orchestrator.

**Deliverable:** `edge/workers/orchestrator/src/PreviewUrlManager.ts`

**Acceptance criteria:**
1. `PreviewUrlManager.getValidUrl(containerId: string): Promise<string>` — returns a verified URL or throws `ContainerZombieError`.
2. HEAD validation uses `fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) })`.
3. URL cache in SQLite is updated atomically on re-fetch (OCC update, see `storage-do.ts` pattern).
4. `ContainerZombieError` includes the `containerId` and last-known URL in its message.
5. Unit test: healthy URL → returns immediately; dead URL + successful re-fetch → returns new URL; dead URL + failed re-fetch → throws `ContainerZombieError`.

**Dependencies:** Task 3.2.  
**Complexity:** M

---

### Task 3.4 — Build the Egress Proxy Worker

**Description:**  
All outbound HTTP from agent containers must flow through a Workers proxy. This proxy:
1. Enforces an allowlist of permitted hosts.
2. Injects API tokens (Anthropic, OpenAI, GitHub) without exposing them to the container process.
3. Logs every proxied request to the `agent_execution_logs` SQLite table (via a DO fetch).
4. Rejects non-allowlisted requests with HTTP 403.

The container is configured to use the egress proxy as an HTTP proxy (`HTTP_PROXY` / `HTTPS_PROXY` env vars or by routing all traffic through it).

**Deliverable:** `edge/workers/egress-proxy/src/index.ts` (full implementation from stub)

**Acceptance criteria:**
1. `ALLOWED_HOSTS` is a `string[]` defined in `[vars]` in wrangler.toml: `["api.anthropic.com", "api.openai.com", "api.github.com", "registry.npmjs.org", "pkg.go.dev"]`.
2. Requests to hosts not in `ALLOWED_HOSTS` return HTTP 403 JSON `{"error": "host_not_allowed", "host": "<host>"}`.
3. Requests to `api.anthropic.com` have `Authorization: Bearer <ANTHROPIC_API_KEY>` injected (replacing any existing Authorization header from the container).
4. Requests to `api.openai.com` have `Authorization: Bearer <OPENAI_API_KEY>` injected.
5. Requests to `api.github.com` have `Authorization: Bearer <GITHUB_TOKEN>` injected.
6. Every proxied request (allowed or rejected) is logged: `{ containerId, host, path, method, status, durationMs }` appended to `agent_execution_logs` via a POST to the `LoggingDO`.
7. The actual HTTP proxying uses `fetch(upstreamUrl, { headers: modifiedHeaders, body, method })`.
8. Integration test: allowed host → proxied and logged; disallowed host → 403 and logged.
9. `tsc --noEmit` passes.

**CONSTRAINT:** Secrets (`ANTHROPIC_API_KEY`, etc.) must never appear in container environment variables — they are only held in the Worker's `env` object, which is isolated to the Worker process.

**Dependencies:** Phase 1 complete.  
**Complexity:** M

---

### Task 3.5 — Configure containers to route through the egress proxy

**Description:**  
Update the container's `Dockerfile` and `agent-runner.js` entrypoint to route all outbound HTTP through the egress proxy Worker.

**Deliverable:** Updated `edge/workers/sandbox/Dockerfile` + `edge/workers/sandbox/agent-runner.js`

**Acceptance criteria:**
1. `Dockerfile` sets `ENV HTTP_PROXY="https://opentag-egress-proxy.<account>.workers.dev"` and `ENV HTTPS_PROXY="https://opentag-egress-proxy.<account>.workers.dev"` (with placeholder for actual URL, resolved at deploy time via a build arg).
2. `agent-runner.js` does NOT hardcode any API keys.
3. A test in the container image: `curl -x $HTTPS_PROXY https://api.anthropic.com/v1/models` returns HTTP 200 (key injected by proxy).
4. A test: `curl -x $HTTPS_PROXY https://example.com` returns HTTP 403 from the proxy.
5. `Dockerfile` builds successfully with `docker build .`.

**Dependencies:** Task 3.4.  
**Complexity:** S

---

## Phase 4 — Agent Framework & MCP Server

**Objective:** Implement the three agent role classes (PM, Implementation, Verification) that run inside containers, define the agent–orchestrator communication protocol, and stub an MCP server that surfaces Slack threads, logs, and errors as MCP tools accessible to all agents.

**Exit criteria:** A PM agent in a container can receive a task, produce a plan, post it back to the orchestrator. An Implementation agent can receive the plan, write code to a file, and report completion. A Verification agent can fetch the preview URL of the Implementation container and make an HTTP call against the written code. The MCP server stub responds to `tools/list` and `tools/call` requests.

**Parallelism:** Tasks 4.1 (agent base class) and 4.4 (MCP server stub) can be done in parallel. Tasks 4.2 (PM agent), 4.3 (Impl agent), 4.5 (Verification agent) sequentially depend on 4.1.

---

### Task 4.1 — Define the agent base class and orchestrator communication protocol

**Description:**  
Define `AgentBase` — the abstract base class all agent roles extend inside the container. Also define the JSON protocol the container uses to report status back to the Orchestrator DO.

**Deliverable:** `edge/workers/sandbox/src/agent-base.ts`

**Acceptance criteria:**
1. `AgentBase` is an abstract TypeScript class with:
   - `abstract role: "pm" | "impl" | "verify"`
   - `abstract run(task: AgentTask): Promise<AgentResult>`
   - `protected postStatus(update: AgentStatusUpdate): Promise<void>` — POSTs to `ORCHESTRATOR_CALLBACK_URL` (env var) with `Authorization: Bearer <AGENT_TOKEN>`.
   - `protected callMcp(tool: string, args: Record<string, unknown>): Promise<unknown>` — calls the MCP server at `MCP_SERVER_URL` (env var).
2. `AgentTask` interface: `{ taskId: string, sessionId: string, objective: string, plan?: PlanStep[], contextBudgetTokens: number }`.
3. `AgentResult` interface: `{ sessionId: string, status: "complete" | "failed" | "needs_revision", output: string, artifacts?: Artifact[] }`.
4. `AgentStatusUpdate` interface: `{ sessionId: string, step: string, progressPct: number, message: string }`.
5. `postStatus` uses `fetch` with exponential backoff (3 retries, 1s/2s/4s delays).
6. `tsc --noEmit` passes.

**Dependencies:** Phase 3 complete.  
**Complexity:** S

---

### Task 4.2 — Implement the PM Agent

**Description:**  
The PM Agent receives a high-level objective, breaks it into a `PlanStep[]`, validates the plan against the acceptance criteria (if provided), and returns the plan as `AgentResult.output`.

**Deliverable:** `edge/workers/sandbox/src/agents/pm-agent.ts`

**Acceptance criteria:**
1. Extends `AgentBase` with `role = "pm"`.
2. `run(task)` calls the LLM (via egress proxy → `api.anthropic.com/v1/messages`) with a system prompt instructing it to produce a JSON plan.
3. LLM response is parsed into `PlanStep[]`: `{ id: string, description: string, acceptanceCriteria: string[], estimatedComplexity: "S"|"M"|"L" }`.
4. If LLM returns invalid JSON, retries up to 2 times with a corrective prompt.
5. Posts `postStatus` after LLM call with `progressPct: 50`.
6. Returns `AgentResult` with `status: "complete"` and `output: JSON.stringify(plan)`.
7. Unit test (mocking `fetch`): valid LLM response → returns plan; invalid JSON → retries and eventually returns plan; LLM error → returns `status: "failed"`.

**Dependencies:** Task 4.1.  
**Complexity:** M

---

### Task 4.3 — Implement the Implementation Agent

**Description:**  
The Implementation Agent receives a `PlanStep[]` and writes code to satisfy each step. It runs inside a container with a real filesystem, so it can use Node.js `fs` to write files.

**Deliverable:** `edge/workers/sandbox/src/agents/impl-agent.ts`

**Acceptance criteria:**
1. Extends `AgentBase` with `role = "impl"`.
2. `run(task)` iterates `task.plan` steps in order. For each step:
   a. Calls LLM with the step description + prior steps as context.
   b. LLM returns `{ filePath: string, content: string }[]` — a list of files to write.
   c. Writes each file using `fs.writeFileSync` with path validation (must be under `/workspace`).
   d. Posts `postStatus` with step progress.
3. After all steps, lists all written files in `AgentResult.artifacts`.
4. Returns `AgentResult` with `status: "complete"` and `output: "Implementation complete"`.
5. Path traversal guard: if any `filePath` is outside `/workspace`, logs a warning and skips the file.
6. Unit test: valid plan → files written, `artifacts` populated; out-of-bounds path → skipped; LLM error on step 2 → `status: "failed"` with completed steps listed.

**Dependencies:** Task 4.1.  
**Complexity:** M

---

### Task 4.4 — Implement the MCP server stub

**Description:**  
The MCP server runs as a lightweight HTTP server inside (or alongside) the Orchestrator Worker. It exposes agent tools as MCP endpoints: `GET /mcp/tools` (list tools) and `POST /mcp/tools/:name` (call tool).

Tools to implement in this phase:
- `get_slack_thread(threadKey: string): ThreadMessage[]` — reads from DO SQLite.
- `get_task(taskId: string): TaskRecord` — reads from DO SQLite.
- `get_execution_logs(sessionId: string, limit?: number): LogEntry[]` — reads agent_execution_logs.
- `post_slack_message(threadKey: string, text: string): void` — calls `chat.postMessage` via Slack API.

**Deliverable:** `edge/workers/orchestrator/src/mcp-server.ts` + Hono route registration in `index.ts`

**Acceptance criteria:**
1. `GET /mcp/tools` returns a JSON array of tool descriptors per MCP protocol: `[{ name, description, inputSchema }]`.
2. `POST /mcp/tools/:name` accepts `{ arguments: { ... } }` body, calls the tool implementation, returns `{ content: [{ type: "text", text: "..." }] }`.
3. Each tool implementation uses `DurableObjectStorageAdapter` / Slack API, not mock data.
4. MCP endpoint is authenticated: requests without `Authorization: Bearer <AGENT_TOKEN>` (where `AGENT_TOKEN` is a derived secret stored in KV) return HTTP 401.
5. `post_slack_message` uses `SLACK_BOT_TOKEN` from `env` — token is never forwarded to the agent; agent only calls the MCP tool.
6. Unit test covers all four tools: correct arguments → correct response shape; missing required arg → HTTP 400.
7. `tsc --noEmit` passes.

**Dependencies:** Task 2.3 (DO storage access), Task 2.4 (Slack token in env).  
**Complexity:** M

---

### Task 4.5 — Implement the Verification Agent

**Description:**  
The Verification Agent verifies the Implementation Agent's output by:
1. Fetching the Implementation container's preview URL via the MCP server.
2. Making real HTTP requests against the running implementation (acting as a client).
3. Evaluating whether each `acceptanceCriteria` is met.
4. Returning a verdict (`pass`, `revise`, `reject`) matching the existing `Verdict` type in `lib/research/types.ts`.

**Deliverable:** `edge/workers/sandbox/src/agents/verify-agent.ts`

**Acceptance criteria:**
1. Extends `AgentBase` with `role = "verify"`.
2. `run(task)` calls `callMcp("get_task", { taskId })` to fetch the plan and `implContainerId`.
3. For each `PlanStep.acceptanceCriteria` item, makes an HTTP request to the Implementation container's preview URL and evaluates the response.
4. HTTP calls use the preview URL from `get_container_url(containerId)` MCP tool (add this tool in Task 4.4).
5. Calls LLM with the HTTP responses + criteria to produce a structured verdict.
6. Returns `AgentResult` with `output: JSON.stringify({ verdict, issues: string[] })`.
7. `verdict` is one of `"pass" | "revise" | "reject"` (compatible with `Verdict` in `lib/research/types.ts`).
8. Unit test (mocking fetch): all criteria met → `verdict: "pass"`; HTTP error → `verdict: "revise"` with issue; fundamental mismatch → `verdict: "reject"`.

**Dependencies:** Tasks 4.1, 4.4, 3.3.  
**Complexity:** M

---

## Phase 5 — WASM Core

**Objective:** Build a TinyGo WASM module that handles hot dispatch logic (request routing, token counting, content validation) inside a Workers isolate, integrated via `syumai/workers`. This is a performance optimization for the critical synchronous path; it does not block other phases.

**Exit criteria:** `wrangler dev` loads the WASM module; a test call to `POST /dispatch` processed by the WASM core returns in <5ms. `wasm-opt` reduces binary under 1 MB.

**Parallelism:** All tasks in this phase are independent of Phases 2–4 and can be done concurrently with them after Phase 1.

---

### Task 5.1 — Scaffold the TinyGo project using `syumai/workers` template

**Description:**  
Bootstrap the Go + TinyGo project for the WASM dispatch Worker.

```bash
# Run once; merge files into edge/wasm-core/
npm create cloudflare@latest -- wasm-worker --template github.com/syumai/workers/_templates/cloudflare/worker-tinygo
```

**Deliverable:** `edge/wasm-core/` directory with:
- `main.go` (from template, then modified)
- `go.mod`, `go.sum`
- `Makefile` or build script

**Acceptance criteria:**
1. `cd edge/wasm-core && tinygo build -o main.wasm -target wasm -no-debug .` exits 0.
2. `wasm-opt -O3 main.wasm -o main.opt.wasm` exits 0 and reduces binary size.
3. `main.opt.wasm` is under 2 MB (to leave headroom in the 10 MB Worker limit).
4. Template source acknowledged in `main.go` header comment.

**CONSTRAINT:** Do NOT use goroutines (`go func()`) anywhere in the WASM code. There is no goroutine scheduler in the Workers WASM context — code that launches goroutines will deadlock or panic.

**CONSTRAINT:** Do NOT use WASI syscalls (file I/O, environment variables via `os.Getenv`, sockets). Pass all inputs via the HTTP request body.

**Dependencies:** Phase 1 complete.  
**Complexity:** S

---

### Task 5.2 — Implement dispatch logic in Go/TinyGo

**Description:**  
Implement the core dispatch logic in `main.go`. The WASM module exposes a single HTTP handler that classifies incoming requests and returns a routing decision.

**Deliverable:** `edge/wasm-core/main.go` (full implementation)

**Acceptance criteria:**
1. Handler receives `POST /dispatch` with body `{ text: string, userId: string, channelId: string }`.
2. Handler returns `{ intent: "research" | "triage" | "question" | "unknown", confidence: number, extractedObjective: string }`.
3. Intent classification uses keyword matching (no ML, no goroutines):
   - `"research"` if text matches `/\bresearch\b/i` or starts with `research:`.
   - `"triage"` if text contains "triage" or "/triage".
   - `"question"` if text ends with "?".
   - `"unknown"` otherwise.
4. `confidence` is a float 0–1 based on match quality (exact keyword = 1.0, fuzzy = 0.8, fallback = 0.5).
5. `extractedObjective` strips `<@USERID>` mentions and leading "research:" prefix from the text.
6. No use of `os` package, no goroutines, no `sync` package.
7. Binary compiled with `tinygo build -target wasm -no-debug` runs correctly in a WASM runner test.
8. Go unit test (`go test ./...`) passes in standard Go (for fast local iteration before cross-compiling).

**CONSTRAINT:** Every input must be read from the request body. No global mutable state (TinyGo's GC is cooperative and single-threaded, but shared global mutables are still bugs waiting to happen).

**Dependencies:** Task 5.1.  
**Complexity:** M

---

### Task 5.3 — Build wasm-opt pipeline and integrate into wrangler build

**Description:**  
Wire the TinyGo → wasm-opt → deploy pipeline so `npm run deploy` builds the WASM binary before deploying.

**Deliverable:** Updated `edge/package.json` `scripts.build:wasm` + updated `edge/wrangler.toml` WASM module path

**Acceptance criteria:**
1. `npm run build:wasm` runs:
   ```bash
   cd wasm-core && tinygo build -o ../workers/wasm-dispatch/src/main.wasm -target wasm -no-debug .
   wasm-opt -O3 workers/wasm-dispatch/src/main.wasm -o workers/wasm-dispatch/src/main.opt.wasm
   ```
2. `npm run deploy` runs `build:wasm` first (via `"predeploy"` script or explicit ordering).
3. `wrangler.toml` `[[wasm_modules]]` binding points to `workers/wasm-dispatch/src/main.opt.wasm`.
4. After deploy, `POST /dispatch` to the live Worker returns the expected JSON.
5. CI check: `main.opt.wasm` is under 3 MB (fail build if larger).

**Dependencies:** Task 5.2.  
**Complexity:** S

---

### Task 5.4 — Integrate WASM dispatch in the Orchestrator Worker

**Description:**  
Replace the `isResearchIntent` / `extractResearchObjective` TypeScript functions in `app/research-agent.ts` (which run in Node.js today) with calls to the WASM dispatch Worker from inside the Orchestrator's Hono router.

**Deliverable:** `edge/workers/orchestrator/src/dispatch-client.ts` + updated `slack-events.ts`

**Acceptance criteria:**
1. `DispatchClient.classify(text, userId, channelId)` calls `POST /dispatch` on the WASM dispatch Worker via a service binding (`env.WASM_DISPATCH`).
2. The Slack events handler (`slack-events.ts`) uses `DispatchClient.classify` instead of inline `isResearchIntent`.
3. `intent === "research"` → dispatches to `OrchestratorDO` for full agent pipeline.
4. `intent === "triage"` → dispatches to the existing `OrchestratorCore.handleMention` path.
5. `intent === "question"` → passes directly to the triage LLM without agent orchestration.
6. Response time for classify call is <10 ms in `wrangler dev` (WASM is local in dev).
7. `tsc --noEmit` passes.

**Dependencies:** Tasks 2.4, 5.3.  
**Complexity:** S

---

## Phase 6 — Context-Hardening Loop

**Objective:** Implement the iterative context compression and validation protocol that runs before each agent handoff. Ensures that context passed between agents is within token budgets, factually consistent, and accepted by a validation step before the next agent starts.

**Exit criteria:** A simulated handoff from PM → Implementation agent compresses the plan to fit within `contextBudgetTokens`, the compressed context passes validation, and the Implementation agent receives the validated context. A rejection scenario causes a re-compression cycle.

**Parallelism:** Tasks 6.1 and 6.2 can be done in parallel. Task 6.3 depends on both.

---

### Task 6.1 — Implement context compression

**Description:**  
Before handing off context from one agent to the next, compress it to stay within the target token budget. Compression must preserve factual content while reducing verbosity.

**Deliverable:** `edge/workers/orchestrator/src/context-hardening/compressor.ts`

**Acceptance criteria:**
1. `compress(context: AgentContext, targetTokens: number): Promise<CompressedContext>` calls the LLM with a summarization prompt if `estimateTokens(context) > targetTokens`.
2. `estimateTokens` uses a conservative estimate of 4 characters per token.
3. If context is within budget, returns the original context unchanged.
4. If LLM summarization still exceeds budget after one pass, truncates the `workingSummary` field to fit.
5. `CompressedContext` includes `{ ...context, compressed: boolean, originalTokenEstimate: number, compressedTokenEstimate: number }`.
6. Unit test: context over budget → LLM called and output within budget; context under budget → LLM not called; compression failure → truncation fallback.

**Dependencies:** Phase 4 complete (uses `AgentContext` type), Phase 7 partial (token fields).  
**Complexity:** M

---

### Task 6.2 — Implement context validation

**Description:**  
After compression, validate the context before passing it to the next agent. Validation checks:
1. Required fields are present and non-empty.
2. Plan steps have `acceptanceCriteria`.
3. Factual consistency: the context does not contradict itself (LLM-based check on the compressed summary).

**Deliverable:** `edge/workers/orchestrator/src/context-hardening/validator.ts`

**Acceptance criteria:**
1. `validate(context: CompressedContext): Promise<ValidationResult>` returns `{ valid: boolean, issues: string[] }`.
2. Structural check (no LLM needed): all `PlanStep` objects have `acceptanceCriteria.length > 0`, `objective` is non-empty, `sessionId` is present.
3. Factual check (LLM): passes the context to the LLM with prompt: "List any contradictions or missing critical information in this plan. Return JSON array of issues or empty array if none."
4. If structural check fails, returns `{ valid: false, issues }` immediately (no LLM call).
5. If LLM returns issues → `valid: false`; if LLM returns empty array → `valid: true`.
6. Unit test: valid context → `{ valid: true }`; missing `acceptanceCriteria` → `{ valid: false, issues: ["..."] }`; LLM reports contradiction → `{ valid: false }`.

**Dependencies:** Task 6.1.  
**Complexity:** M

---

### Task 6.3 — Implement the handoff coordinator

**Description:**  
Orchestrate the compress → validate → handoff loop. If validation fails, re-compress with a stricter budget and try again (max 3 rounds). If still failing after 3 rounds, escalate to the PM agent for plan revision.

**Deliverable:** `edge/workers/orchestrator/src/context-hardening/handoff.ts`

**Acceptance criteria:**
1. `HandoffCoordinator.handoff(fromSessionId, toAgentFlavor, context)`:
   a. Calls `compressor.compress(context, targetTokens)`.
   b. Calls `validator.validate(compressedContext)`.
   c. If `valid: true`, starts the target container (`ContainerManager.start`) and POSTs the compressed context to its `/run` endpoint.
   d. If `valid: false` and `round < 3`, reduces `targetTokens` by 20% and retries.
   e. If `valid: false` after 3 rounds, sets task status to `"needs_pm_revision"` in SQLite and sends a Slack notification.
2. `handoff()` is called by the Orchestrator DO after each agent completes.
3. The target container endpoint `POST /run` receives the `AgentTask` and returns HTTP 202 (async processing).
4. SQLite records the handoff: `{ fromSessionId, toSessionId, round, compressedTokens, timestamp }` in the `agent_handoffs` table (Phase 7, Task 7.3).
5. Integration test: successful handoff starts container and records in DB; validation failure → 3-round retry → escalation path triggered.

**Dependencies:** Tasks 6.1, 6.2, 3.2.  
**Complexity:** L

---

## Phase 7 — State Layer

**Objective:** Finalize the SQLite schema for all 2.0 state (agent sessions, containers, handoffs, execution logs, GitHub artifacts), confirm the existing `DurableObjectStorageAdapter` covers all new tables, and add missing query methods.

**Exit criteria:** All SQL tables in the new schema create without error in a miniflare DO environment. `DurableObjectStorageAdapter` exposes typed methods for every new table. All existing unit tests continue to pass.

**Parallelism:** Tasks 7.1 and 7.2 can be done in parallel with each other and with Phase 2. Task 7.3 (new tables) depends on understanding Phase 3/4 data needs — can be parallelized once Phase 3.1 and 4.1 are complete.

---

### Task 7.1 — Audit existing schema and adapter against 2.0 requirements

**Description:**  
Review `lib/research/migrations/001_initial.sql` and `lib/research/adapters/storage-do.ts`. Identify all tables and methods that 2.0 will need that are not yet present.

**Deliverable:** `docs/state-layer-audit.md` — a written audit noting each missing table and method

**Acceptance criteria:**
1. Document lists all 2.0-required tables not in `001_initial.sql` (at minimum: `agent_containers`, `agent_handoffs`, `agent_execution_logs`, `github_artifacts`).
2. Document lists all `StorageAdapter` interface methods not in `DurableObjectStorageAdapter` that 2.0 phases will call.
3. Document confirms which existing tables and methods are reused unchanged.
4. Document is reviewed and approved before Task 7.3 starts.

**Dependencies:** Phase 1 complete. Conceptual understanding of Phases 3–6.  
**Complexity:** S

---

### Task 7.2 — Extend `StorageAdapter` interface for 2.0 methods

**Description:**  
Add typed method signatures to `lib/research/adapters/storage.ts` for all 2.0 state operations.

**Deliverable:** Updated `lib/research/adapters/storage.ts`

**Acceptance criteria:**
1. New methods added to `StorageAdapter` interface (at minimum):
   - `createAgentContainer(record: AgentContainerRecord): Promise<void>`
   - `getAgentContainer(containerId: string): Promise<AgentContainerRecord | null>`
   - `updateAgentContainerStatus(containerId: string, status: string, previewUrl?: string): Promise<void>`
   - `appendHandoff(record: AgentHandoffRecord): Promise<void>`
   - `getHandoffs(sessionId: string): Promise<AgentHandoffRecord[]>`
   - `appendExecutionLog(entry: AgentExecutionLogEntry): Promise<void>`
   - `getExecutionLogs(sessionId: string, limit?: number): Promise<AgentExecutionLogEntry[]>`
   - `appendGithubArtifact(record: GithubArtifactRecord): Promise<void>`
2. New types `AgentContainerRecord`, `AgentHandoffRecord`, `AgentExecutionLogEntry`, `GithubArtifactRecord` defined in `lib/research/types.ts`.
3. `PostgresStorageAdapter` has stub implementations (throw `new Error("not implemented on Railway")`) so it still compiles.
4. `tsc --noEmit` passes across the entire project.

**Dependencies:** Task 7.1.  
**Complexity:** S

---

### Task 7.3 — Write migration 002: new 2.0 tables

**Description:**  
Create a SQL migration file adding all 2.0-specific tables.

**Deliverable:** `lib/research/migrations/002_agent_pipeline.sql`

**Acceptance criteria:**
1. File contains `CREATE TABLE IF NOT EXISTS` statements for:
   - `agent_containers`: `(container_id TEXT PK, session_id TEXT, flavor TEXT, status TEXT, preview_url TEXT, started_at TIMESTAMPTZ, killed_at TIMESTAMPTZ)`
   - `agent_handoffs`: `(id TEXT PK, from_session_id TEXT, to_session_id TEXT, round INTEGER, compressed_tokens INTEGER, validated BOOLEAN, created_at TIMESTAMPTZ)`
   - `agent_execution_logs`: `(id TEXT PK, session_id TEXT, container_id TEXT, step TEXT, tool_name TEXT, request JSONB, response JSONB, duration_ms INTEGER, created_at TIMESTAMPTZ)`
   - `github_artifacts`: `(id TEXT PK, session_id TEXT, pr_url TEXT, commit_sha TEXT, branch_name TEXT, created_at TIMESTAMPTZ)`
2. All new tables have appropriate indexes (at minimum: `session_id` on each table).
3. Applying this migration after `001_initial.sql` in a fresh SQLite DB succeeds.
4. `OrchestratorDO` runs both migrations in order on cold start (idempotent via `ON CONFLICT DO NOTHING` on `schema_migrations`).
5. `wrangler.toml` migration block is updated to include `v2` tag for new SQLite classes.

**Dependencies:** Task 7.2.  
**Complexity:** S

---

### Task 7.4 — Implement `DurableObjectStorageAdapter` methods for new tables

**Description:**  
Add implementations for all methods added in Task 7.2 to `lib/research/adapters/storage-do.ts`.

**Deliverable:** Updated `lib/research/adapters/storage-do.ts`

**Acceptance criteria:**
1. All methods from Task 7.2 are implemented using `this.sql.exec(...)` with parameterized queries.
2. Each method follows the existing pattern: no raw string interpolation, all values passed as bindings.
3. `updateAgentContainerStatus` uses optimistic-update pattern consistent with `updateSession` (version_id check is optional here — simple UPDATE is acceptable for container status).
4. Unit test (miniflare): each new method creates, reads, and updates a record correctly.
5. `tsc --noEmit` passes.

**Dependencies:** Tasks 7.2, 7.3.  
**Complexity:** M

---

## Phase 8 — Integration & Migration

**Objective:** Connect the new Cloudflare-native orchestrator to the existing Slack app (switching from Socket Mode to Events API), define and execute the migration path from the Railway stack, and run end-to-end integration tests.

**Exit criteria:** A live `@OpenTag research <objective>` mention in Slack arrives at the CF Worker via Events API, passes through the full pipeline (WASM dispatch → Orchestrator DO → PM container → Impl container → Verify container → context-hardening handoffs), and the final answer is posted back to the Slack thread. Railway services are shut down.

**Parallelism:** Tasks 8.1 (Slack app update) and 8.2 (dual-run period) can be done in parallel. Task 8.3 (GitHub integration) is independent. Task 8.4 (cutover) depends on all others.

---

### Task 8.1 — Update Slack app manifest: Socket Mode → Events API

**Description:**  
The existing Slack app uses Socket Mode (`"socket_mode_enabled": true`). Workers cannot maintain long-running TCP connections; the app must switch to Events API with a public HTTPS URL.

**Deliverable:** Updated `slack-app-manifest.json` + `slack-app-manifest.yaml`

**Acceptance criteria:**
1. `"socket_mode_enabled": false` in the manifest.
2. `event_subscriptions.request_url` set to `https://opentag-orchestrator.<account>.workers.dev/slack/events`.
3. `event_subscriptions.bot_events` unchanged: `["app_mention", "assistant_thread_started", "assistant_thread_context_changed", "message.im", "message.mpim"]`.
4. All slash commands retain their definitions.
5. Interactivity `request_url` set to `https://opentag-orchestrator.<account>.workers.dev/slack/interactions`.
6. Manifest is uploaded to `api.slack.com/apps` and Slack confirms "Verified" on the request URL.
7. `SLACK_APP_TOKEN` (Socket Mode xapp- token) is removed from all wrangler.toml secrets (no longer needed).

**Acceptance criteria for verification:**  
Send a test `app_mention` event from Slack; the Worker receives it, logs it, and replies "Research started" within 3 seconds.

**Dependencies:** Task 2.4 complete (Events API route exists).  
**Complexity:** S

---

### Task 8.2 — Dual-run period: Railway and CF in parallel

**Description:**  
Before cutting over, run both Railway and CF in parallel for at least 48 hours. Slack events are mirrored to both systems (using a lightweight forwarding Worker or Slack's app duplication). Compare results.

**Deliverable:** `edge/workers/mirror/src/index.ts` (event mirror Worker) + runbook `docs/dual-run-runbook.md`

**Acceptance criteria:**
1. Mirror Worker receives Slack events, forwards to both the Railway `AGENT_RESEARCH_URL` and the CF orchestrator, and returns the CF response as authoritative.
2. Mirror Worker logs both responses to a KV namespace `DUAL_RUN_LOG` with key `<timestamp>:<eventId>`.
3. `docs/dual-run-runbook.md` specifies:
   - How to compare responses between Railway and CF.
   - Criteria for declaring CF "passing": ≥95% of research tasks complete with a verdict of "pass" or "revise" over 48h.
   - Rollback procedure: point Slack request URL back to Railway endpoint.
4. After 48h of dual-run with ≥95% CF success rate, proceed to Task 8.4.

**Dependencies:** Task 8.1, Railway stack still running.  
**Complexity:** M

---

### Task 8.3 — GitHub integration: PRs attributed to humans

**Description:**  
When the Implementation Agent writes code, it must commit it to a branch and open a PR attributed to the requesting human (co-author commit) using a scoped GitHub App token.

**Deliverable:** `edge/workers/orchestrator/src/github-client.ts`

**Acceptance criteria:**
1. `GithubClient.createBranch(sessionId, baseBranch): Promise<string>` creates a branch `agent/<sessionId>` via GitHub API.
2. `GithubClient.commitFiles(branch, files, message, coAuthor): Promise<string>` commits the Implementation Agent's `artifacts` to the branch with git trailer:
   ```
   Co-authored-by: Human Name <human@email.com>
   ```
3. `GithubClient.openPR(branch, title, body, coAuthor): Promise<string>` opens a PR from the branch to `main` with the human as requested reviewer.
4. GitHub token used is a scoped GitHub App installation token (not a PAT) — rotated automatically. `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` are wrangler secrets.
5. Token is fetched via egress proxy → `api.github.com/app/installations/:id/access_tokens`.
6. `appendGithubArtifact` is called with the resulting PR URL and commit SHA.
7. Unit test (mocking fetch): `createBranch` → branch name returned; `commitFiles` → commit SHA returned with correct co-author trailer; `openPR` → PR URL returned.

**Dependencies:** Task 7.4 (appendGithubArtifact), Task 3.4 (egress proxy).  
**Complexity:** M

---

### Task 8.4 — Cutover: decommission Railway, enable CF as sole runtime

**Description:**  
Once dual-run passes criteria, cut over fully to CF and shut down Railway services.

**Deliverable:** No new code. Updated Slack app manifest (remove mirror Worker from chain) + decommission runbook `docs/cutover-runbook.md`.

**Acceptance criteria:**
1. Slack app manifest `request_url` points directly to `opentag-orchestrator.workers.dev/slack/events` (not the mirror).
2. Railway services (`opentag-bot`, `opentag-research`, `opentag-research-worker`) are stopped and deleted.
3. `DATABASE_URL` (Postgres) secret is removed from all CF worker secrets.
4. `AGENT_RESEARCH_URL` and `RESEARCH_DELIVERY_URL` env vars are removed from CF config (no longer needed; orchestration is internal to DO).
5. `docs/cutover-runbook.md` documents: service shutdown order, DNS/URL update steps, verification checklist, and 24-hour monitoring watch.
6. Post-cutover smoke test: `@OpenTag research What is a Durable Object?` in Slack returns a research summary within 10 minutes.

**Dependencies:** All previous phases complete, dual-run passed (Task 8.2).  
**Complexity:** S

---

### Task 8.5 — End-to-end integration test suite

**Description:**  
Write an automated integration test suite that exercises the full 2.0 pipeline end-to-end using Cloudflare's miniflare (for DO/KV/R2) and mocked container responses.

**Deliverable:** `edge/tests/integration/e2e.test.ts`

**Acceptance criteria:**
1. Tests run with `vitest run --config edge/vitest.config.ts` in CI.
2. **Test: Slack research flow** — POST fake `app_mention` → verify DO creates task → verify PM container is started → mock PM response → verify Impl container is started → mock Impl response → verify Verify container is started → mock verify verdict → verify Slack `chat.postMessage` is called with final answer. All mocks use `vi.mock` / miniflare bindings.
3. **Test: Egress proxy blocks disallowed host** — container call to `https://evil.com` → proxy returns 403.
4. **Test: Context-hardening loop** — oversized context → compressor reduces tokens → validator passes → handoff proceeds.
5. **Test: Container cold-start UX** — when container `start()` takes >5 s (mocked), Slack receives interim "🔄 Agent starting up…" message before the final answer.
6. **Test: Stale preview URL re-negotiation** — first GET of preview URL returns 404 → re-fetches → subsequent call uses new URL.
7. All tests pass green. CI runtime under 3 minutes.

**Dependencies:** All phases complete.  
**Complexity:** L

---

## Appendix A — Environment Variables

### CF Workers Secrets (set via `wrangler secret put`)

| Variable | Used by | Source |
|----------|---------|--------|
| `ANTHROPIC_API_KEY` | Egress Proxy, MCP server | Anthropic console |
| `OPENAI_API_KEY` | Egress Proxy | OpenAI console |
| `SLACK_BOT_TOKEN` | Orchestrator (Slack API calls) | Slack app OAuth page |
| `SLACK_SIGNING_SECRET` | Orchestrator (webhook verification) | Slack app Basic Information |
| `GITHUB_APP_ID` | GitHub client | GitHub App settings |
| `GITHUB_APP_PRIVATE_KEY` | GitHub client | GitHub App settings (PEM) |
| `GITHUB_INSTALLATION_ID` | GitHub client | GitHub App installation |
| `AGENT_TOKEN` | MCP server auth | Generated — store in KV |

### Removed (Railway-only, not needed in CF)

| Variable | Reason removed |
|----------|---------------|
| `DATABASE_URL` | Postgres replaced by DO SQLite |
| `SLACK_APP_TOKEN` | Socket Mode xapp- token; Events API needs none |
| `AGENT_RESEARCH_URL` | Research runtime is now an internal DO call |
| `RESEARCH_DELIVERY_URL` | Delivery polling is now a DO alarm |
| `BLOB_STORAGE_PATH` | Local blob path; R2 replaces it |
| `REDIS_URL` | Redis store replaced by DO storage |

### CF Vars (non-secret, set in `[vars]`)

| Variable | Value |
|----------|-------|
| `ENVIRONMENT` | `"production"` or `"development"` |
| `ALLOWED_HOSTS` | JSON array of permitted egress hosts |
| `WASM_DISPATCH_URL` | Internal service binding URL for WASM worker |

---

## Appendix B — File Layout

```
edge/
├── wrangler.toml                          # Task 1.1 — replaces wrangler.jsonc
├── package.json                           # Task 1.3 — updated
├── tsconfig.json                          # Task 1.4 — updated
├── worker-configuration.d.ts             # Task 1.4 — generated by wrangler types
│
├── wasm-core/                             # Task 5.1 — TinyGo source
│   ├── main.go                            # Task 5.2 — dispatch logic
│   ├── go.mod
│   └── go.sum
│
├── workers/
│   ├── orchestrator/
│   │   └── src/
│   │       ├── index.ts                   # Tasks 2.1, 2.4 — Hono router
│   │       ├── OrchestratorDO.ts          # Task 2.3 — DO lifecycle
│   │       ├── slack-verify.ts            # Task 2.2 — HMAC verification
│   │       ├── slack-events.ts            # Task 2.4 — event fan-out
│   │       ├── ContainerManager.ts        # Task 3.2 — container lifecycle
│   │       ├── PreviewUrlManager.ts       # Task 3.3 — URL negotiation
│   │       ├── mcp-server.ts              # Task 4.4 — MCP tool server
│   │       ├── dispatch-client.ts         # Task 5.4 — WASM dispatch bridge
│   │       ├── github-client.ts           # Task 8.3 — GitHub API
│   │       └── context-hardening/
│   │           ├── compressor.ts          # Task 6.1
│   │           ├── validator.ts           # Task 6.2
│   │           └── handoff.ts             # Task 6.3
│   │
│   ├── egress-proxy/
│   │   └── src/
│   │       └── index.ts                   # Task 3.4 — egress proxy
│   │
│   ├── wasm-dispatch/
│   │   └── src/
│   │       ├── index.ts                   # Task 1.2 stub → Task 5.4
│   │       └── main.opt.wasm              # Task 5.3 — build artifact
│   │
│   ├── sandbox/
│   │   ├── Dockerfile                     # Task 3.1, 3.5
│   │   ├── agent-runner.js                # Task 3.5 — container entrypoint
│   │   └── src/
│   │       ├── agent-base.ts              # Task 4.1
│   │       └── agents/
│   │           ├── pm-agent.ts            # Task 4.2
│   │           ├── impl-agent.ts          # Task 4.3
│   │           └── verify-agent.ts        # Task 4.5
│   │
│   └── mirror/
│       └── src/
│           └── index.ts                   # Task 8.2 — dual-run mirror
│
└── tests/
    └── integration/
        └── e2e.test.ts                    # Task 8.5

lib/research/
├── migrations/
│   ├── 001_initial.sql                    # existing — unchanged
│   └── 002_agent_pipeline.sql             # Task 7.3 — new 2.0 tables
├── adapters/
│   ├── storage.ts                         # Task 7.2 — extended interface
│   └── storage-do.ts                      # Task 7.4 — new method implementations
└── types.ts                               # Task 7.2 — new record types

docs/
├── state-layer-audit.md                   # Task 7.1
├── dual-run-runbook.md                    # Task 8.2
└── cutover-runbook.md                     # Task 8.4

slack-app-manifest.json                    # Task 8.1 — Events API
slack-app-manifest.yaml                    # Task 8.1 — Events API
```

---

*Spec last updated: July 2026. For questions about the architecture, see `docs/research-actors.md` (existing) and [WorkOS Project Horizon](https://workos.com) as the production reference implementation.*
