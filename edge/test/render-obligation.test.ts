import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * `conversation-state-do.ts` imports the real `DurableObject` base class from
 * the `cloudflare:workers` built-in module, which only resolves inside
 * `workerd`. This suite runs under the plain Node suite instead — same
 * approach `test/session-event-do.test.ts` takes — so we stub the module
 * with a minimal base class that just stashes the constructor args.
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

const { ConversationStateDO, RenderObligationEngine, reconstructMarkdown } =
  await import("../src/store/conversation-state-do.js");
import { migrate } from "../src/store/schema.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

/**
 * Adapts `node:sqlite` to the {@link SqlExecutor} seam, mirroring
 * `test/sqlite-state-store.ts` / `test/session-event-do.test.ts`.
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

// ── RenderObligationEngine (pure SQL, node:sqlite) ─────────────────────────

function makeEngine(now?: () => number) {
  const db = new DatabaseSync(":memory:");
  const sql = nodeSqliteExecutor(db);
  migrate(sql);
  const engine = new RenderObligationEngine({ sql, now });
  return { engine, close: () => db.close() };
}

describe("RenderObligationEngine", () => {
  it("set()/get() round-trip; clear() removes it", () => {
    const { engine } = makeEngine(() => 1_000);
    engine.set({
      threadKey: "t1",
      executionId: "exec-1",
      afterEventId: 5,
      channel: "C1",
      threadTs: "1.0",
      timeoutMs: 60_000,
    });

    const row = engine.get("t1");
    expect(row).toEqual({
      threadKey: "t1",
      executionId: "exec-1",
      afterEventId: 5,
      channel: "C1",
      threadTs: "1.0",
      deadline: 61_000,
      attempt: 0,
    });

    engine.clear({ threadKey: "t1" });
    expect(engine.get("t1")).toBeUndefined();
  });

  it("set() upserts by threadKey — a newer write replaces the older one", () => {
    const { engine } = makeEngine(() => 1_000);
    engine.set({
      threadKey: "t1",
      executionId: "exec-1",
      afterEventId: 1,
      channel: "C1",
    });
    engine.set({
      threadKey: "t1",
      executionId: "exec-2",
      afterEventId: 2,
      channel: "C1",
    });

    const row = engine.get("t1");
    expect(row?.executionId).toBe("exec-2");
    expect(row?.afterEventId).toBe(2);
  });

  it("clear(executionId) only deletes a matching row — a newer turn's obligation survives", () => {
    const { engine } = makeEngine();
    engine.set({
      threadKey: "t1",
      executionId: "exec-old",
      afterEventId: 1,
      channel: "C1",
    });
    // A stale clear for a superseded executionId...
    engine.clear({ threadKey: "t1", executionId: "exec-stale-does-not-match" });
    // ...must not remove the current row.
    expect(engine.get("t1")?.executionId).toBe("exec-old");

    engine.clear({ threadKey: "t1", executionId: "exec-old" });
    expect(engine.get("t1")).toBeUndefined();
  });

  it("due() returns rows with deadline <= now, ascending", () => {
    const { engine } = makeEngine(() => 0);
    engine.set({ threadKey: "a", executionId: "e-a", afterEventId: 0, channel: "C", timeoutMs: 300 });
    engine.set({ threadKey: "b", executionId: "e-b", afterEventId: 0, channel: "C", timeoutMs: 100 });
    engine.set({ threadKey: "c", executionId: "e-c", afterEventId: 0, channel: "C", timeoutMs: 200 });

    expect(engine.due(50)).toHaveLength(0);
    const due = engine.due(250);
    expect(due.map((r) => r.threadKey)).toEqual(["b", "c"]);
  });

  it("earliestDeadline() is undefined when empty, MIN(deadline) otherwise", () => {
    const { engine } = makeEngine(() => 0);
    expect(engine.earliestDeadline()).toBeUndefined();
    engine.set({ threadKey: "a", executionId: "e", afterEventId: 0, channel: "C", timeoutMs: 500 });
    engine.set({ threadKey: "b", executionId: "e2", afterEventId: 0, channel: "C", timeoutMs: 100 });
    expect(engine.earliestDeadline()).toBe(100);
  });

  it("reinsertForRetry() bumps attempt + deadline, and is guarded against clobbering a newer obligation", () => {
    let clock = 0;
    const { engine } = makeEngine(() => clock);
    engine.set({ threadKey: "t1", executionId: "exec-1", afterEventId: 3, channel: "C1" });
    const row = engine.get("t1")!;

    clock = 10;
    engine.reinsertForRetry(row, 60_000);
    const retried = engine.get("t1")!;
    expect(retried.attempt).toBe(1);
    expect(retried.deadline).toBe(10 + 60_000);
    expect(retried.executionId).toBe("exec-1");

    // A newer turn now claims the thread_key with a different executionId...
    engine.set({ threadKey: "t1", executionId: "exec-2", afterEventId: 9, channel: "C1" });
    // ...a stale retry-reinsert of the OLD row must not clobber it.
    engine.reinsertForRetry(row, 60_000);
    expect(engine.get("t1")?.executionId).toBe("exec-2");
  });
});

describe("reconstructMarkdown", () => {
  it("concatenates 'output' events with string or {text} payloads, ignoring other kinds", () => {
    const text = reconstructMarkdown([
      { kind: "input", payload: "ignored" },
      { kind: "output", payload: "Hello " },
      { kind: "output", payload: { text: "world" } },
      { kind: "error", payload: { text: "ignored too" } },
      { kind: "output", payload: { markdown: "!" } },
    ]);
    expect(text).toBe("Hello world!");
  });

  it("returns an empty string when there is nothing to reconstruct", () => {
    expect(reconstructMarkdown([])).toBe("");
    expect(reconstructMarkdown([{ kind: "input", payload: "x" }])).toBe("");
  });
});

// ── ConversationStateDO alarm behavior (mocked cloudflare:workers) ─────────

/** Minimal fake `DurableObjectState` — enough of `ctx.storage` for the DO under test. */
function makeFakeCtx(sql: SqlExecutor): {
  storage: {
    sql: SqlExecutor;
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
    transactionSync<T>(fn: () => T): T;
  };
  blockConcurrencyWhile: (fn: () => Promise<unknown>) => Promise<unknown>;
  currentAlarm: () => number | null;
} {
  const kvStore = new Map<string, unknown>();
  let alarmAt: number | null = null;
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
      async getAlarm(): Promise<number | null> {
        return alarmAt;
      },
      async setAlarm(time: number): Promise<void> {
        alarmAt = time;
      },
      transactionSync<T>(fn: () => T): T {
        return fn();
      },
    },
    blockConcurrencyWhile: (fn) => fn(),
    currentAlarm: () => alarmAt,
  };
}

