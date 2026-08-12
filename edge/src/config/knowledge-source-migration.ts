import type { SqlExecutor } from "../store/sql.js";

export function migrateTrackedKnowledgeSourceTables(sql: SqlExecutor): void {
  const columns = sql
    .exec<{ name: string; pk: number }>("PRAGMA table_info(tracked_knowledge_sources)")
    .toArray();
  const names = new Set(columns.map((column) => column.name));
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const targetPrimaryKey = ["team_id", "source_type", "project_id", "channel_id"];
  if (primaryKey.join(",") !== targetPrimaryKey.join(",")) {
    const sourceType = names.has("source_type") ? "source_type" : "'slack'";
    const everEnabled = names.has("ever_enabled")
      ? "ever_enabled"
      : "CASE WHEN enabled = 1 THEN 1 ELSE 0 END";
    const admissionMode = names.has("admission_mode")
      ? "admission_mode"
      : "'explicit'";
    sql.exec(`CREATE TABLE tracked_knowledge_sources_v2 (
      team_id TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'slack'
        CHECK (source_type IN ('slack', 'wiki', 'code', 'custom_db', 'drive')),
      project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      ever_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ever_enabled IN (0, 1)),
      reader_policy_ref TEXT NOT NULL DEFAULT '',
      retention_days INTEGER,
      config_version INTEGER NOT NULL DEFAULT 0,
      admission_mode TEXT NOT NULL DEFAULT 'explicit'
        CHECK (admission_mode IN ('explicit', 'workspace_default')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, source_type, project_id, channel_id)
    )`);
    sql.exec(`INSERT INTO tracked_knowledge_sources_v2 (
      team_id, source_type, project_id, channel_id, enabled, ever_enabled,
      reader_policy_ref, retention_days, config_version, admission_mode, updated_at
    ) SELECT team_id, ${sourceType}, project_id, channel_id, enabled, ${everEnabled},
      reader_policy_ref, retention_days, config_version, ${admissionMode}, updated_at
      FROM tracked_knowledge_sources`);
    sql.exec("DROP INDEX IF EXISTS idx_tracked_knowledge_one_enabled_project");
    sql.exec("DROP TABLE tracked_knowledge_sources");
    sql.exec("ALTER TABLE tracked_knowledge_sources_v2 RENAME TO tracked_knowledge_sources");
  }
  sql.exec("DROP INDEX IF EXISTS idx_tracked_knowledge_one_enabled_project");
  sql.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_knowledge_one_enabled_project
     ON tracked_knowledge_sources(team_id, source_type, channel_id) WHERE enabled = 1`,
  );
}
