import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ActiveTurnEngine } from "../src/store/active-turn-engine.js";
import { migrate } from "../src/store/schema.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

function sqlFor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      const stmt = db.prepare(query);
      const params = bindings as Array<string | number | bigint | null>;
      const rows = /^\s*select/i.test(query)
        ? (stmt.all(...params) as T[])
        : (stmt.run(...params), []);
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

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = sqlFor(db);
  migrate(sql);
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  let token = 0;
  let now = 1_000;
  const engine = new ActiveTurnEngine(sql, tx, () => now, () => `render-${++token}`);
  const record = {
    channelId: "C1",
    threadKey: "slack:C1:1.0",
    conversationKey: "C1::1.0",
    executionId: "exec-1",
    threadTs: "1.0",
    registeredAt: 10,
  };
  expect(engine.register(record, 7_200_000)).toEqual({ accepted: true, duplicate: false });
  return { db, engine, record, setNow: (value: number) => { now = value; } };
}

describe("ActiveTurnEngine transactional state machine", () => {
  it("durably reconciles a reserved live client id into the obligation timestamp", () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqlFor(db);
    migrate(sql);
    const tx = <T>(fn: () => T): T => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    const engine = new ActiveTurnEngine(sql, tx, () => 1_000);
    const record = {
      channelId: "C-live",
      threadKey: "slack:C-live:1.0",
      conversationKey: "C-live::1.0",
      executionId: "exec-live",
      liveClientMessageId: "11111111-1111-5111-8111-111111111111",
      registeredAt: 1,
    };
    expect(engine.register(record, 10_000, {
      afterEventId: 0,
      channel: record.channelId,
      timeoutMs: 5_000,
    }).accepted).toBe(true);
    expect(engine.get(record.threadKey)?.liveMessage).toEqual({
      state: "reserved",
      clientMessageId: record.liveClientMessageId,
    });
    expect(engine.confirmLiveMessage(
      record.threadKey,
      record.executionId,
      record.liveClientMessageId,
      "123.456",
    )).toBe(true);
    expect(engine.get(record.threadKey)?.liveMessage).toEqual({
      state: "posted",
      clientMessageId: record.liveClientMessageId,
      ts: "123.456",
    });
    expect(db.prepare(
      `SELECT live_message_state, live_message_ts FROM render_obligations WHERE thread_key = ?`,
    ).get(record.threadKey)).toEqual({
      live_message_state: "posted",
      live_message_ts: "123.456",
    });
    db.close();
  });

  it("atomically pre-admits an execution with its alarm obligation", () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqlFor(db);
    migrate(sql);
    const tx = <T>(fn: () => T): T => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    };
    const engine = new ActiveTurnEngine(sql, tx, () => 1_000);
    const record = {
      channelId: "C1",
      threadKey: "slack:C1:shortcut",
      conversationKey: "C1::C1",
      executionId: "exec-shortcut",
      registeredAt: 10,
    };
    expect(engine.register(record, 10_000, {
      afterEventId: 0,
      channel: "C1",
      timeoutMs: 5_000,
    })).toEqual({ accepted: true, duplicate: false });
    expect(db.prepare(
      `SELECT execution_id, channel, deadline FROM render_obligations WHERE thread_key = ?`,
    ).get(record.threadKey)).toEqual({
      execution_id: record.executionId,
      channel: "C1",
      deadline: 6_000,
    });
    expect(engine.register({ ...record, executionId: "other" }, 10_000, {
      afterEventId: 0,
      channel: "C1",
      timeoutMs: 5_000,
    })).toEqual({ accepted: false, duplicate: false });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM render_obligations`).get())
      .toEqual({ n: 1 });
    db.close();
  });

  it("abandons only a pristine provisional and immediately re-admits its retry", () => {
    const { db, engine, record } = fixture();
    expect(engine.registerChoice(record.threadKey, record.executionId, "provisional-choice"))
      .toBe("registered");
    db.prepare(
      `INSERT INTO render_obligations
       (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, 0, ?, ?, 99999, 0)`,
    ).run(record.threadKey, record.executionId, record.channelId, record.threadTs!);
    expect(engine.abandonPristine(record.threadKey, record.executionId)).toBe(true);
    expect(engine.get(record.threadKey)).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM active_turn_choices`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM render_obligations`).get()).toEqual({ n: 0 });
    expect(engine.register(record, 7_200_000)).toEqual({ accepted: true, duplicate: false });
    const render = engine.beginRender(record.threadKey, record.executionId);
    if (render.status !== "claimed") throw new Error("render not claimed");
    expect(engine.confirmRender(record.threadKey, record.executionId, render.token, false, true))
      .toBe(true);
    expect(engine.abandonPristine(record.threadKey, record.executionId)).toBe(false);
    expect(engine.get(record.threadKey)).toBeDefined();
    db.close();
  });

  it("cannot abandon a provisional once Stop, render, effect, or choice state owns it", () => {
    const stopped = fixture();
    expect(stopped.engine.claimCancellation(
      stopped.record.threadKey,
      stopped.record.executionId,
      "EvStop",
    )).toBe("claimed");
    expect(stopped.engine.abandonPristine(
      stopped.record.threadKey,
      stopped.record.executionId,
    )).toBe(false);
    stopped.db.close();

    const effect = fixture();
    effect.db.prepare(
      `INSERT INTO render_obligations
       (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, 0, ?, ?, 99999, 0)`,
    ).run(
      effect.record.threadKey,
      effect.record.executionId,
      effect.record.channelId,
      effect.record.threadTs!,
    );
    expect(effect.engine.beginEffect(
      effect.record.threadKey,
      effect.record.executionId,
      "shortcut",
    ).status).toBe("claimed");
    expect(effect.engine.abandonPristine(
      effect.record.threadKey,
      effect.record.executionId,
    )).toBe(false);
    expect(effect.db.prepare(`SELECT COUNT(*) AS n FROM render_obligations`).get())
      .toEqual({ n: 1 });
    effect.db.close();
  });
  it("registers dynamic HITL ids and atomically tombstones all of them on Stop", () => {
    const { db, engine, record } = fixture();
    expect(engine.registerChoice(record.threadKey, record.executionId, "confirm-1"))
      .toBe("registered");
    expect(engine.registerChoice(record.threadKey, record.executionId, "incident-1"))
      .toBe("registered");
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvHitl"))
      .toBe("claimed");
    expect(engine.registerChoice(record.threadKey, record.executionId, "too-late"))
      .toBe("cancelled");
    expect(engine.cancelRegisteredChoices(record.threadKey, record.executionId))
      .toEqual(["confirm-1", "incident-1"]);
    for (const choiceId of ["confirm-1", "incident-1"]) {
      const receipt = db.prepare(`SELECT value FROM kv WHERE key = ?`)
        .get(`hitl-id:${choiceId}`) as { value: string };
      expect(JSON.parse(receipt.value)).toMatchObject({
        value: { confirmed: false, choiceId },
      });
      expect(db.prepare(`SELECT value FROM kv WHERE key = ?`)
        .get(`hitl-cancelled:${choiceId}`)).toEqual({ value: "true" });
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM active_turn_choices`).get())
      .toEqual({ n: 0 });
    db.close();
  });

  it("unregisters a consumed choice and rejects registration after terminal cleanup", () => {
    const { db, engine, record } = fixture();
    expect(engine.registerChoice(record.threadKey, record.executionId, "done-choice"))
      .toBe("registered");
    expect(engine.unregisterChoice(record.threadKey, record.executionId, "done-choice"))
      .toBe(true);
    const render = engine.beginRender(record.threadKey, record.executionId);
    if (render.status !== "claimed") throw new Error("render not claimed");
    expect(engine.confirmRender(
      record.threadKey,
      record.executionId,
      render.token,
      true,
      true,
    )).toBe(true);
    expect(engine.registerChoice(record.threadKey, record.executionId, "late-choice"))
      .toBe("missing");
    db.close();
  });

  it("cannot overwrite cancellation with a stale render CAS", () => {
    const { db, engine, record } = fixture();
    expect(engine.claimCancellation(record.threadKey, record.executionId, "Ev1"))
      .toBe("claimed");
    expect(engine.beginRender(record.threadKey, record.executionId))
      .toEqual({ status: "cancelled" });
    expect(engine.get(record.threadKey)).toMatchObject({
      status: "cancelled",
      stopEventId: "Ev1",
    });
    db.close();
  });

  it("keeps Stop silent during a render and suppresses every later step after retry", () => {
    const { db, engine, record } = fixture();
    const render = engine.beginRender(record.threadKey, record.executionId);
    expect(render).toEqual({ status: "claimed", token: "render-1" });
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvRender"))
      .toBe("in_flight");
    expect(engine.confirmRender(
      record.threadKey,
      record.executionId,
      "render-1",
      false,
      true,
    ))
      .toBe(true);
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvRender"))
      .toBe("retry");
    expect(engine.beginRender(record.threadKey, record.executionId))
      .toEqual({ status: "cancelled" });
    db.close();
  });

  it("replays one failed Stop identity and serializes duplicate acknowledgement", () => {
    const { db, engine, record } = fixture();
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvRetry"))
      .toBe("claimed");
    expect(engine.markCancelControlled(record.threadKey, record.executionId, "EvRetry"))
      .toBe(true);
    expect(engine.beginCancelAck(record.threadKey, record.executionId, "EvRetry"))
      .toBe(true);
    expect(engine.beginCancelAck(record.threadKey, record.executionId, "EvRetry"))
      .toBe(false);
    expect(engine.failCancelAck(record.threadKey, record.executionId, "EvRetry"))
      .toBe(true);
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvRetry"))
      .toBe("retry");
    expect(engine.markCancelControlled(record.threadKey, record.executionId, "EvRetry"))
      .toBe(true);
    expect(engine.beginCancelAck(record.threadKey, record.executionId, "EvRetry"))
      .toBe(true);
    expect(engine.confirmCancellationAndClear(
      record.threadKey,
      record.executionId,
      "EvRetry",
    ))
      .toBe(true);
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvRetry"))
      .toBe("missing");
    db.close();
  });

  it("atomically clears the matching obligation with lifecycle completion", () => {
    const { db, engine, record } = fixture();
    db.prepare(
      `INSERT INTO render_obligations
       (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, 0, ?, ?, 99999, 0)`,
    ).run(record.threadKey, record.executionId, record.channelId, record.threadTs!);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM render_obligations`).get()).toEqual({ n: 1 });
    const render = engine.beginRender(record.threadKey, record.executionId);
    expect(render.status).toBe("claimed");
    if (render.status !== "claimed") throw new Error("render not claimed");
    expect(engine.confirmRender(
      record.threadKey,
      record.executionId,
      render.token,
      false,
      true,
    )).toBe(true);
    expect(engine.lifecycleComplete(record.threadKey, record.executionId)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM render_obligations`).get()).toEqual({ n: 0 });
    expect(engine.get(record.threadKey)).toBeUndefined();
    db.close();
  });

  it("atomically confirms a final visible render and admits the next turn immediately", () => {
    const { db, engine, record } = fixture();
    db.prepare(
      `INSERT INTO render_obligations
       (thread_key, execution_id, after_event_id, channel, thread_ts, deadline, attempt)
       VALUES (?, ?, 0, ?, ?, 99999, 0)`,
    ).run(record.threadKey, record.executionId, record.channelId, record.threadTs!);
    const render = engine.beginRender(record.threadKey, record.executionId);
    if (render.status !== "claimed") throw new Error("render not claimed");
    expect(engine.confirmRender(
      record.threadKey,
      record.executionId,
      render.token,
      true,
      true,
    )).toBe(true);
    expect(engine.get(record.threadKey)).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM render_obligations`).get())
      .toEqual({ n: 0 });
    expect(engine.register({ ...record, executionId: "exec-2" }, 7_200_000))
      .toEqual({ accepted: true, duplicate: false });
    db.close();
  });

  it("reopens only a definitive failed render and fences an ambiguous one", () => {
    const { db, engine, record } = fixture();
    const failed = engine.beginRender(record.threadKey, record.executionId);
    if (failed.status !== "claimed") throw new Error("render not claimed");
    expect(engine.failRender(record.threadKey, record.executionId, failed.token))
      .toBe(true);
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvKnown"))
      .toBe("claimed");
    db.close();

    const ambiguous = fixture();
    const unknown = ambiguous.engine.beginRender(
      ambiguous.record.threadKey,
      ambiguous.record.executionId,
    );
    expect(unknown.status).toBe("claimed");
    // No failRender RPC follows an ambiguous network throw.
    expect(ambiguous.engine.claimCancellation(
      ambiguous.record.threadKey,
      ambiguous.record.executionId,
      "EvUnknown",
    )).toBe("in_flight");
    ambiguous.db.close();
  });

  it("keeps Stop silent until a successful mutation is definitive, then suppresses the next tool", () => {
    const { db, engine, record } = fixture();
    const effect = engine.beginEffect(
      record.threadKey,
      record.executionId,
      "memory_write",
    );
    expect(effect).toEqual({ status: "claimed", token: "render-1" });
    expect(engine.get(record.threadKey)).toMatchObject({
      effectToken: "render-1",
      effectName: "memory_write",
    });
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvMutationPending",
    )).toBe("effect_in_flight");
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    expect(engine.confirmEffect(
      record.threadKey,
      record.executionId,
      effect.token,
    )).toBe(true);
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvMutationDefinitive",
    )).toBe("claimed");
    expect(engine.beginEffect(
      record.threadKey,
      record.executionId,
      "start_task",
    )).toEqual({ status: "cancelled" });
    db.close();
  });

  it("retains an ambiguous mutation token so no visible Stop can race ahead", () => {
    const { db, engine, record } = fixture();
    const effect = engine.beginEffect(
      record.threadKey,
      record.executionId,
      "start_task",
    );
    expect(effect.status).toBe("claimed");
    // A network throw intentionally makes no failEffect call: the remote task
    // may still have started, so every Stop attempt stays non-acknowledgeable.
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvAmbiguousTask",
    )).toBe("effect_in_flight");
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvAmbiguousTaskRetry",
    )).toBe("effect_in_flight");
    db.close();
  });

  it("blocks obligation rendering during an effect and exposes a durable Stop continuation after resolution", () => {
    const { db, engine, record } = fixture();
    const effect = engine.beginEffect(
      record.threadKey,
      record.executionId,
      "research_start",
    );
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    expect(engine.beginRender(record.threadKey, record.executionId))
      .toEqual({ status: "in_flight" });
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvLateEffectStop",
    )).toBe("effect_in_flight");
    expect(engine.confirmEffect(
      record.threadKey,
      record.executionId,
      effect.token,
    )).toBe(true);
    expect(engine.pendingStopContinuations()).toMatchObject([{
      record: { executionId: record.executionId, threadKey: record.threadKey },
      status: "cancelled",
      stopEventId: "EvLateEffectStop",
    }]);
    expect(engine.beginRender(record.threadKey, record.executionId))
      .toEqual({ status: "cancelled" });
    db.close();
  });

  it("durably converts a Stop behind a render after definitive non-final success or failure", () => {
    for (const resolution of ["confirm", "fail"] as const) {
      const { db, engine, record } = fixture();
      const render = engine.beginRender(record.threadKey, record.executionId);
      if (render.status !== "claimed") throw new Error("render not claimed");
      expect(engine.claimCancellation(
        record.threadKey,
        record.executionId,
        `EvRender-${resolution}`,
      )).toBe("in_flight");
      expect(engine.pendingStopContinuations()).toHaveLength(0);

      const resolved = resolution === "confirm"
        ? engine.confirmRender(record.threadKey, record.executionId, render.token, false, true)
        : engine.failRender(record.threadKey, record.executionId, render.token);
      expect(resolved).toBe(true);
      expect(engine.pendingStopContinuations()).toMatchObject([{
        record: { executionId: record.executionId },
        status: "cancelled",
        stopEventId: `EvRender-${resolution}`,
      }]);
      expect(engine.beginRender(record.threadKey, record.executionId))
        .toEqual({ status: "cancelled" });
      db.close();
    }
  });

  it("moves a near-expiry Stop onto a refreshed continuation lease across retries", () => {
    const { db, engine, record, setNow } = fixture();
    db.prepare(`UPDATE active_turns SET expires_at = 1001 WHERE thread_key = ?`)
      .run(record.threadKey);
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvNearExpiry",
    )).toBe("claimed");
    const claimedExpiry = (db.prepare(
      `SELECT expires_at FROM active_turns WHERE thread_key = ?`,
    ).get(record.threadKey) as { expires_at: number }).expires_at;
    expect(claimedExpiry).toBeGreaterThan(7_200_000);

    setNow(61_000);
    expect(engine.pendingStopContinuations()).toHaveLength(1);
    const retryExpiry = (db.prepare(
      `SELECT expires_at FROM active_turns WHERE thread_key = ?`,
    ).get(record.threadKey) as { expires_at: number }).expires_at;
    expect(retryExpiry).toBeGreaterThan(claimedExpiry);
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvNearExpiry",
    )).toBe("retry");
    expect((db.prepare(
      `SELECT expires_at FROM active_turns WHERE thread_key = ?`,
    ).get(record.threadKey) as { expires_at: number }).expires_at).toBe(retryExpiry);
    db.close();
  });

  it("clears a definitively failed mutation and then permits exact cancellation", () => {
    const { db, engine, record } = fixture();
    const effect = engine.beginEffect(
      record.threadKey,
      record.executionId,
      "memory_write",
    );
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    expect(engine.failEffect(
      record.threadKey,
      record.executionId,
      effect.token,
    )).toBe(true);
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvDefinitiveFailure",
    )).toBe("claimed");
    db.close();
  });

  it("atomically persists a confirmed downstream resource for later exact Stop control", () => {
    const { db, engine, record } = fixture();
    const effect = engine.beginEffect(
      record.threadKey,
      record.executionId,
      "start_task",
    );
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    const resource = {
      kind: "research_task" as const,
      teamId: "team-1",
      taskId: "task-1",
      threadKey: record.threadKey,
    };
    expect(engine.confirmEffect(
      record.threadKey,
      record.executionId,
      effect.token,
      resource,
    )).toBe(true);
    expect(engine.get(record.threadKey)?.effectResource).toEqual(resource);
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvResourceStop",
    )).toBe("claimed");
    expect(engine.pendingStopContinuations()[0]?.effectResource).toEqual(resource);
    db.close();
  });

  it("atomically hands a confirmed resource to an already-recorded Stop", () => {
    const { db, engine, record } = fixture();
    const effect = engine.beginEffect(record.threadKey, record.executionId, "start_task");
    if (effect.status !== "claimed") throw new Error("effect not claimed");
    expect(engine.claimCancellation(
      record.threadKey,
      record.executionId,
      "EvStopDuringConfirm",
    )).toBe("effect_in_flight");
    const resource = {
      kind: "research_task" as const,
      teamId: "team-race",
      taskId: "task-race",
      threadKey: record.threadKey,
    };
    expect(engine.confirmEffect(
      record.threadKey,
      record.executionId,
      effect.token,
      resource,
    )).toBe(true);
    expect(engine.pendingStopContinuations()).toMatchObject([{
      status: "cancelled",
      stopEventId: "EvStopDuringConfirm",
      effectResource: resource,
    }]);
    db.close();
  });

  it("allows a distinct Stop to adopt retryable failures but never an in-flight ack", () => {
    const { db, engine, record } = fixture();
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvOld"))
      .toBe("claimed");
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvNew"))
      .toBe("claimed");
    expect(engine.markCancelControlled(record.threadKey, record.executionId, "EvNew"))
      .toBe(true);
    expect(engine.beginCancelAck(record.threadKey, record.executionId, "EvNew"))
      .toBe(true);
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvOther"))
      .toBe("committed");
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvNew"))
      .toBe("ack_retry");
    expect(engine.confirmCancellationAndClear(
      record.threadKey,
      record.executionId,
      "EvNew",
    )).toBe(true);
    expect(engine.register({ ...record, executionId: "exec-next" }, 7_200_000))
      .toEqual({ accepted: true, duplicate: false });
    db.close();
  });

  it("allows a distinct Stop to adopt a definitive acknowledgement failure", () => {
    const { db, engine, record } = fixture();
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvAckOld"))
      .toBe("claimed");
    expect(engine.markCancelControlled(record.threadKey, record.executionId, "EvAckOld"))
      .toBe(true);
    expect(engine.beginCancelAck(record.threadKey, record.executionId, "EvAckOld"))
      .toBe(true);
    expect(engine.failCancelAck(record.threadKey, record.executionId, "EvAckOld"))
      .toBe(true);
    expect(engine.claimCancellation(record.threadKey, record.executionId, "EvAckNew"))
      .toBe("claimed");
    expect(engine.get(record.threadKey)).toMatchObject({
      status: "cancelled",
      stopEventId: "EvAckNew",
    });
    db.close();
  });
});
