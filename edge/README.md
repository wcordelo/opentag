# OpenTag edge

The `edge/` workspace is the testable Cloudflare target: the Slack bot,
Durable Object state, optional research Worker, production AG-UI Container,
Claude Code harness, and private Claudex proxy.

Current architecture: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

Operations: [docs/operations.md](../docs/operations.md)

Current release evidence: [docs/current-state.md](../docs/current-state.md)

Extension rules: [docs/extending.md](../docs/extending.md)

## Deployment units

| Config or package | Role | Status |
| --- | --- | --- |
| `wrangler.bot.toml` | `opentag-bot`, production Slack surface | Active target |
| `wrangler.toml` | `opentag-edge`, local/development bot | Active target |
| `workers/agent-runtime/` | `opentag-agent`, AG-UI triage Container | Production runtime |
| `workers/sandbox/` | `opentag-harness`, Claude Code Container | Production coding runtime |
| `workers/claudex-proxy/` | `opentag-claudex-proxy`, CLIProxyAPI Container | Private Claudex backend |
| `wrangler.research.toml` | `opentag-orchestrator`, internal research | Optional task plane |
| `wrangler.bot-store.toml` | StateStore workerd alias | Test-only; no deploy script or embedded admin credential |
| `workers/wasm-dispatch/` | Intent dispatcher | Optional research build path |
| `PLATFORM_STATE` / `ROUTER_MEASUREMENTS` | Tenant metadata/effect ledger and router shadow ledger | Deployed; synthetic/live-queried, external effecters remain gated |

## Install and test

```bash
cd edge
npm ci
npm run typecheck
npm test
npm run test:e2e
```

GitHub Actions runs these under Node 22. `edge/tsconfig.json` includes
`workers/**/*.ts`, so compile-time packages used by the sandbox Worker must
also be declared in `edge/package.json`.

Harness package check:

```bash
cd workers/sandbox
npm ci
npm run typecheck

cd ../claudex-proxy
npm ci
npm run typecheck
```

## Bot request flow

```mermaid
flowchart LR
    Slack["Slack"] --> Verify["worker.ts<br/>verify + ack"]
    Verify --> Route["normalize + response-worthiness route"]
    Route -->|respond| Pre["stable identity + pre-admission"]
    Route -->|observe| History["Slack history only"]
    Pre --> Adapter["CloudflareSlackAdapter"]
    Adapter --> Fast["shortcut / command / quick action"]
    Adapter --> Life["runSlackTurnLifecycle"]
    Fast <--> State["BOT_STATE"]
    Life <--> State
    Life <--> Events["SESSION_EVENTS"]
    Life --> Agent["AGENT_RUNTIME"]
    Life -->|"coding / selected"| Harness["HARNESS"]
    Life --> Platform["PLATFORM_STATE"]
    Life --> Router["ROUTER_MEASUREMENTS<br/>shadow only"]
    Buzz["Buzz /buzz/wake<br/>signed receive"] --> Life
    Fast -. optional .-> Research["RESEARCH_TASKS"]
```

`runSlackTurnLifecycle()` is the only production model-turn entry point. It:

1. adopts or refreshes the pre-admitted active turn;
2. resolves override flags and verifies the exact turn remains pending;
3. writes the initial render obligation;
4. admits the exact execution in SessionEventDO;
5. exits silently for a duplicate redelivery, or emits one durable-deduped
   busy note for a genuinely concurrent ask;
6. refreshes the obligation cursor after accepted admission;
7. requests remote-git HITL for qualifying coding turns;
8. routes to AG-UI or the authoritative Claude Code harness;
9. fences every turn render and non-Slack side effect;
10. leaves final cleanup to confirmed terminal visibility or exact Stop.

The response route is intentionally separate from model execution. DMs,
explicit mentions, trusted triggers, and files always proceed. An unmentioned
thread question, action request, or problem report also proceeds without a
tag; passive thread chatter is retained in Slack history without creating an
active turn. The shared route helper is applied during pre-admission and again
at adapter ingress so Slack's duplicate `app_mention`/threaded `message`
delivery cannot create a row that the adapter later discards.

AG-UI incremental Markdown is mirrored best-effort into SessionEventDO before
Slack updates so alarm recovery can replay it. Harness NDJSON uses the same
exact execution log. Session input is override-stripped and recovery filters
events by execution ID.

## Durable Objects

| Binding | Class | Responsibilities |
| --- | --- | --- |
| `BOT_STATE` | `ConversationStateDO` | generic StateStore, active/effect/render fences, obligations, Stop continuation, HITL, memory |
| `SESSION_EVENTS` | `SessionEventDO` | execute/forward dedup, append events, replay, exact interrupts |
| `WORKSPACE_CONFIG` | `WorkspaceConfigDO` | prompts, bundles, channel policy |
| `KNOWLEDGE` | `KnowledgeDO` | channel knowledge |

Production and development configs have separate migration histories. Do not
rename Durable Object classes or delete migration tags after deployment.

## Slack renderer and identity

- streaming uses one placeholder, conflation, and bounded updates;
- Markdown blocks are capped at Slack limits and terminal `done` remains last;
- all Slack Web API bodies use form encoding;
- DMs use `DM_SCOPE`;
- a channel mention uses its own/root message timestamp;
- a top-level slash command uses channel scope because Slack provides no ts;
- a DM slash command may look up a recent DM timestamp solely for assistant
  status while retaining `DM_SCOPE` as its conversation identity;
- stable wire IDs are `ot1e_…` for executions and `ot1m_…` for forwarded messages.
- clear thread asks do not require a bot tag; passive conversation remains
  history-only;
- a final confirmed render deletes the exact active-turn row, while a busy note
  is reserved for a genuine distinct concurrent turn.

## Stop and recovery

Stop is detected before bot dispatch. It claims the exact turn, cancels HITL,
interrupts SessionEventDO, controls AG-UI/harness/research, posts a fenced
acknowledgement, and clears only after visibility. Partial work continues by
the ConversationStateDO alarm.

Render obligations replay only the obligated execution. A live session is
deferred only while its exact active-turn row still exists; an orphaned
`executing` marker is treated as a crash so recovery cannot defer forever.

## Runtime selection

The default is `AGENT_RUNTIME` plus the `AGENT_URL` path. Same-zone
`workers.dev` fetches can fail with Cloudflare 1042, so use the service binding.
Repository coding defaults to `claudecode`. `--claude` selects native Claude;
`--claudex` or a `gpt-*` model selects the same Claude Code binary through the
private `CLAUDEX_PROXY` service binding. `--nanocodex` selects the native
Nanocodex CLI against OpenAI Responses (`OPENAI_API_KEY` injected by the
Harness Worker). Qualifying coding work and explicit coding-mode selections do
not fall back to AG-UI.

## Deploy

Deployment is always an explicit operator action:

```bash
npm run deploy:agent
npm --prefix workers/claudex-proxy run deploy  # target before harness
npm --prefix workers/sandbox run deploy        # target before bot
npm run deploy:bot
npm run deploy:research   # optional
```

The harness has separate secrets, allowlists, and deployment steps in
[docs/operations.md](../docs/operations.md). Do not deploy it merely because
its package typechecks.

## Workers-safe CopilotKit Channels

Normal installs use `@copilotkit/channels` from
`vendor/copilotkit-channels-0.1.1.tgz`; UI and Slack packages come from npm.
The tarball removes `createRequire(import.meta.url)`, which crashes workerd.
A sibling CopilotKit checkout is needed only to refresh the tarball; see
[vendor/README.md](./vendor/README.md).
