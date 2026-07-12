import { defineConfig } from "vitest/config";

// Claude Tag bot-spine unit tests only (Node).
// StateStore workerd suite: vitest.workers.bot-store.config.ts → npm run test:e2e
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.workers.test.ts", "node_modules/**"],
  },
});
