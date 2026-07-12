/**
 * Unit tests for the idempotent Postgres→DO migration helper (no live DB).
 */
import { describe, expect, it } from "vitest";
import {
  migrateResearchState,
  validateMigrationParity,
  type MigrationSource,
} from "../../../../../scripts/migrate-pg-to-do";
import { MemoryStorageAdapter } from "../../../../../lib/research/adapters/storage-memory.js";
import type { TaskRecord } from "../../../../../lib/research/types.js";

function sourceWith(tasks: TaskRecord[]): MigrationSource {
  return {
    async listTasks() {
      return tasks;
    },
    async listBlobRefs() {
      return [];
    },
  };
}

describe("migrateResearchState", () => {
  it("copies tasks and is idempotent on second run", async () => {
    const tasks: TaskRecord[] = [
      {
        taskId: "task_1",
        threadKey: "slack:C:1",
        status: "complete",
        objective: "one",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        taskId: "task_2",
        threadKey: "slack:C:2",
        status: "running",
        objective: "two",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ];
    const source = sourceWith(tasks);
    const sink = { storage: new MemoryStorageAdapter() };

    const first = await migrateResearchState(source, sink);
    expect(first.tasksWritten).toBe(2);
    expect(first.tasksSkipped).toBe(0);

    const second = await migrateResearchState(source, sink);
    expect(second.tasksWritten).toBe(0);
    expect(second.tasksSkipped).toBe(2);

    const parity = await validateMigrationParity(source, sink);
    expect(parity.ok).toBe(true);
    expect(parity.checksumMatch).toBe(true);
  });
});
