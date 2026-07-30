# R1 deployment plan — Supermemory Local on Railway

**Status:** R1 + C1 executed 2026-07-28. Local sidecar live; `opentag-bot` deployed with Supermemory secrets and knowledge Queue bindings.
**Date:** 2026-07-28
**Stop gate remaining:** tracked-source enablement (Ed25519 grant authority), agent/harness Container redeploy (Docker), mutation-contract, R2 backup/restore.

## Executed Railway targets

| Resource | Exact value |
| --- | --- |
| Workspace | `William Lopez-Cordero's Projects` (`546abf5f-9447-4d89-84d3-5e5e08c809a0`) |
| Project | `opentag-supermemory-local` (`e1cb3cce-fcd8-4b98-89aa-9502ecffe9a7`) |
| Environment | `production` (`1d7cbe3e-4297-4aa9-a58c-82a42c2ee4cd`) |
| Service | `supermemory-local` (`2df36853-771f-4edc-8e7e-d33e66a00910`) |
| Volume | `supermemory-data` (`0dc54ff8-c396-4706-a3e7-b0a6eb9440e7`) @ `/var/lib/supermemory` |
| Public domain | `https://supermemory-local-production.up.railway.app` |
| Successful deploy | `17484747-fa9f-4edf-a170-0a58b579557b` |
| Volume ownership fix | `RAILWAY_RUN_UID=0` (required; non-root chmod crash-looped) |
| Generated key path | volume `/api-key` (also set as service `SUPERMEMORY_API_KEY`) |

## Runtime variables set

- `SUPERMEMORY_DATA_DIR=/var/lib/supermemory`
- `OPENAI_MODEL=gpt-5.1` / `OPENAI_FAST_MODEL=gpt-5.1` / `OPENAI_TEXT_MODEL=gpt-5.1`
- `SUPERMEMORY_EMBEDDING_PROVIDER=local`
- `SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5`
- `SUPERMEMORY_EMBEDDING_DIMENSIONS=768`
- `RAILWAY_RUN_UID=0`
- `OPENAI_API_KEY` (from local `.env`, never committed)
- `SUPERMEMORY_API_KEY` (from volume `/api-key`)

Do **not** set `DATABASE_URL`. Do **not** invent `healthcheckPath` from `/` or authenticated routes.

## Smoke evidence (2026-07-28)

- UI title `supermemory · local` at `/` (HTTP 200).
- OpenAPI at `/v3/openapi` and `/v4/openapi` (HTTP 200).
- Authenticated `POST /v3/documents` → poll to `done` → `POST /v4/search` returned 1 hit under `workspace:smoke-team`.
- Same query under `workspace:other-team` returned 0 hits.
- First-boot `sm_...` key did not appear in Railway logs (entrypoint redactor).

## Still blocked / separate approvals

- ~~Cloudflare `opentag-bot` secrets `SUPERMEMORY_URL` / `SUPERMEMORY_API_KEY`.~~ **Done 2026-07-28 (C1).**
- ~~Queue producer/consumer enablement.~~ **Done** — `opentag-knowledge` + `opentag-knowledge-dlq` bound on `opentag-bot` version `e09e1750-9998-435c-99c9-a0ac7149fefa`.
- Tracked knowledge source enablement (still needs Ed25519 grant authority + ADMIN lifecycle).
- Local live PATCH/DELETE mutation contract (`SUPERMEMORY_MUTATION_CONTRACT=verified`).
- R2 backup/restore rehearsal.
- Agent/harness Container redeploy (needs Docker daemon).
- Centaur harness Container smoke (Docker Desktop installed locally but daemon not ready).

## C1 execution record

- `SUPERMEMORY_URL=https://supermemory-local-production.up.railway.app`
- `SUPERMEMORY_API_KEY` set from Railway volume `/api-key` (value not committed)
- Bot URL: `https://opentag-bot.williamlopezc.workers.dev`
- Queue vars: `KNOWLEDGE_QUEUE_NAME=opentag-knowledge`, `KNOWLEDGE_DLQ_NAME=opentag-knowledge-dlq`
