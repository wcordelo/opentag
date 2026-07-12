import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Runs bot-store tests INSIDE workerd so ConversationStateDO, ctx.storage.sql,
 * transactionSync, and the RPC boundary are exercised. Uses wrangler.bot-store.toml
 * (not the research orchestrator wrangler.toml).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.bot-store.toml" },
    }),
  ],
  test: {
    include: ["test/**/*.workers.test.ts"],
  },
});
