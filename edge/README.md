# OpenTag Edge — Claude Tag on Cloudflare

**Product:** OpenTag as an open Claude-in-Slack alternative on Cloudflare.
Authoritative: [`../PRODUCT.md`](../PRODUCT.md).

| Config | Role |
| --- | --- |
| **`wrangler.toml`** | **Default** — bot Worker + StateStore + config + knowledge + `RESEARCH_TASKS` |
| `wrangler.research.toml` | Research **task** Worker (internal `/research` only — no public Slack) |
| `wrangler.bot-store.toml` | StateStore e2e alias |
| `workers/egress-proxy/` | Shared egress for containers |

## Prerequisite — sibling CopilotKit

Edge depends on local `@copilotkit/channels*` via `file:../../CopilotKit/packages/...`:

```bash
# From Documents/ (or sibling of opentag)
cd CopilotKit
pnpm install
pnpm --filter @copilotkit/shared --filter @copilotkit/core \
  --filter @copilotkit/channels-ui --filter @copilotkit/channels \
  --filter @copilotkit/channels-slack build
```

Then:

```bash
cd edge
npm install
npm test
npm run test:e2e         # StateStore workerd (primary)
npm run test:workers     # research task suite (secondary)
npm run typecheck
npm run dev              # bot spine (Slack Events API)
npm run dev:research     # research task Worker
```

Agent replies need `pnpm runtime` at repo root (`AGENT_URL`).

## Local E2E

```bash
cp .dev.vars.example .dev.vars   # fill Slack + AGENT_URL + secrets
./scripts/e2e-local.sh           # readiness checks + checklist
pnpm runtime                     # terminal A (repo root) — AGENT_URL target
npm run dev                      # terminal B — tunnel this to Slack
# Re-install / update Slack app from ../slack-app-manifest.yaml
# (includes message.channels for thread continuity)
# optional research:
# merge .dev.vars.research.example into .dev.vars, then npm run dev:research
```

**Smoke:** @mention → reply; thread follow-up without @; Linear `issue_list`;
`confirm_write` across Worker restart; `/research` delivery; `remember:`.

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
