import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ConversationStateDO } from "./store/conversation-state-do.js";

/**
 * Worker bindings. `BOT_STATE` is the Durable Object namespace that fronts the
 * SQLite-backed state store (declared in `wrangler.toml`). Secrets mirror the
 * Node deployment's `.env` so the same bot code runs on the edge.
 */
export interface Env {
  /** Durable Object namespace bound to {@link ConversationStateDO}. */
  BOT_STATE: DurableObjectNamespace<ConversationStateDO>;

  // ── Agent backend (see runtime.ts) ──
  AGENT_URL: string;
  AGENT_AUTH_HEADER?: string;

  // ── Platform secrets (set whichever platform(s) you run) ──
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_APP_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
}
