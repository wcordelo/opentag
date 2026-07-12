# OpenTag — setup & configuration

> **Authoritative product path:** [PRODUCT.md](./PRODUCT.md) · [edge/README.md](./edge/README.md).
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
# Sibling CopilotKit (channels packages)
cd ../CopilotKit && pnpm install
pnpm --filter @copilotkit/channels-ui --filter @copilotkit/channels --filter @copilotkit/channels-slack build

# Agent
cd ../opentag && cp .env.example .env   # OPENAI_API_KEY, etc.
pnpm runtime

# Bot Worker
cd edge
cp ../.env.example .dev.vars   # or set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, AGENT_URL
npm install && npm run dev
```

Tunnel the Worker URL to Slack Request URLs (`/slack/events`, `/slack/commands`, `/slack/interactions`) — see [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).

## 1. Create a Slack app

1. [api.slack.com/apps](https://api.slack.com/apps?new_app=1) → **From a manifest** → paste
   [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
2. **OAuth & Permissions** → Install → copy **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
3. **Basic Information** → **Signing Secret** → `SLACK_SIGNING_SECRET`.
4. Set Request URLs to your Worker (not Socket Mode; `socket_mode_enabled: false`).

## 2. Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | `edge/.dev.vars` | Bot Web API |
| `SLACK_SIGNING_SECRET` | `edge/.dev.vars` | Events HMAC verify |
| `AGENT_URL` | edge + root `.env` | AG-UI triage endpoint |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | root `.env` | Model for `pnpm runtime` |
| `LINEAR_API_KEY` / `NOTION_*` | root `.env` | Optional MCP tools on runtime |
| `ADMIN_SECRET` / `INTERNAL_SECRET` | edge | Admin routes / research forward |

See [`.env.example`](./.env.example).

## 3. Integrations (runtime)

Linear and Notion MCP wiring is unchanged in [`runtime.ts`](./runtime.ts). Run
`pnpm notion-mcp` when using Notion.

## Research tasks

```bash
cd edge && npm run dev:research
# or optional Postgres track: RESEARCH_MOCK=1 pnpm e2e:research
```

See [docs/research-actors.md](./docs/research-actors.md).

## Tests

```bash
cd edge && npm test && npm run test:e2e && npm run typecheck
# root lib/research unit tests (after pnpm install at root for runtime deps):
pnpm test
```
