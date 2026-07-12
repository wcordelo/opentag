import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Miniflare / workerd pool for research *task* integration tests.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.research.toml" },
    }),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
  },
});
