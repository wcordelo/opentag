# OpenTag Edge — Claude Tag on Cloudflare

**Product:** OpenTag as an open Claude-in-Slack alternative on Cloudflare.
Authoritative: [`../PRODUCT.md`](../PRODUCT.md).

| Config | Role |
| --- | --- |
| **`wrangler.bot.toml`** | **Production** — `opentag-bot` Claude Tag spine |
| `wrangler.toml` | Local/dev bot Worker (`opentag-edge`) |
| `wrangler.research.toml` | Research **task** Worker (internal `/research` only) |
| `wrangler.bot-store.toml` | StateStore e2e alias |
| `workers/egress-proxy/` | Shared egress for containers |

## Prerequisite — `@copilotkit/channels*`

CI and local installs use npm + a Workers-safe vendored tarball:

- `@copilotkit/channels` → `edge/vendor/copilotkit-channels-0.1.1.tgz` (no `createRequire`)
- `@copilotkit/channels-ui` / `@copilotkit/channels-slack` → npm registry

```bash
cd edge
npm ci   # or npm install
npm test                 # bot-spine unit tests
npm run test:e2e         # StateStore workerd
npm run typecheck
npm run deploy:bot       # production Worker (opentag-bot)
npm run dev              # local bot spine (Slack Events API)
npm run dev:research     # optional research task Worker
```

Optional local sibling CopilotKit checkout is only needed when refreshing the vendor tarball (see `vendor/README.md`).

## Local E2E

```bash
cp .dev.vars.example .dev.vars   # fill Slack + AGENT_URL + secrets
./scripts/e2e-local.sh           # readiness checks + checklist
pnpm runtime                     # terminal A (repo root) — AGENT_URL target
npm run dev                      # terminal B
./scripts/e2e-smoke-local.sh     # signed Events API → real Slack reply (no tunnel)
# For live Slack inbound: tunnel :8787 and point Request URLs at the bot Worker;
# re-install ../slack-app-manifest.yaml (includes message.channels)
# optional research: merge .dev.vars.research.example, then npm run dev:research
```

**Smoke:** @mention → reply; thread follow-up without @; Linear `issue_list`;
`confirm_write` across Worker restart; `/research` delivery; `remember:`.

**Workers note:** sibling `@copilotkit/channels` must not use `createRequire(import.meta.url)`
(crashes workerd). Patch `create-bot.ts` to a static package version if rebuilding.

## Spine

1. Slack → `src/worker.ts` → `CloudflareSlackAdapter` → `createBot` (`@copilotkit/channels`)
2. StateStore `BOT_STATE` — HITL, locks, transcripts, dedup
3. `WORKSPACE_CONFIG` — prompts + access bundles
4. `KNOWLEDGE` — longer-term memory
5. `RESEARCH_TASKS` → orchestrator `POST /research`
6. `AGENT_URL` → Node AG-UI runtime (`HttpAgent`)

## Layout

```
edge/
├── wrangler.toml
├── wrangler.research.toml
├── src/                  # bot spine + CloudflareSlackAdapter
├── workers/orchestrator/ # research tasks
└── workers/egress-proxy/
```
