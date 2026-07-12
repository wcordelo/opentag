# OpenTag 2.0 — Gate 0 Decisions (research-track technical)

> **Product direction:** [`PRODUCT.md`](./PRODUCT.md) is authoritative.
> This file records **technical CF invariants** and the historical
> *research-task migration* Gate 0. Do **not** treat §3 “`/research`-only”
> as the product scope — that clause is superseded (see bottom).

Status: **APPROVED** for technical invariants (DO naming, egress, Events API
HMAC). Product surface = Claude Tag bot spine on CF (PRODUCT.md).

Inputs reviewed (historical): `goal-prompt.md`, `opentag-2.0-analysis.md`,
`opentag-2.0-impl-spec.md`, `lib/research/*`, `app/research-agent.ts`,
`app/commands/index.ts`, `slack-app-manifest.yaml`.

---

## 1. Durable Object naming granularity (research task plane)

| DO class | Key | Rationale |
|---|---|---|
| `OrchestratorDO` | `idFromName(teamId)` — **one per Slack workspace** | Hard invariant #6 in `goal-prompt.md`. |
| `ResearcherDO` | `idFromName(taskId)` — one per task/session | Bounded fiber-step work for a single task. |
| `VerifierDO` | `idFromName(taskId)` — one per task/session | Same reasoning as Researcher. |
| Agent containers (PM/Impl/Verify) | rows in owning `OrchestratorDO` SQLite | Lifecycle with workspace task DO. |

**Resolution:** OrchestratorDO is per-workspace (`teamId`), not per-thread.
Threads are rows keyed by `thread_key`. Bot plane uses separate DOs
(`ConversationStateDO`, `WorkspaceConfigDO`, `KnowledgeDO`) — see PRODUCT.md.

---

## 2. Egress Proxy Design (application-level)

Application-level HTTP proxy Worker (`edge/workers/egress-proxy`), not
transparent TCP interception. Containers hold no API keys — only short-lived
`AGENT_TOKEN`. Proxy allowlists hosts, injects secrets, logs to OrchestratorDO.

---

## 3. Slack Events API (historical research-track shape)

**Historical note:** Gate 0 originally placed Slack HTTP on the Orchestrator
Worker with `/research`-only scope. **Current product:** Slack Events /
commands / interactions terminate on the **bot Worker** (`edge/src/worker.ts`).
Research is invoked via TaskRuntime → `RESEARCH_TASKS` service binding →
`POST /research` (internal). Orchestrator public `/slack/*` routes are
removed (410 if hit).

Technical still binding: HMAC verify with `SLACK_SIGNING_SECRET`, no Socket
Mode, ack within 3s + `waitUntil` / `chat.postMessage` for results.

---

## Sign-off (Gate 0 — technical)

1. **DO granularity (§1):** APPROVED — per-workspace `OrchestratorDO` (research task plane).
2. **Egress proxy (§2):** APPROVED — application-level HTTP proxy Worker.
3. **Events API HMAC / no Socket Mode:** APPROVED.
4. **Scope (original `/research`-only):** APPROVED for the *research migration track* only — **not** product direction.

---

## Product supersession (2026-07-11)

**[`PRODUCT.md`](./PRODUCT.md) is authoritative for product direction.**

| Prior (Gate 0 product reading) | Current (PRODUCT.md) |
|---|---|
| Research Orchestrator is the CF product | Bot + StateStore is the CF product spine |
| Only `/research` on CF | Full Slack bot on CF (mentions, commands, HITL) |
| Research DOs = the system | Research DOs = long-running **task** runtime |
| Bot StateStore = optional sibling | Bot StateStore = durability spine |
| Orchestrator owns Slack HTTP | Bot Worker owns Slack HTTP; research is service-bound |

## Full cutover (2026-07-11)

Railway Socket Mode Slack (`pnpm start`, `SLACK_APP_TOKEN`, `opentag-bot`) is **removed**.
Discord / Telegram / WhatsApp are out of this product track. Slack = CF Worker only.