type ReplayEvent = {
  id: number;
  executionId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
};

/** Fake `env.SESSION_EVENTS` namespace — routes by the `idFromName` string. */
function makeFakeSessionEvents(opts: {
  eventsByThread?: Map<string, ReplayEvent[]>;
  interruptedThreads?: Set<string>;
}) {
  const eventsByThread = opts.eventsByThread ?? new Map<string, ReplayEvent[]>();
  const interruptedThreads = opts.interruptedThreads ?? new Set<string>();
  return {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { name: string }) => ({
      getState: async () => ({
        interrupted: interruptedThreads.has(id.name),
      }),
      replay: async (afterEventId?: number) => {
        const events = eventsByThread.get(id.name) ?? [];
        return events.filter((e) => e.id > (afterEventId ?? 0));
      },
    }),
  };
}

function makeDo(env: Record<string, unknown>) {
  const db = new DatabaseSync(":memory:");
  const sql = nodeSqliteExecutor(db);
  const ctx = makeFakeCtx(sql);
  const doInstance = new ConversationStateDO(ctx as never, env as never);
  return { doInstance, ctx, close: () => db.close() };
}

describe("ConversationStateDO render obligations", () => {
  const origFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("set -> clear -> alarm is a no-op (nothing posted)", async () => {
    const { doInstance, close } = makeDo({ SLACK_BOT_TOKEN: "xoxb-test" });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C1:1.0",
        executionId: "exec-1",
        afterEventId: 0,
        channel: "C1",
        threadTs: "1.0",
        timeoutMs: -1000, // already "due" if it survives
      });
      await doInstance.obligationClear({
        threadKey: "slack:C1:1.0",
        executionId: "exec-1",
      });

      await doInstance.alarm();

      expect(fetchCalls).toHaveLength(0);
      expect(
        await doInstance.obligationGet({ threadKey: "slack:C1:1.0" }),
      ).toBeUndefined();
    } finally {
      close();
    }
  });

  it("set -> alarm due -> reconstructed fallback posted, obligation cleared", async () => {
    const eventsByThread = new Map<string, ReplayEvent[]>([
      [
        "slack:C1:1.0",
        [
          { id: 1, executionId: "exec-1", kind: "output", payload: "final ", createdAt: 1 },
          { id: 2, executionId: "exec-1", kind: "output", payload: { text: "answer" }, createdAt: 2 },
        ],
      ],
    ]);
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({ eventsByThread }),
    });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C1:1.0",
        executionId: "exec-1",
        afterEventId: 0,
        channel: "C1",
        threadTs: "1.0",
        timeoutMs: -1000,
      });

      await doInstance.alarm();

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]!.url).toContain("chat.postMessage");
      const body = fetchCalls[0]!.body as { channel: string; thread_ts: string; text: string };
      expect(body.channel).toBe("C1");
      expect(body.thread_ts).toBe("1.0");
      expect(body.text).toContain("final answer");
      expect(body.text).toContain("Recovered after an interrupted turn");

      expect(
        await doInstance.obligationGet({ threadKey: "slack:C1:1.0" }),
      ).toBeUndefined();
    } finally {
      close();
    }
  });

  it("replay-empty -> generic error card posted", async () => {
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({}), // no events for any thread
    });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C2:2.0",
        executionId: "exec-2",
        afterEventId: 0,
        channel: "C2",
        threadTs: "2.0",
        timeoutMs: -1000,
      });

      await doInstance.alarm();

      expect(fetchCalls).toHaveLength(1);
      const body = fetchCalls[0]!.body as { text: string };
      expect(body.text).toContain("interrupted before an answer could be delivered");
    } finally {
      close();
    }
  });

  it("interrupted session -> silent clear (nothing posted)", async () => {
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({
        interruptedThreads: new Set(["slack:C3:3.0"]),
      }),
    });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C3:3.0",
        executionId: "exec-3",
        afterEventId: 0,
        channel: "C3",
        threadTs: "3.0",
        timeoutMs: -1000,
      });

      await doInstance.alarm();

      expect(fetchCalls).toHaveLength(0);
      expect(
        await doInstance.obligationGet({ threadKey: "slack:C3:3.0" }),
      ).toBeUndefined();
    } finally {
      close();
    }
  });

  it("second alarm run does not double-post", async () => {
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({}),
    });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C4:4.0",
        executionId: "exec-4",
        afterEventId: 0,
        channel: "C4",
        timeoutMs: -1000,
      });

      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(1);

      // A second alarm fire (e.g. a redundant wake) must find nothing due.
      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("alarm reschedules for the next sweep after serving all due obligations", async () => {
    const { doInstance, ctx, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({}),
    });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C5:5.0",
        executionId: "exec-5",
        afterEventId: 0,
        channel: "C5",
        timeoutMs: -1000,
      });

      const before = Date.now();
      await doInstance.alarm();
      const after = Date.now();

      // No obligations remain, so the alarm must be rescheduled to roughly
      // "now + 1h" (the sweep interval), not left dangling on the served
      // obligation's stale deadline.
      const scheduled = ctx.currentAlarm();
      expect(scheduled).not.toBeNull();
      expect(scheduled!).toBeGreaterThanOrEqual(before + 59 * 60_000);
      expect(scheduled!).toBeLessThanOrEqual(after + 60 * 60_000 + 1000);
    } finally {
      close();
    }
  });

  it("missing SLACK_BOT_TOKEN logs and drops (never throws)", async () => {
    const { doInstance, close } = makeDo({
      SESSION_EVENTS: makeFakeSessionEvents({}),
    });
    try {
      await doInstance.obligationSet({
        threadKey: "slack:C6:6.0",
        executionId: "exec-6",
        afterEventId: 0,
        channel: "C6",
        timeoutMs: -1000,
      });

      await expect(doInstance.alarm()).resolves.toBeUndefined();
      expect(fetchCalls).toHaveLength(0);
    } finally {
      close();
    }
  });
});
