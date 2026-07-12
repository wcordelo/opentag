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

## 2. Egress proxy

Application-level HTTP proxy Worker (`edge/workers/egress-proxy`), not transparent
TCP interception. Containers hold no long-lived API keys — only short-lived
`AGENT_TOKEN`. The proxy allowlists hosts, injects secrets, and logs execution.

---

## 3. Slack Events API

- **No Socket Mode** — incompatible with Workers.
- Slack Events / commands / interactions terminate on the **bot Worker**
  (`edge/src/worker.ts` / `opentag-bot`).
- Research is invoked via TaskRuntime → `RESEARCH_TASKS` → internal `POST /research`.
- HMAC verify with `SLACK_SIGNING_SECRET`; ack within ~3s; finish via `waitUntil` /
  `chat.postMessage` / agent stream.

---

## Product shape (current)

| Concern | Owner |
|---|---|
| Slack HTTP | Bot Worker |
| Claude Tag durability | Bot StateStore (`BOT_STATE`) |
| Deep research | Optional research Worker (task flavor) |
| LLM / MCP | Node `pnpm runtime` (`AGENT_URL`) |

Discord / Telegram / WhatsApp are **out of scope** for this product track.
Railway Socket Mode Slack has been **removed**.

---

## Sign-off

1. **DO granularity (§1):** APPROVED  
2. **Egress proxy (§2):** APPROVED — application-level HTTP proxy  
3. **Events API / no Socket Mode (§3):** APPROVED  
4. **Research as task (not product spine):** APPROVED — see PRODUCT.md
