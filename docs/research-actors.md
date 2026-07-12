# OpenTag Research Actors

Architecture and deployment runbook for the procedural Orchestrator / Researcher / Verifier pipeline on OpenTag.

## Overview

The research framework replaces Centaur's K8s/DO edge stack with:

- **Shared core** (`lib/research/`) — actor logic, fibers, OCC, outbox patterns
- **Railway track** (primary) — Postgres + Node worker processes
- **Cloudflare track** (comparison) — Durable Objects + SQLite (`edge/`)

## Processes (Railway)

| Service | Command | Port |
|---------|---------|------|
| Bot | `pnpm dev` | — (Socket Mode) |
| Triage runtime | `pnpm runtime` | 8200 |
| Research runtime | `pnpm research:runtime` | 8201 (+ delivery API 8202) |
| Alarm worker | `pnpm research:worker` | — |

## Quick start (local)

```bash
# Start Postgres + Redis
docker compose up -d

# Migrate + env
cp .env.example .env
# Set DATABASE_URL=postgres://opentag:opentag@localhost:5432/opentag

pnpm install
pnpm research:runtime   # terminal 1
pnpm research:worker    # terminal 2
pnpm dev                # terminal 3
```

In Slack: `@OpenTag research What are the latest trends in edge computing?`

Or: `/research What are the latest trends in edge computing?`

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection (required for research) |
| `AGENT_RESEARCH_URL` | Research AG-UI endpoint (bot routing) |
| `RESEARCH_DELIVERY_URL` | Delivery API base (default `http://localhost:8202`) |
| `PARALLEL_API_KEY` | Parallel web search / deep research |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | LLM providers |
| `RESEARCH_MODEL` | Primary model (default `claude-sonnet-4-20250514`) |
| `SLACK_ALLOWED_CHANNEL_IDS` | Comma-separated channel allowlist |
| `BLOB_STORAGE_PATH` | Local blob spill directory (default `./data/blobs`) |

## Architecture

```
Slack (Socket Mode) → bot (app/) → research runtime (runtime-research.ts)
                                        ↓
                              Orchestrator → Researcher → Verifier
                                        ↓
                                   Postgres
                                        ↑
                              alarm worker (worker/research-alarm.ts)
                                        ↓
                              Slack delivery (chat.postMessage)
```

## Adapter layer

All actor code imports `StorageAdapter`, `LlmAdapter`, `BlobAdapter` — never `pg` or `DurableObject` directly.

| Adapter | Railway | Cloudflare |
|---------|---------|------------|
| Storage | `PostgresStorageAdapter` | `DurableObjectStorageAdapter` |
| Blobs | `FilesystemBlobAdapter` | R2 binding |
| Scheduler | `alarm_queue` + worker | DO `alarm()` |

## Testing

```bash
pnpm test                              # unit tests
RESEARCH_MOCK=1 pnpm e2e:research      # in-memory pipeline
```

## Cloudflare comparison track

```bash
cd edge
npm install
npm run dev    # wrangler dev
```

See [docs/evaluation.md](./evaluation.md) for Railway vs Cloudflare comparison criteria.

## Railway deployment

Three services from the same repo:

1. **opentag-bot** — `pnpm start`
2. **opentag-research** — `pnpm research:runtime`
3. **opentag-research-worker** — `pnpm research:worker`

Attach a Railway Postgres plugin; set `DATABASE_URL` on all research services.

## MVP scope

- Deep research with web search + synthesis + verifier loop
- Channel allowlist permissions
- Task budgets and deadlines
- Blob spill for large payloads

Not in MVP: company context ETL, general codex agent, 60+ tool plugins.
