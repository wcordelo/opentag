import type { SqlExecutor } from "../store/sql.js";

const SOURCE_TYPES = "('slack', 'wiki', 'code', 'custom_db', 'drive')";
const LEDGER_COLUMNS = [
  "source_key",
  "source_type",
  "team_id",
  "project_id",
  "channel_id",
  "thread_ts",
  "config_version",
  "requested_at",
  "reason",
  "desired_revision",
  "indexed_revision",
  "local_document_id",
  "local_document_revision",
  "derived_index_generation",
  "add_attempt_token",
  "add_attempt_revision",
  "local_workflow_status",
  "poll_deadline_at",
  "next_poll_at",
  "poll_count",
  "last_local_operation",
  "last_local_error",
  "status",
  "queue_attempts",
  "lease_token",
  "lease_expires_at",
  "last_error_class",
  "last_error_code",
  "incomplete_reason",
  "tombstoned_at",
  "created_at",
  "updated_at",
] as const;

function tableName(value: string): string {
  if (!/^knowledge_ledger(?:_v2)?$/.test(value)) {
    throw new Error("invalid knowledge ledger table name");
  }
  return value;
}

export function knowledgeLedgerTableSql(value: string): string {
  const name = tableName(value);
  return `CREATE TABLE IF NOT EXISTS ${name} (
    source_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'slack'
      CHECK (source_type IN ${SOURCE_TYPES}),
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    desired_revision TEXT,
    indexed_revision TEXT,
    local_document_id TEXT,
    local_document_revision TEXT,
    derived_index_generation TEXT,
    add_attempt_token TEXT,
    add_attempt_revision TEXT,
    local_workflow_status TEXT,
    poll_deadline_at INTEGER,
    next_poll_at INTEGER,
    poll_count INTEGER NOT NULL DEFAULT 0,
    last_local_operation TEXT,
    last_local_error TEXT,
    status TEXT NOT NULL,
    queue_attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    last_error_class TEXT,
    last_error_code TEXT,
    incomplete_reason TEXT,
    tombstoned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(team_id, source_type, channel_id, thread_ts)
  )`;
}

function columns(sql: SqlExecutor, table: string): Set<string> {
  return new Set(
    sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name),
  );
}

function hasLegacyIdentityUniqueIndex(sql: SqlExecutor): boolean {
  const indexes = sql.exec<{ name: string; unique: number }>(
    "PRAGMA index_list(knowledge_ledger)",
  ).toArray();
  return indexes.some((index) => {
    if (index.unique !== 1) return false;
    const indexName = index.name.replaceAll('"', '""');
    const indexColumns = sql.exec<{ name: string; seqno: number }>(
      `PRAGMA index_info("${indexName}")`,
    ).toArray()
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    return indexColumns.join(",") === "team_id,channel_id,thread_ts";
  });
}

function addSourceType(sql: SqlExecutor, table: string): void {
  if (columns(sql, table).has("source_type")) return;
  sql.exec(
    `ALTER TABLE ${table} ADD COLUMN source_type TEXT NOT NULL DEFAULT 'slack'`,
  );
}

export function migrateKnowledgeLedgerSourceTypes(sql: SqlExecutor): void {
  if (columns(sql, "knowledge_ledger").size === 0) return;
  addSourceType(sql, "knowledge_ledger");
  for (const table of [
    "knowledge_events",
    "knowledge_outbox",
    "knowledge_ledger_derived_history",
    "knowledge_dlq_records",
  ]) {
    if (columns(sql, table).size > 0) addSourceType(sql, table);
  }
  if (!hasLegacyIdentityUniqueIndex(sql)) return;

  sql.exec("DROP TABLE IF EXISTS knowledge_ledger_v2");
  sql.exec(knowledgeLedgerTableSql("knowledge_ledger_v2").replace(
    "CREATE TABLE IF NOT EXISTS",
    "CREATE TABLE",
  ));
  const list = LEDGER_COLUMNS.join(", ");
  sql.exec(
    `INSERT INTO knowledge_ledger_v2 (${list})
     SELECT ${list} FROM knowledge_ledger`,
  );
  sql.exec("DROP TABLE knowledge_ledger");
  sql.exec("ALTER TABLE knowledge_ledger_v2 RENAME TO knowledge_ledger");
}

const QUERYABILITY_STATUSES = "('unverified', 'searchable', 'no_match', 'provider_unavailable')";

const QUERYABILITY_COLUMN_DEFINITIONS = [
  ["source_key", "TEXT"],
  ["source_type", "TEXT"],
  ["team_id", "TEXT"],
  ["project_id", "TEXT"],
  ["channel_id", "TEXT"],
  ["thread_ts", "TEXT"],
  ["content_revision", "TEXT"],
  ["index_revision", "TEXT"],
  ["local_document_id", "TEXT"],
  ["derived_index_generation", "TEXT"],
  ["status", "TEXT"],
  ["provider_result_count", "INTEGER"],
  ["accepted_citation_count", "INTEGER"],
  ["created_at", "TEXT"],
  ["updated_at", "TEXT"],
] as const;

function queryabilityTableName(value: string): string {
  if (value !== "knowledge_queryability_receipts") {
    throw new Error("invalid knowledge queryability table name");
  }
  return value;
}

export function knowledgeQueryabilityTableSql(
  value = "knowledge_queryability_receipts",
): string {
  const name = queryabilityTableName(value);
  return `CREATE TABLE IF NOT EXISTS ${name} (
    source_key TEXT NOT NULL,
    source_type TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    content_revision TEXT NOT NULL,
    index_revision TEXT NOT NULL,
    local_document_id TEXT NOT NULL,
    derived_index_generation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ${QUERYABILITY_STATUSES}),
    provider_result_count INTEGER NOT NULL,
    accepted_citation_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_key, content_revision, index_revision, derived_index_generation)
  )`;
}

export function migrateKnowledgeQueryability(sql: SqlExecutor): void {
  const current = new Set(
    sql.exec<{ name: string }>(
      "PRAGMA table_info(knowledge_queryability_receipts)",
    ).toArray().map((row) => row.name),
  );
  if (current.size === 0) {
    sql.exec(knowledgeQueryabilityTableSql());
    return;
  }
  for (const [name, definition] of QUERYABILITY_COLUMN_DEFINITIONS) {
    if (!current.has(name)) {
      sql.exec(`ALTER TABLE knowledge_queryability_receipts ADD COLUMN ${name} ${definition}`);
    }
  }
}
