import type { SqlExecutor } from "./sql.js";

/**
 * Schema version for the bot state tables. Bump when the DDL below changes and
 * add a migration branch in {@link migrate}. The current version is recorded in
 * the `_meta` table so a Durable Object that was created on an older schema can
 * upgrade in place on its next constructor run.
 */
export const SCHEMA_VERSION = 9;

/**
 * One table per {@link import("./sql.js")} StateStore namespace. Everything the
 * bot stores is JSON text in a `value` column — the StateStore contract already
 * requires JSON-serializable values, so we lean into it and keep types uniform.
 *
 * Expiry model: every expirable row carries an absolute `expires_at` (epoch ms,
 * NULL = never). Reads are lazily filtered/cleaned (matching the in-memory
 * reference store), and a periodic Durable Object alarm sweeps tombstones so a
 * cold conversation's table doesn't grow unbounded (see `sweepExpired`).
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS _meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,

  // kv namespace: single value per key.
  `CREATE TABLE IF NOT EXISTS kv (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     expires_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at)`,

  // list namespace: ordered items + per-list expiry/metadata.
  `CREATE TABLE IF NOT EXISTS list_meta (
     key        TEXT PRIMARY KEY,
     expires_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS list_items (
     key   TEXT NOT NULL,
     seq   INTEGER NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (key, seq)
   )`,

  // lock namespace: at most one holder per key, always TTL-bounded.
  `CREATE TABLE IF NOT EXISTS locks (
     key        TEXT PRIMARY KEY,
     token      TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS locks_expires_at ON locks (expires_at)`,

  // dedup namespace: presence-with-TTL set.
  `CREATE TABLE IF NOT EXISTS dedup (
     key        TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS dedup_expires_at ON dedup (expires_at)`,

  // queue namespace: FIFO items ordered by seq.
  `CREATE TABLE IF NOT EXISTS queue (
     key   TEXT NOT NULL,
     seq   INTEGER NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (key, seq)
   )`,

  // render_obligations (SPEC.md §3.1 / §4.2): the never-silent guarantee. One
  // row per in-flight turn, keyed by threadKey — a fresh write for the same
  // thread supersedes any prior one (PRIMARY KEY upsert). The DO's single
  // alarm serves any row whose `deadline` has passed (see conversation-state-do.ts
  // `alarm()`); a normal turn completion deletes the row before the deadline
  // ever arrives.
  `CREATE TABLE IF NOT EXISTS render_obligations (
     thread_key     TEXT PRIMARY KEY,
     execution_id   TEXT NOT NULL,
     after_event_id INTEGER NOT NULL,
     channel        TEXT NOT NULL,
     thread_ts      TEXT,
     live_client_msg_id TEXT,
     live_message_ts TEXT,
     live_message_state TEXT NOT NULL DEFAULT 'unreserved',
     deadline       INTEGER NOT NULL,
     attempt        INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS render_obligations_deadline ON render_obligations (deadline)`,

  // Exact active-turn ownership and Slack render fencing. Every transition is
  // one ConversationStateDO SQLite transaction; no correctness depends on a
  // Worker-side lease surviving an RPC stall.
  `CREATE TABLE IF NOT EXISTS active_turns (
     thread_key       TEXT PRIMARY KEY,
     channel_id       TEXT NOT NULL,
     conversation_key TEXT NOT NULL,
     execution_id     TEXT NOT NULL,
     thread_ts        TEXT,
     choice_id        TEXT,
     live_client_msg_id TEXT,
     live_message_ts  TEXT,
     live_message_state TEXT NOT NULL DEFAULT 'unreserved',
     registered_at    INTEGER NOT NULL,
     delivery_status  TEXT NOT NULL,
     render_token     TEXT,
     effect_token     TEXT,
     effect_name      TEXT,
     effect_resource  TEXT,
     confirmed_output INTEGER NOT NULL DEFAULT 0,
     stop_event_id    TEXT,
     updated_at       INTEGER NOT NULL,
     expires_at       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS active_turns_channel ON active_turns (channel_id, registered_at DESC)`,
  `CREATE INDEX IF NOT EXISTS active_turns_expiry ON active_turns (expires_at)`,

  // Every modern HITL picker belongs to one exact active execution. Keeping
  // this registry beside active_turns and the exact-id HITL receipts lets Stop
  // install denial receipts for every outstanding picker in one SQLite
  // transaction. Dynamic tools must register here before rendering a card.
  `CREATE TABLE IF NOT EXISTS active_turn_choices (
     thread_key   TEXT NOT NULL,
     execution_id TEXT NOT NULL,
     choice_id    TEXT NOT NULL,
     registered_at INTEGER NOT NULL,
     PRIMARY KEY (thread_key, execution_id, choice_id)
   )`,
  `CREATE INDEX IF NOT EXISTS active_turn_choices_execution
     ON active_turn_choices (thread_key, execution_id)`,

  // Bounded, exact-execution pre-model handoff retry. The alarm claims one row
  // before calling SessionEventDO.execute; completion or re-arm is a CAS on
  // claim_token so a stale attempt cannot overwrite a newer lifecycle action.
  `CREATE TABLE IF NOT EXISTS session_handoffs (
     thread_key          TEXT PRIMARY KEY,
     execution_id       TEXT NOT NULL,
     forwarded_message_id TEXT NOT NULL,
     input_lines         TEXT NOT NULL,
     status              TEXT NOT NULL,
     due_at              INTEGER NOT NULL,
     attempt             INTEGER NOT NULL DEFAULT 0,
     claim_token         TEXT,
     claimed_at          INTEGER,
     result              TEXT,
     expires_at          INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS session_handoffs_due
     ON session_handoffs (status, due_at)`,
];

/**
 * Create/upgrade the schema. Idempotent: safe to call on every Durable Object
 * construction. Run inside `blockConcurrencyWhile` so no request observes a
 * half-built schema.
 */
