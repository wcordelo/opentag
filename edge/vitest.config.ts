import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Claude Tag bot-spine unit tests only (Node).
// StateStore workerd suite: vitest.workers.bot-store.config.ts → npm run test:e2e
export default defineConfig({
  // Worker subpackages (`workers/graphify`, `workers/supermemory`) install their
  // own node_modules in CI *after* unit tests. Pin Cloudflare packages to the
  // edge root so vi.mock() in boundary tests still intercepts them when those
  // nested installs exist locally.
  resolve: {
    alias: {
      "@cloudflare/sandbox": path.join(root, "node_modules/@cloudflare/sandbox"),
      "@cloudflare/containers": path.join(root, "node_modules/@cloudflare/containers"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.workers.test.ts", "node_modules/**"],
  },
});
