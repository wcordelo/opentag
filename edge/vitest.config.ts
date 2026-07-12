import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // workerd-only suite (uses `cloudflare:test`) runs via vitest.workers.config.ts
    exclude: ["test/**/*.workers.test.ts", "node_modules/**"],
  },
});
