# OpenTag Edge — Claude Tag on Cloudflare

**Product:** OpenTag as an open Claude-in-Slack alternative on Cloudflare.
Authoritative: [`../PRODUCT.md`](../PRODUCT.md).

| Config | Role |
| --- | --- |
| **`wrangler.toml`** | **Default** — bot Worker + StateStore + config + knowledge + `RESEARCH_TASKS` |
| `wrangler.research.toml` | Research **task** Worker (internal `/research` only — no public Slack) |
| `wrangler.bot-store.toml` | StateStore e2e alias |
| `workers/egress-proxy/` | Shared egress for containers |

```bash
cd edge
npm install
npm test
npm run test:e2e         # StateStore workerd (primary)
npm run test:workers     # research task suite (secondary)
npm run dev              # bot spine
npm run dev:research     # research task Worker
```

## Spine

1. Slack → `src/worker.ts` (Events / commands / interactions)
2. StateStore `BOT_STATE` — HITL, locks, transcripts, dedup
3. `WORKSPACE_CONFIG` — prompts + access bundles
4. `KNOWLEDGE` — longer-term memory
5. `RESEARCH_TASKS` → orchestrator `POST /research`

## Layout

```
edge/
├── wrangler.toml
├── wrangler.research.toml
├── src/                  # bot spine
├── workers/orchestrator/ # research tasks (Slack demoted)
└── workers/egress-proxy/
```
