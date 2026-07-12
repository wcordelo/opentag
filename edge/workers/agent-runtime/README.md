# opentag-agent — AG-UI triage on Cloudflare Containers

Production `AGENT_URL` target for `opentag-bot`. A thin Worker proxies HTTP to a
single always-on Container running Node [`runtime.ts`](../../../runtime.ts)
(and an optional Notion MCP sidecar).

Requires **Workers Paid** (Cloudflare Containers).

## Deploy

```bash
cd edge/workers/agent-runtime
npm ci

npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put LINEAR_TEAM_KEY
# optional:
# npx wrangler secret put AGENT_MODEL
# npx wrangler secret put NOTION_TOKEN
# npx wrangler secret put NOTION_MCP_AUTH_TOKEN
# npx wrangler secret put AGENT_AUTH_HEADER

npm run deploy
```

Wire the bot:

```bash
printf '%s' 'https://opentag-agent.<account>.workers.dev/api/copilotkit/agent/triage/run' \
  | npx wrangler secret put AGENT_URL --config ../../wrangler.bot.toml
```

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Auth gate + `TRIAGE.getByName("triage").fetch` |
| `src/container.ts` | `TriageContainer` — port 8200, always-on activity |
| `Dockerfile` | Node 22 + `runtime.ts` + Notion launcher |
| `entrypoint.sh` | Optional Notion sidecar, then AG-UI on `:8200` |

Secrets are Worker secrets forwarded into the container as env vars (long-lived
keys — distinct from sandbox egress-proxy containers; see [`DECISIONS.md`](../../../DECISIONS.md) §2 vs §4).

## Local iteration

`pnpm runtime` at the repo root remains a **dev-only** shortcut so you can
change prompts/MCP without rebuilding the image.
