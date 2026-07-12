-- Agent pipeline schema: containers, handoffs, execution logs, GitHub artifacts.
-- TEXT used for JSON/timestamp columns for SQLite (DO) compatibility; also valid for Postgres audit track.

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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_from_session ON agent_handoffs(from_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_to_session ON agent_handoffs(to_session_id);

CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  container_id TEXT,
  step TEXT,
  tool_name TEXT,
  request TEXT,
  response TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_execution_logs_session ON agent_execution_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_execution_logs_container ON agent_execution_logs(container_id);

CREATE TABLE IF NOT EXISTS github_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pr_url TEXT,
  commit_sha TEXT,
  branch_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_artifacts_session ON github_artifacts(session_id);
