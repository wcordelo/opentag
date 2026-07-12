# AGENTS.md

## Cursor Cloud specific instructions

This repo has two independently-buildable parts:

- **Root (`/`) — the OpenTag bot** (`app/`, `runtime.ts`): the chat-platform bot + AG-UI agent
  backend, built on `@copilotkit/bot-*`. Commands are in `package.json` (`dev`, `runtime`,
  `test`, `check-types`); setup/architecture is in `README.md` and `setup.md`.
- **`edge/` — `@opentag/bot-store-durable-object`**: a self-contained Cloudflare Durable
  Object + SQLite `StateStore` for the bot. This is the coherent, fully-testable package.
  Commands and layering are in `edge/README.md`.

### Root app is NOT standalone-installable here (by design)

`npm install` at the repo root **fails** (e.g. `No matching version found for
@copilotkit/bot-discord@^0.1.0`). The `@copilotkit/bot-*` packages are mid-`0.x` and not
coherently published to npm yet — this is documented in `README.md`, `setup.md`, and
`edge/README.md` ("Upstream status, gaps"). Do **not** try to "fix" this by bumping versions;
the root app is meant to run from the CopilotKit monorepo as `examples/slack`. Consequently
root `npm test` / `npm run check-types` cannot run in this VM (no `node_modules`). Running the
bot for real also needs live secrets (`SLACK_*`/`DISCORD_*`/`TELEGRAM_*` + `OPENAI_API_KEY`).

### `edge/` is the testable target — all green

From `edge/`: `npm test` (16 pass, 1 auto-skips), `npm run test:e2e` (18 pass, real Durable
Object inside workerd), `npm run check-types`. The engine suite uses Node's experimental
`node:sqlite` (fine on Node 22); the e2e suite uses `@cloudflare/vitest-pool-workers`, which
bundles its own current workerd.

### `wrangler dev` caveat (non-obvious)

`edge/`'s pinned `wrangler@^3.78` bundles an **old workerd** (falls back to compat date
`2025-07-18`). The store uses `DurableObjectNamespace.getByName`, which that runtime lacks, so
`GET /debug/store` under `npm run dev` returns 500 (`this.ns.getByName is not a function`).
`GET /health` still works. To exercise the full `/debug/store` round-trip (kv/list/lock/dedup/
queue through a live DO), run with a current wrangler instead, e.g.
`npx -y wrangler@4 dev --config edge/wrangler.toml`. The `npm run test:e2e` suite already
covers this path with a newer runtime, so it is unaffected.
