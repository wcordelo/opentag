import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

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

const { RouterMeasurementDO } = await import("../src/router/measurement-do.js");
import { createRouterDispatchMeasurement } from "../src/router/measurement.js";
import type { RouterShadowRecord } from "../src/router/shadow.js";
import type { SqlCursor, SqlExecutor, SqlValue } from "../src/store/sql.js";

type RouterMeasurementInstance = InstanceType<typeof RouterMeasurementDO>;

function sqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    exec<T = Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<T> {
      const statement = db.prepare(query);
      const params = bindings as Array<string | number | null | bigint>;
      const returnsRows = /^\s*select/i.test(query) || /\breturning\b/i.test(query);
      const rows = returnsRows
        ? statement.all(...params) as T[]
        : (statement.run(...params), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
      };
    },
  };
}

function makeState() {
  const db = new DatabaseSync(":memory:");
  const sql = sqliteExecutor(db);
  const ctx = {
    storage: { sql },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
  const state = new RouterMeasurementDO(ctx as never, {} as never);
  return { state, close: () => db.close() };
}

async function call(
  state: RouterMeasurementInstance,
  path: string,
  body?: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await state.fetch(new Request(`https://do${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

const shadow: RouterShadowRecord = {
  routerSchema: 1,
  patternTable: "v1",
  shadow: true,
  tier1Gate: "dark",
  tierDecided: 1,
  tierDispatched: 2,
  confidence: 0.91,
  classifierPath: "heuristic",
  matchedRule: "t1.01",
  primarySignal: "question_form",
  eligibleTiers: [1, 2],
  classifyLatencyMs: 0,
  surfaceFeatures: {
    hasCodeBlock: false,
    hasAttachment: false,
    wordCount: 5,
    matchedTier1Pattern: true,
    matchedTier2Pattern: false,
    tier3Flag: false,
  },
};

const measurement = createRouterDispatchMeasurement({
  workspaceId: "workspace-1",
  threadKey: "slack:C1:thread-1",
  executionId: "execution-1",
  shadowRecord: shadow,
  recordedAt: "2026-08-01T20:00:00.000Z",
});

describe("RouterMeasurementDO", () => {
  it("keeps dispatch telemetry category-only and records bounded labeled feedback", async () => {
    const { state, close } = makeState();
    try {
      expect((await call(state, "/health")).body).toMatchObject({
        ok: true,
        storage: "sqlite",
        shadowOnly: true,
      });

      const first = await call(state, "/record", measurement);
      expect(first.response.status).toBe(200);
      expect(first.body).toMatchObject({ ok: true, duplicate: false });

      const duplicate = await call(state, "/record", measurement);
      expect(duplicate.response.status).toBe(200);
      expect(duplicate.body).toMatchObject({ ok: true, duplicate: true });

      const outcome = await call(state, "/outcome", {
        workspaceId: measurement.workspaceId,
        executionId: measurement.executionId,
        outcome: "answered",
        injectedChunkCount: 0,
        injectedTokenCount: 0,
      });
      expect(outcome.response.status).toBe(200);
      expect(outcome.body).toMatchObject({ ok: true, duplicate: false });

      const feedback = await call(state, "/feedback", {
        schemaVersion: 1,
        feedbackId: "feedback-1",
        workspaceId: measurement.workspaceId,
        executionId: measurement.executionId,
        kind: "escalated_explicit",
        messageText: "That answer was not what I meant.",
        decidedTier: 1,
        correctedTier: 2,
        createdAt: "2026-08-01T20:01:00.000Z",
      });
      expect(feedback.response.status).toBe(200);
      expect(feedback.body).toMatchObject({ ok: true, duplicate: false });

      const feedbackList = await call(state, "/feedback/list", {
        workspaceId: measurement.workspaceId,
      });
      expect(feedbackList.body.feedback).toMatchObject([{
        feedbackId: "feedback-1",
        messageText: "That answer was not what I meant.",
        features: {
          classifierPath: "heuristic",
          matchedRule: "t1.01",
          primarySignal: "question_form",
          tierDecided: 1,
        },
      }]);

      const summary = await call(state, "/summary", {
        workspaceId: measurement.workspaceId,
      });
      expect(summary.body).toMatchObject({
        workspaceId: measurement.workspaceId,
        total: 1,
        shadowOnly: true,
        feedbackCount: 1,
        tierDecisions: [{ tierDecided: 1, tierDispatched: 2, count: 1 }],
        outcomes: [{ outcome: "answered", count: 1 }],
      });
    } finally {
      close();
    }
  });

  it("rejects cross-workspace feedback and conflicting terminal outcomes", async () => {
    const { state, close } = makeState();
    try {
      await call(state, "/record", measurement);

      const wrongWorkspace = await call(state, "/feedback", {
        schemaVersion: 1,
        feedbackId: "feedback-wrong-workspace",
        workspaceId: "workspace-2",
        executionId: measurement.executionId,
        kind: "escalated_implicit",
        messageText: "No, actually, that is not right.",
        decidedTier: 1,
        correctedTier: 2,
        createdAt: "2026-08-01T20:01:00.000Z",
      });
      expect(wrongWorkspace.response.status).toBe(409);
      expect(wrongWorkspace.body.error).toBe("workspace_scope_mismatch");

      expect((await call(state, "/outcome", {
        workspaceId: measurement.workspaceId,
        executionId: measurement.executionId,
        outcome: "answered",
      })).response.status).toBe(200);
      const conflict = await call(state, "/outcome", {
        workspaceId: measurement.workspaceId,
        executionId: measurement.executionId,
        outcome: "failed",
      });
      expect(conflict.response.status).toBe(409);
      expect(conflict.body.error).toBe("router_outcome_conflict");
    } finally {
      close();
    }
  });
});
