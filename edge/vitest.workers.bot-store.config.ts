import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Primary CF suite: StateStore inside workerd (ConversationStateDO + SQL).
 * Uses wrangler.bot-store.toml (thin alias of the bot spine BOT_STATE binding).
 * Default product deploy is wrangler.toml — same DO class.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.bot-store.toml" },
      // Never let lifecycle-alarm tests inherit a developer's real Slack
      // secret from .dev.vars.
      miniflare: { bindings: { SLACK_BOT_TOKEN: "" } },
    }),
  ],
  test: {
    include: ["test/**/*.workers.test.ts"],
  },
});
