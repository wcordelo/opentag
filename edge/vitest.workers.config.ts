import { defineConfig } from "vitest/config";

/**
 * Research-task secondary suite (Node).
 *
 * Full Miniflare DO e2e against wrangler.research.toml needs a local
 * WASM_DISPATCH service worker — not provisioned in CI yet. Those cases stay
 * as `it.todo` in tests/integration/e2e.test.ts.
 *
 * Smoke coverage (WASM classify contract, egress allowlist, TaskRuntime shape)
 * runs here and under `npm test` via the shared integration file.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/integration/**/*.test.ts",
      "workers/**/*.test.ts",
    ],
  },
});
