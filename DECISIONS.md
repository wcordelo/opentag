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
| `ConversationStateDO` (`BOT_STATE`) | partitioned StateStore and Slack thread keys | HITL, active/effect/render fences, obligations, Stop continuation, transcripts, dedup |
| `SessionEventDO` (`SESSION_EVENTS`) | exact Slack obligation thread key | session creation, execute/forward dedup, append-only events, replay, exact interrupt |
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

## 2. Container credential and egress boundaries

The production triage agent Container (`edge/workers/agent-runtime/`) receives
its configured model/MCP secrets like laptop `pnpm runtime`.

The optional Claude Code harness uses a stricter boundary in
`edge/workers/sandbox/`: the Container has internet disabled and HTTPS
intercepted; its process receives sentinel Anthropic/GitHub credentials. The
outer Worker injects real credentials only after validating host, method,
execution, repository, generated branch, request body, operation, expiry, and
requester attribution. Package/source mirrors are GET/HEAD-only. GitHub GraphQL
mutations are denied. There is no separate `edge/workers/egress-proxy` service.

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
| Conversation delivery | `ConversationStateDO` (`BOT_STATE`) |
| Session execution/events | `SessionEventDO` (`SESSION_EVENTS`) |
| Deep research | Optional research Worker (task flavor) |
| LLM / MCP | `opentag-agent` Container (`AGENT_URL`) |
| Repository coding | Optional `opentag-harness` Worker + Container |

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

## 11. Stable exact turn identities and pre-admission

Production Slack turns derive purpose-tagged SHA-256 IDs from stable Slack
identity: `ot1e_` for executions and `ot1m_` for forwarded messages. Random
IDs are allowed only for direct tests/admin paths that cannot be redelivered.
Synchronous and Web Crypto implementations remain parity-tested.

Ingress registers the active turn and initial obligation before its first
profile, config, task, or model await. DMs—including DM slash commands—use
`DM_SCOPE`. Thread replies use the root timestamp. A top-level channel mention
uses its own message timestamp because that becomes the bot reply-thread root;
a top-level slash command falls back to channel scope because Slack provides no
message timestamp.

## 12. Exact render, effect, and rejection fences

Every output/status/title from a running turn and every non-Slack production
side effect claims the exact active turn before crossing its external boundary.
Confirmation or definitive failure updates that claim atomically. Quick-action
buttons therefore become synthetic user turns rather than privileged callbacks.

If a distinct ask is rejected because the same thread is already running, a
separate durable `busy-note:{threadKey}` dedup claim permits at most one
out-of-band busy notification per minute. Stable Slack redeliveries remain
silent. This note is not model output from either execution and must not claim
or release the live turn's render token.

After SessionEventDO accepts an execution, refresh the obligation replay cursor.
On duplicate admission, abandon only the pristine redelivery row and return.
Never clear a render obligation in `finally`; confirmed visibility or exact
cancellation owns cleanup.

## 13. Stop is a durable continuation

Stop targets the exact active execution and proceeds in order:

1. claim cancellation and cancel registered HITL choices;
2. control the exact runtime/effect (`interruptExpected`, harness process group,
   AG-UI abort, or research cancellation);
3. wait for definitive quiescence where required;
4. claim and post the Slack acknowledgement;
5. confirm visibility and clear the exact active turn and obligation.

Ambiguous intermediate work remains for bounded DO-alarm continuation. Stop
never reports success ahead of the underlying work.

## 14. Harness remote git requires durable per-turn HITL

The only grant path is `awaitRemoteGitApproval()`. Approval binds the exact
execution, canonical allowlisted repo, generated `opentag/session-*` branch,
approved push/optional-PR operation, bounded expiry, and requester attribution.
Prompt text is descriptive, never the enforcement boundary.

## 15. Coding success has mechanical postconditions

A coding turn may report success only after the harness proves a new commit or
tree change on its dedicated branch. When PR creation was approved, it also
proves the expected branch was pushed and an open requester-attributed PR
exists. Coding intent treats the harness as authoritative and cannot silently
fall back to AG-UI.

## 16. Research cancellation requires quiescence

An exact research cancel returns `{ cancelled: true, quiescent: true }` only
after actors suppress queued outbox/delivery/alarm work for that task. Slack
Stop acknowledgement waits for this contract so cancelled research cannot
post a late answer.

---

## Sign-off

1. **DO granularity (§1):** APPROVED
2. **Container credential/egress boundaries (§2):** APPROVED
3. **Events API / no Socket Mode (§3):** APPROVED
4. **Research as task (not product spine):** APPROVED — see PRODUCT.md
5. **Triage on CF Containers (§4):** APPROVED
6. **Cross-isolate HITL (§5):** APPROVED
7. **Linear team name (§6):** APPROVED
8. **Thread memory + structured confirm (§7):** APPROVED
9. **Slack form-urlencoded API (§8):** APPROVED
10. **Slack profile email assignee (§9):** APPROVED
11. **Container envVars class field (§10):** APPROVED
12. **Stable exact turn identities (§11):** APPROVED
13. **Render/effect/rejection fencing (§12):** APPROVED
14. **Durable Stop (§13):** APPROVED
15. **Remote-git HITL (§14):** APPROVED
16. **Coding postconditions (§15):** APPROVED
17. **Research cancellation (§16):** APPROVED
