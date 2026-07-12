/**
 * The narrow slice of Cloudflare's `SqlStorage` interface that the state engine
 * actually uses. Depending on this local shape instead of the full
 * `@cloudflare/workers-types` `SqlStorage` keeps {@link SqlStateEngine}
 * portable: it can run inside a Durable Object in production *and* against a
 * `node:sqlite` shim in unit tests (see `test/`), so the same code is exercised
 * by the upstream `runStateStoreConformance` suite outside `workerd`.
 *
 * Cloudflare's real cursor exposes more (`raw()`, `columnNames`, `rowsRead`,
 * iteration); we only need `toArray()` and `one()`, so that's all we model.
 */
export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

export interface SqlCursor<T> {
  /** Materialize every result row as a plain object keyed by column name. */
  toArray(): T[];
  /** Exactly-one-row accessor; throws if the result set isn't a single row. */
  one(): T;
}

export interface SqlExecutor {
  /**
   * Execute one statement with positional `?` bindings and return a cursor.
   * Synchronous by contract — Durable Object SQLite completes in-thread, which
   * is what lets us compose calls inside `transactionSync`.
   */
  exec<T = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<T>;
}

/**
 * Run `fn` atomically. In a Durable Object this is `ctx.storage.transactionSync`
 * (rolls back on throw); the `node:sqlite` shim wraps it in `BEGIN/COMMIT`.
 * Kept as an injected capability so the engine never references either backend
 * directly.
 */
export type TransactionRunner = <T>(fn: () => T) => T;
