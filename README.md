# OpenTag: an open-source alternative to Claude in Slack

Run your own AI agent inside Slack: it reads a thread, answers, calls your tools, and
renders rich results right in the conversation. Think of it as having Claude in your
workspace, except **open-source and self-hosted**: you own the runtime, bring your own
model, and wire it to your own tools. No per-seat pricing, no lock-in.

It's built on **[`@copilotkit/channels`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels)** —
CopilotKit's open SDK for chat-platform agents — hosted on **Cloudflare Workers**, with the
LLM/MCP brain in a **Cloudflare Container** (`opentag-agent`).

> **Authoritative product docs:** [PRODUCT.md](./PRODUCT.md) · [edge/README.md](./edge/README.md) · [setup.md](./setup.md)

---

## See it in action

https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135

▶️ **[Watch the demo](https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135)** (~50s) — an OpenTag agent working a Slack thread: it renders a breakdown, a table, and a bar chart inline (**generative UI**) and files a ticket only after an **Approve** gate (**human-in-the-loop**).

> **Two ways to run it:** **host it on your own** with the open-source stack below — or skip the ops and **[sign up for the managed service →](https://go.copilotkit.ai/opentag-managed-gh)** coming soon from CopilotKit.

---

## What’s in the box (current architecture)

OpenTag is a **Slack-native Claude Tag alternative** on Cloudflare. Slack ingress is
**Events API only** (no Socket Mode). The bot Worker owns mentions, slash commands, and
interactions; a Cloudflare Container hosts the LLM; optional research runs as a task Worker.

```
                    ┌─────────────────────────────────────────┐
  Slack ───────────▶│  opentag-bot (Cloudflare Worker)        │
  Events / slash /  │  createBot + CloudflareSlackAdapter     │
  interactions      │                                         │
                    │  BOT_STATE      — HITL, locks, dedup    │
                    │  WORKSPACE_CONFIG — prompts + bundles   │
                    │  KNOWLEDGE      — channel memory        │
                    └────────────┬──────────────┬─────────────┘
                                 │              │
                    HttpAgent    │              │ RESEARCH_TASKS
                    (AGENT_URL)  │              │ service binding
                                 ▼              ▼
                    ┌────────────────┐  ┌──────────────────────┐
                    │ opentag-agent  │  │ opentag-orchestrator │
                    │ CF Container   │  │ research task Worker │
                    │ runtime.ts     │  │ fibers → Slack post  │
                    │ AG-UI + MCP    │  └──────────────────────┘
                    └────────────────┘
```

| Piece | Role |
| --- | --- |
| **Bot Worker** (`edge/`, `opentag-bot`) | Slack Events API, `createBot`, tools/commands, reactions, Durable Object state |
| **AG-UI agent** (`edge/workers/agent-runtime/`, `opentag-agent`) | LLM turns, MCP (Linear / Notion), system prompt — production `AGENT_URL` |
| **Research task Worker** (optional) | Deep research fibers; posts verified summaries back to the thread |
| **Egress proxy** (optional) | Application-level HTTP proxy for deferred sandbox containers |

Local `pnpm runtime` is **dev-only** (iterate on prompts/MCP without rebuilding the Container image).

---

## Features

### Slack UX

- **@mentions** and **thread continuity** (follow-ups without re-@mentioning via `message.channels` / groups / IM events)
- **Slash commands:** `/agent`, `/config`, `/research`
- **DMs** and assistant-pane hooks (manifest includes App Home Messages + assistant view)
- **Reactions over chat spam:** thanks / ok → ❤️ or 👍; long turns get a brief hourglass reaction; explicit “react to my message” / “react with heart” handled without an LLM round-trip
- **`react_message` tool** for the agent when a reaction is better than a text reply
- **HITL** via Block Kit (`confirm_write` and related cards) durable across Worker restarts

### Agent & tools (bot Worker)

Client tools available to the model (gated by **access bundles**):

| Tool | Purpose |
| --- | --- |
| `lookup_slack_user` | Resolve people in the workspace |
| `read_thread` | Fetch thread history |
| `confirm_write` | Human-in-the-loop approve-before-write |
| `issue_card` / `issue_list` | Linear-style issue UI |
| `page_list` | Notion-style page lists |
| `show_status` / `show_links` / `show_incident` | Status / links / incident cards |
| `memory_search` / `memory_write` | Channel knowledge (`remember: …` shortcut) |
| `start_task` / `research_progress` | Kick off / poll deep research |
| `react_message` | Add a Slack emoji reaction |

Chart/diagram image tools are **not** available on the Workers bot (no Playwright in isolate).

### Runtime (Node)

- TanStack AI + OpenAI / Anthropic (and optional Google) via `runtime.ts`
- **Linear** and **Notion** MCP when credentials are present
- Thread transcript + requester timezone injected every turn (stateless AG-UI agents stay oriented)
- Null-safe Linear tool args middleware for MCP quirks

### Research (optional task plane)

- Start with `/research <topic>`, `@bot research: …`, or `start_task`
- Orchestrator / Researcher / Verifier Durable Objects, OCC fibers, Slack delivery with retries
- Not the product surface — a **task** behind `RESEARCH_TASKS` (see [docs/research-actors.md](./docs/research-actors.md))

### Config & tenancy

- Per-channel **system prompts** (`/config`)
- **Access bundles** — tool allowlists + secret refs + MCP endpoint refs
- Workspace keying by Slack `teamId` with channel overrides

---

## Quick start (self-hosted)

**Production:** deploy `opentag-agent` (Container) + `opentag-bot` — no laptop processes.
See [setup.md](./setup.md).

**Local iterate:** run the agent on `:8200` and the bot Worker with wrangler; for live Slack
inbound, expose the Worker (or deploy it) and point Slack Request URLs at it.

### 1. Create a Slack app

1. [api.slack.com/apps](https://api.slack.com/apps?new_app=1) → **From a manifest** → paste [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
2. Install the app → copy **Bot User OAuth Token** (`xoxb-…`) and **Signing Secret**.
3. Set Request URLs to your bot Worker (not Socket Mode):
   - `https://<worker>/slack/events`
   - `https://<worker>/slack/commands`
   - `https://<worker>/slack/interactions`
4. Reinstall / refresh scopes if you change the manifest (includes `reactions:write`).

Production example in this repo’s manifest: `https://opentag-bot.williamlopezc.workers.dev`.

### 2. Secrets

**Agent** (Container secrets, or root `.env` for local `pnpm runtime`):

```bash
cp .env.example .env
# OPENAI_API_KEY=...
# LINEAR_API_KEY=...   # optional
# NOTION_TOKEN=...     # optional
```

**Bot Worker** (`edge/`):

```bash
cd edge
cp .dev.vars.example .dev.vars
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=...
# AGENT_URL=https://opentag-agent.<account>.workers.dev/api/copilotkit/agent/triage/run
#   (or http://localhost:8200/... for local pnpm runtime)
# ADMIN_SECRET=...
# INTERNAL_SECRET=...   # must match research Worker if you run research
```

### 3. Install & run (local / dev)

```bash
# Agent (repo root) — skip if AGENT_URL already points at opentag-agent
pnpm install
pnpm runtime                 # AG-UI on :8200

# Bot Worker
cd edge
npm ci                       # uses vendored Workers-safe @copilotkit/channels
npm run dev                  # wrangler → usually :8787
```

Expose `:8787` to Slack (cloudflared, ngrok, or deploy — see below). Then @mention the bot in a channel thread.

**Optional research Worker:**

```bash
cd edge
# merge .dev.vars.research.example secrets; same INTERNAL_SECRET as the bot
npm run dev:research
```

### 4. CopilotKit channels packages

CI and normal local installs use npm + a **Workers-safe vendored tarball**
(`edge/vendor/copilotkit-channels-0.1.1.tgz`) so workerd doesn’t hit `createRequire`.

You only need a sibling [CopilotKit](https://github.com/CopilotKit/CopilotKit) checkout when
**refreshing** that vendor package — see [`edge/vendor/README.md`](./edge/vendor/README.md) and
[`edge/README.md`](./edge/README.md).

---

## Deploy (Cloudflare)

| Config | Worker | Role |
| --- | --- | --- |
| [`edge/wrangler.bot.toml`](./edge/wrangler.bot.toml) | **`opentag-bot`** | **Production** Claude Tag bot |
| [`edge/workers/agent-runtime/`](./edge/workers/agent-runtime/) | **`opentag-agent`** | **Production** AG-UI Container |
| [`edge/wrangler.toml`](./edge/wrangler.toml) | `opentag-edge` | Local / legacy-dev bot |
| [`edge/wrangler.research.toml`](./edge/wrangler.research.toml) | orchestrator | Research tasks (internal `/research`) |
| [`edge/workers/egress-proxy/`](./edge/workers/egress-proxy/) | egress proxy | Sandbox container egress |

```bash
cd edge
npm run deploy:agent         # AG-UI Container (Workers Paid)
npm run deploy:bot           # production bot
# wrangler secret put SLACK_BOT_TOKEN --config wrangler.bot.toml
# wrangler secret put SLACK_SIGNING_SECRET --config wrangler.bot.toml
# wrangler secret put AGENT_URL --config wrangler.bot.toml
#   → https://opentag-agent.<account>.workers.dev/api/copilotkit/agent/triage/run
# wrangler secret put INTERNAL_SECRET --config wrangler.bot.toml
# wrangler secret put ADMIN_SECRET --config wrangler.bot.toml

npm run deploy:research      # optional research plane
```

Production needs no laptop runtime or tunnel to `:8200`.

---

## Make it your own

- **Change behavior** — edit the system prompt and tooling in [`lib/triage-agent.ts`](./lib/triage-agent.ts) (redeploy `opentag-agent` for prod).
- **Edge Slack surface** — tools, commands, reactions, and ingress live under [`edge/src/`](./edge/src/) (`bot-engine.ts`, `tools/`, `commands/`, `slack/`).
- **Access control** — channel bundles in `WorkspaceConfigDO` / [`edge/src/config/`](./edge/src/config/).
- **Bring your own model + MCP** — OpenAI / Anthropic / Google keys; Linear & Notion when configured.
- **Deep research** — [`lib/research/`](./lib/research/) + [`edge/workers/orchestrator/`](./edge/workers/orchestrator/).

---

## Repository layout

```
opentag/
├── runtime.ts              # Node AG-UI entry (local + Container)
├── lib/triage-agent.ts     # Shared triage BuiltInAgent factory
├── runtime-research.ts     # Optional research AG-UI agent
├── slack-app-manifest.yaml # Slack app (Events API, scopes, slash commands)
├── PRODUCT.md              # Authoritative product / architecture
├── DECISIONS.md            # Technical decisions
├── setup.md                # Setup & env reference
├── edge/                   # Cloudflare bot + agent + research Workers
│   ├── src/                # Bot spine (worker, adapter, tools, store)
│   ├── wrangler.bot.toml   # Production opentag-bot
│   ├── workers/agent-runtime/  # Production AG-UI Container (opentag-agent)
│   ├── workers/orchestrator/
│   ├── workers/egress-proxy/
│   └── vendor/             # Workers-safe @copilotkit/channels tarball
├── lib/research/           # Research domain (fibers, OCC, delivery)
├── docs/                   # Research actors, evaluation notes
├── e2e/                    # Live / loop probes
├── scripts/                # Notion MCP helper, etc.
└── app/                    # Shared app helpers (not the Slack ingress path)
```

The old Railway / Socket Mode Node bot path has been **removed**. Slack ingress is
Cloudflare-only.

---

## Tests & CI

```bash
# Edge bot spine (what edge-ci runs)
cd edge
npm run typecheck
npm test                 # unit
npm run test:e2e         # StateStore on workerd

# Root research / runtime unit tests
pnpm test
```

GitHub Actions: [`.github/workflows/edge-ci.yml`](./.github/workflows/edge-ci.yml) —
typecheck + unit + StateStore e2e on `edge/**` changes.

Local Slack smoke helpers: `edge/scripts/e2e-local.sh`, `edge/scripts/e2e-smoke-local.sh`
(see [edge/README.md](./edge/README.md)).

---

## Environment reference (high level)

| Variable | Where | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | `edge/.dev.vars` / secrets | Bot Web API (needs `reactions:write` for emoji acks) |
| `SLACK_SIGNING_SECRET` | edge | Events / commands HMAC |
| `AGENT_URL` | bot secrets / `.dev.vars` | AG-UI triage run URL (`opentag-agent` in prod) |
| `AGENT_AUTH_HEADER` | bot + agent (optional) | Auth to the runtime |
| `OPENAI_API_KEY` | agent secrets / root `.env` | Model for triage runtime |
| `LINEAR_API_KEY` / `NOTION_*` | agent secrets / root `.env` | Optional MCP |
| `ADMIN_SECRET` | edge | Protect `/admin/*` |
| `INTERNAL_SECRET` | bot + research | Service-to-service research kickoff |

Full lists: [`.env.example`](./.env.example), [`edge/.dev.vars.example`](./edge/.dev.vars.example).

---

## Hard invariants

1. **No Socket Mode** on Cloudflare Workers — Events API + HMAC only.
2. **Bot Worker owns Slack HTTP**; research is internal via `RESEARCH_TASKS`.
3. Sandbox container egress is **application-level HTTP proxy** only (no transparent TCP). Triage agent Container holds API keys directly (DECISIONS §4).
4. Task / actor code talks to **adapters**, not raw `pg` / ad-hoc DO APIs.
5. Cold starts: ack Slack quickly; finish via `waitUntil` / `chat.postMessage` / agent stream.

---

## Don’t want to host it yourself?

Self-hosting means you run and scale the runtime, persistence, and inspection tooling yourself.
A **managed CopilotKit service** is on its way — same agent shape, less ops: durable threads,
persistence, hosted inspection, and agents that improve from feedback (**Continuous Learning
from Human Feedback**).

- **[Join the waitlist →](https://go.copilotkit.ai/opentag-managed-gh)**
- **[Talk to an engineer →](https://copilotkit.ai/talk-to-an-engineer)**

---

## Learn more

| Doc | Contents |
| --- | --- |
| [PRODUCT.md](./PRODUCT.md) | Product north star, spine, deploy layout, remaining work |
| [docs/README.md](./docs/README.md) | Doc index |
| [edge/README.md](./edge/README.md) | Worker configs, vendored channels, local E2E |
| [setup.md](./setup.md) | Setup walkthrough & env table |
| [DECISIONS.md](./DECISIONS.md) | Locked technical decisions (DO naming, egress, Events API) |
| [docs/research-actors.md](./docs/research-actors.md) | Research fiber / actor runbook |
| [docs/evaluation.md](./docs/evaluation.md) | Research eval smoke commands |
| [AGENTS.md](./AGENTS.md) | Instructions for coding agents |
| [CopilotKit Slack quickstart](https://docs.copilotkit.ai/slack) | Canonical Slack agent guide |

---

## License

MIT — see [LICENSE](./LICENSE).
