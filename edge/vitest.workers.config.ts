import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Runs tests INSIDE workerd (miniflare) so the real ConversationStateDO,
 * ctx.storage.sql, transactionSync, and the RPC boundary are exercised — true
 * end-to-end for the store. Bindings + the SQLite DO migration are read from
 * wrangler.toml.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    include: ["test/**/*.workers.test.ts"],
  },
});
