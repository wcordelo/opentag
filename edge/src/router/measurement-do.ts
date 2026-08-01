import { DurableObject } from "cloudflare:workers";
import type { SqlExecutor } from "../store/sql.js";
import {
  RouterMeasurementError,
  type RouterDispatchMeasurement,
  type RouterFeedbackRecord,
  type RouterMeasurementOutcome,
  routerFeedbackFeatures,
  validateRouterDispatchMeasurement,
  validateRouterFeedback,
  routerMeasurementOutcome,
} from "./measurement.js";

const RETENTION_DAYS = 30;
const MAX_LIST_LIMIT = 100;

const DDL = [
  `CREATE TABLE IF NOT EXISTS router_dispatch_measurements (
     execution_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     thread_key TEXT NOT NULL,
     record_json TEXT NOT NULL,
     tier_decided INTEGER NOT NULL CHECK (tier_decided IN (1, 2, 3)),
     tier_dispatched INTEGER NOT NULL CHECK (tier_dispatched IN (1, 2, 3)),
     shadow INTEGER NOT NULL CHECK (shadow IN (0, 1)),
     outcome TEXT,
     recorded_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_router_dispatch_workspace
   ON router_dispatch_measurements(workspace_id, recorded_at)`,
  `CREATE TABLE IF NOT EXISTS router_feedback (
     feedback_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     execution_id TEXT NOT NULL,
     feedback_json TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_router_feedback_workspace
   ON router_feedback(workspace_id, created_at)`,
];

type DispatchRow = {
  execution_id: string;
  workspace_id: string;
  thread_key: string;
  record_json: string;
  tier_decided: number;
  tier_dispatched: number;
  shadow: number;
  outcome: string | null;
  recorded_at: string;
  updated_at: string;
};

type FeedbackRow = {
  feedback_id: string;
  workspace_id: string;
  execution_id: string;
  feedback_json: string;
  kind: string;
  created_at: string;
};

function migrate(sql: SqlExecutor): void {
  for (const statement of DDL) sql.exec(statement);
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new RouterMeasurementError("router_measurement_corrupt", 503);
  }
}

function id(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RouterMeasurementError(`${field}_invalid`);
  }
  return value;
}

function limit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LIST_LIMIT) {
    throw new RouterMeasurementError("limit_invalid");
  }
  return value as number;
}

function now(): string {
  return new Date().toISOString();
}

function dispatchFromRow(row: DispatchRow): RouterDispatchMeasurement {
  return validateRouterDispatchMeasurement(parseJson<unknown>(row.record_json));
}

function feedbackFromRow(row: FeedbackRow): RouterFeedbackRecord {
  return validateRouterFeedback(parseJson<unknown>(row.feedback_json));
}

function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => {
    throw new RouterMeasurementError("invalid_json");
  });
}

