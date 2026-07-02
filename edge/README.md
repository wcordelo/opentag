# `@opentag/bot-store-durable-object`

A **Durable Object + SQLite** `StateStore` for [`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot) — the edge-native persistence layer for OpenTag's **Centaur-less** stack.

It is a drop-in replacement for the in-memory default and [`@copilotkit/bot-store-redis`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-store-redis): same `StateStore` contract, but session/conversation state lives in a Cloudflare Durable Object's private, embedded SQLite database instead of process memory or a separate Redis hop.

```ts
import { createBot } from "@copilotkit/bot";
import { createDurableObjectStore } from "@opentag/bot-store-durable-object";

const bot = createBot({
  adapters: [/* … */],
  agent: (threadId) => makeAgent(threadId),
  store: { adapter: createDurableObjectStore(env.BOT_STATE) }, // ← the only change
});
```

## Why this exists

`@copilotkit/bot` persists everything behind one small interface — **`StateStore`** — with five namespaces:

| Namespace | Bot uses it for |
| --- | --- |
| `kv` | `conv:<key>` → threadId mapping, `threadstate:<key>`, `sub:<key>`, and action snapshots (`action:<id>`) for **durable HITL** |
| `list` | cross-platform transcripts |
| `lock` | the per-conversation **turn lock** (`turn:<key>`) so one conversation processes one turn at a time |
| `dedup` | inbound event de-duplication |
| `queue` | bounded work queues |

Swap the backend and durable HITL, restart-safe turn locks, and transcripts all keep working — now on the edge, co-located with compute.

### Why Durable Objects + SQLite

- **Zero-latency storage.** SQLite runs in the *same thread* as the object — microsecond reads/writes, no Redis network round-trip.
- **Real atomicity.** A DO is single-threaded with input/output gates, so RPC methods don't interleave mid-operation. Combined with `ctx.storage.transactionSync`, the multi-statement mutations (lock acquire, dedup, queue eviction) are genuinely atomic — no Lua scripts, no `WATCH`/`MULTI`.
- **Strong durability.** SQLite commits are replicated to multiple machines before the write is acknowledged.
- **No external dependency.** One fewer thing to run, secure, and scale.

## File structure

```
edge/
├── wrangler.toml                       # DO binding + `new_sqlite_classes` migration
├── package.json · tsconfig.json · vitest.config.ts
├── src/
│   ├── worker.ts                       # Hono entrypoint: /health, /debug/store, webhook sketch; re-exports the DO
│   ├── env.ts                          # Worker bindings (BOT_STATE namespace + secrets)
│   └── store/
│       ├── sql.ts                      # narrow SqlExecutor seam (portable + testable)
│       ├── schema.ts                   # DDL + versioned migrate()
│       ├── sql-state-engine.ts         # synchronous SQLite impl of all StateStore ops
│       ├── conversation-state-do.ts    # the Durable Object hosting the engine (RPC surface + alarm GC)
│       ├── partition.ts                # key → DO instance routing (singleGlobal | byConversationKey)
│       ├── durable-object-state-store.ts # the StateStore the bot consumes (RPC forwarder + factory)
│       ├── state-store-contract.ts     # StateStore interface, mirrored from @copilotkit/bot
│       └── index.ts                    # barrel exports
└── test/
    ├── sqlite-state-store.ts           # node:sqlite shim → exercises the real engine off-workerd
    ├── conformance.ts                  # the @copilotkit/bot StateStore conformance suite (vendored)
    ├── engine.test.ts                  # runs the suite against the engine on node:sqlite (16 tests)
    └── store.workers.test.ts           # runs the suite + DO integration checks INSIDE workerd (18 tests)
```

### Layering

```
createBot(store.adapter)
        │  StateStore (async)
        ▼
DurableObjectStateStore ──getByName(partition(key))──▶ ConversationStateDO (RPC)
   (Worker, thin forwarder)                                  │  JSON ⇄ TEXT
                                                              ▼
                                                       SqlStateEngine (sync)
                                                              │  SqlExecutor
                                                              ▼
                                                   ctx.storage.sql  (embedded SQLite)
```

The **engine is backend-blind** — it talks to a narrow `SqlExecutor` and a `transactionSync`-style runner. That's what lets the production code be validated by the upstream conformance suite under plain Node (`node:sqlite`) without `workerd`.

## Resilience model

- **Schema setup.** `migrate()` runs in the DO constructor inside `blockConcurrencyWhile`, so no request observes a half-built schema. It records `schema_version` in a `_meta` table for in-place upgrades.
- **Transaction isolation.** Multi-statement operations run inside `ctx.storage.transactionSync` (rolls back on throw). The DO's single-threaded execution means there's no cross-request interleaving to guard against — the "promise-chaining / SQLite lock" concern collapses into the object model itself.
- **TTL + GC.** Every expirable row carries an absolute `expires_at`. Reads lazily evict expired rows (matching the in-memory reference), and an hourly **DO alarm** (`sweepExpired`) reclaims abandoned keys (indexed on `expires_at`).
- **Lock safety.** Locks are token-scoped and TTL-bounded (default 30s), so a crashed turn can't deadlock a conversation, and a stale token can never free a lock re-acquired after expiry.
- **Sharding path.** Default is one global DO (always correct; the bot already serializes per conversation). Switch to `byConversationKey()` to co-locate a conversation's keys on their own object for locality + isolation — no engine changes.

## Develop & verify

```bash
npm install
npm test            # 16 conformance tests against the engine on node:sqlite (fast, no workerd)
npm run test:e2e    # 18 tests INSIDE workerd: same suite + DO integration, via the real Durable Object
npm run test:all    # both
npm run check-types # tsc --noEmit
npm run dev         # wrangler dev — hit /health and /debug/store
```

Two layers of testing:

1. **Engine (`npm test`)** — the vendored `@copilotkit/bot` conformance suite against the real `SqlStateEngine` over `node:sqlite`. Fast, proves the SQL/TTL/atomicity logic.
2. **End-to-end (`npm run test:e2e`)** — the *same* suite plus DO-specific checks (cross-instance isolation, cross-stub durability) run in **`workerd`** via `@cloudflare/vitest-pool-workers`, so `ConversationStateDO`, `ctx.storage.sql`, `transactionSync`, and `getByName` RPC routing are all exercised for real.

`/debug/store` additionally round-trips every namespace through a live Durable Object under `wrangler dev`. Remove or guard it in production.

> Edge ingress is HTTP-webhook driven (Slack Events API, Discord interactions, WhatsApp Cloud API), not the Node socket-mode / long-poll adapters. `worker.ts` sketches the `/webhook/:platform` wiring; the persistence swap is complete and the focus of this package.
