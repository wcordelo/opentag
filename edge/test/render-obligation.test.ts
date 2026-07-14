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

  it("reinsertForDefer() preserves the finite rejection-attempt budget", () => {
    let clock = 0;
    const { engine } = makeEngine(() => clock);
    engine.set({ threadKey: "t1", executionId: "exec-1", afterEventId: 3, channel: "C1" });
    const original = engine.get("t1")!;

    for (let n = 0; n < 5; n += 1) {
      const due = engine.get("t1")!;
      engine.delete(due.threadKey, due.executionId);
      clock += 120_000;
      engine.reinsertForDefer(due, 120_000);
      expect(engine.get("t1")?.attempt).toBe(original.attempt);
    }
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
  interruptedByThread?: Map<string, string>;
  executingByThread?: Map<string, string>;
  sessionIdByThread?: Map<string, string>;
  controlLog?: string[];
}) {
  const eventsByThread = opts.eventsByThread ?? new Map<string, ReplayEvent[]>();
  const interruptedThreads = opts.interruptedThreads ?? new Set<string>();
  const interruptedByThread = opts.interruptedByThread ?? new Map<string, string>();
  const executingByThread = opts.executingByThread ?? new Map<string, string>();
  const sessionIdByThread = opts.sessionIdByThread ?? new Map<string, string>();
  return {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { name: string }) => ({
      getState: async () => ({
        ...(sessionIdByThread.has(id.name)
          ? { sessionId: sessionIdByThread.get(id.name) }
          : {}),
        interrupted: interruptedThreads.has(id.name),
        ...(interruptedByThread.has(id.name)
          ? { interruptedExecutionId: interruptedByThread.get(id.name) }
          : {}),
        ...(executingByThread.has(id.name)
          ? { executing: { executionId: executingByThread.get(id.name)!, startedAt: 1 } }
          : {}),
      }),
      replay: async (afterEventId?: number) => {
        const events = eventsByThread.get(id.name) ?? [];
        return events.filter((e) => e.id > (afterEventId ?? 0));
      },
      interruptExpected: async (executionId: string) => {
        opts.controlLog?.push(`session:${executionId}`);
        interruptedByThread.set(id.name, executionId);
        return { interrupted: true, cancelled: true as const };
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
  let fetchCalls: Array<{ url: string; body: unknown; rawBody?: string; contentType?: string }>;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = init?.body ? String(init.body) : undefined;
      const contentType = new Headers(init?.headers).get("Content-Type") ?? undefined;
      const body = rawBody
        ? contentType?.startsWith("application/x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(rawBody))
          : JSON.parse(rawBody)
        : undefined;
      fetchCalls.push({
        url: String(url),
        body,
        rawBody,
        contentType,
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

  it("durably resumes Stop through exact session+harness quiescence before form-encoded Slack ack", async () => {
    const controlLog: string[] = [];
    const threadKey = "slack:CSTOP:10.0";
    let slackAttempts = 0;
    const clientMessageIds: string[] = [];
    const sessionEvents = makeFakeSessionEvents({
      sessionIdByThread: new Map([[threadKey, "session-exact"]]),
      controlLog,
    });
    const harness = {
      fetch: async (_url: string, init?: RequestInit) => {
        controlLog.push(`harness:${JSON.parse(String(init?.body)).executionId}`);
        return new Response(JSON.stringify({ interrupted: true }), { status: 200 });
      },
    };
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      slackAttempts += 1;
      expect(new Headers(init?.headers).get("Content-Type"))
        .toBe("application/x-www-form-urlencoded;charset=UTF-8");
      const form = new URLSearchParams(String(init?.body));
      clientMessageIds.push(form.get("client_msg_id") ?? "");
      expect(form.get("thread_ts")).toBe("10.0");
      controlLog.push(`slack:${form.get("channel")}`);
      if (slackAttempts === 1) throw new Error("ambiguous transport");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: sessionEvents,
      HARNESS: harness,
      HARNESS_AUTH_TOKEN: "harness-secret",
    });
    try {
      const record = {
        channelId: "CSTOP",
        threadKey,
        conversationKey: "CSTOP::10.0",
        executionId: "exec-stop",
        threadTs: "10.0",
        registeredAt: 1,
      };
      expect(await doInstance.activeTurnRegister(record)).toMatchObject({ accepted: true });
      expect(await doInstance.activeTurnClaimCancellation({
        threadKey,
        executionId: record.executionId,
        stopEventId: "EvDurableStop",
      })).toBe("claimed");

      await doInstance.alarm();
      expect(controlLog).toEqual([
        "session:exec-stop",
        "harness:exec-stop",
        "slack:CSTOP",
      ]);
      expect((await doInstance.activeTurnGet({ threadKey }))?.status)
        .toBe("cancel_ack_in_flight");

      await doInstance.alarm();
      expect(controlLog).toEqual([
        "session:exec-stop",
        "harness:exec-stop",
        "slack:CSTOP",
        "slack:CSTOP",
      ]);
      expect(await doInstance.activeTurnGet({ threadKey })).toBeUndefined();
      expect(clientMessageIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(clientMessageIds[1]).toBe(clientMessageIds[0]);
    } finally {
      close();
    }
  });

  it("keeps a session-backed Stop retryable when harness control is unconfigured", async () => {
    const threadKey = "slack:CSTOP:missing-harness";
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({
        sessionIdByThread: new Map([[threadKey, "session-needs-harness"]]),
      }),
    });
    try {
      const record = {
        channelId: "CSTOP",
        threadKey,
        conversationKey: "CSTOP::missing-harness",
        executionId: "exec-needs-harness",
        registeredAt: 1,
      };
      await doInstance.activeTurnRegister(record);
      await doInstance.activeTurnClaimCancellation({
        threadKey,
        executionId: record.executionId,
        stopEventId: "EvNeedsHarness",
      });
      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(0);
      expect(await doInstance.activeTurnGet({ threadKey })).toMatchObject({
        status: "cancelled",
        stopEventId: "EvNeedsHarness",
      });
    } finally {
      close();
    }
  });

  it("cancels a persisted exact research resource to quiescence before Stop ack", async () => {
    const threadKey = "slack:CSTOP:research";
    const order: string[] = [];
    const sessionEvents = makeFakeSessionEvents({ controlLog: order });
    const research = {
      fetch: async (url: string, init?: RequestInit) => {
        order.push("research");
        expect(url).toContain("/internal/tasks/task-exact/cancel");
        expect(new Headers(init?.headers).get("Authorization"))
          .toBe("Bearer internal-secret");
        expect(JSON.parse(String(init?.body))).toEqual({
          teamId: "team-exact",
          threadKey,
        });
        return Response.json({
          cancelled: true,
          quiescent: true,
          taskId: "task-exact",
        });
      },
    };
    globalThis.fetch = (async () => {
      order.push("slack");
      return Response.json({ ok: true });
    }) as typeof fetch;
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: sessionEvents,
      RESEARCH_TASKS: research,
      INTERNAL_SECRET: "internal-secret",
    });
    try {
      const record = {
        channelId: "CSTOP",
        threadKey,
        conversationKey: "CSTOP::research",
        executionId: "exec-research",
        registeredAt: 1,
      };
      await doInstance.activeTurnRegister(record);
      const effect = await doInstance.activeTurnBeginEffect({
        threadKey,
        executionId: record.executionId,
        effectName: "start_task",
      });
      if (effect.status !== "claimed") throw new Error("effect not claimed");
      await doInstance.activeTurnConfirmEffect({
        threadKey,
        executionId: record.executionId,
        token: effect.token,
        resource: {
          kind: "research_task",
          teamId: "team-exact",
          taskId: "task-exact",
          threadKey,
        },
      });
      await doInstance.activeTurnClaimCancellation({
        threadKey,
        executionId: record.executionId,
        stopEventId: "EvResearchStop",
      });
      await doInstance.alarm();
      expect(order).toEqual(["session:exec-research", "research", "slack"]);
      expect(await doInstance.activeTurnGet({ threadKey })).toBeUndefined();
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
      expect(fetchCalls[0]!.contentType)
        .toBe("application/x-www-form-urlencoded;charset=UTF-8");
      expect(fetchCalls[0]!.rawBody).toContain("thread_ts=1.0");

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
        interruptedByThread: new Map([["slack:C3:3.0", "exec-3"]]),
        // A later turn may already be running in the same session DO. The
        // exact old tombstone remains authoritative for this old obligation.
        executingByThread: new Map([["slack:C3:3.0", "exec-new"]]),
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

  it("rearms an ambiguous render beyond three alarms, then reconciles idempotently exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({}),
    });
    const ambiguousCalls: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      ambiguousCalls.push(Object.fromEntries(
        new URLSearchParams(String(init?.body ?? "")),
      ));
      call += 1;
      if (call === 1) throw new TypeError("connection reset after dispatch");
      // Slack confirms the first client_msg_id was already applied.
      return Response.json({ ok: false, error: "duplicate_client_msg_id" });
    }) as typeof fetch;
    try {
      const active = {
        channelId: "C-ambiguous",
        threadKey: "slack:C-ambiguous:1.0",
        conversationKey: "C-ambiguous::1.0",
        executionId: "exec-ambiguous",
        threadTs: "1.0",
        registeredAt: Date.now(),
      };
      await doInstance.activeTurnRegister(active);
      await doInstance.obligationSet({
        threadKey: active.threadKey,
        executionId: active.executionId,
        afterEventId: 0,
        channel: active.channelId,
        threadTs: active.threadTs,
        timeoutMs: -1,
      });

      await doInstance.alarm();
      expect(ambiguousCalls).toHaveLength(1);
      let row = await doInstance.obligationGet({ threadKey: active.threadKey });
      expect(row?.attempt).toBe(0);
      const snapshot = await doInstance.activeTurnGet({ threadKey: active.threadKey });
      expect(snapshot?.renderToken).toBeDefined();

      // The retained render token fences four subsequent alarms. These are
      // deferrals, not definitive Slack failures, so attempt remains zero.
      for (let n = 0; n < 4; n += 1) {
        vi.advanceTimersByTime(2 * 60_000 + 1);
        await doInstance.alarm();
        row = await doInstance.obligationGet({ threadKey: active.threadKey });
        expect(row?.attempt).toBe(0);
      }
      expect(ambiguousCalls).toHaveLength(1);

      await doInstance.activeTurnFailRender({
        threadKey: active.threadKey,
        executionId: active.executionId,
        token: snapshot!.renderToken!,
      });
      vi.advanceTimersByTime(2 * 60_000 + 1);
      await doInstance.alarm();

      expect(ambiguousCalls).toHaveLength(2);
      expect(ambiguousCalls[0]!.client_msg_id).toBe(ambiguousCalls[1]!.client_msg_id);
      expect(ambiguousCalls[0]!.client_msg_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await doInstance.obligationGet({ threadKey: active.threadKey }))
        .toBeUndefined();
      await doInstance.alarm();
      expect(ambiguousCalls).toHaveLength(2);
    } finally {
      close();
      vi.useRealTimers();
    }
  });

  it("defers a live execution beyond three alarms and later replays its successful terminal output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T14:00:00Z"));
    const threadKey = "slack:C-live:1.0";
    const executionId = "exec-live";
    const executingByThread = new Map([[threadKey, executionId]]);
    const eventsByThread = new Map<string, ReplayEvent[]>([[threadKey, [
      { id: 1, executionId, kind: "output", payload: "finished answer", createdAt: 1 },
      { id: 2, executionId, kind: "done", payload: { ok: true }, createdAt: 2 },
    ]]]);
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({ eventsByThread, executingByThread }),
    });
    try {
      // A genuinely live execution keeps its active-turn row registered —
      // the live-defer branch requires it (an executing slot with NO active
      // row is a crash orphan and recovers instead; see the sibling test).
      await doInstance.activeTurnRegister({
        channelId: "C-live",
        threadKey,
        conversationKey: "C-live::1.0",
        executionId,
        threadTs: "1.0",
        registeredAt: Date.now(),
      });
      await doInstance.obligationSet({
        threadKey,
        executionId,
        afterEventId: 0,
        channel: "C-live",
        threadTs: "1.0",
        timeoutMs: -1,
      });
      for (let n = 0; n < 4; n += 1) {
        await doInstance.alarm();
        expect((await doInstance.obligationGet({ threadKey }))?.attempt).toBe(0);
        vi.advanceTimersByTime(2 * 60_000 + 1);
      }
      expect(fetchCalls).toHaveLength(0);

      executingByThread.delete(threadKey);
      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(1);
      expect((fetchCalls[0]!.body as { text: string }).text)
        .toContain("Recovered completed turn");
      expect((fetchCalls[0]!.body as { text: string }).text)
        .toContain("finished answer");
      expect(await doInstance.obligationGet({ threadKey })).toBeUndefined();
    } finally {
      close();
      vi.useRealTimers();
    }
  });

  it("recovers (never defers forever) when an executing slot outlives its active-turn row", async () => {
    // Isolate crash: the lifecycle claimed session:executing but died before
    // terminalizing it, and the active-turn row expired (or was never
    // written). The alarm must treat the orphaned executing slot as a crash
    // and post recovery — unbounded live-deferral here would be permanent
    // silence, the exact failure the never-silent contract forbids.
    const threadKey = "slack:C-orphan:1.0";
    const executionId = "exec-orphan";
    const executingByThread = new Map([[threadKey, executionId]]);
    const eventsByThread = new Map<string, ReplayEvent[]>([[threadKey, [
      { id: 1, executionId, kind: "output", payload: "partial answer", createdAt: 1 },
    ]]]);
    const { doInstance, close } = makeDo({
      SLACK_BOT_TOKEN: "xoxb-test",
      SESSION_EVENTS: makeFakeSessionEvents({ eventsByThread, executingByThread }),
    });
    try {
      // No activeTurnRegister call — the row is gone, only executing remains.
      await doInstance.obligationSet({
        threadKey,
        executionId,
        afterEventId: 0,
        channel: "C-orphan",
        threadTs: "1.0",
        timeoutMs: -1,
      });
      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(1);
      expect((fetchCalls[0]!.body as { text: string }).text)
        .toContain("partial answer");
      expect(await doInstance.obligationGet({ threadKey })).toBeUndefined();
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

  it("defers transient state/replay/token failures beyond the retry budget and recovers once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T16:00:00Z"));
    const threadKey = "slack:C-transient:7.0";
    const executionId = "exec-transient";
    let stateFailures = 4;
    let replayFailures = 4;
    let token: string | undefined;
    let sessionBinding: Record<string, unknown> | undefined;
    const sessionEvents = {
      idFromName: (name: string) => ({ name }),
      get: (_id: { name: string }) => ({
        getState: async () => {
          if (stateFailures-- > 0) throw new Error("transient getState");
          return { interrupted: false };
        },
        replay: async () => {
          if (replayFailures-- > 0) throw new Error("transient replay");
          return [
            { id: 1, executionId, kind: "output", payload: "eventual answer", createdAt: 1 },
            { id: 2, executionId, kind: "done", payload: { ok: true }, createdAt: 2 },
          ];
        },
      }),
    };
    const { doInstance, close } = makeDo({
      get SESSION_EVENTS() { return sessionBinding; },
      get SLACK_BOT_TOKEN() { return token; },
    });
    try {
      await doInstance.obligationSet({
        threadKey,
        executionId,
        afterEventId: 0,
        channel: "C-transient",
        timeoutMs: -1,
      });

      const expectDeferred = async () => {
        await expect(doInstance.alarm()).resolves.toBeUndefined();
        expect((await doInstance.obligationGet({ threadKey }))?.attempt).toBe(0);
        vi.advanceTimersByTime(2 * 60_000 + 1);
      };

      // Missing binding/config, then transient state and replay RPC failures
      // all remain unknown across more alarms than the rejection retry cap.
      for (let n = 0; n < 4; n += 1) await expectDeferred();
      sessionBinding = sessionEvents;
      for (let n = 0; n < 4; n += 1) await expectDeferred();
      for (let n = 0; n < 4; n += 1) await expectDeferred();
      expect(fetchCalls).toHaveLength(0);

      // Durable state and replay now recover, but missing Slack config is also
      // unknown and must preserve the same zero-attempt obligation beyond the
      // normal definitive-rejection retry budget.
      for (let n = 0; n < 4; n += 1) {
        await expectDeferred();
      }
      expect(fetchCalls).toHaveLength(0);
      token = "xoxb-restored";
      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(1);
      expect((fetchCalls[0]!.body as { text: string }).text).toContain("eventual answer");
      expect(await doInstance.obligationGet({ threadKey })).toBeUndefined();
      await doInstance.alarm();
      expect(fetchCalls).toHaveLength(1);
    } finally {
      close();
      vi.useRealTimers();
    }
  });
});
