import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./workers/graphify/wrangler.test.toml" },
    }),
  ],
  test: {
    include: ["test/**/*.graphify.workers.test.ts"],
    testTimeout: 15_000,
  },
});
