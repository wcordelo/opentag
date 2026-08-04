# OpenTag product contract

Status: **ACTIVE and authoritative**

Updated: **2026-08-01**

## North star

OpenTag is an open-source, self-hosted Claude-in-Slack alternative. A Slack
workspace can run conversational agents, approved tool actions, long-running
research, and optional repository coding turns while keeping its runtime and
state on Cloudflare.

Cloudflare supplies Workers, Durable Objects, R2, service bindings, and
Containers. CopilotKit `@copilotkit/channels` supplies the bot engine. Slack is
the product surface; task and coding planes remain behind the bot.

## Product promise

A user should experience:

- fast acknowledgement and incremental Slack rendering;
- durable thread continuity across Worker isolate changes;
- no silent terminal outcomes;
- a reliable Stop command that suppresses late output and controls in-flight effects;
- visible human approval before external writes;
- thread-scoped model and harness preferences;
- quick-action buttons that behave like ordinary user turns;
- optional deep research delivered back to the originating thread;
- Claude Code repository work with native Anthropic or Claudex/Codex model
  execution and mechanical commit/PR verification.

For Slack threads, tagging is optional for a clear ask. OpenTag reads every
human thread reply, routes questions, action requests, problem reports, files,
and explicit mentions into the normal turn lifecycle, and leaves conversational
noise as history without replying to it.

## Product surfaces

| Surface | Status | Contract |
| --- | --- | --- |
| Mentions and thread replies | Implemented | DMs, files, and explicit mentions are always eligible; unmentioned thread questions, action requests, and problem reports route without a tag; passive chatter remains history |
| `/agent` | Implemented | Same exact lifecycle as a mention |
| `/config` | Implemented | Channel prompt update preserving bundles and policy |
| `/research` | Implemented | Effect-fenced task start with exact cancellation |
| DMs and assistant threads | Implemented | Stable DM scope, status, title, Stop |
| Durable HITL | Implemented | `choiceId` persistence and cross-isolate polling |
| Linear create | Implemented | Structured approval, requester-email assignee, issue card |
| Thread overrides | Implemented | Sticky model/harness; unsupported reasoning flags fail visibly |
| Quick actions | Implemented | Synthetic turn authored by clicking user |
| Never-silent recovery | Implemented | Session events, render obligations, DO alarms |
| Claude Code harness | Production-enabled | Native Claude, Claudex, and Nanocodex modes share the same sandbox, Stop, egress, and git postconditions |
| Research actors | Optional | Internal task plane, never Slack ingress |
| Platform foundation | Source-complete; synthetic-live | Shared Worker fleet, per-team Durable Object isolation, metadata-only provisioning/effect ledger, connector references, OAuth/marketplace metadata, metering, and memory governance |
| Router | Live shadow mode | Versioned heuristic classifier and workspace measurement ledger; Tier 1 and Tier 3 remain dark |
| Buzz receive | Fail-closed integration | `/buzz/wake` exists with signed-admission plumbing, but an authenticated relay canary requires configured Buzz signer and relay credentials |
| Multi-agent PM/implement/verify product | Deferred | Not in the public TaskRuntime API |

The current deployment and feature-by-feature evidence is maintained in
[docs/current-state.md](./current-state.md). The platform and connector
rows describe metadata and policy foundations; they do not claim that a real
provider credential broker, OAuth callback, billing worker, deletion worker, or
external Buzz relay is live.

## Current architecture spine

1. **Ingress:** Slack Events API, commands, and interactions terminate on
   `opentag-bot`. Socket Mode and the old Railway bot are unsupported.
2. **Ingress routing and pre-admission:** normalized thread events pass through
   a deterministic response-worthiness gate. Only response-worthy events create
   an exact active-turn row and initial obligation before asynchronous
   enrichment; duplicate Slack `message` delivery for an `app_mention` exits
   before admission.
3. **Bot engine:** `createBot` and `CloudflareSlackAdapter` handle messages,
   commands, cards, status, titles, and streaming.
