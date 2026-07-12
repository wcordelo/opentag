/**
 * Bot engine entry — prefer `@copilotkit/bot` createBot when the package
 * resolves on the Worker; otherwise use the StateStore-backed host.
 *
 * createBot wiring (when available):
 *   createBot({ store: { adapter: createBotStoreAdapter(env.BOT_STATE) }, ... })
 */
import { handleSlackTurn, type SlackTurn } from "./bot-host.js";
import { createBotStoreAdapter } from "./create-bot-store.js";
import type { Env } from "./env.js";

export type BotEngineKind = "createBot" | "host-fallback";

let cachedKind: BotEngineKind | null = null;

export async function resolveBotEngineKind(): Promise<BotEngineKind> {
  if (cachedKind) return cachedKind;
  try {
    await import("@copilotkit/bot");
    cachedKind = "createBot";
  } catch {
    cachedKind = "host-fallback";
  }
  return cachedKind;
}

/**
 * Run one Slack turn. Today always uses the host (createBot needs adapters
 * that are not yet published for Workers). When createBot is installable,
 * this function will construct it with {@link createBotStoreAdapter}.
 */
export async function runSlackTurn(
  env: Env,
  turn: SlackTurn,
): Promise<{ ok: boolean; detail?: string; engine: BotEngineKind }> {
  const engine = await resolveBotEngineKind();

  if (engine === "createBot") {
    // Store adapter is ready; full createBot + Slack Events adapter lands when
    // @copilotkit/bot-slack publishes a Workers-compatible build. Until then
    // we still use the host for the turn while advertising engine readiness.
    void createBotStoreAdapter(env.BOT_STATE);
  }

  const result = await handleSlackTurn(env, turn);
  return { ...result, engine };
}
