import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTrackedKnowledgeSourceTables } from "../src/config/knowledge-source-migration.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

const databases: DatabaseSync[] = [];

function sqlFor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      const statement = db.prepare(query);
      const params = bindings as Array<string | number | bigint | null>;
      const rows = /^\s*(select|pragma)/i.test(query)
        ? statement.all(...params) as T[]
        : (statement.run(...params), [] as T[]);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0]!;
        },
      };
    },
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("tracked knowledge source migration", () => {
  it("migrates the legacy primary key and defaults old rows to Slack", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const sql = sqlFor(db);
    db.exec(`CREATE TABLE tracked_knowledge_sources (
      team_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      reader_policy_ref TEXT NOT NULL DEFAULT '',
      retention_days INTEGER,
      config_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, project_id, channel_id)
    )`);
    db.exec(`INSERT INTO tracked_knowledge_sources
      (team_id, project_id, channel_id, enabled, reader_policy_ref, config_version, updated_at)
      VALUES ('T1', 'P1', 'C1', 1, 'readers', 3, '2026-08-02T00:00:00.000Z')`);

    migrateTrackedKnowledgeSourceTables(sql);

    const columns = db.prepare("PRAGMA table_info(tracked_knowledge_sources)").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name))
      .toEqual(["team_id", "source_type", "project_id", "channel_id"]);
    expect(db.prepare("SELECT source_type, enabled, ever_enabled, admission_mode FROM tracked_knowledge_sources").all())
      .toEqual([{ source_type: "slack", enabled: 1, ever_enabled: 1, admission_mode: "explicit" }]);
  });

  it("preserves pre-existing non-Slack source rows during the key migration", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const sql = sqlFor(db);
    db.exec(`CREATE TABLE tracked_knowledge_sources (
      team_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      ever_enabled INTEGER NOT NULL DEFAULT 0,
      reader_policy_ref TEXT NOT NULL DEFAULT '',
      retention_days INTEGER,
      config_version INTEGER NOT NULL DEFAULT 0,
      admission_mode TEXT NOT NULL DEFAULT 'explicit',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, project_id, channel_id)
    )`);
    db.exec(`INSERT INTO tracked_knowledge_sources
      (team_id, source_type, project_id, channel_id, enabled, ever_enabled, updated_at)
      VALUES
      ('T1', 'slack', 'P1', 'C1', 1, 1, '2026-08-02T00:00:00.000Z'),
      ('T1', 'wiki', 'P1', 'C2', 0, 1, '2026-08-02T00:00:00.000Z')`);

    migrateTrackedKnowledgeSourceTables(sql);

    expect(db.prepare(
      "SELECT source_type, enabled FROM tracked_knowledge_sources ORDER BY source_type",
    ).all()).toEqual([
      { source_type: "slack", enabled: 1 },
      { source_type: "wiki", enabled: 0 },
    ]);
  });
});
