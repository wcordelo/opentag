import { Hono } from "hono";
import type { Env } from "./env.js";
import { createDurableObjectStore } from "./store/index.js";

// Re-export the Durable Object class at the Worker entrypoint so the runtime can
// instantiate it (the class name is referenced by `wrangler.toml`).
export { ConversationStateDO } from "./store/index.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, store: "durable-object-sqlite" }));

/**
 * Smoke-test endpoint: drives the real `StateStore` through the Durable Object
 * so you can verify the SQLite backend end-to-end under `wrangler dev` without
 * standing up a chat platform. Round-trips kv, list, lock, dedup, and queue.
 * Remove (or guard behind auth) in production.
 */
app.get("/debug/store", async (c) => {
  const store = createDurableObjectStore(c.env.BOT_STATE);
  const k = `debug:${crypto.randomUUID()}`;

  await store.kv.set(k, { hello: "edge" }, 5_000);
  const got = await store.kv.get<{ hello: string }>(k);

  await store.list.append(k, "a");
  await store.list.append(k, "b", { maxLen: 2 });
  const list = await store.list.range<string>(k);

  const lock = await store.lock.acquire(`${k}:lock`, { ttlMs: 1_000 });
  const lockedOut = await store.lock.acquire(`${k}:lock`);
  if (lock) await store.lock.release(`${k}:lock`, lock.token);

  const firstSeen = await store.dedup.seen(`${k}:evt`, 5_000);
  const secondSeen = await store.dedup.seen(`${k}:evt`, 5_000);

  await store.queue.enqueue(`${k}:q`, 1);
  await store.queue.enqueue(`${k}:q`, 2);
  const depth = await store.queue.depth(`${k}:q`);
  const head = await store.queue.dequeue<number>(`${k}:q`);

  return c.json({
    kv: got,
    list,
    lock: { acquired: lock !== null, secondAttemptBlocked: lockedOut === null },
    dedup: { firstSeen, secondSeen },
    queue: { depth, head },
  });
});

/**
 * Webhook ingress (sketch). On the edge, bots are HTTP-webhook driven (Slack
 * Events API, Discord interactions, WhatsApp Cloud API) rather than the Node
 * socket-mode / long-poll adapters. The persistence wiring is the point of this
 * package and is identical to the Node app — only the backend changes:
 *
 * ```ts
 * import { createBot } from "@copilotkit/bot";
 * import { slack } from "@copilotkit/bot-slack";
 *
 * const bot = createBot({
 *   adapters: [slack({ ... })],
 *   agent: (threadId) => makeAgent(threadId, c.env),
 *   // ▼ the only change from the Redis/in-memory deployment:
 *   store: { adapter: createDurableObjectStore(c.env.BOT_STATE) },
 *   components: [ConfirmCreateIssue],
 * });
 * // dispatch the verified webhook payload into the bot here
 * ```
 *
 * A click that lands after a cold start re-fires because the action snapshot
 * lives in the Durable Object's SQLite DB, not process memory.
 */
app.post("/webhook/:platform", async (c) => {
  // TODO: verify the platform signature, then dispatch into createBot(...) as above.
  return c.json({ received: true, platform: c.req.param("platform") }, 202);
});

export default app;
