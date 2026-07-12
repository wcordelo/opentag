/**
 * Store adapter for `@copilotkit/channels` createBot on Cloudflare.
 *
 * ```ts
 * import { createBot } from "@copilotkit/channels";
 * import { createBotStoreAdapter } from "./create-bot-store.js";
 *
 * const bot = createBot({
 *   adapters: [cfSlack],
 *   agent: (threadId) => makeAgent(threadId),
 *   store: { adapter: createBotStoreAdapter(env.BOT_STATE) },
 * });
 * ```
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
