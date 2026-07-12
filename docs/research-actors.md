# OpenTag Research Actors

Runbook for the Orchestrator / Researcher / Verifier **task** pipeline.

> Research is a **TaskRuntime flavor**, not the Claude Tag product surface.
> Product north star: [`PRODUCT.md`](../PRODUCT.md). Slack ingress lives on the
> bot Worker (`edge/src/worker.ts`); this Worker exposes internal `/research`.

## Overview

- **Shared core** (`lib/research/`) — actor logic, fibers, OCC, outbox
- **Cloudflare** — Durable Objects + SQLite (`edge/wrangler.research.toml`), invoked via bot `RESEARCH_TASKS` binding
- **Optional Railway** — Postgres + Node processes for local eval (not Slack ingress)

## Processes

| Service | Command | Role |
|---------|---------|------|
| Bot Worker | `cd edge && npm run dev` | Slack Events API (primary) |
| Triage runtime | `pnpm runtime` | AG-UI agent (`AGENT_URL`) |
| Research Worker | `cd edge && npm run dev:research` | Internal `/research` |
| Optional: research runtime | `pnpm research:runtime` | Railway/Postgres AG-UI + delivery |
| Optional: alarm worker | `pnpm research:worker` | Postgres alarm poller |

## Cloudflare research task Worker

```bash
cd edge
npm install   # requires sibling CopilotKit channels build — see edge/README.md
npm run dev:research   # wrangler.research.toml → opentag-orchestrator
npm run dev            # wrangler.toml → binds RESEARCH_TASKS → orchestrator
```

Internal kickoff: `POST /research` with `Authorization: Bearer $INTERNAL_SECRET`
(body: `{ teamId, threadKey, objective }`).

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (optional Railway research) |
| `AGENT_URL` | Triage AG-UI (bot Worker → Node runtime) |
| `INTERNAL_SECRET` | Bearer for CF `/research` + `/internal/*` |
| `PARALLEL_API_KEY` | Parallel web search |

## Testing

```bash
RESEARCH_MOCK=1 pnpm e2e:research
cd edge && npm test && npm run test:e2e
```
