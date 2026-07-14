import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
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

const { default: worker } = await import("../src/worker.js");
const { resetBotSingleton } = await import("../src/bot-engine.js");
const { resetRequestContext } = await import("../src/request-context.js");
const { SessionEventEngine } = await import("../src/store/session-event-do.js");
const { ActiveTurnEngine } = await import("../src/store/active-turn-engine.js");
const { SqlStateEngine } = await import("../src/store/sql-state-engine.js");
const { migrate } = await import("../src/store/schema.js");
const { activeTurnThreadKvKey } = await import(
  "../src/slack/active-turn-registry.js"
);

const SESSION_SCHEMA = [
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     execution_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX events_execution ON events(execution_id, id)`,
  `CREATE TABLE executions (
     execution_id TEXT PRIMARY KEY,
     forwarded_message_id TEXT UNIQUE,
     started_at INTEGER NOT NULL,
     terminal_at INTEGER
   )`,
  `CREATE TABLE cancelled_executions (
     execution_id TEXT PRIMARY KEY,
     cancelled_at INTEGER NOT NULL
   )`,
];

function sqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> {
      const statement = db.prepare(query);
      const values = bindings as Array<string | number | bigint | null>;
      const returnsRows = /^\s*select/i.test(query) || /\breturning\b/i.test(query);
      const rows = returnsRows
        ? (statement.all(...values) as T[])
        : (statement.run(...values), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0]!;
        },
      };
    },
  };
}

function makeSessionEvents() {
  const engines = new Map<string, InstanceType<typeof SessionEventEngine>>();
  const databases: DatabaseSync[] = [];
  const interruptExpectedCalls: Array<{ threadKey: string; executionId: string }> = [];
  const executeCalls: Array<{
    threadKey: string;
    executionId: string;
    forwardedMessageId: string;
  }> = [];

  const engineFor = (threadKey: string) => {
    let engine = engines.get(threadKey);
    if (engine) return engine;
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const sql = sqliteExecutor(db);
    for (const statement of SESSION_SCHEMA) sql.exec(statement);
    const kv = new Map<string, unknown>();
    engine = new SessionEventEngine({
      sql,
      kv: {
        get: async <T>(key: string) => kv.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { kv.set(key, value); },
        delete: async (key: string) => kv.delete(key),
      },
    });
    engines.set(threadKey, engine);
    return engine;
  };

  return {
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => {
        const engine = engineFor(id.name);
        return {
          create: engine.create.bind(engine),
          // Observe only the DO RPC boundary; production normalization,
          // request context, identity derivation, and lifecycle stay intact.
          execute: async (args: {
            executionId: string;
            forwardedMessageId: string;
            inputLines: string[];
          }) => {
            executeCalls.push({
              threadKey: id.name,
              executionId: args.executionId,
              forwardedMessageId: args.forwardedMessageId,
            });
            return engine.execute(args);
          },
          appendEvent: engine.appendEvent.bind(engine),
          replay: engine.replay.bind(engine),
          getState: engine.getState.bind(engine),
          interrupt: engine.interrupt.bind(engine),
          interruptExpected: async (executionId: string) => {
            interruptExpectedCalls.push({ threadKey: id.name, executionId });
            return engine.interruptExpected(executionId);
          },
        };
      },
    },
    engineFor,
    interruptExpectedCalls,
    executeCalls,
    close: () => databases.forEach((db) => db.close()),
  };
}

function makeBotState() {
  type Obligation = {
    threadKey: string;
    executionId: string;
    afterEventId: number;
    channel: string;
    threadTs?: string;
    deadline: number;
    attempt: number;
  };
  const values = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const seen = new Set<string>();
  const obligations = new Map<string, Obligation>();
  const obligationSetCalls: Array<{
    threadKey: string;
    executionId: string;
    afterEventId: number;
    channel: string;
    threadTs?: string;
    timeoutMs?: number;
  }> = [];
  const obligationClearCalls: Array<{ threadKey: string; executionId?: string }> = [];
  const activeDb = new DatabaseSync(":memory:");
  const activeSql = sqliteExecutor(activeDb);
  migrate(activeSql);
  const activeTx = <T>(fn: () => T): T => {
    activeDb.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      activeDb.exec("COMMIT");
      return result;
    } catch (err) {
      activeDb.exec("ROLLBACK");
      throw err;
    }
  };
  const activeTurns = new ActiveTurnEngine(activeSql, activeTx);
  const atomicState = new SqlStateEngine({ sql: activeSql, tx: activeTx });
  const syncAtomicClear = <T>(
    threadKey: string,
    executionId: string,
    action: () => T,
  ): T => {
    const had = obligations.get(threadKey)?.executionId === executionId;
    const result = action();
    const remaining = activeDb.prepare(
      `SELECT execution_id FROM render_obligations WHERE thread_key = ?`,
    ).get(threadKey) as { execution_id?: string } | undefined;
    if (had && remaining?.execution_id !== executionId) {
      obligations.delete(threadKey);
      obligationClearCalls.push({ threadKey, executionId });
    }
    return result;
  };
  const stub = {
    kvGet: async <T>(key: string) => values.get(key) as T | undefined,
    kvSet: async (key: string, value: unknown) => { values.set(key, value); },
    kvDelete: async (key: string) => { values.delete(key); },
    hitlPrepareChoice: async (args: {
      choiceKey: string;
      cancelledKey: string;
    }) => {
      const result = atomicState.hitlPrepareChoice(args.choiceKey, args.cancelledKey);
      return result.status === "ready"
        ? result
        : { status: result.status, record: JSON.parse(result.record) as unknown };
    },
    hitlConsumeChoice: async (args: {
      choiceKey: string;
      cancelledKey: string;
    }) => {
      const result = atomicState.hitlConsumeChoice(args.choiceKey, args.cancelledKey);
      return result.status === "pending"
        ? result
        : { status: result.status, record: JSON.parse(result.record) as unknown };
    },
    hitlPersistChoiceUnlessCancelled: async (args: {
      choiceKey: string;
      cancelledKey: string;
      record: unknown;
    }) => {
      return atomicState.hitlPersistChoiceUnlessCancelled(
        args.choiceKey,
        args.cancelledKey,
        JSON.stringify(args.record),
        10 * 60_000,
      );
    },
    hitlCancelChoice: async (args: {
      choiceKey: string;
      cancelledKey: string;
      denial: unknown;
    }) => {
      atomicState.hitlCancelChoice(
        args.choiceKey,
        args.cancelledKey,
        JSON.stringify(args.denial),
        10 * 60_000,
      );
    },
    listAppend: async (key: string, value: unknown, opts?: { maxLen?: number }) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      if (opts?.maxLen && list.length > opts.maxLen) list.splice(0, list.length - opts.maxLen);
      lists.set(key, list);
      return list.length;
    },
    listRange: async (key: string, start = 0, stop = -1) => {
      const list = lists.get(key) ?? [];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      return list.slice(start, end);
    },
    listTrim: async () => undefined,
    listDelete: async (key: string) => { lists.delete(key); },
    lockAcquire: async () => ({ token: crypto.randomUUID() }),
    lockRelease: async () => undefined,
    dedupSeen: async (key: string) => {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    },
    queueEnqueue: async () => 0,
    queueDequeue: async () => undefined,
    queueDepth: async () => 0,
    // Faithful StateStore boundary: upsert by thread, compare-delete whenever
    // an execution id is supplied. Production code owns every asserted call.
    obligationSet: async (args: {
      threadKey: string;
      executionId: string;
      afterEventId: number;
      channel: string;
      threadTs?: string;
      timeoutMs?: number;
    }) => {
      obligationSetCalls.push({ ...args });
      obligations.set(args.threadKey, {
        threadKey: args.threadKey,
        executionId: args.executionId,
        afterEventId: args.afterEventId,
        channel: args.channel,
        ...(args.threadTs ? { threadTs: args.threadTs } : {}),
        deadline: Date.now() + (args.timeoutMs ?? 16 * 60_000),
        attempt: 0,
      });
      activeDb.prepare(
        `INSERT INTO render_obligations
         (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(thread_key) DO UPDATE SET
           execution_id = excluded.execution_id,
           after_event_id = excluded.after_event_id,
           channel = excluded.channel,
           thread_ts = excluded.thread_ts,
           deadline = excluded.deadline,
           attempt = 0`,
      ).run(
        args.threadKey,
        args.executionId,
        args.afterEventId,
        args.channel,
        args.threadTs ?? null,
        Date.now() + (args.timeoutMs ?? 16 * 60_000),
      );
    },
    obligationClear: async (args: { threadKey: string; executionId?: string }) => {
      obligationClearCalls.push({ ...args });
      const current = obligations.get(args.threadKey);
      if (current && (args.executionId === undefined || current.executionId === args.executionId)) {
        obligations.delete(args.threadKey);
      }
      activeDb.prepare(
        args.executionId
          ? `DELETE FROM render_obligations WHERE thread_key = ? AND execution_id = ?`
          : `DELETE FROM render_obligations WHERE thread_key = ?`,
      ).run(...(args.executionId
        ? [args.threadKey, args.executionId]
        : [args.threadKey]));
    },
    obligationGet: async ({ threadKey }: { threadKey: string }) => obligations.get(threadKey),
    activeTurnRegister: async (record: import("../src/store/active-turn-types.js").ActiveTurnRecord) =>
      activeTurns.register(record, 2 * 60 * 60_000),
    activeTurnRegisterWithObligation: async (args: {
      record: import("../src/store/active-turn-types.js").ActiveTurnRecord;
      obligation: {
        afterEventId: number;
        channel: string;
        threadTs?: string;
        timeoutMs: number;
      };
    }) => {
      const result = activeTurns.register(
        args.record,
        2 * 60 * 60_000,
        args.obligation,
      );
      if (result.accepted) {
        const row = {
          threadKey: args.record.threadKey,
          executionId: args.record.executionId,
          afterEventId: args.obligation.afterEventId,
          channel: args.obligation.channel,
          ...(args.obligation.threadTs ? { threadTs: args.obligation.threadTs } : {}),
          deadline: Date.now() + args.obligation.timeoutMs,
          attempt: 0,
        };
        obligations.set(args.record.threadKey, row);
        obligationSetCalls.push({
          threadKey: args.record.threadKey,
          executionId: args.record.executionId,
          ...args.obligation,
        });
      }
      return result;
    },
    activeTurnRefresh: async (record: import("../src/store/active-turn-types.js").ActiveTurnRecord) =>
      activeTurns.refresh(record, 2 * 60 * 60_000),
    activeTurnGet: async ({ threadKey }: { threadKey: string }) => activeTurns.get(threadKey),
    activeTurnLatest: async ({ channelId }: { channelId: string }) => activeTurns.latest(channelId),
    activeTurnRegisterChoice: async (args: {
      threadKey: string; executionId: string; choiceId: string;
    }) => activeTurns.registerChoice(args.threadKey, args.executionId, args.choiceId),
    activeTurnUnregisterChoice: async (args: {
      threadKey: string; executionId: string; choiceId: string;
    }) => activeTurns.unregisterChoice(args.threadKey, args.executionId, args.choiceId),
    activeTurnCancelRegisteredChoices: async (args: {
      threadKey: string; executionId: string;
    }) => activeTurns.cancelRegisteredChoices(args.threadKey, args.executionId),
    activeTurnClaimCancellation: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => activeTurns.claimCancellation(args.threadKey, args.executionId, args.stopEventId),
    activeTurnMarkCancelControlled: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => activeTurns.markCancelControlled(args.threadKey, args.executionId, args.stopEventId),
    activeTurnBeginCancelAck: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => activeTurns.beginCancelAck(args.threadKey, args.executionId, args.stopEventId),
    activeTurnFailCancelAck: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => activeTurns.failCancelAck(args.threadKey, args.executionId, args.stopEventId),
    activeTurnConfirmCancellationAndClear: async (args: {
      threadKey: string; executionId: string; stopEventId: string;
    }) => syncAtomicClear(args.threadKey, args.executionId, () =>
      activeTurns.confirmCancellationAndClear(
        args.threadKey,
        args.executionId,
        args.stopEventId,
      )),
    activeTurnBeginRender: async (args: { threadKey: string; executionId: string }) =>
      activeTurns.beginRender(args.threadKey, args.executionId),
    activeTurnConfirmRender: async (args: {
      threadKey: string; executionId: string; token: string; final: boolean; output: boolean;
    }) => syncAtomicClear(args.threadKey, args.executionId, () =>
      activeTurns.confirmRender(
        args.threadKey,
        args.executionId,
        args.token,
        args.final,
        args.output,
      )),
    activeTurnFailRender: async (args: {
      threadKey: string; executionId: string; token: string;
    }) => activeTurns.failRender(args.threadKey, args.executionId, args.token),
    activeTurnLifecycleComplete: async (args: { threadKey: string; executionId: string }) =>
      syncAtomicClear(args.threadKey, args.executionId, () =>
        activeTurns.lifecycleComplete(args.threadKey, args.executionId)),
    activeTurnAbandonPristine: async (args: { threadKey: string; executionId: string }) =>
      syncAtomicClear(args.threadKey, args.executionId, () =>
        activeTurns.abandonPristine(args.threadKey, args.executionId)),
    activeTurnDiscardInterruptedRedelivery: async (args: {
      threadKey: string; executionId: string;
    }) => syncAtomicClear(args.threadKey, args.executionId, () =>
      activeTurns.discardInterruptedRedelivery(args.threadKey, args.executionId)),
  };
  return {
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
    values,
    seen,
    obligations,
    obligationSetCalls,
    obligationClearCalls,
  };
}

function makeWorkspaceConfig() {
  const stub = {
    fetch: async (request: RequestInfo | URL) => {
      const path = new URL(String(request)).pathname;
      if (path === "/getConfig") {
        return Response.json({
          teamId: "T1",
          channelId: null,
          systemPrompt: "integration test",
          policies: { allowMemoryWrite: true, allowTasks: true },
          accessBundleId: "default",
          updatedAt: "now",
        });
      }
      if (path === "/getBundle") {
        return Response.json({ id: "default", tools: [], mcpEndpoints: [], secretRefs: [] });
      }
      return Response.json({ ok: true });
    },
  };
  return {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
  };
}

async function slackSignature(secret: string, timestamp: string, body: string) {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    bytes.encode(`v0:${timestamp}:${body}`),
  );
  return `v0=${[...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function signedRequest(
  path: string,
  body: string,
  secret: string,
  contentType: string,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`https://bot.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": await slackSignature(secret, timestamp, body),
    },
    body,
  });
}

describe("real /agent ingress and Stop lifecycle", () => {
  const originalFetch = globalThis.fetch;
  let slackPosts: Array<Record<string, string>>;

  beforeEach(() => {
    resetBotSingleton();
    resetRequestContext();
    slackPosts = [];
    globalThis.fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      const params = new URLSearchParams(String(init?.body ?? ""));
      if (url.endsWith("/auth.test")) return Response.json({ ok: true, user_id: "UBOT" });
      if (url.endsWith("/users.info")) {
        return Response.json({
          ok: true,
          user: { id: "U1", name: "ada", real_name: "Ada", tz: "UTC", profile: { email: "ada@example.com" } },
        });
      }
      if (url.endsWith("/conversations.history") || url.endsWith("/conversations.replies")) {
        return Response.json({ ok: true, messages: [] });
      }
      if (url.endsWith("/chat.postMessage")) slackPosts.push(Object.fromEntries(params));
      return Response.json({ ok: true, ts: "900.001" });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    resetBotSingleton();
    resetRequestContext();
  });

  it("terminalizes a real /agent trivial shortcut with no pending active row", async () => {
    const signingSecret = "signing-secret";
    const botState = makeBotState();
    const env = {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      AGENT_URL: "https://agent.test/run",
      BOT_STATE: botState.namespace,
      WORKSPACE_CONFIG: makeWorkspaceConfig(),
      KNOWLEDGE: {} as never,
    } as unknown as Env;
    const waitUntil: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => { waitUntil.push(promise); },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const params = new URLSearchParams({
      command: "/agent",
      text: "thanks!",
      channel_id: "C_SHORTCUT",
      user_id: "U1",
      trigger_id: "trigger-shortcut",
      team_id: "T1",
    });
    const request = await signedRequest(
      "/slack/commands",
      params.toString(),
      signingSecret,
      "application/x-www-form-urlencoded",
    );
    expect((await worker.request(request, undefined, env, executionCtx)).status).toBe(200);
    await Promise.all(waitUntil);
    expect(slackPosts).toHaveLength(1);
    expect(JSON.stringify(slackPosts[0])).toContain("You're welcome.");
    expect([...botState.values.keys()].some((key) => key.startsWith("active-turn:")))
      .toBe(false);
    expect(botState.obligations.size).toBe(0);
  });

  it.each(["/config", "/research"] as const)(
    "pre-admits and stops %s before its first command-specific effect",
    async (command) => {
      const signingSecret = "signing-secret";
      const botState = makeBotState();
      let releaseProfile!: () => void;
      const profileReleased = new Promise<void>((resolve) => { releaseProfile = resolve; });
      let profileStarted!: () => void;
      const profileLookup = new Promise<void>((resolve) => { profileStarted = resolve; });
      const configWrites: string[] = [];
      const researchStarts: string[] = [];

      globalThis.fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = String(request);
        const params = new URLSearchParams(String(init?.body ?? ""));
        if (url.endsWith("/auth.test")) return Response.json({ ok: true, user_id: "UBOT" });
        if (url.endsWith("/users.info")) {
          profileStarted();
          await profileReleased;
          return Response.json({
            ok: true,
            user: { id: "U1", name: "ada", real_name: "Ada", profile: { email: "ada@example.com" } },
          });
        }
        if (url.endsWith("/chat.postMessage")) slackPosts.push(Object.fromEntries(params));
        return Response.json({ ok: true, ts: "900.001" });
      }) as typeof fetch;

      const workspaceStub = {
        fetch: async (request: RequestInfo | URL) => {
          const path = new URL(String(request)).pathname;
          if (path === "/getConfig") {
            return Response.json({
              teamId: "T1",
              channelId: "C_SHORT",
              systemPrompt: "before",
              policies: { allowMemoryWrite: true, allowTasks: true },
              accessBundleId: "default",
              updatedAt: "now",
            });
          }
          if (path === "/getBundle") {
            return Response.json({
              id: "default",
              tools: ["start_task"],
              mcpEndpoints: [],
              secretRefs: [],
            });
          }
          configWrites.push(path);
          return Response.json({ ok: true });
        },
      };
      const env = {
        SLACK_SIGNING_SECRET: signingSecret,
        SLACK_BOT_TOKEN: "xoxb-test",
        AGENT_URL: "https://agent.test/run",
        BOT_STATE: botState.namespace,
        WORKSPACE_CONFIG: {
          idFromName: (name: string) => ({ name }),
          get: () => workspaceStub,
        },
        SESSION_EVENTS: makeSessionEvents().namespace,
        RESEARCH_TASKS: {
          fetch: async () => {
            researchStarts.push("start");
            return Response.json({ status: "accepted", taskId: "task-1" });
          },
        },
        KNOWLEDGE: {} as never,
      } as unknown as Env;
      const waitUntil: Promise<unknown>[] = [];
      const executionCtx = {
        waitUntil: (promise: Promise<unknown>) => { waitUntil.push(promise); },
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext;
      const params = new URLSearchParams({
        command,
        text: command === "/config" ? "new prompt" : "investigate safely",
        channel_id: "C_SHORT",
        user_id: "U1",
        trigger_id: `trigger-${command}`,
        team_id: "T1",
      });
      const commandRequest = await signedRequest(
        "/slack/commands",
        params.toString(),
        signingSecret,
        "application/x-www-form-urlencoded",
      );
      expect((await worker.request(commandRequest, undefined, env, executionCtx)).status).toBe(200);
      await profileLookup;
      expect(botState.obligations.size).toBe(1);

      const stopBody = JSON.stringify({
        type: "event_callback",
        event_id: `EvStop-${command}`,
        team_id: "T1",
        event: {
          type: "app_mention",
          channel: "C_SHORT",
          user: "U1",
          text: "stop",
          ts: "1710000099.000100",
        },
      });
      const stopStart = waitUntil.length;
      const stopRequest = await signedRequest(
        "/slack/events",
        stopBody,
        signingSecret,
        "application/json",
      );
      expect((await worker.request(stopRequest, undefined, env, executionCtx)).status).toBe(200);
      await Promise.all(waitUntil.slice(stopStart));
      releaseProfile();
      await Promise.all(waitUntil);

      expect(configWrites).toEqual([]);
      expect(researchStarts).toEqual([]);
      expect(slackPosts.map((post) => post.text)).toEqual(["🛑 Stopped."]);
      expect(botState.obligations.size).toBe(0);
    },
  );

  it.each([
    { label: "top-level channel", channel: "C_TOP", threadTs: undefined, root: "C_TOP" },
    { label: "threaded channel", channel: "C_THREAD", threadTs: "1710000000.123400", root: "1710000000.123400" },
  ])("cancels the exact wire execution for a $label turn", async ({ channel, threadTs, root }) => {
    const signingSecret = "signing-secret";
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const botState = makeBotState();
    const sessions = makeSessionEvents();
    const harnessTurns: Array<Record<string, unknown>> = [];
    const harnessInterrupts: Array<{
      body: Record<string, unknown>;
      authorization: string | null;
    }> = [];
    let turnStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const harness = {
      fetch: vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(request)).pathname;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (path === "/interrupt") {
          harnessInterrupts.push({
            body,
            authorization: new Headers(init?.headers).get("Authorization"),
          });
          return Response.json({ interrupted: true });
        }
        harnessTurns.push(body);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { turnStream = controller; },
        }), {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }),
    };
    const env = {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
      AGENT_URL: "https://agent.test/run",
      HARNESS: harness,
      HARNESS_URL: "https://harness.test",
      HARNESS_AUTH_TOKEN: "harness-secret",
      BOT_STATE: botState.namespace,
      WORKSPACE_CONFIG: makeWorkspaceConfig(),
      SESSION_EVENTS: sessions.namespace,
      KNOWLEDGE: {} as never,
    } as unknown as Env;
    const waitUntil: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => { waitUntil.push(promise); },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const params = new URLSearchParams({
      command: "/agent",
      text: "--claude explain the cancellation path",
      channel_id: channel,
      user_id: "U1",
      trigger_id: `trigger-${channel}`,
      team_id: "T1",
    });
    if (threadTs) params.set("thread_ts", threadTs);
    const commandRequest = await signedRequest(
      "/slack/commands",
      params.toString(),
      signingSecret,
      "application/x-www-form-urlencoded",
    );
    // Preserve the exact signed body and headers for a genuine redelivery.
    const exactRetryRequest = commandRequest.clone();

    expect((await worker.request(commandRequest, undefined, env, executionCtx)).status).toBe(200);
    await vi.waitFor(() => expect(harnessTurns).toHaveLength(1));

    const turn = harnessTurns[0]!;
    const executionId = String(turn.executionId);
    const forwardedMessageId = String(turn.forwardedMessageId);
    const threadKey = `slack:${channel}:${root}`;
    expect(executionId).toMatch(/^ot1e_[A-Za-z0-9_-]{43}$/);
    expect(forwardedMessageId).toMatch(/^ot1m_[A-Za-z0-9_-]{43}$/);
    expect(executionId).not.toBe(forwardedMessageId);
    expect(turn).toMatchObject({
      threadKey,
      remoteGitApproved: false,
    });
    expect(turn).not.toHaveProperty("createPullRequest", true);
    expect(botState.obligations.get(threadKey)).toMatchObject({
      threadKey,
      executionId,
      channel,
      ...(threadTs ? { threadTs } : {}),
      attempt: 0,
    });
    expect(botState.obligationSetCalls).toHaveLength(1);

    const stopBody = JSON.stringify({
      type: "event_callback",
      event_id: `EvStop-${channel}`,
      team_id: "T1",
      event: {
        // Remote stop-routing safety requires a real app mention for a
        // top-level channel cancellation; threaded replies stay scoped and
        // may use ordinary message events.
        type: threadTs ? "message" : "app_mention",
        channel,
        user: "U1",
        text: "stop",
        ts: "1710000001.999900",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
    });
    const stopRequest = await signedRequest(
      "/slack/events",
      stopBody,
      signingSecret,
      "application/json",
    );
    const beforeStopPromises = waitUntil.length;
    expect((await worker.request(stopRequest, undefined, env, executionCtx)).status).toBe(200);
    await Promise.all(waitUntil.slice(beforeStopPromises));
    await vi.waitFor(() => expect(harnessInterrupts).toHaveLength(1));

    // Stop has terminalized the exact durable execution and removed its
    // obligation. Race a late container success through the still-open real
    // NDJSON consumer. One chunk proves both output and done were attempted
    // before reader cancellation can react to the rejected terminal append.
    expect(botState.obligations.has(threadKey)).toBe(false);
    expect(botState.obligationClearCalls).toEqual([{ threadKey, executionId }]);
    turnStream!.enqueue(new TextEncoder().encode(
      `${JSON.stringify({ kind: "output", payload: { text: "LATE_SUCCESS_MUST_NOT_POST" } })}\n` +
      `${JSON.stringify({ kind: "done", payload: { ok: true, summary: "late success" } })}\n`,
    ));
    turnStream!.close();
    await Promise.all(waitUntil);

    expect(sessions.interruptExpectedCalls).toEqual([{ threadKey, executionId }]);
    expect(harnessInterrupts).toEqual([{
      authorization: "Bearer harness-secret",
      body: { sessionId: expect.any(String), threadKey, executionId },
    }]);
    expect(botState.values.has(activeTurnThreadKvKey(threadKey))).toBe(false);
    expect(botState.obligations.has(threadKey)).toBe(false);
    expect(botState.obligationClearCalls).toEqual([{ threadKey, executionId }]);

    const events = await sessions.engineFor(threadKey).replay();
    expect(events.filter((event) => event.kind === "done")).toEqual([
      expect.objectContaining({ executionId, payload: { interrupted: true } }),
    ]);
    expect(events.some((event) => event.kind === "output")).toBe(false);
    expect(slackPosts.map((post) => post.text)).toEqual(["🛑 Stopped."]);
    expect(slackPosts.some((post) => post.text?.includes("LATE_SUCCESS_MUST_NOT_POST"))).toBe(false);
    expect(await sessions.engineFor(threadKey).getState()).toMatchObject({
      interrupted: true,
      interruptedExecutionId: executionId,
    });

    // Re-admit the exact signed redelivery past command dedup. It traverses
    // production normalization/context/lifecycle and regenerates both IDs;
    // the durable cancellation tombstone rejects it before another /turn.
    botState.seen.clear();
    const retryStart = waitUntil.length;
    expect((await worker.request(exactRetryRequest, undefined, env, executionCtx)).status).toBe(200);
    await Promise.all(waitUntil.slice(retryStart));
    expect(harnessTurns).toHaveLength(1);
    expect(sessions.executeCalls).toHaveLength(2);
    expect(sessions.executeCalls[1]).toEqual(sessions.executeCalls[0]);
    expect(sessions.executeCalls[0]).toMatchObject({
      threadKey,
      executionId,
      forwardedMessageId,
    });

    // An idle non-exact Stop is a true no-op. A distinct trigger must expose
    // fresh production-generated IDs and complete normally; it must not be
    // poisoned as the old singleton "cancel next" behavior did.
    await sessions.engineFor(threadKey).interrupt();
    botState.seen.clear();
    const distinct = new URLSearchParams(params);
    distinct.set("trigger_id", `distinct-trigger-${channel}`);
    const distinctRequest = await signedRequest(
      "/slack/commands",
      distinct.toString(),
      signingSecret,
      "application/x-www-form-urlencoded",
    );
    const distinctStart = waitUntil.length;
    expect((await worker.request(distinctRequest, undefined, env, executionCtx)).status).toBe(200);
    await vi.waitFor(() => expect(harnessTurns).toHaveLength(2));
    expect(sessions.executeCalls).toHaveLength(3);
    expect(sessions.executeCalls[2]!.executionId).toMatch(/^ot1e_[A-Za-z0-9_-]{43}$/);
    expect(sessions.executeCalls[2]!.forwardedMessageId).toMatch(/^ot1m_[A-Za-z0-9_-]{43}$/);
    expect(sessions.executeCalls[2]!.executionId).not.toBe(executionId);
    expect(sessions.executeCalls[2]!.forwardedMessageId).not.toBe(forwardedMessageId);
    turnStream!.enqueue(new TextEncoder().encode(
      `${JSON.stringify({ kind: "output", payload: { text: "UNRELATED_TURN_OK" } })}\n` +
      `${JSON.stringify({ kind: "done", payload: { ok: true } })}\n`,
    ));
    turnStream!.close();
    await Promise.all(waitUntil.slice(distinctStart));
    expect(botState.obligations.has(threadKey)).toBe(false);
    expect(slackPosts).toHaveLength(2);
    expect(slackPosts[0]!.text).toBe("🛑 Stopped.");
    // Channels may render a successful assistant response as blocks with the
    // plain-text fallback "(message)"; the second post proves the unrelated
    // turn was admitted and delivered after the idle non-exact Stop.
    expect(slackPosts[1]!.text).not.toBe("🛑 Stopped.");
    expect(JSON.stringify(slackPosts[1])).toContain("UNRELATED_TURN_OK");
    expect(metricLines.some((line) => line.includes('"metric":"turn_interrupted"'))).toBe(true);
    expect(metricLines.some((line) => line.includes('"metric":"turn_completed"'))).toBe(true);

    const identityFields = JSON.stringify({
      executionId: turn.executionId,
      forwardedMessageId: turn.forwardedMessageId,
      interruptExecutionId: harnessInterrupts[0]!.body.executionId,
    });
    expect(identityFields).not.toContain(`slack:${channel}:`);
    sessions.close();
  });
});
