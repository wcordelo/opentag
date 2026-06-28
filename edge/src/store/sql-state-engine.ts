import type { SqlExecutor, TransactionRunner } from "./sql.js";

/**
 * Default lock auto-expiry, matching `@copilotkit/bot`'s `MemoryStore`: a
 * crashed holder can't deadlock a key forever.
 */
const DEFAULT_LOCK_TTL_MS = 30_000;

export interface EngineDeps {
  sql: SqlExecutor;
  /** Atomic wrapper — `ctx.storage.transactionSync` in a DO. */
  tx: TransactionRunner;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable token source for locks. Defaults to `crypto.randomUUID`. */
  newToken?: () => string;
}

/**
 * The actual SQLite implementation of the `StateStore` contract, expressed as
 * **synchronous** methods over a {@link SqlExecutor}. Synchronous is deliberate:
 * Durable Object SQLite returns in-thread, so multi-statement operations
 * (lock acquire, dedup, queue eviction) can be wrapped in a single
 * `transactionSync` and observed atomically. The async `StateStore` surface is
 * layered on top by the Durable Object / RPC adapter.
 *
 * Values are JSON **strings** here; (de)serialization lives one layer up so this
 * file is purely SQL + TTL bookkeeping.
 */
export class SqlStateEngine {
  private readonly sql: SqlExecutor;
  private readonly tx: TransactionRunner;
  private readonly now: () => number;
  private readonly newToken: () => string;

  constructor(deps: EngineDeps) {
    this.sql = deps.sql;
    this.tx = deps.tx;
    this.now = deps.now ?? (() => Date.now());
    this.newToken = deps.newToken ?? (() => crypto.randomUUID());
  }

  // ── kv ────────────────────────────────────────────────────────────────────

