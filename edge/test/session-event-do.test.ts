import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

/**
 * `session-event-do.ts` imports the real `DurableObject` base class from the
 * `cloudflare:workers` built-in module, which only resolves inside `workerd`
 * (the `vitest-pool-workers` suite, e.g. `vitest.workers.bot-store.config.ts`).
 * This suite runs under the plain Node suite (`vitest.config.ts`) instead —
 * same approach `test/engine.test.ts` takes for `SqlStateEngine` — so we stub
 * the module with a minimal base class. `SessionEventDO` only uses `this.ctx`
 * from it, so the stub just needs to stash the constructor args.
 */
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { SessionEventEngine, SessionEventDO } = await import(
  "../src/store/session-event-do.js"
);
type KvExecutor = import("../src/store/session-event-do.js").KvExecutor;
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

/**
 * Adapts `node:sqlite` to the {@link SqlExecutor} seam, same approach as
 * `test/sqlite-state-store.ts` uses for `SqlStateEngine`. Distinguishes
 * row-returning statements by `SELECT` / `RETURNING` so `appendEvent`'s
 * `INSERT ... RETURNING id` gets its row back.
 */
function nodeSqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> {
      const stmt = db.prepare(query);
      const params = bindings as Array<string | number | null | bigint>;
      const returnsRows =
        /^\s*select/i.test(query) || /\breturning\b/i.test(query);
      const rows = returnsRows
        ? (stmt.all(...params) as T[])
        : (stmt.run(...params), []);
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

/** Minimal in-memory shim for the DO KV slots (`ctx.storage.get/put/delete`). */
function memoryKv(): KvExecutor {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.has(key) ? (store.get(key) as T) : undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
  };
}

