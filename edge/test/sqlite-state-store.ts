import { DatabaseSync } from "node:sqlite";
import { SqlStateEngine } from "../src/store/sql-state-engine.js";
import { migrate } from "../src/store/schema.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";
import type { StateStore } from "../src/store/state-store-contract.js";

/**
 * Adapts Node's built-in `node:sqlite` to our {@link SqlExecutor} seam so the
 * exact production {@link SqlStateEngine} can be exercised by the upstream
 * `StateStore` conformance suite without `workerd`. The engine is backend-blind;
 * in production the same calls land on Durable Object SQLite.
 */
function nodeSqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> {
      const stmt = db.prepare(query);
      const params = bindings as Array<string | number | null | bigint>;
      const isSelect = /^\s*select/i.test(query);
      const rows = isSelect ? (stmt.all(...params) as T[]) : (stmt.run(...params), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`expected exactly one row, got ${rows.length}`);
          }
          return rows[0] as T;
        },
      };
    },
  };
}

/**
 * Build an in-process {@link StateStore} over `node:sqlite` that mirrors what
 * {@link import("../src/store/conversation-state-do.js")} does in a Durable
 * Object: engine + JSON (de)serialization + a synchronous transaction runner.
 */
export function makeSqliteStateStore(): { store: StateStore; close: () => void } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeSqliteExecutor(db);
  migrate(sql);

  const engine = new SqlStateEngine({
    sql,
    // BEGIN/COMMIT mirrors transactionSync's rollback-on-throw semantics.
    tx: <T>(fn: () => T): T => {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  });

  const store: StateStore = {
    kv: {
      get: async <T>(key: string) => {
        const raw = engine.kvGet(key);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      },
      set: async <T>(key: string, value: T, ttlMs?: number) => {
        engine.kvSet(key, JSON.stringify(value), ttlMs);
      },
      delete: async (key: string) => engine.kvDelete(key),
    },
    list: {
      append: async <T>(
        key: string,
        value: T,
        opts?: { maxLen?: number; ttlMs?: number },
      ) => engine.listAppend(key, JSON.stringify(value), opts),
      range: async <T>(key: string, start?: number, stop?: number) =>
        engine.listRange(key, start, stop).map((v) => JSON.parse(v) as T),
      trim: async (key: string, maxLen: number) => engine.listTrim(key, maxLen),
      delete: async (key: string) => engine.listDelete(key),
    },
    lock: {
      acquire: async (key: string, opts?: { ttlMs?: number }) =>
        engine.lockAcquire(key, opts?.ttlMs),
      release: async (key: string, token: string) =>
        engine.lockRelease(key, token),
    },
    dedup: {
      seen: async (key: string, ttlMs: number) => engine.dedupSeen(key, ttlMs),
    },
    queue: {
      enqueue: async <T>(
        key: string,
        value: T,
        opts?: { maxSize?: number; onFull?: "drop-oldest" | "drop-newest" },
      ) => engine.queueEnqueue(key, JSON.stringify(value), opts),
      dequeue: async <T>(key: string) => {
        const raw = engine.queueDequeue(key);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      },
      depth: async (key: string) => engine.queueDepth(key),
    },
  };

  return { store, close: () => db.close() };
}
