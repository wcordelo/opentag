import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { ActiveTurnEngine } from "../src/store/active-turn-engine.js";
import { migrate } from "../src/store/schema.js";
import type { ActiveTurnRecord } from "../src/store/active-turn-types.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

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

const bot = vi.hoisted(() => ({
  handleEventsBody: vi.fn(async (
    _payload: unknown,
    meta?: { onTurnHandoff?: () => void },
  ) => {
    meta?.onTurnHandoff?.();
  }),
}));

vi.mock("../src/bot-engine.js", () => ({
  getOrCreateBot: async () => ({ adapter: bot }),
  resolveBotEngineKind: () => "agui",
}));

const { DeferredIngressDO } = await import("../src/deferred-ingress-do.js");
const { default: worker } = await import("../src/worker.js");

type RegistrationMode = "open" | "duplicate" | "concurrent";

function sqliteEngine() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlExecutor = {
    exec<T = Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> {
      const stmt = db.prepare(query);
      const params = bindings as Array<string | number | bigint | null>;
      const rows = /^\s*select/i.test(query)
        ? stmt.all(...params) as T[]
        : (stmt.run(...params), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`expected one row, got ${rows.length}`);
          }
          return rows[0]!;
        },
      };
    },
  };
  migrate(sql);
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    db,
    engine: new ActiveTurnEngine(sql, tx),
  };
}

function fakeDeferredCtx() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, value); },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => { alarm = at; },
    },
  };
}

function lifecycleNamespace() {
  let owner = sqliteEngine();
  const values = new Map<string, unknown>();
  let registrationMode: RegistrationMode = "open";
  let hiddenIdleReads = 0;
  const stub = {
    activeTurnRegisterWithObligation: async (
      args: {
        record: ActiveTurnRecord;
        obligation: {
          afterEventId: number;
          channel: string;
          threadTs?: string;
          timeoutMs: number;
        };
      },
    ) => {
      if (
        !owner.engine.get(args.record.threadKey) &&
        registrationMode === "duplicate"
      ) {
        owner.engine.register(args.record, 7_200_000);
      } else if (
        !owner.engine.get(args.record.threadKey) &&
        registrationMode === "concurrent"
      ) {
        owner.engine.register({
          ...args.record,
          executionId: `${String(args.record.executionId)}-other`,
        }, 7_200_000);
      }
      return owner.engine.register(args.record, 7_200_000, args.obligation);
    },
    activeTurnGet: async ({ threadKey }: { threadKey: string }) => {
      if (hiddenIdleReads > 0) {
        hiddenIdleReads -= 1;
        return undefined;
      }
      return owner.engine.get(threadKey);
    },
    kvGet: async (key: string) => values.get(key),
    kvSet: async (key: string, value: unknown) => { values.set(key, value); },
    kvDelete: async (key: string) => { values.delete(key); },
  };
  return {
    binding: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
    values,
    setMode(mode: RegistrationMode) {
      registrationMode = mode;
    },
    clearRows() {
      owner.db.close();
      owner = sqliteEngine();
      registrationMode = "open";
    },
    hideNextIdleRead() {
      hiddenIdleReads += 1;
    },
  };
}

function makeEnv(state: ReturnType<typeof lifecycleNamespace>): Env {
  return {
    ADMIN_SECRET: "internal-secret",
    BOT_STATE: state.binding,
    SLACK_BOT_USER_ID: "UOPENTAG",
  } as unknown as Env;
}

function bridgeToWorker(env: Env): Fetcher {
  return {
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => worker.request(
      new Request(input, init),
      undefined,
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext,
    ),
  } as Fetcher;
}

function ordinaryFileJob() {
  return {
    id: "file-turn:EvFileConcurrent",
    kind: "file_turn" as const,
    teamId: "T1",
    payload: {
      callback: {
        type: "event_callback",
        event_id: "EvFileConcurrent",
        team_id: "T1",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@UOPENTAG> inspect this",
          ts: "1710000000.100000",
          files: [{ id: "F1", name: "evidence.txt" }],
        },
      },
    },
  };
}

describe("deferred ingress discriminates duplicate from concurrent admission", () => {
  beforeEach(() => {
    bot.handleEventsBody.mockClear();
  });

  it("keeps a distinct-concurrent ordinary file turn pending, then hands it off once", async () => {
    const state = lifecycleNamespace();
    state.setMode("concurrent");
    const env = makeEnv(state);
    const owner = new DeferredIngressDO(fakeDeferredCtx() as never, {
      BOT_SELF: bridgeToWorker(env),
      ADMIN_SECRET: "internal-secret",
    } as never);
    await owner.prepare(ordinaryFileJob());

    await owner.alarm();
    expect(await owner.getState()).toMatchObject({
      status: "pending",
      attempt: 1,
      lastError: "internal_handoff_http_503",
    });
    expect(bot.handleEventsBody).not.toHaveBeenCalled();

    state.clearRows();
    await owner.alarm();
    expect(await owner.getState()).toMatchObject({ status: "completed" });
    expect(bot.handleEventsBody).toHaveBeenCalledTimes(1);
  });

  it("completes an exact duplicate idempotently without a second handoff", async () => {
    const state = lifecycleNamespace();
    state.setMode("duplicate");
    const env = makeEnv(state);
    const owner = new DeferredIngressDO(fakeDeferredCtx() as never, {
      BOT_SELF: bridgeToWorker(env),
      ADMIN_SECRET: "internal-secret",
    } as never);
    await owner.prepare(ordinaryFileJob());

    await owner.alarm();

    expect(await owner.getState()).toMatchObject({ status: "completed" });
    expect(bot.handleEventsBody).not.toHaveBeenCalled();
  });

  it("retains an unconsumed late-file repair when idle loses a race, then consumes after retry", async () => {
    const state = lifecycleNamespace();
    state.setMode("concurrent");
    state.hideNextIdleRead();
    const env = makeEnv(state);
    const owner = new DeferredIngressDO(fakeDeferredCtx() as never, {
      BOT_SELF: bridgeToWorker(env),
      ADMIN_SECRET: "internal-secret",
    } as never);
    const pending = {
      teamId: "T1",
      channelId: "C1",
      userId: "U1",
      mentionTs: "1710000000.100000",
      threadTs: "1710000000.100000",
      eventId: "EvMention",
      expiresAt: Date.now() + 15_000,
    };
    const candidate = {
      teamId: "T1",
      channelId: "C1",
      userId: "U1",
      fileTs: "1710000001.100000",
      threadTs: pending.threadTs,
      files: [{ id: "F1", name: "evidence.txt" }],
    };
    const job = {
      id: "late-file-repair:EvMention:1710000001.100000:F1",
      kind: "late_file" as const,
      teamId: "T1",
      payload: {
        callback: {
          type: "event_callback",
          team_id: "T1",
          event: {
            user: "U1",
            ts: candidate.fileTs,
          },
        },
        pending,
        candidate,
      },
    };
    await owner.prepare(job);

    await owner.alarm();
    expect(await owner.getState()).toMatchObject({ status: "pending", attempt: 1 });
    expect(state.values.get("late-file-consumed:EvMention")).toBeUndefined();
    expect(bot.handleEventsBody).not.toHaveBeenCalled();

    state.clearRows();
    await owner.alarm();
    expect(await owner.getState()).toMatchObject({ status: "completed" });
    expect(state.values.get("late-file-consumed:EvMention")).toBe(true);
    expect(bot.handleEventsBody).toHaveBeenCalledTimes(1);
  });
});
