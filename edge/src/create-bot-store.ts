/**
 * Store adapter for `@copilotkit/bot` on Cloudflare (PRODUCT.md Phase 1).
 *
 * Usage once the bot SDK is available in this package:
 *
 * ```ts
 * import { createBot } from "@copilotkit/bot";
 * import { createBotStoreAdapter } from "./create-bot-store.js";
 *
 * const bot = createBot({
 *   adapters: [slackAdapter],
 *   agent: (threadId) => makeAgent(threadId),
 *   store: { adapter: createBotStoreAdapter(env.BOT_STATE) },
 * });
 * ```
 *
 * Until the SDK publishes coherently for Workers, `bot-host.ts` exercises the
 * same StateStore durability contract (dedup, turn lock, threadstate, HITL).
 */
import {
  createDurableObjectStore,
  type DurableObjectStateStore,
} from "./store/index.js";
import type { Env } from "./env.js";

export function createBotStoreAdapter(
  namespace: Env["BOT_STATE"],
): DurableObjectStateStore {
  return createDurableObjectStore(namespace);
}
