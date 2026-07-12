# OpenTag Edge — Cloudflare comparison track

Thin Durable Object shells over shared `lib/research/` core.

## Setup

```bash
cd edge
npm install
npm run dev
```

## Endpoints

- `GET /health` — health check
- `POST /research` — `{ threadKey, objective }` → Orchestrator DO

## Shared core

Actor logic lives in `../lib/research/`:
- `orchestrator.ts`, `researcher.ts`, `verifier.ts`
- `adapters/storage-do.ts` — DO SQLite adapter

## Compare with Railway

See [../docs/evaluation.md](../docs/evaluation.md).