function responseForError(error: unknown): Response {
  if (error instanceof RouterMeasurementError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  console.error(
    "[router-measurement] request failed",
    error instanceof Error ? error.message : "unknown",
  );
  return Response.json({ error: "router_measurement_internal_error" }, { status: 503 });
}

export class RouterMeasurementDO extends DurableObject {
  private readonly sql: SqlExecutor;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = this.ctx.storage.sql as unknown as SqlExecutor;
    void this.ctx.blockConcurrencyWhile(async () => migrate(this.sql));
  }

  private prune(nowIso: string): void {
    const cutoff = new Date(Date.parse(nowIso) - RETENTION_DAYS * 86_400_000).toISOString();
    this.sql.exec("DELETE FROM router_feedback WHERE created_at < ?", cutoff);
    this.sql.exec("DELETE FROM router_dispatch_measurements WHERE recorded_at < ?", cutoff);
  }

  private record(value: unknown): { ok: true; duplicate: boolean; record: RouterDispatchMeasurement } {
    const record = validateRouterDispatchMeasurement(value);
    const timestamp = now();
    this.prune(timestamp);
    const existing = this.sql
      .exec<DispatchRow>(
        "SELECT * FROM router_dispatch_measurements WHERE execution_id = ?",
        record.executionId,
      )
      .toArray()[0];
    if (existing) {
      const current = dispatchFromRow(existing);
      if (JSON.stringify(current) !== JSON.stringify(record)) {
        throw new RouterMeasurementError("dispatch_measurement_conflict", 409);
      }
      return { ok: true, duplicate: true, record: current };
    }
    this.sql.exec(
      `INSERT INTO router_dispatch_measurements (
         execution_id, workspace_id, thread_key, record_json, tier_decided,
         tier_dispatched, shadow, outcome, recorded_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.executionId,
      record.workspaceId,
      record.threadKey,
      JSON.stringify(record),
      record.shadowRecord.tierDecided,
      record.shadowRecord.tierDispatched,
      record.shadowRecord.shadow ? 1 : 0,
      record.outcome ?? null,
      record.recordedAt,
      timestamp,
    );
    return { ok: true, duplicate: false, record };
  }

  private outcome(value: unknown): { ok: true; duplicate: boolean; record: RouterDispatchMeasurement } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RouterMeasurementError("outcome_request_invalid");
    }
    const input = value as Record<string, unknown>;
    const workspaceId = id(input.workspaceId, "workspace_id");
    const executionId = id(input.executionId, "execution_id");
    const nextOutcome = routerMeasurementOutcome(input.outcome as RouterMeasurementOutcome);
    const existing = this.sql
      .exec<DispatchRow>(
        "SELECT * FROM router_dispatch_measurements WHERE execution_id = ?",
        executionId,
      )
      .toArray()[0];
    if (!existing) throw new RouterMeasurementError("dispatch_measurement_not_found", 404);
    const current = dispatchFromRow(existing);
    if (current.workspaceId !== workspaceId) {
      throw new RouterMeasurementError("workspace_scope_mismatch", 409);
    }
    if (current.outcome !== undefined) {
      if (
        current.outcome === nextOutcome &&
        (input.outcomeReason === undefined || current.outcomeReason === input.outcomeReason)
      ) {
        return { ok: true, duplicate: true, record: current };
      }
      throw new RouterMeasurementError("router_outcome_conflict", 409);
    }
    const updated = validateRouterDispatchMeasurement({
      ...current,
      outcome: nextOutcome,
      ...(input.outcomeReason === undefined ? {} : { outcomeReason: input.outcomeReason }),
      ...(input.injectedChunkCount === undefined ? {} : { injectedChunkCount: input.injectedChunkCount }),
      ...(input.injectedTokenCount === undefined ? {} : { injectedTokenCount: input.injectedTokenCount }),
    });
    this.sql.exec(
      `UPDATE router_dispatch_measurements
       SET record_json = ?, outcome = ?, updated_at = ?
       WHERE execution_id = ?`,
      JSON.stringify(updated),
      updated.outcome!,
      now(),
      executionId,
    );
    return { ok: true, duplicate: false, record: updated };
  }

  private listDispatch(value: unknown): { workspaceId: string; records: RouterDispatchMeasurement[] } {
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const workspaceId = id(input.workspaceId, "workspace_id");
    const rows = this.sql
      .exec<DispatchRow>(
        `SELECT * FROM router_dispatch_measurements
         WHERE workspace_id = ? ORDER BY recorded_at DESC LIMIT ?`,
        workspaceId,
        limit(input.limit),
      )
      .toArray();
    return { workspaceId, records: rows.map(dispatchFromRow) };
  }

  private summary(value: unknown): Record<string, unknown> {
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const workspaceId = id(input.workspaceId, "workspace_id");
    const rows = this.sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM router_dispatch_measurements WHERE workspace_id = ?",
        workspaceId,
      )
      .toArray();
    const byTier = this.sql
      .exec<{ tier_decided: number; tier_dispatched: number; count: number }>(
        `SELECT tier_decided, tier_dispatched, COUNT(*) AS count
         FROM router_dispatch_measurements WHERE workspace_id = ?
         GROUP BY tier_decided, tier_dispatched`,
        workspaceId,
      )
      .toArray();
    const byOutcome = this.sql
      .exec<{ outcome: string | null; count: number }>(
        `SELECT outcome, COUNT(*) AS count
         FROM router_dispatch_measurements WHERE workspace_id = ?
         GROUP BY outcome`,
        workspaceId,
      )
      .toArray();
    const feedback = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM router_feedback WHERE workspace_id = ?",
        workspaceId,
      )
      .toArray()[0]?.count ?? 0;
    return {
      schemaVersion: 1,
      workspaceId,
      total: rows[0]?.total ?? 0,
      shadowOnly: true,
      tierDecisions: byTier.map((row) => ({
        tierDecided: row.tier_decided,
        tierDispatched: row.tier_dispatched,
        count: row.count,
      })),
      outcomes: byOutcome.map((row) => ({ outcome: row.outcome ?? "pending", count: row.count })),
      feedbackCount: feedback,
    };
  }

  private feedback(value: unknown): { ok: true; duplicate: boolean; feedback: RouterFeedbackRecord } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RouterMeasurementError("feedback_invalid");
    }
    const input = value as Record<string, unknown>;
    const workspaceId = id(input.workspaceId, "workspace_id");
    const executionId = id(input.executionId, "execution_id");
    const dispatch = this.sql
      .exec<DispatchRow>(
        "SELECT * FROM router_dispatch_measurements WHERE execution_id = ?",
        executionId,
      )
      .toArray()[0];
    if (!dispatch) throw new RouterMeasurementError("dispatch_measurement_not_found", 404);
    if (dispatch.workspace_id !== workspaceId) {
      throw new RouterMeasurementError("workspace_scope_mismatch", 409);
    }
    const expectedFeatures = routerFeedbackFeatures(dispatchFromRow(dispatch).shadowRecord);
    const feedback = validateRouterFeedback({
      ...input,
      features: input.features === undefined ? expectedFeatures : input.features,
    });
    if (JSON.stringify(feedback.features) !== JSON.stringify(expectedFeatures)) {
      throw new RouterMeasurementError("feedback_features_mismatch", 409);
    }
    const existing = this.sql
      .exec<FeedbackRow>("SELECT * FROM router_feedback WHERE feedback_id = ?", feedback.feedbackId)
      .toArray()[0];
    if (existing) {
      const current = feedbackFromRow(existing);
      if (JSON.stringify(current) !== JSON.stringify(feedback)) {
        throw new RouterMeasurementError("feedback_conflict", 409);
      }
      return { ok: true, duplicate: true, feedback: current };
    }
    // Retention is anchored to the DO's current clock, never to a caller's
    // event timestamp. A future-dated feedback record must not delete newer
    // dispatch history while it is being inserted.
    this.prune(now());
    this.sql.exec(
      `INSERT INTO router_feedback (
         feedback_id, workspace_id, execution_id, feedback_json, kind, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      feedback.feedbackId,
      feedback.workspaceId,
      feedback.executionId,
      JSON.stringify(feedback),
      feedback.kind,
      feedback.createdAt,
    );
    return { ok: true, duplicate: false, feedback };
  }

  private listFeedback(value: unknown): { workspaceId: string; feedback: RouterFeedbackRecord[] } {
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const workspaceId = id(input.workspaceId, "workspace_id");
    const rows = this.sql
      .exec<FeedbackRow>(
        `SELECT * FROM router_feedback
         WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
        workspaceId,
        limit(input.limit),
      )
      .toArray();
    return { workspaceId, feedback: rows.map(feedbackFromRow) };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        this.sql.exec("SELECT 1 AS ok").one();
        return Response.json({ ok: true, storage: "sqlite", shadowOnly: true });
      }
      if (url.pathname === "/record" && request.method === "POST") {
        return Response.json(this.record(await readJson(request)));
      }
      if (url.pathname === "/outcome" && request.method === "POST") {
        return Response.json(this.outcome(await readJson(request)));
      }
      if (url.pathname === "/dispatch/list" && request.method === "POST") {
        return Response.json(this.listDispatch(await readJson(request)));
      }
      if (url.pathname === "/summary" && request.method === "POST") {
        return Response.json(this.summary(await readJson(request)));
      }
      if (url.pathname === "/feedback" && request.method === "POST") {
        return Response.json(this.feedback(await readJson(request)));
      }
      if (url.pathname === "/feedback/list" && request.method === "POST") {
        return Response.json(this.listFeedback(await readJson(request)));
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return responseForError(error);
    }
  }
}
