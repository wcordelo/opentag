import { defineConfig } from "vitest/config";

// Node unit tests: research Workers + bot-store engine (node:sqlite).
// Workerd suites use vitest.workers*.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "workers/**/*.test.ts",
      "tests/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: [
      "test/**/*.workers.test.ts",
      "node_modules/**",
    ],
  },
});
