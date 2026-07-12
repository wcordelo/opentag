# OpenTag Edge

Two Cloudflare tracks share this directory:

| Track | Path | Wrangler config | Purpose |
| --- | --- | --- | --- |
| **Research orchestrator** | `workers/` | `wrangler.toml` | OpenTag 2.0 `/research` pipeline (Orchestrator / Researcher / Verifier DOs) |
| **Bot StateStore** | `src/store/` | `wrangler.bot-store.toml` | `@opentag/bot-store-durable-object` — Durable Object + SQLite `StateStore` for `@copilotkit/bot` |

```bash
cd edge
npm install
npm test                 # node unit tests (both tracks)
npm run test:workers     # research orchestrator workerd suite
npm run test:e2e         # bot-store workerd suite
npm run dev              # research orchestrator (wrangler.toml)
npm run dev:bot-store    # bot StateStore worker
```

---

## Research orchestrator

Thin Durable Object shells over shared `lib/research/` core.

### Endpoints

- `GET /health` — health check
- `POST /research` — `{ threadKey, objective }` → Orchestrator DO

### Shared core

Actor logic lives in `../lib/research/`:

- `orchestrator.ts`, `researcher.ts`, `verifier.ts`
- `adapters/storage-do.ts` — DO SQLite adapter

Compare with Railway: [../docs/evaluation.md](../docs/evaluation.md).

---

## `@opentag/bot-store-durable-object`

A **Durable Object + SQLite** `StateStore` for [`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot) — drop-in replacement for in-memory / Redis stores.

```ts
import { createBot } from "@copilotkit/bot";
import { createDurableObjectStore } from "@opentag/bot-store-durable-object";

const bot = createBot({
  adapters: [/* … */],
  agent: (threadId) => makeAgent(threadId),
  store: { adapter: createDurableObjectStore(env.BOT_STATE) },
});
```

### Layout

```
edge/
├── wrangler.toml                 # research orchestrator (default)
├── wrangler.bot-store.toml       # bot StateStore worker
├── workers/                      # orchestrator, egress-proxy, wasm-dispatch, …
├── src/store/                    # SqlStateEngine + ConversationStateDO
├── test/                         # bot-store conformance + workerd e2e
└── tests/integration/            # research orchestrator workerd tests
```

### Verify (bot-store)

```bash
npm run test:e2e         # workerd + real ConversationStateDO
npm run test:e2e:full    # typecheck + suites + createBot + live wrangler
npm run check-types
npm run dev:bot-store    # /health and /debug/store
```

See `AGENTS.md` at the repo root for Cursor Cloud notes (including the wrangler/`getByName` caveat — use `wrangler.bot-store.toml`).
