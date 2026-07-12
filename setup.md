# OpenTag — setup & configuration

> **Start here for product overview:** [README.md](./README.md) · [PRODUCT.md](./PRODUCT.md) · [edge/README.md](./edge/README.md).  
> Slack ingress is the **Cloudflare bot Worker** (Events API). There is no Socket Mode bot.

## How it fits together

```
Slack Events API ──▶  edge/ bot Worker (createBot + DO StateStore)
                              │
                              ├── AG-UI ──▶  opentag-agent (CF Container)
                              └── RESEARCH_TASKS ──▶  research Worker (optional)
```

## Production deploy

Requires **Workers Paid** (Cloudflare Containers).

```bash
# 1. Triage agent Container
cd edge/workers/agent-runtime
npm ci
# secrets: OPENAI_API_KEY, LINEAR_API_KEY, LINEAR_TEAM_KEY, optional Notion + AGENT_AUTH_HEADER
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put LINEAR_API_KEY
npm run deploy

# 2. Point the bot at the agent
cd ../..
printf '%s' 'https://opentag-agent.<account>.workers.dev/api/copilotkit/agent/triage/run' \
  | npx wrangler secret put AGENT_URL --config wrangler.bot.toml
npm run deploy:bot
```

No laptop `pnpm runtime` or cloudflared tunnel is required for production Slack.

## Local / quick iterate (dev-only)

```bash
# Agent (repo root) — optional when iterating on prompts without redeploying the image
cp .env.example .env          # OPENAI_API_KEY, optional Linear/Notion
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
| `AGENT_URL` | bot secrets / `.dev.vars` | AG-UI triage endpoint (`opentag-agent` in prod) |
| `OPENAI_API_KEY` | agent secrets / root `.env` | Model for triage runtime |
| `LINEAR_API_KEY` / `NOTION_*` | agent secrets / root `.env` | Optional MCP tools |
| `ADMIN_SECRET` / `INTERNAL_SECRET` | edge | Admin routes / research forward |

See [`.env.example`](./.env.example) and [`edge/.dev.vars.example`](./edge/.dev.vars.example).

## 3. Integrations (runtime)

Linear and Notion MCP wiring lives in [`lib/triage-agent.ts`](./lib/triage-agent.ts) /
[`runtime.ts`](./runtime.ts). In the Container, Notion starts as a sidecar when
`NOTION_TOKEN` + `NOTION_MCP_AUTH_TOKEN` are set. Locally: `pnpm notion-mcp`.

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
