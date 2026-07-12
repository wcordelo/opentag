# AGENTS.md

## Cursor Cloud specific instructions

This repo has two independently-buildable parts:

- **Root (`/`) — the OpenTag bot** (`app/`, `runtime.ts`): the chat-platform bot + AG-UI agent
  backend, built on `@copilotkit/bot-*`. Commands are in `package.json` (`dev`, `runtime`,
  `test`, `check-types`); setup/architecture is in `README.md` and `setup.md`.
- **`edge/` — two Cloudflare tracks**:
  1. **Research orchestrator** (`workers/`, `wrangler.toml`) — OpenTag 2.0 `/research` Durable Objects.
  2. **`@opentag/bot-store-durable-object`** (`src/store/`, `wrangler.bot-store.toml`) — bot `StateStore` on DO + SQLite.

  Commands and layering: `edge/README.md`.

### Root app is NOT standalone-installable here (by design)

`npm install` at the repo root **fails** (e.g. `No matching version found for
@copilotkit/bot-discord@^0.1.0`). The `@copilotkit/bot-*` packages are mid-`0.x` and not
coherently published to npm yet — this is documented in `README.md`, `setup.md`, and
`edge/README.md` ("Upstream status, gaps"). Do **not** try to "fix" this by bumping versions;
the root app is meant to run from the CopilotKit monorepo as `examples/slack`. Consequently
root `npm test` / `npm run check-types` cannot run in this VM (no `node_modules`). Running the
bot for real also needs live secrets (`SLACK_*`/`DISCORD_*`/`TELEGRAM_*` + `OPENAI_API_KEY`).

### `edge/` is the testable target

From `edge/`:

- `npm test` — node unit tests (research Workers + bot-store engine on `node:sqlite`)
- `npm run test:e2e` — bot-store inside workerd (`vitest.workers.bot-store.config.ts`)
- `npm run test:workers` — research orchestrator workerd suite
- `npm run check-types`

### `wrangler dev` caveat (bot-store, non-obvious)

Older wrangler bundles may lack `DurableObjectNamespace.getByName`, so
`GET /debug/store` under `npm run dev:bot-store` can return 500. `GET /health` still works.
Prefer current wrangler 4: `npx wrangler@4 dev --config edge/wrangler.bot-store.toml`.
`npm run test:e2e` already covers this path with a newer runtime.
