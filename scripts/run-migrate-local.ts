/**
 * One-shot CLI: migrate tasks from local Postgres → live OrchestratorDO.
 *
 * Usage:
 *   DATABASE_URL=postgres://opentag:opentag@localhost:5432/opentag \
 *   ORCHESTRATOR_URL=https://opentag-orchestrator....workers.dev \
 *   MIGRATE_TEAM_ID=T0BBBEDLEGY \
 *   npx tsx scripts/run-migrate-local.ts
 */
import pg from "pg";
import {
  migrateResearchState,
  validateMigrationParity,
  type MigrationSource,
  type MigrationSink,
} from "./migrate-pg-to-do.js";
import type { TaskRecord, BlobRef } from "../lib/research/types.js";
import type { StorageAdapter } from "../lib/research/adapters/storage.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://opentag:opentag@localhost:5432/opentag";
const ORCHESTRATOR_URL =
  process.env["ORCHESTRATOR_URL"] ??
  "https://opentag-orchestrator.williamlopezc.workers.dev";
const TEAM_ID = process.env["MIGRATE_TEAM_ID"] ?? "T0BBBEDLEGY";

function createPgSource(pool: pg.Pool): MigrationSource {
  return {
    async listTasks(): Promise<TaskRecord[]> {
      const { rows } = await pool.query<{
        task_id: string;
        thread_key: string;
        status: TaskRecord["status"];
        objective: string;
        created_at: string;
        deadline_at: string | null;
        event_ts: string | null;
        event_id: string | null;
        metadata: unknown;
      }>(`SELECT * FROM tasks ORDER BY created_at ASC`);
      return rows.map((r) => ({
        taskId: r.task_id,
        threadKey: r.thread_key,
        status: r.status,
        objective: r.objective,
        createdAt:
          typeof r.created_at === "string"
            ? r.created_at
            : new Date(r.created_at).toISOString(),
        deadlineAt: r.deadline_at
          ? typeof r.deadline_at === "string"
            ? r.deadline_at
            : new Date(r.deadline_at).toISOString()
          : undefined,
        eventTs: r.event_ts ?? undefined,
        eventId: r.event_id ?? undefined,
        metadata:
          r.metadata && typeof r.metadata === "object"
            ? (r.metadata as Record<string, unknown>)
            : undefined,
      }));
    },
    async listBlobRefs(): Promise<Array<BlobRef & { createdAt: string }>> {
      const { rows } = await pool.query<{
        log_id: string;
        r2_key: string;
        bytes: number;
        content_type: string;
        created_at: string;
      }>(`SELECT * FROM blob_storage`);
      return rows.map((r) => ({
        logId: r.log_id,
        key: r.r2_key,
        bytes: r.bytes,
        contentType: r.content_type,
        createdAt:
          typeof r.created_at === "string"
            ? r.created_at
            : new Date(r.created_at).toISOString(),
      }));
    },
  };
}

/** StorageAdapter subset that talks to the live Worker import API. */
function createHttpDoSink(): MigrationSink {
  const cache = new Map<string, TaskRecord>();

  const storage = {
    async getTask(taskId: string) {
      if (cache.has(taskId)) return cache.get(taskId)!;
      const res = await fetch(
        `${ORCHESTRATOR_URL}/internal/tasks/${encodeURIComponent(taskId)}?teamId=${encodeURIComponent(TEAM_ID)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getTask failed: ${res.status}`);
      const task = (await res.json()) as TaskRecord;
      cache.set(taskId, task);
      return task;
    },
    async createTask(task: TaskRecord) {
      const res = await fetch(`${ORCHESTRATOR_URL}/internal/import-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: TEAM_ID, task }),
      });
      if (!res.ok) {
        throw new Error(`import-task failed: ${res.status} ${await res.text()}`);
      }
      cache.set(task.taskId, task);
    },
    async getBlobRef() {
      return null;
    },
    async storeBlobRef() {
      /* blob bytes migration deferred — metadata-only for this cutover */
    },
  } as unknown as StorageAdapter;

  return { storage };
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const source = createPgSource(pool);
    const sink = createHttpDoSink();

    console.log("Migrating", { DATABASE_URL: DATABASE_URL.replace(/:[^@]+@/, ":***@"), ORCHESTRATOR_URL, TEAM_ID });
    const first = await migrateResearchState(source, sink);
    console.log("first run", first);
    const second = await migrateResearchState(source, sink);
    console.log("second run (idempotent)", second);
    const parity = await validateMigrationParity(source, sink);
    console.log("parity", parity);
    if (!parity.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
