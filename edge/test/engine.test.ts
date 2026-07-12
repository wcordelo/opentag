import { runStateStoreConformance } from "./conformance.js";
import { makeSqliteStateStore } from "./sqlite-state-store.js";

/**
 * Run the full `@copilotkit/bot` StateStore contract against the production
 * SqlStateEngine (backed here by node:sqlite; by Durable Object SQLite in prod).
 */
let close: (() => void) | undefined;

runStateStoreConformance(
  "durable-object-sqlite (node:sqlite)",
  () => {
    const made = makeSqliteStateStore();
    close = made.close;
    return made.store;
  },
  async () => {
    close?.();
    close = undefined;
  },
);