  kvGet(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string; expires_at: number | null }>(
        `SELECT value, expires_at FROM kv WHERE key = ?`,
        key,
      )
      .toArray()[0];
    if (!row) return undefined;
    if (this.expired(row.expires_at)) {
      this.sql.exec(`DELETE FROM kv WHERE key = ?`, key);
      return undefined;
    }
    return row.value;
  }

  kvSet(key: string, value: string, ttlMs?: number): void {
    this.sql.exec(
      `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key,
      value,
      this.expiresAt(ttlMs),
    );
  }

  kvDelete(key: string): void {
    this.sql.exec(`DELETE FROM kv WHERE key = ?`, key);
  }

  // ── list ────────────────────────────────────────────────────────────────

  listAppend(
    key: string,
    value: string,
    opts?: { maxLen?: number; ttlMs?: number },
  ): number {
    return this.tx(() => {
      if (this.listExpired(key)) this.clearList(key);

      // Per-key monotonic sequence. Contiguity isn't required — ordering and
      // "keep newest N" are both expressed against `seq` directly.
      const maxSeq =
        this.sql
          .exec<{ s: number | null }>(
            `SELECT MAX(seq) AS s FROM list_items WHERE key = ?`,
            key,
          )
          .one().s ?? 0;
      this.sql.exec(
        `INSERT INTO list_items (key, seq, value) VALUES (?, ?, ?)`,
        key,
        maxSeq + 1,
        value,
      );

      // (Re)set whole-list expiry only when a ttl is supplied; otherwise create
      // the meta row if missing but preserve any existing expiry.
      if (opts?.ttlMs !== undefined) {
        this.sql.exec(
          `INSERT INTO list_meta (key, expires_at) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`,
          key,
          this.expiresAt(opts.ttlMs),
        );
      } else {
        this.sql.exec(
          `INSERT OR IGNORE INTO list_meta (key, expires_at) VALUES (?, NULL)`,
          key,
        );
      }

      if (opts?.maxLen !== undefined) this.keepNewest(key, opts.maxLen);

      return this.listLen(key);
    });
  }

  listRange(key: string, start = 0, stop?: number): string[] {
    if (this.listExpired(key)) {
      this.clearList(key);
      return [];
    }
    // `stop` is an inclusive index; translate to LIMIT/OFFSET. LIMIT -1 = "all".
    const limit = stop === undefined ? -1 : Math.max(0, stop - start + 1);
    return this.sql
      .exec<{ value: string }>(
        `SELECT value FROM list_items WHERE key = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
        key,
        limit,
        Math.max(0, start),
      )
      .toArray()
      .map((r) => r.value);
  }

  listTrim(key: string, maxLen: number): void {
    this.tx(() => {
      if (this.listExpired(key)) {
        this.clearList(key);
        return;
      }
      this.keepNewest(key, maxLen);
    });
  }

  listDelete(key: string): void {
    this.clearList(key);
  }

  // ── lock ────────────────────────────────────────────────────────────────

  lockAcquire(key: string, ttlMs?: number): { token: string } | null {
    return this.tx(() => {
      const cur = this.sql
        .exec<{ expires_at: number }>(
          `SELECT expires_at FROM locks WHERE key = ?`,
          key,
        )
        .toArray()[0];
      if (cur && !this.expired(cur.expires_at)) return null; // still held

      const token = this.newToken();
      this.sql.exec(
        `INSERT INTO locks (key, token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
        key,
        token,
        this.now() + (ttlMs ?? DEFAULT_LOCK_TTL_MS),
      );
      return { token };
    });
  }

  lockRelease(key: string, token: string): void {
    // Token-scoped: a stale token must never free a lock re-acquired by someone
    // else after expiry.
    this.sql.exec(
      `DELETE FROM locks WHERE key = ? AND token = ?`,
      key,
      token,
    );
  }

  // ── dedup ─────────────────────────────────────────────────────────────────

  dedupSeen(key: string, ttlMs: number): boolean {
    return this.tx(() => {
      const cur = this.sql
        .exec<{ expires_at: number }>(
          `SELECT expires_at FROM dedup WHERE key = ?`,
          key,
        )
        .toArray()[0];
      if (cur && !this.expired(cur.expires_at)) return true;
      this.sql.exec(
        `INSERT INTO dedup (key, expires_at) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`,
        key,
        this.now() + ttlMs,
      );
      return false;
    });
  }

  // ── queue ──────────────────────────────────────────────────────────────────

  queueEnqueue(
    key: string,
    value: string,
    opts?: { maxSize?: number; onFull?: "drop-oldest" | "drop-newest" },
  ): number {
    return this.tx(() => {
      const depth = this.queueDepth(key);
      if (opts?.maxSize !== undefined && depth >= opts.maxSize) {
        if ((opts.onFull ?? "drop-oldest") === "drop-newest") return depth; // reject incoming
        // drop-oldest: evict the head before inserting.
        this.sql.exec(
          `DELETE FROM queue WHERE key = ? AND seq = (SELECT MIN(seq) FROM queue WHERE key = ?)`,
          key,
          key,
        );
      }
      const maxSeq =
        this.sql
          .exec<{ s: number | null }>(
            `SELECT MAX(seq) AS s FROM queue WHERE key = ?`,
            key,
          )
          .one().s ?? 0;
      this.sql.exec(
        `INSERT INTO queue (key, seq, value) VALUES (?, ?, ?)`,
        key,
        maxSeq + 1,
        value,
      );
      return this.queueDepth(key);
    });
  }

  queueDequeue(key: string): string | undefined {
    return this.tx(() => {
      const row = this.sql
        .exec<{ seq: number; value: string }>(
          `SELECT seq, value FROM queue WHERE key = ? ORDER BY seq ASC LIMIT 1`,
          key,
        )
        .toArray()[0];
      if (!row) return undefined;
      this.sql.exec(`DELETE FROM queue WHERE key = ? AND seq = ?`, key, row.seq);
      return row.value;
    });
  }

  queueDepth(key: string): number {
    return this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM queue WHERE key = ?`, key)
      .one().n;
  }

  // ── maintenance ─────────────────────────────────────────────────────────

  /**
   * Delete expired rows across every namespace. Cheap (indexed on `expires_at`)
   * and idempotent — drive it from a Durable Object alarm so abandoned keys
   * don't accumulate.
   */
  sweepExpired(): void {
    const now = this.now();
    this.tx(() => {
      this.sql.exec(
        `DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?`,
        now,
      );
      this.sql.exec(`DELETE FROM locks WHERE expires_at < ?`, now);
      this.sql.exec(`DELETE FROM dedup WHERE expires_at < ?`, now);
      // Expired lists: drop items + meta in one pass.
      const dead = this.sql
        .exec<{ key: string }>(
          `SELECT key FROM list_meta WHERE expires_at IS NOT NULL AND expires_at < ?`,
          now,
        )
        .toArray();
      for (const { key } of dead) this.clearList(key);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Expired iff a TTL is set and strictly in the past (live at exact equality). */
  private expired(expiresAt: number | null): boolean {
    return expiresAt !== null && expiresAt < this.now();
  }

  private expiresAt(ttlMs?: number): number | null {
    return ttlMs === undefined ? null : this.now() + ttlMs;
  }

  private listExpired(key: string): boolean {
    const meta = this.sql
      .exec<{ expires_at: number | null }>(
        `SELECT expires_at FROM list_meta WHERE key = ?`,
        key,
      )
      .toArray()[0];
    return !!meta && this.expired(meta.expires_at);
  }

  private clearList(key: string): void {
    this.sql.exec(`DELETE FROM list_items WHERE key = ?`, key);
    this.sql.exec(`DELETE FROM list_meta WHERE key = ?`, key);
  }

  private listLen(key: string): number {
    return this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM list_items WHERE key = ?`,
        key,
      )
      .one().n;
  }

  /** Keep only the newest `maxLen` items for `key` (drops the oldest). */
  private keepNewest(key: string, maxLen: number): void {
    this.sql.exec(
      `DELETE FROM list_items
         WHERE key = ?
           AND seq NOT IN (
             SELECT seq FROM list_items WHERE key = ? ORDER BY seq DESC LIMIT ?
           )`,
      key,
      key,
      Math.max(0, maxLen),
    );
  }
}
