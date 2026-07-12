/**
 * DO SQLite schema migrations — SQLite-compatible rewrite of
 * lib/research/migrations/001_initial.sql plus Phase 7 tables
 * (agent_containers, agent_handoffs, agent_execution_logs, github_artifacts).
 *
 * Postgres types (JSONB / TIMESTAMPTZ / NOW()) are mapped to SQLite
 * (TEXT / INTEGER / datetime('now')). Applied idempotently on every DO
 * cold start via schema_migrations.
 */

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS session_state (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version_id INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  tool_name TEXT,
  request TEXT,
  response TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_log_session ON research_log(session_id, step_index);

CREATE TABLE IF NOT EXISTS verified_facts (
  fact_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  confidence REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verified_facts_session ON verified_facts(session_id);

CREATE TABLE IF NOT EXISTS fact_edges (
  session_id TEXT NOT NULL,
  from_hash TEXT NOT NULL,
  to_hash TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (session_id, from_hash, to_hash, relation)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  target_actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(session_id, status);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_slack_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deadline_at TEXT,
  event_ts TEXT,
  event_id TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_key);

CREATE TABLE IF NOT EXISTS delivery_obligations (
  id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_pending ON delivery_obligations(status, thread_key);

CREATE TABLE IF NOT EXISTS alarm_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_at_ms INTEGER NOT NULL,
  payload TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alarm_due ON alarm_queue(run_at_ms, priority DESC);

CREATE TABLE IF NOT EXISTS blob_storage (
  log_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_cache (
  request_id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS agent_containers (
  container_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  flavor TEXT NOT NULL,
  status TEXT NOT NULL,
  preview_url TEXT,
  started_at TEXT,
  killed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_containers_session ON agent_containers(session_id);

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  from_session_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  compressed_tokens INTEGER,
  validated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_session ON agent_handoffs(from_session_id);

CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  container_id TEXT,
  step TEXT,
  tool_name TEXT,
  request TEXT,
  response TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_execution_logs_session ON agent_execution_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_execution_logs_container ON agent_execution_logs(container_id);

CREATE TABLE IF NOT EXISTS github_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pr_url TEXT,
  commit_sha TEXT,
  branch_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_github_artifacts_session ON github_artifacts(session_id);
`;

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): unknown;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isMigrationApplied(sql: SqlLike, version: number): boolean {
  try {
    const cursor = sql.exec(
      "SELECT 1 FROM schema_migrations WHERE version = ?",
      version,
    ) as { toArray?: () => unknown[] };
    return (cursor.toArray?.() ?? []).length > 0;
  } catch {
    return false;
  }
}

function applyMigration(sql: SqlLike, version: number, body: string): void {
  if (isMigrationApplied(sql, version)) return;
  for (const statement of splitStatements(body)) {
    sql.exec(statement);
  }
  sql.exec(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now')) ON CONFLICT DO NOTHING",
    version,
  );
}

/** Run all schema migrations idempotently. Safe on every DO cold start. */
export function runMigrations(sql: SqlLike): void {
  // schema_migrations must exist before we can check versions — apply its
  // CREATE from migration 001 first if needed.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  applyMigration(sql, 1, MIGRATION_001);
  applyMigration(sql, 2, MIGRATION_002);
}