const EVENTS_DDL = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     execution_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS events_execution ON events(execution_id, id)`,
];

function makeEngine(now?: () => number) {
  const db = new DatabaseSync(":memory:");
  const sql = nodeSqliteExecutor(db);
  for (const stmt of EVENTS_DDL) sql.exec(stmt);
  const engine = new SessionEventEngine({
    sql,
    kv: memoryKv(),
    now,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
  return { engine, close: () => db.close() };
}

describe("SessionEventEngine", () => {
  it("execute() is idempotent by executionId (duplicate on redelivery)", async () => {
    const { engine } = makeEngine();

    const first = await engine.execute({
      executionId: "exec-1",
      inputLines: ["hello", "world"],
    });
    expect(first).toEqual({ accepted: true, duplicate: false });

    // Still marked as executing -> redelivery of the same executionId is a dup.
    const dup = await engine.execute({
      executionId: "exec-1",
      inputLines: ["hello", "world"],
    });
    expect(dup).toEqual({ accepted: false, duplicate: true });

    // Only the original two input events should exist.
    const events = await engine.replay();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "input")).toBe(true);
  });

  it("execute() is still idempotent after the execution finished (input row survives)", async () => {
    const { engine } = makeEngine();
    await engine.execute({ executionId: "exec-2", inputLines: ["a"] });
    await engine.appendEvent({
      executionId: "exec-2",
      kind: "done",
      payload: { ok: true },
    });

    // session:executing is now cleared, but the 'input' row for exec-2 still
    // exists, so a redelivered execute must still be treated as a duplicate.
    const dup = await engine.execute({ executionId: "exec-2", inputLines: ["a"] });
    expect(dup).toEqual({ accepted: false, duplicate: true });
  });

  it("replay(afterEventId) returns only events with id > cursor, ascending", async () => {
    const { engine } = makeEngine();
    await engine.execute({ executionId: "exec-3", inputLines: ["l1", "l2"] });
    await engine.appendEvent({
      executionId: "exec-3",
      kind: "output",
      payload: { text: "chunk-1" },
    });
    await engine.appendEvent({
      executionId: "exec-3",
      kind: "output",
      payload: { text: "chunk-2" },
    });
    await engine.appendEvent({
      executionId: "exec-3",
      kind: "done",
      payload: { ok: true },
    });

    const all = await engine.replay();
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(all.map((e) => e.kind)).toEqual([
      "input",
      "input",
      "output",
      "output",
      "done",
    ]);

    const afterFirstInput = await engine.replay(all[0]!.id);
    expect(afterFirstInput).toHaveLength(4);
    expect(afterFirstInput[0]!.kind).toBe("input");
    expect(afterFirstInput[0]!.payload).toBe("l2");

    const afterAll = await engine.replay(all[4]!.id);
    expect(afterAll).toHaveLength(0);

    // Payload JSON round-trips.
    const outputEvent = all.find((e) => e.kind === "output");
    expect(outputEvent?.payload).toEqual({ text: "chunk-1" });
  });

  it("interrupt() clears session:executing and appends a done event", async () => {
    const { engine } = makeEngine();
    await engine.execute({ executionId: "exec-4", inputLines: ["go"] });

    const before = await engine.getState();
    expect(before.executing?.executionId).toBe("exec-4");
    expect(before.interrupted).toBe(false);

    const result = await engine.interrupt();
    expect(result).toEqual({ interrupted: true });

    const after = await engine.getState();
    expect(after.executing).toBeUndefined();
    expect(after.interrupted).toBe(true);

    const events = await engine.replay();
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent?.executionId).toBe("exec-4");
    expect(doneEvent?.payload).toEqual({ interrupted: true });

    // Interrupting again with nothing running is a no-op.
    const noop = await engine.interrupt();
    expect(noop).toEqual({ interrupted: false });
  });

  it("appendEvent() clears session:executing on 'error' but not on 'output'", async () => {
    const { engine } = makeEngine();
    await engine.execute({ executionId: "exec-5", inputLines: ["go"] });

    await engine.appendEvent({
      executionId: "exec-5",
      kind: "output",
      payload: { text: "partial" },
    });
    expect((await engine.getState()).executing?.executionId).toBe("exec-5");

    await engine.appendEvent({
      executionId: "exec-5",
      kind: "error",
      payload: { message: "boom" },
    });
    expect((await engine.getState()).executing).toBeUndefined();
  });

  it("create() is idempotent for the same harnessType and returns the existing sessionId", async () => {
    const { engine } = makeEngine();
    const first = await engine.create({
      threadKey: "thread-1",
      harnessType: "claude-code",
    });
    expect(first.restarted).toBe(false);

    const second = await engine.create({
      threadKey: "thread-1",
      harnessType: "claude-code",
    });
    expect(second).toEqual({ sessionId: first.sessionId, restarted: false });
  });

  it("create() restarts (wipes events + KV) on harness mismatch", async () => {
    const { engine } = makeEngine();
    const first = await engine.create({
      threadKey: "thread-2",
      harnessType: "claude-code",
    });
    await engine.execute({ executionId: "exec-6", inputLines: ["hi"] });
    expect(await engine.replay()).toHaveLength(1);

    const restarted = await engine.create({
      threadKey: "thread-2",
      harnessType: "codex",
    });
    expect(restarted.restarted).toBe(true);
    expect(restarted.sessionId).not.toBe(first.sessionId);

    // Event log and executing/interrupted slots are wiped.
    expect(await engine.replay()).toHaveLength(0);
    const state = await engine.getState();
    expect(state.sessionId).toBe(restarted.sessionId);
    expect(state.executing).toBeUndefined();
    expect(state.interrupted).toBe(false);

    // A redelivery of the old execute() is no longer treated as a duplicate
    // since its input row was wiped.
    const reExecute = await engine.execute({
      executionId: "exec-6",
      inputLines: ["hi"],
    });
    expect(reExecute).toEqual({ accepted: true, duplicate: false });
  });
});

/** Minimal fake `DurableObjectState` — just enough of `ctx.storage` for `SessionEventDO`. */
function makeFakeCtx(sql: SqlExecutor): {
  storage: { sql: SqlExecutor } & KvExecutor;
  blockConcurrencyWhile: (fn: () => Promise<unknown>) => Promise<unknown>;
} {
  const kvStore = new Map<string, unknown>();
  return {
    storage: {
      sql,
      async get<T>(key: string): Promise<T | undefined> {
        return kvStore.has(key) ? (kvStore.get(key) as T) : undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        kvStore.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return kvStore.delete(key);
      },
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
}

describe("SessionEventDO (RPC wrapper smoke test)", () => {
  it("delegates create/execute/replay/interrupt through to the engine", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = nodeSqliteExecutor(db);
    const ctx = makeFakeCtx(sql);
    // Migration runs inside the constructor's blockConcurrencyWhile.
    const doInstance = new SessionEventDO(ctx as never, {} as never);

    const created = await doInstance.create({
      threadKey: "thread-do-1",
      harnessType: "claude-code",
    });
    expect(created.restarted).toBe(false);

    const executed = await doInstance.execute({
      executionId: "do-exec-1",
      inputLines: ["do it"],
    });
    expect(executed).toEqual({ accepted: true, duplicate: false });

    const dup = await doInstance.execute({
      executionId: "do-exec-1",
      inputLines: ["do it"],
    });
    expect(dup).toEqual({ accepted: false, duplicate: true });

    await doInstance.appendEvent({
      executionId: "do-exec-1",
      kind: "output",
      payload: { text: "hi" },
    });

    const events = await doInstance.replay();
    expect(events.map((e) => e.kind)).toEqual(["input", "output"]);

    const interrupted = await doInstance.interrupt();
    expect(interrupted).toEqual({ interrupted: true });

    const state = await doInstance.getState();
    expect(state.sessionId).toBe(created.sessionId);
    expect(state.executing).toBeUndefined();
    expect(state.interrupted).toBe(true);

    db.close();
  });
});
