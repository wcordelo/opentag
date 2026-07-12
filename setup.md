# OpenTag — setup & configuration

> **Start here for product overview:** [README.md](./README.md) · [PRODUCT.md](./PRODUCT.md) · [edge/README.md](./edge/README.md).  
> Slack ingress is the **Cloudflare bot Worker** (Events API). There is no Socket Mode bot.

## How it fits together

```
Slack Events API ──▶  edge/ bot Worker (createBot + DO StateStore)
                              │
                              ├── AG-UI ──▶  pnpm runtime (runtime.ts + MCP)
                              └── RESEARCH_TASKS ──▶  research Worker (optional)
```

## Quick run

```bash
# Agent (repo root)
cp .env.example .env          # OPENAI_API_KEY, AGENT_URL, optional Linear/Notion
pnpm install && pnpm runtime  # :8200

# Bot Worker
cd edge
cp .dev.vars.example .dev.vars   # SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, AGENT_URL
npm ci && npm run dev            # uses vendored @copilotkit/channels — see edge/README.md
```

Point Slack Request URLs at the Worker (`/slack/events`, `/slack/commands`,
`/slack/interactions`) — see [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
For local Slack inbound, tunnel the wrangler port (often `:8787`) or deploy
`npm run deploy:bot`.

Refreshing the channels vendor tarball (optional): see [`edge/vendor/README.md`](./edge/vendor/README.md).

## 1. Create a Slack app

1. [api.slack.com/apps](https://api.slack.com/apps?new_app=1) → **From a manifest** → paste
   [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
2. **OAuth & Permissions** → Install → copy **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
3. **Basic Information** → **Signing Secret** → `SLACK_SIGNING_SECRET`.
4. Set Request URLs to your Worker (`socket_mode_enabled: false`). Reinstall after
   scope changes (includes `reactions:write`).

## 2. Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | `edge/.dev.vars` / secrets | Bot Web API |
| `SLACK_SIGNING_SECRET` | `edge/.dev.vars` / secrets | Events HMAC verify |
| `AGENT_URL` | edge + root `.env` | AG-UI triage endpoint |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | root `.env` | Model for `pnpm runtime` |
| `LINEAR_API_KEY` / `NOTION_*` | root `.env` | Optional MCP tools on runtime |
| `ADMIN_SECRET` / `INTERNAL_SECRET` | edge | Admin routes / research forward |

See [`.env.example`](./.env.example) and [`edge/.dev.vars.example`](./edge/.dev.vars.example).

## 3. Integrations (runtime)

Linear and Notion MCP wiring lives in [`runtime.ts`](./runtime.ts). Run
`pnpm notion-mcp` when using Notion.

## Research tasks

```bash
cd edge && npm run dev:research
# or mock: RESEARCH_MOCK=1 pnpm e2e:research
```

See [docs/research-actors.md](./docs/research-actors.md).

## Tests

```bash
cd edge && npm test && npm run test:e2e && npm run typecheck
pnpm test   # root lib/research unit tests
```

## Doc index

See [docs/README.md](./docs/README.md).
