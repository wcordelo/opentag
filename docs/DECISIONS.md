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

The Claude Code harness uses a stricter boundary in
`edge/workers/sandbox/`: the Container has internet disabled and HTTPS
intercepted; its process receives sentinel Anthropic/OpenAI/GitHub credentials. The
outer Worker injects real credentials only after validating host, method,
execution, repository, generated branch, request body, operation, expiry, and
requester attribution. Package/source mirrors are GET/HEAD-only. GitHub GraphQL
mutations are denied. Claudex model requests cross a private service binding to
`opentag-claudex-proxy`; the harness never receives Codex OAuth state, and the
proxy exposes only the model/message endpoints required by Claude Code.
Nanocodex model requests use Worker-injected `OPENAI_API_KEY` for
`api.openai.com` HTTPS Responses only (no ChatGPT subscription OAuth in the
container). There is no separate generic `edge/workers/egress-proxy` service.

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
| Repository coding | `opentag-harness` Worker + Container, with native Claude, private Claudex, and native Nanocodex modes |

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

Threaded Stop commands still require an exact mention of the configured bot
before cancellation. Ordinary human thread replies use the response-worthiness
gate described below: clear questions, action requests, problem reports, file
shares, and explicit mentions may admit without requiring a tag, while passive
conversation remains history without acquiring an active-turn row.

## 11A. Slack response routing and duplicate admission

**Decision (2026-08-01):** Slack thread tags are optional for clear asks, but
OpenTag must not answer every conversational message. The verified ingress path
normalizes every human thread reply, then applies the deterministic
`classifySlackResponseRoute()` gate before durable pre-admission.

The gate always admits DMs, explicit bot mentions, trusted triggers, and file
shares. It also admits an unmentioned thread reply when the existing router
classifier identifies a question or a non-conversational signal, or when the
text contains a clear action request or problem report. Passive conversation is
observed and remains Slack history without creating a turn. Top-level
unmentioned channel chatter remains silent. The gate is response-worthiness,
not Router Tier 1/Tier 3 dispatch; admitted events still use the existing Tier
2 lifecycle while router measurements remain shadow-only.

Slack can deliver the same explicit mention as both `app_mention` and a
threaded `message`. The duplicate `message` path is therefore rejected before
it can register an active turn. This closes the stale-lock failure where the
adapter later discarded the duplicate after pre-admission had already created
an `active_turns` row.

The existing exact lifecycle remains authoritative after admission: the final
render must be confirmed before the exact active-turn row is deleted, and the
busy warning is reserved for a real distinct concurrent turn. We did not add a
time-based force-delete path because that would trade a visible stale warning
for possible answer-after-Stop or duplicate execution.

Evidence: `response-routing.test.ts`, `pre-admit-turn.test.ts`,
`cloudflare-slack-adapter.test.ts`, and the live routing/finalization canary in
[`docs/current-state.md`](./current-state.md).

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

## 17. Non-human actors, permission views, and runtime defaults

Slack automation is an explicit `slack_automation` actor, never a synthetic
human. It cannot Stop, mutate, start research, approve remote git, create a PR,
or provide `Prompted by:` attribution. Trusted rich-payload triggering is
disabled by default and requires both an exact `bot:B...`/`app:A...` allowlist
match and an exact nested mention of the configured bot user.

`PermissionSnapshotV1`, `show_permissions`, the admin permissions endpoint, and
the harness permissions file are informational views only. Authorization stays
in access-bundle resolution, exact-turn/effect fences, sandbox egress policy,
and durable HITL. Snapshots are bounded and redacted.

Runtime precedence is resolved independently per field: explicit message flag,
sticky thread choice, channel default, then deployment default. Merely using a
channel default never writes sticky state, and an unavailable selected harness
fails visibly without AG-UI fallback.

## 18. Shared-fleet tenancy

OpenTag uses one shared Worker fleet with strict per-team Durable Object
isolation. Team and project scope are resolved by server-owned mappings and
validated helpers; request bodies, Slack text, and connector labels never
choose arbitrary Durable Object names. Platform metadata is sharded by the
canonical internal tenant identity, while platform-wide marketplace metadata
uses a reserved object.

## 19. Worker Secrets and tenant custody

Cloudflare Worker Secrets are the approved deployment/bootstrap mechanism.
Self-hosters may configure them through the one-click Wrangler flow or the
Cloudflare CLI, and secret values must never enter Git, prompts, logs, or
Durable Object metadata.

Worker Secrets are deployment-scoped, so they are not by themselves a
per-tenant OAuth/token store for a shared fleet. Tenant Durable Objects retain
only opaque custody references, versions, grants, revocations, and effect
intents. A credential broker/effect worker must supply tenant-scoped resolution,
rotation, revocation, and audit before Drive, Linear, billing, or deletion can
be enabled. The current Layer 3 enum intentionally does not pretend that
`workers_secrets` is a complete per-tenant custody backend.

## 20. Knowledge, MCP, and live rollout

Internal knowledge/MCP calls use actor-bound bot tokens with exact team/project/
ACL scope, single-use replay protection, durable audit, and final source
authorization. External MCP remains operator-only. Synthetic validation is the
first rollout stage; the user authorized the live rollout without requiring an
additional approval prompt, but missing provider or relay credentials still
produce a fail-closed result.

## 21. Native Nanocodex adapter

OpenTag includes a native typed OpenAI Responses adapter for Nanocodex beneath
the existing authenticated harness boundary. It owns typed event translation,
checkpoint-aware replay, retry scoping, and completed-only provider-state
commit. It does not grant shell, repository, or remote-git tools to the native
adapter; coding turns remain on the existing Claude Code harness wire contract.

## 22. Router rollout

The exact heuristic classifier and workspace measurement ledger are enabled in
shadow mode. Tier 2 remains the safe dispatch floor. Tier 1 requires measured
knowledge health, quality/fallback gates, cost evidence, and rollback proof;
Tier 3 remains dark until its sandbox/capacity contract is separately approved.

## 23. Current evidence

The dated deployment, Slack canaries, synthetic platform ledger run, router
summary, Buzz fail-closed probe, and open gates are recorded in
[docs/current-state.md](./current-state.md). Historical backfill reports
retain their original point-in-time claims and link to that reconciliation.

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
18. **Non-human actors, permission views, and runtime defaults (§17):** APPROVED
19. **Shared-fleet tenancy (§18):** APPROVED
20. **Worker Secrets and tenant custody (§19):** APPROVED with the broker gap
21. **Knowledge/MCP rollout (§20):** APPROVED
22. **Native Nanocodex adapter (§21):** APPROVED
23. **Router shadow rollout (§22):** APPROVED
