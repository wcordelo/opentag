# AGENTS.md

## Cursor Cloud / agent instructions

- **Product docs:** [`PRODUCT.md`](./PRODUCT.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`docs/centaur-port.md`](./docs/centaur-port.md) · [`docs/extending.md`](./docs/extending.md) · [`docs/operations.md`](./docs/operations.md)
- **Slack product surface:** Cloudflare edge (`edge/`) — Events API bot Worker + StateStore. Production Worker: `opentag-bot` (`npm run deploy:bot`). Channels deps: `edge/vendor/` tarball + npm.
- **Agent brain (production):** `edge/workers/agent-runtime/` Container (`opentag-agent`). Bot uses **`AGENT_RUNTIME` service binding** + `AGENT_URL` path (same-zone `workers.dev` fetch → CF 1042).
- **Agent brain (dev-only):** root `pnpm runtime` (`runtime.ts` / `lib/triage-agent.ts`) on `:8200`. Hardcoded to the **OpenAI adapter** (`@tanstack/ai-openai`): needs a working `OPENAI_API_KEY`; `AGENT_MODEL` only swaps the OpenAI model id and `ANTHROPIC_API_KEY` does not drive it. Runtime accepts AG-UI runs at `POST /api/copilotkit/agent/triage/run` (emits `RUN_STARTED` then streams; a bad/over-quota key surfaces as a `RUN_ERROR` SSE event, not a startup crash).
- **Research tasks:** optional `edge/wrangler.research.toml` (internal); not on the CI critical path.
- **Claude Code harness:** optional `edge/workers/sandbox/` Worker + `containers/harness/` image. It is code-complete but not enabled/deployed by default. Coding intent cannot silently fall back to AG-UI.
- **Technical locks:** [`DECISIONS.md`](./DECISIONS.md) — especially exact identity/fences/Stop §§11–13 and remote-git/postconditions §§14–16.

### Root `pnpm start` is not the Slack bot

`pnpm start` / `pnpm dev` exit with a pointer to `cd edge && npm run dev`. There is no Socket Mode / Railway Slack bot.

### `edge/` is the testable CF target

```bash
cd edge
npm ci
npm test                 # bot-spine unit only (includes durable-choice + thread-memory)
npm run test:e2e         # StateStore workerd
npm run typecheck
npm run deploy:bot       # production bot
npm run deploy:agent     # production AG-UI Container
npm run dev              # local bot Worker (Slack Events)
```

Harness validation is separate:

```bash
cd edge/workers/sandbox
npm ci
npm run typecheck
```

Do not deploy any Worker or Container without explicit user approval.

Slack Request URLs must point at **`opentag-bot`**, not the research orchestrator.

### Linear create pitfalls

- `LINEAR_TEAM_KEY` = team **display name** (e.g. `Berendo`), not a bare key like `CPK`.
- Bot token needs **`users:read.email`** (reinstall + refresh secret after scope changes).
- Slack Web API: use **form-urlencoded** (`edge/src/slack/web-api.ts`) — JSON `users.info` skips email.
- HITL Create/Cancel needs `choiceId` durable poll (`edge/src/hitl/durable-choice.ts`).
