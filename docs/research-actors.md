# OpenTag Research Actors

Runbook for the Orchestrator / Researcher / Verifier **task** pipeline.

> Research is a **TaskRuntime flavor**, not the Claude Tag product surface.
> Product north star: [`PRODUCT.md`](../PRODUCT.md). Slack ingress lives on the
> bot Worker (`edge/src/worker.ts`); this Worker exposes internal `/research`.

## Overview

- **Shared core** (`lib/research/`) — actor logic, fibers, OCC, outbox
- **Railway** — Postgres + Node processes (local / hybrid)
- **Cloudflare** — Durable Objects + SQLite (`edge/wrangler.research.toml`), invoked via bot `RESEARCH_TASKS` binding

## Processes (Railway)

| Service | Command | Port |
|---------|---------|------|
| Bot | `pnpm dev` | — (Socket Mode; Railway path) |
| Triage runtime | `pnpm runtime` | 8200 |
| Research runtime | `pnpm research:runtime` | 8201 (+ delivery API 8202) |
| Alarm worker | `pnpm research:worker` | — |

## Cloudflare research task Worker

```bash
cd edge
npm install
npm run dev:research   # wrangler.research.toml → opentag-orchestrator
```

Bot spine (default):

```bash
npm run dev            # wrangler.toml → binds RESEARCH_TASKS → orchestrator
```

Internal kickoff: `POST /research` with `Authorization: Bearer $INTERNAL_SECRET`
(body: `{ teamId, threadKey, objective }`).

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (Railway research) |
| `AGENT_RESEARCH_URL` | Research AG-UI endpoint (Railway bot routing) |
| `RESEARCH_DELIVERY_URL` | Delivery API base |
| `PARALLEL_API_KEY` | Parallel web search |
| `INTERNAL_SECRET` | Bearer for CF `/research` + `/internal/*` |

## Testing

```bash
pnpm test                              # unit tests (repo root)
RESEARCH_MOCK=1 pnpm e2e:research      # in-memory pipeline
cd edge && npm test && npm run test:e2e
```

## MVP scope

Deep research with search + synthesis + verifier; channel allowlist; budgets;
blob spill. Not in MVP: company ETL, general codex agent, 60+ tool plugins.
