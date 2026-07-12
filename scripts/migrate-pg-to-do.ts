/**
 * Postgres → DO SQLite + R2 migration tooling (M7).
 *
 * SAFETY: This module never connects to production by default. Callers must
 * pass explicit connection strings / adapters. Running against a live DB
 * requires the Gate "external action" sign-off from goal-prompt.md.
 */
import type { StorageAdapter } from "../lib/research/adapters/storage.js";
import type { TaskRecord, BlobRef } from "../lib/research/types.js";

export interface MigrationSource {
  listTasks(): Promise<TaskRecord[]>;
  listBlobRefs(): Promise<Array<BlobRef & { createdAt: string }>>;
}

export interface MigrationSink {
  storage: StorageAdapter;
  putBlob?(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface MigrationReport {
  tasksRead: number;
  tasksWritten: number;
  tasksSkipped: number;
  blobsRead: number;
  blobsWritten: number;
  blobsSkipped: number;
}

/**
 * Idempotent copy of task + blob-ref metadata from source → sink.
 * Second run with the same data produces no additional writes.
 */
export async function migrateResearchState(
  source: MigrationSource,
  sink: MigrationSink,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    tasksRead: 0,
    tasksWritten: 0,
    tasksSkipped: 0,
    blobsRead: 0,
    blobsWritten: 0,
    blobsSkipped: 0,
  };

  const tasks = await source.listTasks();
  report.tasksRead = tasks.length;
  for (const task of tasks) {
    const existing = await sink.storage.getTask(task.taskId);
    if (existing) {
      report.tasksSkipped++;
      continue;
    }
    await sink.storage.createTask(task);
    report.tasksWritten++;
  }

  const blobs = await source.listBlobRefs();
  report.blobsRead = blobs.length;
  for (const blob of blobs) {
    const existing = await sink.storage.getBlobRef(blob.logId);
    if (existing) {
      report.blobsSkipped++;
      continue;
    }
    await sink.storage.storeBlobRef(blob);
    report.blobsWritten++;
  }

  return report;
}

/**
 * Validation helper — compares task counts and a simple checksum of task IDs.
 */
export async function validateMigrationParity(
  source: MigrationSource,
  sink: MigrationSink,
): Promise<{ ok: boolean; sourceCount: number; sinkCount: number; checksumMatch: boolean }> {
  const sourceTasks = await source.listTasks();
  const sinkTasks: TaskRecord[] = [];
  for (const t of sourceTasks) {
    const got = await sink.storage.getTask(t.taskId);
    if (got) sinkTasks.push(got);
  }

  const checksum = (tasks: TaskRecord[]) =>
    tasks
      .map((t) => t.taskId)
      .sort()
      .join("|");

  return {
    ok: sourceTasks.length === sinkTasks.length && checksum(sourceTasks) === checksum(sinkTasks),
    sourceCount: sourceTasks.length,
    sinkCount: sinkTasks.length,
    checksumMatch: checksum(sourceTasks) === checksum(sinkTasks),
  };
}
