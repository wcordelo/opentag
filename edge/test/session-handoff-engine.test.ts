import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/schema.js";
import {
  SessionHandoffEngine,
  SESSION_HANDOFF_MAX_ATTEMPTS,
} from "../src/store/session-handoff-engine.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlExecutor = {
    exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      const stmt = db.prepare(query);
      const args = bindings as Array<string | number | bigint | null>;
      const rows = /^\s*select/i.test(query)
        ? (stmt.all(...args) as T[])
        : (stmt.run(...args), []);
      return {
        toArray: () => rows,
        one: () => rows[0]!,
      };
    },
  };
  migrate(sql);
  let now = 1_000;
  let token = 0;
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
  const engine = new SessionHandoffEngine(
    sql,
    tx,
    () => now,
    () => `claim-${++token}`,
  );
  return { db, engine, setNow: (value: number) => { now = value; } };
}

describe("SessionHandoffEngine", () => {
  it("binds retries to exact execution/message identity and terminal CAS", () => {
    const { db, engine } = fixture();
    engine.start({
      threadKey: "thread-1",
      executionId: "exec-1",
      forwardedMessageId: "message-1",
      inputLines: ["hello"],
    });
    expect(() => engine.start({
      threadKey: "thread-1",
      executionId: "exec-other",
      forwardedMessageId: "message-other",
      inputLines: ["steal"],
    })).toThrow("session_handoff_identity_conflict");
    const claim = engine.claimDue()!;
    expect(claim).toMatchObject({ status: "claimed", attempt: 1, claimToken: "claim-1" });
    expect(engine.complete({
      threadKey: claim.threadKey,
      executionId: claim.executionId,
      claimToken: "stale",
      outcome: "accepted",
    })).toBe(false);
    expect(engine.complete({
      threadKey: claim.threadKey,
      executionId: claim.executionId,
      claimToken: claim.claimToken!,
      outcome: "accepted",
    })).toBe(true);
    expect(engine.get("thread-1")?.status).toBe("accepted");
    db.close();
  });

  it("exhausts the bounded retry budget without deleting terminal evidence", () => {
    const { db, engine, setNow } = fixture();
    engine.start({
      threadKey: "thread-retry",
      executionId: "exec-retry",
      forwardedMessageId: "message-retry",
      inputLines: ["hello"],
    });
    for (let attempt = 1; attempt <= SESSION_HANDOFF_MAX_ATTEMPTS; attempt += 1) {
      const claim = engine.claimDue()!;
      const state = engine.retry({
        threadKey: claim.threadKey,
        executionId: claim.executionId,
        claimToken: claim.claimToken!,
        reason: "transport",
        delayMs: 1,
      });
      expect(state).toBe(attempt === SESSION_HANDOFF_MAX_ATTEMPTS ? "exhausted" : "pending");
      setNow(1_000 + attempt);
    }
    expect(engine.claimDue()).toBeUndefined();
    expect(engine.get("thread-retry")).toMatchObject({
      status: "exhausted",
      attempt: SESSION_HANDOFF_MAX_ATTEMPTS,
      result: "transport",
    });
    db.close();
  });
});