export function migrate(sql: SqlExecutor): void {
  for (const stmt of DDL) sql.exec(stmt);

  const row = sql
    .exec<{ v: string }>(`SELECT v FROM _meta WHERE k = 'schema_version'`)
    .toArray()[0];
  const current = row ? Number(row.v) : 0;

  if (current > 0 && current < 4) {
    const columns = sql
      .exec<{ name: string }>(`PRAGMA table_info(active_turns)`)
      .toArray();
    if (!columns.some((column) => column.name === "confirmed_output")) {
      sql.exec(
        `ALTER TABLE active_turns ADD COLUMN confirmed_output INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  if (current > 0 && current < 6) {
    const columns = sql
      .exec<{ name: string }>(`PRAGMA table_info(active_turns)`)
      .toArray();
    if (!columns.some((column) => column.name === "effect_token")) {
      sql.exec(`ALTER TABLE active_turns ADD COLUMN effect_token TEXT`);
    }
    if (!columns.some((column) => column.name === "effect_name")) {
      sql.exec(`ALTER TABLE active_turns ADD COLUMN effect_name TEXT`);
    }
  }

  if (current > 0 && current < 7) {
    const columns = sql
      .exec<{ name: string }>(`PRAGMA table_info(active_turns)`)
      .toArray();
    if (!columns.some((column) => column.name === "effect_resource")) {
      sql.exec(`ALTER TABLE active_turns ADD COLUMN effect_resource TEXT`);
    }
  }

  if (current > 0 && current < 8) {
    const activeColumns = sql
      .exec<{ name: string }>(`PRAGMA table_info(active_turns)`)
      .toArray();
    if (!activeColumns.some((column) => column.name === "live_client_msg_id")) {
      sql.exec(`ALTER TABLE active_turns ADD COLUMN live_client_msg_id TEXT`);
    }
    if (!activeColumns.some((column) => column.name === "live_message_ts")) {
      sql.exec(`ALTER TABLE active_turns ADD COLUMN live_message_ts TEXT`);
    }
    if (!activeColumns.some((column) => column.name === "live_message_state")) {
      sql.exec(
        `ALTER TABLE active_turns ADD COLUMN live_message_state TEXT NOT NULL DEFAULT 'unreserved'`,
      );
    }
    const obligationColumns = sql
      .exec<{ name: string }>(`PRAGMA table_info(render_obligations)`)
      .toArray();
    if (!obligationColumns.some((column) => column.name === "live_client_msg_id")) {
      sql.exec(`ALTER TABLE render_obligations ADD COLUMN live_client_msg_id TEXT`);
    }
    if (!obligationColumns.some((column) => column.name === "live_message_ts")) {
      sql.exec(`ALTER TABLE render_obligations ADD COLUMN live_message_ts TEXT`);
    }
    if (!obligationColumns.some((column) => column.name === "live_message_state")) {
      sql.exec(
        `ALTER TABLE render_obligations ADD COLUMN live_message_state TEXT NOT NULL DEFAULT 'unreserved'`,
      );
    }
  }

  // Future migrations: v0 creates the current DDL directly; older durable
  // objects take the explicit branches above before the version is advanced.
  if (current < SCHEMA_VERSION) {
    sql.exec(
      `INSERT INTO _meta (k, v) VALUES ('schema_version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(SCHEMA_VERSION),
    );
  }
}
