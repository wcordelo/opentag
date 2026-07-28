import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import {
  TEST_KNOWLEDGE_SOURCE_ISSUER,
  TEST_KNOWLEDGE_SOURCE_KEY_ID,
  TEST_KNOWLEDGE_SOURCE_PUBLIC_KEY,
} from "./test/helpers/knowledge-source-grant.js";

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
      miniflare: {
        bindings: {
          ADMIN_SECRET: "test-admin-secret",
          SLACK_BOT_TOKEN: "",
          KNOWLEDGE_SOURCE_AUTH_ISSUER: TEST_KNOWLEDGE_SOURCE_ISSUER,
          KNOWLEDGE_SOURCE_AUTH_KEY_ID: TEST_KNOWLEDGE_SOURCE_KEY_ID,
          KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY: TEST_KNOWLEDGE_SOURCE_PUBLIC_KEY,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workers.test.ts"],
    // Four workerd files cold-start multiple SQLite-backed DOs concurrently.
    // Preserve behavioral timeouts without failing on host startup contention.
    testTimeout: 15_000,
  },
});
