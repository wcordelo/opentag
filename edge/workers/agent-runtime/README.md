# opentag-agent — AG-UI triage on Cloudflare Containers

Production `AGENT_URL` target for `opentag-bot`. A thin Worker proxies HTTP to a
single always-on Container running Node [`runtime.ts`](../../../runtime.ts)
(and an optional Notion MCP sidecar). Prompt / MCP wiring:
[`lib/triage-agent.ts`](../../../lib/triage-agent.ts).

Requires **Workers Paid** (Cloudflare Containers).

The bot reaches this Worker via the **`AGENT_RUNTIME` service binding** (not
same-zone `workers.dev` fetch — that returns Cloudflare 1042).

This is the default conversational runtime. Repository coding is a separate,
opt-in `opentag-harness` package documented in
[docs/operations.md](../../../docs/operations.md); coding intent does not
silently fall back here when that harness is selected.

## Deploy

```bash
cd edge/workers/agent-runtime
npm ci

npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put LINEAR_TEAM_KEY   # team display name, e.g. Berendo
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

After changing `lib/triage-agent.ts` or `runtime.ts`, redeploy this package so
the Container image rebuilds (Docker layer cache can stick an old prompt file —
touch the file or bump the image if needed).

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Auth gate + `TRIAGE.getByName("triage").fetch` |
| `src/container.ts` | `TriageContainer` — port 8200, always-on activity |
| `Dockerfile` | Node 22 + `runtime.ts` + `lib/triage-agent.ts` + Notion launcher |
| `entrypoint.sh` | Optional Notion sidecar, then AG-UI on `:8200` |

Secrets are Worker secrets forwarded into the container as env vars (long-lived
keys — distinct from sandbox egress-proxy containers; see [`DECISIONS.md`](../../../DECISIONS.md) §2 vs §4).

### Pitfall: `envVars` class field

`TriageContainer.envVars` must be assigned as a **class field**
(`envVars = triageEnvVars()`), not a getter. The Containers base class sets
`envVars = {}`, which shadows getters — the process then starts with no
`OPENAI_API_KEY` / Linear secrets (DECISIONS §10).

### Linear

- `LINEAR_TEAM_KEY` = team **display name** or ID (`Berendo`), not a bare issue
  prefix key like `CPK`.
- After `confirm_write` returns APPROVED, the agent should call `save_issue`
  immediately in the same turn, then `issue_card` with the URL.

## Local iteration

`pnpm runtime` at the repo root remains a **dev-only** shortcut so you can
change prompts/MCP without rebuilding the image.
