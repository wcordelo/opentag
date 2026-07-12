-- Research actor framework initial schema (mirrors Centaur edge SQLite design)

CREATE TABLE IF NOT EXISTS session_state (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  version_id INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS research_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  tool_name TEXT,
  request JSONB,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_log_session ON research_log(session_id, step_index);

CREATE TABLE IF NOT EXISTS verified_facts (
  fact_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  confidence REAL,
  created_at TIMESTAMPTZ NOT NULL
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
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(session_id, status);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_slack_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ,
  event_ts TEXT,
  event_id TEXT,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_key);

CREATE TABLE IF NOT EXISTS delivery_obligations (
  id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_pending ON delivery_obligations(status, thread_key);

CREATE TABLE IF NOT EXISTS alarm_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_at_ms BIGINT NOT NULL,
  payload JSONB,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alarm_due ON alarm_queue(run_at_ms, priority DESC);

CREATE TABLE IF NOT EXISTS blob_storage (
  log_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_cache (
  request_id TEXT PRIMARY KEY,
  verdict JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
