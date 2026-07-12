# OpenTag 2.0 — Gate 0 Decisions

Status: **APPROVED** (Gate 0 signed off 2026-07-11). Decisions below are
binding for Tracks A–E. Scope: `/research`-only on CF; other slash commands
and non-Slack platforms remain on Railway.

Inputs reviewed: `goal-prompt.md`, `opentag-2.0-analysis.md` (16-finding audit),
`opentag-2.0-impl-spec.md` (35-task spec), existing `lib/research/*`,
`edge/worker/src/index.ts`, `edge/wrangler.jsonc`, `app/research-agent.ts`,
`app/commands/index.ts`, `slack-app-manifest.yaml`.

---

## 1. Durable Object naming granularity

| DO class | Key | Rationale |
|---|---|---|
| `OrchestratorDO` | `idFromName(teamId)` — **one per Slack workspace** | Hard invariant #6 in `goal-prompt.md`. |
| `ResearcherDO` | `idFromName(taskId)` — one per task/session | Bounded fiber-step work for a single task; matches analysis.md's recommended fix; not constrained by invariant #6 (which only names Orchestrator). |
| `VerifierDO` | `idFromName(taskId)` — one per task/session | Same reasoning as Researcher. |
| Agent containers (PM/Impl/Verify, Phase 4) | rows in the owning `OrchestratorDO`'s SQLite (`agent_containers` table) | Lifecycle state lives with the task's workspace DO — no separate DO class. |

**⚠️ Conflict with reference docs, flagged per Gate-0 "architectural surprise" rule:**
`opentag-2.0-impl-spec.md` Task 2.4 (AC #4) and `opentag-2.0-analysis.md` Issue 5
both recommend addressing `OrchestratorDO` by **`idFromName(threadKey)`** — one DO
per Slack *thread* — matching the existing `edge/worker/src/index.ts` stub. That
directly contradicts `goal-prompt.md` invariant #6 ("Each Slack workspace gets
exactly one Orchestrator DO identified by its workspace ID").

**Resolution: the invariant wins.** `goal-prompt.md` is the authoritative
instruction for this run, so `OrchestratorDO` is per-workspace, not per-thread.
Effects of this choice:

- **Free workspace-level Slack event dedup.** `isSlackEventProcessed` now lives
  in one DO per workspace by construction, so the audit's proposed separate
  `WorkspaceIndex` DO is unnecessary — dropped.
- **Threads become rows, not DOs.** All tasks for a workspace share one
  SQLite database, keyed by the existing `thread_key` column on `tasks`
  (already present in `storage-do.ts`/`001_initial.sql`). No schema change
  needed for this.
- **Accepted trade-off:** a very active workspace concentrates all task writes
  on one DO's SQLite, which the audit flags as a contention risk at scale
  (Issue 5, per-workspace bullet). Not mitigated in M1–M8 — DO SQLite
  serializes writes per DO and the actor core already handles this via OCC
  (`occ.ts`). If it becomes a real bottleneck post-launch, the fix is
  workspace sharding (`idFromName(teamId + ":" + shard)`), deferred to Phase 2.
- Task 2.4's acceptance criteria (`idFromName(threadKey)`) and any other
  impl-spec text that assumes per-thread DOs will be corrected to
  `idFromName(teamId)` when Track A/B code is written.

---

## 2. Egress Proxy Design (application-level, per hard invariant #2)

Per invariant #2 and analysis.md Issue 1 (CRITICAL — CF Workers TCP sockets are
outbound-only; a Worker cannot intercept container TCP traffic): the proxy is
an **application-level HTTP proxy Worker**, not transparent interception.

- **Component:** `edge/workers/egress-proxy`, a standalone Worker deployed at
  a fixed URL (e.g. `https://opentag-egress-proxy.<account>.workers.dev`).
- **Container-side contract:** agent code inside a Sandbox container never
  calls external APIs directly. All outbound calls route through the proxy
  (via `HTTP_PROXY`/`HTTPS_PROXY` env vars pointing at the proxy, injected at
  container boot). The container holds **no API keys** — only a short-lived
  per-session token (`AGENT_TOKEN`) that identifies it to the proxy and MCP
  server.
- **Proxy responsibilities:**
  1. **Allowlist:** `ALLOWED_HOSTS` (`api.anthropic.com`, `api.openai.com`,
     `api.github.com`, `registry.npmjs.org`, `pkg.go.dev`) — non-allowlisted
     host → HTTP 403 `{error: "host_not_allowed", host}`.
  2. **Auth injection:** the proxy holds real API keys as Worker secrets and
     injects `Authorization` headers server-side per destination host,
     replacing anything the container sent.
  3. **Logging:** every proxied request (allowed or rejected) — `containerId,
     host, path, method, status, durationMs` — is appended to
     `agent_execution_logs` via a fetch to the owning `OrchestratorDO`.
  4. **Forwarding:** plain `fetch(upstreamUrl, { headers, body, method })`.
