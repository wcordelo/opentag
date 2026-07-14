# OpenTag Research Actors

Runbook for the Orchestrator / Researcher / Verifier **task** pipeline.

> Research is a **TaskRuntime flavor**, not the Claude Tag product surface.
> Product north star: [`PRODUCT.md`](../PRODUCT.md). Slack ingress lives on the
> bot Worker (`edge/src/worker.ts`); this Worker exposes internal `/research`.

Current architecture and Stop sequencing: [ARCHITECTURE.md](../ARCHITECTURE.md).
An exact cancel is complete only when the task reports both `cancelled: true`
and `quiescent: true`; queued actor, outbox, delivery, and alarm work must then
remain suppressed.

## Overview

- **Shared core** (`lib/research/`) — actor logic, fibers, OCC, outbox, delivery
- **Cloudflare** — Durable Objects + SQLite (`edge/wrangler.research.toml`), invoked via bot `RESEARCH_TASKS` binding
- **Optional local Postgres** — `RESEARCH_MOCK=1 pnpm e2e:research` for adapter tests (not Slack ingress)

## Processes

| Service | Command | Role |
|---------|---------|------|
| Bot Worker | `cd edge && npm run dev` | Slack Events API (primary) |
| Triage runtime | `opentag-agent` Container (prod) / `pnpm runtime` (dev) | AG-UI agent (`AGENT_URL`) |
| Research Worker | `cd edge && npm run dev:research` | Internal `/research` |

## Cloudflare research task Worker

```bash
cd edge
npm ci
# Match INTERNAL_SECRET with the bot Worker (.dev.vars)
npm run dev:research   # wrangler.research.toml → opentag-orchestrator
npm run deploy:research
```

Internal kickoff: `POST /research` with `Authorization: Bearer $INTERNAL_SECRET`
(body: `{ teamId, threadKey, objective }`). Prefer bot `POST /tasks/start` in
normal operation so channel policies and Slack thread context apply.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `INTERNAL_SECRET` | Bearer for CF `/research` + `/internal/*` (must match bot) |
| `SLACK_BOT_TOKEN` | Delivery of research summaries to Slack |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Research LLM (orchestrator secrets) |
| `PARALLEL_API_KEY` | Optional Parallel web search |
| `DATABASE_URL` | Optional Postgres track only |

## Testing

```bash
RESEARCH_MOCK=1 pnpm e2e:research
cd edge && npm test && npm run test:e2e
```

See also [evaluation.md](./evaluation.md).
