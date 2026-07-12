# AGENTS.md

## Cursor Cloud / agent instructions

- **Slack product surface:** Cloudflare edge (`edge/`) — Events API bot Worker + StateStore. Requires a sibling [CopilotKit](https://github.com/CopilotKit/CopilotKit) checkout at `../CopilotKit` with `@copilotkit/channels*` built (`pnpm --filter @copilotkit/channels... build`).
- **Agent brain:** root `pnpm runtime` (`runtime.ts`) — AG-UI on `:8200`; Worker `AGENT_URL` points here.
- **Research tasks:** `edge/wrangler.research.toml` (internal); optional Railway Postgres track via `pnpm research:runtime`.

### Root `pnpm start` is not the Slack bot

`pnpm start` / `pnpm dev` exit with a pointer to `cd edge && npm run dev`. There is no Socket Mode / Railway Slack bot.

### `edge/` is the testable CF target

```bash
# Once: build sibling CopilotKit channels packages
cd ../CopilotKit && pnpm install && pnpm --filter @copilotkit/channels-ui --filter @copilotkit/channels --filter @copilotkit/channels-slack build

cd edge
npm install
npm test                 # unit (bot spine + research helpers)
npm run test:e2e         # StateStore workerd (primary)
npm run test:workers     # research (secondary)
npm run typecheck
npm run dev              # bot Worker (Slack Events)
npm run dev:research     # research task Worker
```

Slack Request URLs must point at the **bot** Worker, not the orchestrator.
