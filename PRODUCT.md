# OpenTag Product — Claude Tag on Cloudflare

Status: **ACTIVE** (authoritative).  
Updated: 2026-07-12.

## North star

OpenTag is an **open-source Claude Tag alternative**: a Slack-native AI agent you host yourself. Cloudflare is the infrastructure (Workers, Durable Objects, R2, Containers). CopilotKit `@copilotkit/channels` is the bot engine (`edge/vendor/` holds a Workers-safe tarball until upstream drops `createRequire`).

**Acceptance (product):** a production Slack workspace can run the full agent loop — mentions, slash commands, HITL approvals — with durable state across Worker restarts, per-channel prompts, memory, access-controlled tools, reactions for light acks, and long-running tasks (including deep research).

## Spine

1. **Ingress** — Slack Events API + slash commands + interactions on the **bot Worker** (no Socket Mode).
2. **Bot engine** — `createBot` + `CloudflareSlackAdapter` + `createDurableObjectStore(env.BOT_STATE)` + `HttpAgent` via **`AGENT_RUNTIME` service binding** + `AGENT_URL` path.
3. **StateStore** (`edge/src/store/`, binding `BOT_STATE`) — durable HITL (`hitl-id:`), thread memory (`threadmem:`), turn locks, transcripts, dedup.
4. **Tenant keying** — workspace (`teamId`) with channel overrides.
5. **AG-UI brain** — `opentag-agent` Cloudflare Container running Node `runtime.ts` (LLM + MCP).

## Claude Tag parity checklist

| Capability | Status |
|---|---|
| Channel / workspace prompts & config | Implemented (`WorkspaceConfigDO`) |
| Access bundles (tool allowlist + secret *refs*) | Implemented; MCP clients open on Node runtime from refs |
| Memory — thread + knowledge | Implemented (StateStore threadstate + `KnowledgeDO` + `threadmem:`) |
| Durable HITL (cross-isolate Create/Cancel) | Implemented (`choiceId` + DO poll; see DECISIONS §5) |
| Linear create with Slack email assignee | Implemented (`users:read.email` + structured `confirm_write`) |
| Fuzzy ticket field labels | Implemented (`coerceTicketFields` / thread-memory) |
| Reactions for thanks / explicit react intents | Implemented (`trivial-ack`, `react-intent`, `react_message`) |
| Deep research | Task type via `RESEARCH_TASKS` → orchestrator |
| Bundle → MCP | Runtime opens MCP from context `mcpEndpoints` + env `secretRefs` |
| Multi-agent PM / impl / verify | **Deferred** — not in public TaskRuntime API |

## What research is (and is not)

- **Is:** a long-running task (`lib/research/` + research DOs) started by the bot, results posted back to the thread.
- **Is not:** the product surface, the default edge deploy, or the Slack ingress owner.

## Hard invariants

See also [`DECISIONS.md`](./DECISIONS.md).

1. No Socket Mode on Cloudflare Workers.
2. Container egress for **sandbox** pm/impl/verify is application-level HTTP proxy only (see DECISIONS §2).
3. Task/actor code talks to adapters, not `pg` / raw DO APIs.
4. Cold starts: immediate Slack ack; final result via `chat.postMessage` / agent stream.

## Deploy layout

| Config | Role |
|---|---|
| `edge/wrangler.toml` | Local/dev bot Worker (`opentag-edge`) |
| `edge/wrangler.bot.toml` | **Production** Claude Tag bot (`opentag-bot`) |
| `edge/workers/agent-runtime/` | **Production** AG-UI triage Container (`opentag-agent`) |
| `edge/wrangler.research.toml` | Research task Worker (internal `/research`, no public Slack) |
| `edge/workers/egress-proxy/` | Shared egress for sandbox containers |

**Live URLs (this account):**
- Bot: `https://opentag-bot.williamlopezc.workers.dev`
- Agent: `https://opentag-agent.williamlopezc.workers.dev/api/copilotkit/agent/triage/run`

Point Slack Events / commands / interactions Request URLs at the bot. Production `AGENT_URL` is the agent Worker above (no laptop / cloudflared). Local `pnpm runtime` is **dev-only**.

## Remaining work (honest)

- Multi-agent PM / impl / verify sandbox pipeline (deferred).
- Upstream `@copilotkit/channels` Workers fix (today: vendored tarball in `edge/vendor/`).
- Chart/diagram image tools deferred on Workers (no Playwright in isolate).
- Optional: skip the extra LLM hop after Create by saving Linear from the bot when approved.

## Doc map

[README.md](./README.md) · [setup.md](./setup.md) · [edge/README.md](./edge/README.md) · [docs/README.md](./docs/README.md)