- **Session-token validation:** the token issued by `ContainerManager.start()`
  is checked against the owning `OrchestratorDO` (or a KV cache of active
  tokens) before the proxy forwards a request — a killed/superseded
  container's token stops working immediately.
- **Explicitly not attempted:** OS-level TCP interception, transparent
  proxying, VPC/network-policy egress control. If Cloudflare later ships an
  account-level Gateway/egress-filtering product, that's defense-in-depth on
  top of this design, not a replacement (it can't do per-request auth
  injection or per-container logging).

---

## 3. Slack Events API webhook shape

All Slack HTTP entry points live in the Orchestrator Worker
(`edge/workers/orchestrator`) behind one shared HMAC verification middleware.

**Scope decision (flagging for sign-off):** `goal-prompt.md`'s invariants and
milestones (M1–M8) only describe the `/research` flow and Orchestrator →
Researcher → Verifier pipeline. They say nothing about the other four Slack
commands currently live in `app/commands/index.ts` (`/agent`, `/triage`,
`/preview`, `/file-issue`), their Linear/Notion tools, modals, or the
Discord/Telegram/WhatsApp adapters. **Proposed scope: this migration covers
only the `/research` slash command and the `research`-intent `@mention` flow.**
Everything else (`/agent`, `/triage`, `/preview`, `/file-issue`, non-Slack
platforms) stays on the existing Railway/CopilotKit bot unless a future track
explicitly picks it up. This is the reading that matches M6's acceptance
criterion ("real `/research` slash command... posts result via
`chat.postMessage`") and M8's ("real end-to-end research request... in a
production Slack workspace") — neither mentions triage/Linear/Notion.

Endpoints:

- **`POST /slack/events`** — Events API, JSON body.
  - `type: "url_verification"` → echo `{challenge}` immediately, HTTP 200
    (signature still checked for defense in depth).
  - `type: "event_callback"`, `event.type` ∈ `{app_mention, message.im,
    message.mpim, assistant_thread_started,
    assistant_thread_context_changed}` → extract `text/channel/thread_ts/user`,
    build `threadKey = "slack:" + channelId + ":" + threadTs` (matches
    `buildThreadKey` in `app/research-agent.ts`), dispatch fire-and-forget via
    `ctx.waitUntil(orchestratorStub.fetch(...))`, return HTTP 200 `{ok:true}`
    immediately — Slack requires ack within 3s.
  - Only events matching research intent (same `isResearchIntent` logic
    ported from `app/research-agent.ts`) are routed to the Orchestrator; all
    other event types return `200 {ok:true}` and are otherwise ignored (they
    stay Railway's responsibility per the scope decision above).
  - Idempotency: `isSlackEventProcessed(event_id)` is checked/marked inside
    `OrchestratorDO` before any work starts, handling Slack's up-to-3x retry
    behavior (existing `StorageAdapter` method, reused unchanged).
- **`POST /slack/commands`** — Slash Commands. Body is
  `application/x-www-form-urlencoded` (distinct parsing path from Events API's
  JSON). Only `command === "/research"` is handled; any other command returns
  a plain-text ack telling the user it's not available on this deployment yet.
  `/research` handler: parse `text`, `channel_id`, `user_id`, build
  `threadKey`, dispatch fire-and-forget to `OrchestratorDO`, and respond
  within Slack's 3s budget with `{response_type: "in_channel", text: "🔍
  Research started…"}` — the slash-command ack doubles as the interim message
  (satisfies analysis.md Issue 2's "immediate Slack ack" requirement without
  an extra `chat.postMessage` call).
- **`POST /slack/interactions`** — Block Kit button/modal payloads
  (`payload=<url-encoded-json>`). Not built in this migration — no HITL
  confirm-button gate exists in the `/research` flow today, and it's out of
  the stated milestone scope. Route reserved/stubbed (HTTP 200) so Slack's
  manifest validation doesn't fail, but has no handler logic.
- **Signature verification (shared middleware, `slack-verify.ts`):**
  - Read the raw body **before** JSON/form parsing (required for HMAC).
  - Use `crypto.subtle` (Web Crypto API) — Workers has no Node `crypto`.
  - Validate `X-Slack-Signature: v0=<hex>` computed over
    `v0:<X-Slack-Request-Timestamp>:<raw_body>` using `SLACK_SIGNING_SECRET`.
  - Reject timestamps >300s old → HTTP 401 `{error: "stale_request"}`.
  - Bad signature → HTTP 401 `{error: "invalid_signature"}`.
  - `SLACK_APP_TOKEN` (Socket Mode `xapp-` token) is not used anywhere in the
    new path and is dropped from CF secrets (Socket Mode is forbidden per
    invariant #1).

---

## Sign-off

1. **DO granularity (§1):** APPROVED — per-workspace `OrchestratorDO`.
2. **Egress proxy (§2):** APPROVED — application-level HTTP proxy Worker.
3. **Events API shape (§3):** APPROVED — `/slack/events`, `/slack/commands`,
   stubbed `/slack/interactions`.
4. **Scope:** APPROVED — `/research`-only migration; rest stays on Railway.
