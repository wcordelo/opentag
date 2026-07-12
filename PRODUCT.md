# OpenTag Product — Claude Tag on Cloudflare

Status: **ACTIVE** (authoritative).  
Date: 2026-07-11. Updated: 2026-07-11 (full CF cutover).

## North star

OpenTag is an **open-source Claude Tag alternative**: a Slack-native AI agent you host yourself. Cloudflare is the infrastructure (Workers, Durable Objects, R2, Containers). CopilotKit `@copilotkit/channels` is the bot engine (`edge/vendor/` holds a Workers-safe tarball until upstream drops `createRequire`).

**Acceptance (product):** a production Slack workspace can run the full agent loop — mentions, slash commands, HITL approvals — with durable state across Worker restarts, per-channel prompts, memory, access-controlled tools, and long-running tasks (including deep research).

## Spine

1. **Ingress** — Slack Events API + slash commands + interactions on the **bot Worker** (no Socket Mode).
2. **Bot engine** — `createBot` + `CloudflareSlackAdapter` + `createDurableObjectStore(env.BOT_STATE)` + `HttpAgent` → `AGENT_URL`.
3. **StateStore** (`edge/src/store/`, binding `BOT_STATE`) — durable HITL, turn locks, transcripts, dedup.
4. **Tenant keying** — workspace (`teamId`) with channel overrides.

## Claude Tag parity checklist

| Capability | Status |
|---|---|
| Channel / workspace prompts & config | Implemented (`WorkspaceConfigDO`) |
| Access bundles (tool allowlist + secret *refs*) | Implemented; MCP clients open on Node runtime from refs |
| Memory — thread + knowledge | Implemented (StateStore threadstate + `KnowledgeDO`) |
| Durable HITL | Implemented (createBot ActionStore + Block Kit via Channels) |
| Deep research | Task type via `RESEARCH_TASKS` → orchestrator |
| Bundle → MCP | Runtime opens MCP from context `mcpEndpoints` + env `secretRefs` |
| Multi-agent PM / impl / verify | **Deferred** (Track F) — not in public TaskRuntime API |

## What research is (and is not)

- **Is:** a long-running task (`lib/research/` + research DOs) started by the bot, results posted back to the thread.
- **Is not:** the product surface, the default edge deploy, or the Slack ingress owner.

## Hard invariants

1. No Socket Mode on Cloudflare Workers.
2. Container egress is application-level HTTP proxy only.
3. Task/actor code talks to adapters, not `pg` / raw DO APIs.
4. Cold starts: immediate Slack ack; final result via `chat.postMessage` / agent stream.

## Deploy layout

| Config | Role |
|---|---|
| `edge/wrangler.toml` | Local/dev bot Worker (`opentag-edge`) |
| `edge/wrangler.bot.toml` | **Production** Claude Tag bot (`opentag-bot`) — clean DO migrations |
| `edge/wrangler.research.toml` | Research task Worker (internal `/research`, no public Slack) |
| `edge/workers/egress-proxy/` | Shared egress for containers |

**Live URL (this account):** `https://opentag-bot.williamlopezc.workers.dev`  
Point Slack Events / commands / interactions Request URLs there. `AGENT_URL` is a Worker secret pointing at a public AG-UI runtime (today: cloudflared quick tunnel to local `:8200`).

## Remaining work (honest)

- Track F: `pm_impl_verify` / sandbox multi-agent pipeline.
- Upstream `@copilotkit/channels` Workers fix (today: vendored tarball in `edge/vendor/`).
- Chart/diagram image tools deferred on Workers (no Playwright in isolate).
- Stable public `AGENT_URL` (Railway/Fly) — today a cloudflared quick tunnel to local runtime.
- Re-apply Slack app manifest Request URLs to `opentag-bot` for true Slack→CF inbound.
- Research Miniflare DO e2e (`WASM_DISPATCH` service) still `it.todo`.
- Legacy `opentag-edge` Worker still on account (old DO history); production is `opentag-bot`.
