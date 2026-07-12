import type { SqlExecutor } from "./sql.js";

/**
 * Schema version for the bot state tables. Bump when the DDL below changes and
 * add a migration branch in {@link migrate}. The current version is recorded in
 * the `_meta` table so a Durable Object that was created on an older schema can
 * upgrade in place on its next constructor run.
 */
export const SCHEMA_VERSION = 1;

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

  // Future migrations: `if (current < 2) { ...; }` etc. v0 → v1 is just the DDL.
  if (current < SCHEMA_VERSION) {
    sql.exec(
      `INSERT INTO _meta (k, v) VALUES ('schema_version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(SCHEMA_VERSION),
    );
  }
}
