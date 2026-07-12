import { defineConfig } from "vitest/config";

// Unit-test config for edge/ Workers source. Integration tests that need
// Miniflare DO/KV/R2 bindings use vitest.workers.config.ts (cloudflare pool).
export default defineConfig({
  test: {
    environment: "node",
    include: ["workers/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