4. **Lifecycle:** `runSlackTurnLifecycle()` owns session admission, obligations,
   routing, HITL, terminal delivery, busy rejection feedback, and status.
5. **Durability:** `ConversationStateDO` owns active/effect/render fences and
   recovery; `SessionEventDO` owns execution, events, replay, and interrupts.
6. **Conversation runtime:** `opentag-agent` runs Node `runtime.ts`, reached
   through the `AGENT_RUNTIME` service binding plus `AGENT_URL` path.
7. **Coding runtime:** `opentag-harness` runs coding CLIs in a per-session
   Container with outbound interception and remote-git HITL. It can call
   Anthropic directly (`claudecode`), the private `opentag-claudex-proxy`
   service (`claudex`) for GPT models through CLIProxyAPI/Codex OAuth, or the
   native Nanocodex CLI (`nanocodex`) against OpenAI Responses with a Worker-
   injected `OPENAI_API_KEY`.
8. **Tasks:** optional research starts through `RESEARCH_TASKS` and delivers
   back to the originating Slack thread.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the state machines and sequence
diagrams.

## Reliability contract

Every production turn carries a stable execution ID, a stable forwarded-message
ID, an exact active-turn record, SessionEventDO admission, and a render
obligation until terminal visibility is confirmed. Duplicate deliveries stay
silent; passive thread events never create a turn; distinct concurrent asks
receive a durable-deduped busy note.

Every delivered turn ends with a live or recovered answer, an explicit error,
a confirmed interruption, or an intentionally silent shortcut. Returning from
application code is not proof of delivery. Slack output and non-Slack effects
use compare-and-set fences, and crash recovery reconstructs only events from
the obligated execution.

## Security contract

The default AG-UI Container receives its configured runtime secrets. The
coding harness uses a stricter design:

- internet disabled at the Container boundary and HTTPS intercepted;
- sentinel Anthropic/GitHub credentials inside the process;
- real credentials injected only after exact Worker policy validation;
- Claudex caller credentials stripped at both Worker boundaries, with the
  bounded Codex OAuth object loaded from and refreshed back to private R2;
- remote git bound to execution, canonical repo, generated branch, method,
  operation, expiry, and requester attribution;
- GraphQL mutations denied;
- non-root process, read-only harness files, disposable execution HOME, and
  process-group cancellation;
- success conditioned on verified commit/tree and, when approved, branch/PR
  postconditions.

## Centaur relationship

OpenTag adopted Centaur's Slack streaming conflation, status/title UX, Stop
parser, render-obligation discipline, session/event log, stable dedup concepts,
override syntax, quick-action pattern, and requester-attribution guidance. It
reimplemented those patterns for Cloudflare Durable Objects and Workers.

OpenTag also adds stronger Cloudflare-specific controls: exact active-turn and
effect fences, pre-admission, durable Stop continuation, research quiescence,
Worker-enforced harness egress, and mechanical coding postconditions. Rails,
Postgres, Kubernetes, and Centaur's console are not part of this product.

The exact map is [docs/centaur-port.md](./centaur-port.md).

## Hard invariants

1. Slack terminates only on `opentag-bot`; no Socket Mode.
2. Bot, session, obligation, Stop, and research keys must agree.
3. DMs use `DM_SCOPE`; channel thread events use their reply-thread timestamp;
   top-level slash commands use channel scope because Slack provides no ts.
4. Route response-worthiness before pre-admission; pre-admit before the first
   async lookup.
5. Never clear an obligation merely because code returned; confirmed final
   render owns exact active-turn cleanup.
6. Never grant remote git through prompts or environment variables alone.
7. Research and harness cancellation are complete only after quiescence.
8. Task-domain code depends on adapters rather than infrastructure APIs.

## Canonical documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — implemented topology and lifecycle
- [docs/centaur-port.md](./centaur-port.md) — port/adaptation inventory
- [docs/extending.md](./extending.md) — safe extension guide
- [docs/operations.md](./operations.md) — validation, deploy, and diagnosis
- [DECISIONS.md](./DECISIONS.md) — locked technical decisions
