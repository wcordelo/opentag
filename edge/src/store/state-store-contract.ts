/**
 * The `StateStore` contract, mirrored verbatim from `@copilotkit/bot`
 * (`src/state/state-store.ts`).
 *
 * We keep a local copy so this Worker package type-checks standalone before the
 * `@copilotkit/bot` packages publish to npm. Because TypeScript is structural,
 * a {@link DurableObjectStateStore} that satisfies *this* interface is also
 * assignable to `createBot({ store: { adapter } })`'s `StateStore` — no cast
 * needed once the real package is installed. Keep this in sync with upstream.
 *
 * JSON-serialization contract: all values round-trip through `JSON.stringify` /
 * `JSON.parse` on remote backends, so `T` must be JSON-serializable.
 */
export interface StateStore {
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
    delete(key: string): Promise<void>;
  };
  list: {
    append<T>(
      key: string,
      value: T,
      opts?: { maxLen?: number; ttlMs?: number },
    ): Promise<number>;
    range<T>(key: string, start?: number, stop?: number): Promise<T[]>;
    trim(key: string, maxLen: number): Promise<void>;
    delete(key: string): Promise<void>;
  };
  lock: {
    acquire(
      key: string,
      opts?: { ttlMs?: number },
    ): Promise<{ token: string } | null>;
    release(key: string, token: string): Promise<void>;
  };
  dedup: {
    seen(key: string, ttlMs: number): Promise<boolean>;
  };
  queue: {
    enqueue<T>(
      key: string,
      value: T,
      opts?: { maxSize?: number; onFull?: "drop-oldest" | "drop-newest" },
    ): Promise<number>;
    dequeue<T>(key: string): Promise<T | undefined>;
    depth(key: string): Promise<number>;
  };
}
