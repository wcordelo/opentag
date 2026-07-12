# OpenTag — technical decisions

Status: **APPROVED** for technical invariants.  
Product direction: **[`PRODUCT.md`](./PRODUCT.md)** (authoritative).

These decisions lock Cloudflare infrastructure choices for the bot spine and the
optional research task plane.

---

## 1. Durable Object naming

### Bot plane

| DO class | Key | Role |
|---|---|---|
| `ConversationStateDO` (`BOT_STATE`) | per conversation | HITL, turn locks, transcripts, dedup |
| `WorkspaceConfigDO` | per `teamId` | prompts, access bundles, policies |
| `KnowledgeDO` | per `teamId` | longer-term channel memory |

### Research task plane

| DO class | Key | Rationale |
|---|---|---|
| `OrchestratorDO` | `idFromName(teamId)` — **one per Slack workspace** | Workspace-scoped task control plane |
| `ResearcherDO` | `idFromName(taskId)` | Bounded fiber-step work for one task |
| `VerifierDO` | `idFromName(taskId)` | Same as Researcher |

Threads are rows keyed by `thread_key` inside the orchestrator, not separate DOs.

---

## 2. Egress proxy (sandbox containers only)

Application-level HTTP proxy Worker (`edge/workers/egress-proxy`), not transparent
TCP interception. **Deferred pm/impl/verify sandbox** containers hold no long-lived
API keys — only short-lived `AGENT_TOKEN`. The proxy allowlists hosts, injects
secrets, and logs execution.

This does **not** apply to the production triage agent Container
(`edge/workers/agent-runtime/`): that process holds long-lived `OPENAI_API_KEY` /
MCP secrets the same way laptop `pnpm runtime` does.

---

## 3. Slack Events API

- **No Socket Mode** — incompatible with Workers.
- Slack Events / commands / interactions terminate on the **bot Worker**
  (`edge/src/worker.ts` / `opentag-bot`).
- Research is invoked via TaskRuntime → `RESEARCH_TASKS` → internal `POST /research`.
- HMAC verify with `SLACK_SIGNING_SECRET`; ack within ~3s; finish via `waitUntil` /
  `chat.postMessage` / agent stream.

---

## 4. Triage AG-UI on Cloudflare Containers

Production `AGENT_URL` targets `opentag-agent` — a thin Worker that proxies to a
Cloudflare Container running Node `runtime.ts` (+ optional Notion MCP sidecar).
Requires **Workers Paid** for Containers. The bot reaches the agent via a
**service binding** (`AGENT_RUNTIME`) — same-zone `workers.dev` fetch returns
Cloudflare error 1042. Local `pnpm runtime` remains a dev-only shortcut.

---

## Product shape (current)

| Concern | Owner |
|---|---|
| Slack HTTP | Bot Worker (`opentag-bot`) |
| Claude Tag durability | Bot StateStore (`BOT_STATE`) |
| Deep research | Optional research Worker (task flavor) |
| LLM / MCP | `opentag-agent` Container (`AGENT_URL`) |

Discord / Telegram / WhatsApp are **out of scope** for this product track.
Railway Socket Mode Slack has been **removed**.

---

## 5. Cross-isolate HITL (`awaitChoice`)

`@copilotkit/channels` keeps `thread.awaitChoice` waiters in an **in-memory Map**.
On Workers, Slack `block_actions` often land on a different isolate than the turn
that posted Create/Cancel — the waiter is missing and clicks appear dead.

**Mitigation:** embed a stable `choiceId` in every Create/Cancel (and incident)
button value, persist clicks under `hitl-id:{choiceId}` (plus conversationKey
fallback) in `BOT_STATE`, and race the in-memory waiter against a DO poll
(`edge/src/hitl/durable-choice.ts`). Matching conversationKey is not required.
ActionStore snapshots alone are not enough: they revive `onClick` handlers, not
the waiter Promise. Poll interval is ~100ms. After Create, the bot posts
`⏳ Creating Linear issue…` immediately while the agent calls `save_issue`.

---

## 6. Linear default team

`LINEAR_TEAM_KEY` must be the Linear team **display name** (or ID) that
`list_issues` / `save_issue` accept — e.g. `Berendo` for this workspace (issue
prefix `BER-…`). A bare legacy key like `CPK` fails create/list. `get_team`
still accepts UUID, key, or name.

## 7. Mid-thread memory + structured confirm

AG-UI agent message lists are isolate-local. Slack `conversations.replies` can
also return empty. Persist recent user turns under `threadmem:{conversationKey}`
in `BOT_STATE`, merge with Slack history in `runBundledAgentTurn`, inject ticket
field candidates + a fuzzy parse hint, and embed the transcript in the user
prompt so create/file turns do not ask the user to restate fields.

`confirm_write` takes structured `title` / `description` / `assigneeEmail` /
`team`. Before posting the card, `coerceTicketFields` repairs mashed titles
(e.g. `title: test descripton test test` → title `test`, description `test test`)
via fuzzy label matching (prefix / edit-distance to canonical names — not a
typo allowlist).

## 8. Slack Web API encoding

The bot’s Slack client (`edge/src/slack/web-api.ts`) must use
**`application/x-www-form-urlencoded`** bodies. JSON bodies break several
methods — notably `users.info` returns `user_not_found` and never includes
`profile.email`. Nested fields (`blocks`, `attachments`) are JSON-stringified
form values.

## 9. Default Linear assignee = Slack profile email

With bot scope `users:read.email`, every turn resolves the requester via
`users.info` and injects **Linear assignee email for this conversation**.
`confirm_write` / `save_issue` default to that email for “create a ticket for
me”. Do not ask the requester for their own email when the profile email is
set. After adding scopes, **reinstall** the Slack app and update
`SLACK_BOT_TOKEN` on the bot Worker (local `.dev.vars` and Cloudflare secrets)
if Slack issued a new token. Verify with the `x-oauth-scopes` response header
on `auth.test`.

## 10. Container `envVars` must be a class field

`@cloudflare/containers` sets `envVars = {}` on the base class. A subclass
**getter** is shadowed and the triage Container starts with no
`OPENAI_API_KEY` / Linear secrets. Assign `envVars = triageEnvVars()` as a
class field on `TriageContainer` (`edge/workers/agent-runtime/src/container.ts`).

---

## Sign-off

1. **DO granularity (§1):** APPROVED  
2. **Egress proxy (§2):** APPROVED — application-level HTTP proxy (sandbox only)  
3. **Events API / no Socket Mode (§3):** APPROVED  
4. **Research as task (not product spine):** APPROVED — see PRODUCT.md  
5. **Triage on CF Containers (§4):** APPROVED  
6. **Cross-isolate HITL (§5):** APPROVED  
7. **Linear team name (§6):** APPROVED  
8. **Thread memory + structured confirm (§7):** APPROVED  
9. **Slack form-urlencoded API (§8):** APPROVED  
10. **Slack profile email assignee (§9):** APPROVED  
11. **Container envVars class field (§10):** APPROVED
