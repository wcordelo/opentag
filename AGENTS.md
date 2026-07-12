# AGENTS.md

## Cursor Cloud specific instructions

- **Root (`/`)** — OpenTag bot (`app/`, `runtime.ts`) on `@copilotkit/bot-*`. Prefer CopilotKit monorepo `examples/slack` until packages publish. See `README.md` / `setup.md`.
- **`edge/`** — Claude Tag on Cloudflare ([`PRODUCT.md`](PRODUCT.md)):
  1. **Default** — bot Worker (`src/`, `wrangler.toml`) + StateStore + `RESEARCH_TASKS`
  2. **Research tasks** — internal only (`workers/orchestrator/`, `wrangler.research.toml`)
  3. **Egress / WASM / sandbox** — under `workers/`

### Root app is NOT standalone-installable here (by design)

`npm install` at repo root fails until `@copilotkit/bot-*` publish coherently. Do not “fix” by bumping versions.

### `edge/` is the testable CF target

```bash
cd edge
npm test                 # unit (bot spine + research helpers)
npm run test:e2e         # StateStore workerd (primary)
npm run test:workers     # research (secondary)
npm run typecheck
npm run dev              # bot
npm run dev:research     # research task Worker
```

Slack Request URLs must point at the **bot** Worker, not the orchestrator.
