import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { StorageAdapter } from "./storage.js";
import type {
  AlarmQueueItem,
  DeliveryObligation,
  FactEdge,
  OutboxMessage,
  ResearchLogEntry,
  SessionState,
  SessionStateData,
  TaskRecord,
  VerifiedFact,
  BlobRef,
  AgentContainerRecord,
  AgentContainerStatus,
  AgentHandoffRecord,
  AgentExecutionLogEntry,
  GithubArtifactRecord,
} from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class PostgresStorageAdapter implements StorageAdapter {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const tableCheck = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_name = 'schema_migrations'
         ) AS exists`,
      );
      const hasMigrations = tableCheck.rows[0]?.exists ?? false;

      if (hasMigrations) {
        const { rows } = await client.query<{ version: number }>(
          `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
        );
        if ((rows[0]?.version ?? 0) >= 1) return;
      }

      const sql = readFileSync(join(__dirname, "../migrations/001_initial.sql"), "utf8");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING`,
      );
    } finally {
      client.release();
    }
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const origQuery = this.pool.query.bind(this.pool);
      (this.pool as { query: typeof client.query }).query = client.query.bind(client);
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        (this.pool as { query: typeof origQuery }).query = origQuery;
      }
    } finally {
      client.release();
    }
  }

  async getSession(id: string): Promise<SessionState | null> {
    const { rows } = await this.pool.query<{
      id: string;
      data: SessionStateData;
      version_id: number;
      updated_at: Date;
    }>(`SELECT id, data, version_id, updated_at FROM session_state WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      data: row.data,
      versionId: row.version_id,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async createSession(id: string, data: SessionStateData, updatedAt: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_state (id, data, version_id, updated_at) VALUES ($1, $2, 1, $3)`,
      [id, JSON.stringify(data), updatedAt],
    );
  }

  async updateSession(
    id: string,
    data: SessionStateData,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE session_state SET data = $1, version_id = version_id + 1, updated_at = $2
       WHERE id = $3 AND version_id = $4`,
      [JSON.stringify(data), updatedAt, id, expectedVersion],
    );
    return (rowCount ?? 0) > 0;
  }

  async appendLog(entry: ResearchLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO research_log (id, session_id, step_index, status, tool_name, request, response, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.sessionId,
        entry.stepIndex,
        entry.status,
        entry.toolName ?? null,
        entry.request ? JSON.stringify(entry.request) : null,
        entry.response ? JSON.stringify(entry.response) : null,
        entry.createdAt,
      ],
    );
  }

  async updateLogStatus(
    id: string,
    status: ResearchLogEntry["status"],
    response?: unknown,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE research_log SET status = $1, response = COALESCE($2, response) WHERE id = $3`,
      [status, response ? JSON.stringify(response) : null, id],
    );
  }

  async getLastLog(sessionId: string): Promise<ResearchLogEntry | null> {
    const { rows } = await this.pool.query<{
      id: string;
      session_id: string;
      step_index: number;
      status: ResearchLogEntry["status"];
      tool_name: string | null;
      request: unknown;
      response: unknown;
      created_at: Date;
    }>(
      `SELECT * FROM research_log WHERE session_id = $1 ORDER BY step_index DESC LIMIT 1`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    return this.mapLog(row);
  }

  async getLogs(sessionId: string, limit = 100): Promise<ResearchLogEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      session_id: string;
      step_index: number;
      status: string;
      tool_name: string | null;
      request: unknown;
      response: unknown;
      created_at: Date;
    }>(
      `SELECT * FROM research_log WHERE session_id = $1 ORDER BY step_index ASC LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map((r) => this.mapLog(r));
  }

  private mapLog(row: {
    id: string;
    session_id: string;
    step_index: number;
    status: ResearchLogEntry["status"];
    tool_name: string | null;
    request: unknown;
    response: unknown;
    created_at: Date;
  }): ResearchLogEntry {
    return {
      id: row.id,
      sessionId: row.session_id,
      stepIndex: row.step_index,
      status: row.status,
      toolName: row.tool_name ?? undefined,
      request: row.request ?? undefined,
      response: row.response ?? undefined,
      createdAt: row.created_at.toISOString(),
    };
  }

  async upsertFact(fact: VerifiedFact & { sessionId?: string }): Promise<void> {
    const sessionId = (fact as VerifiedFact & { sessionId: string }).sessionId ?? "default";
    await this.pool.query(
      `INSERT INTO verified_facts (fact_hash, session_id, content, source_url, confidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fact_hash) DO UPDATE SET content = EXCLUDED.content`,
      [fact.factHash, sessionId, fact.content, fact.sourceUrl ?? null, fact.confidence ?? null, fact.createdAt],
    );
  }

  async getFacts(sessionId: string): Promise<VerifiedFact[]> {
    const { rows } = await this.pool.query<{
      fact_hash: string;
      content: string;
      source_url: string | null;
      confidence: number | null;
      created_at: Date;
    }>(`SELECT * FROM verified_facts WHERE session_id = $1`, [sessionId]);
    return rows.map((r) => ({
      factHash: r.fact_hash,
      content: r.content,
      sourceUrl: r.source_url ?? undefined,
      confidence: r.confidence ?? undefined,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async addFactEdge(edge: FactEdge & { sessionId?: string }): Promise<void> {
    const sessionId = (edge as FactEdge & { sessionId: string }).sessionId ?? "default";
    await this.pool.query(
      `INSERT INTO fact_edges (session_id, from_hash, to_hash, relation)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [sessionId, edge.fromHash, edge.toHash, edge.relation],
    );
  }

  async appendOutbox(msg: OutboxMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO outbox (id, session_id, target_actor, payload, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [msg.id, msg.sessionId, msg.targetActor, JSON.stringify(msg.payload), msg.status, msg.createdAt],
    );
  }

  async getPendingOutbox(sessionId: string): Promise<OutboxMessage[]> {
    const { rows } = await this.pool.query<{
      id: string;
      session_id: string;
      target_actor: string;
      payload: OutboxMessage["payload"];
      status: OutboxMessage["status"];
      created_at: Date;
    }>(
      `SELECT * FROM outbox WHERE session_id = $1 AND status = 'pending' ORDER BY created_at`,
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      targetActor: r.target_actor,
      payload: r.payload,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async markOutboxSent(id: string): Promise<void> {
    await this.pool.query(`UPDATE outbox SET status = 'sent' WHERE id = $1`, [id]);
  }

  async isRequestProcessed(requestId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM processed_requests WHERE request_id = $1`,
      [requestId],
    );
    return rows.length > 0;
  }

  async markRequestProcessed(requestId: string, processedAt: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_requests (request_id, processed_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [requestId, processedAt],
    );
  }

  async isSlackEventProcessed(eventId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM processed_slack_events WHERE event_id = $1`,
      [eventId],
    );
    return rows.length > 0;
  }

  async markSlackEventProcessed(eventId: string, processedAt: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_slack_events (event_id, processed_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [eventId, processedAt],
    );
  }

  async createTask(task: TaskRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO tasks (task_id, thread_key, status, objective, created_at, deadline_at, event_ts, event_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        task.taskId,
        task.threadKey,
        task.status,
        task.objective,
        task.createdAt,
        task.deadlineAt ?? null,
        task.eventTs ?? null,
        task.eventId ?? null,
        task.metadata ? JSON.stringify(task.metadata) : null,
      ],
    );
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const { rows } = await this.pool.query<{
      task_id: string;
      thread_key: string;
      status: TaskRecord["status"];
      objective: string;
      created_at: Date;
      deadline_at: Date | null;
      event_ts: string | null;
      event_id: string | null;
      metadata: Record<string, unknown> | null;
    }>(`SELECT * FROM tasks WHERE task_id = $1`, [taskId]);
    const row = rows[0];
    if (!row) return null;
    return {
      taskId: row.task_id,
      threadKey: row.thread_key,
      status: row.status,
      objective: row.objective,
      createdAt: row.created_at.toISOString(),
      deadlineAt: row.deadline_at?.toISOString(),
      eventTs: row.event_ts ?? undefined,
      eventId: row.event_id ?? undefined,
      metadata: row.metadata ?? undefined,
    };
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskRecord["status"],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET status = $1, metadata = COALESCE($2, metadata) WHERE task_id = $3`,
      [status, metadata ? JSON.stringify(metadata) : null, taskId],
    );
  }

  async getTasksByThread(threadKey: string): Promise<TaskRecord[]> {
    const { rows } = await this.pool.query<{
      task_id: string;
      thread_key: string;
      status: TaskRecord["status"];
      objective: string;
      created_at: Date;
      deadline_at: Date | null;
      event_ts: string | null;
      event_id: string | null;
      metadata: Record<string, unknown> | null;
    }>(`SELECT * FROM tasks WHERE thread_key = $1 ORDER BY created_at DESC`, [threadKey]);
    return rows.map((row) => ({
      taskId: row.task_id,
      threadKey: row.thread_key,
      status: row.status,
      objective: row.objective,
      createdAt: row.created_at.toISOString(),
      deadlineAt: row.deadline_at?.toISOString(),
      eventTs: row.event_ts ?? undefined,
      eventId: row.event_id ?? undefined,
      metadata: row.metadata ?? undefined,
    }));
  }

  async appendDeliveryObligation(obligation: DeliveryObligation): Promise<void> {
    await this.pool.query(
      `INSERT INTO delivery_obligations (id, thread_key, payload, status)
       VALUES ($1, $2, $3, $4)`,
      [obligation.id, obligation.threadKey, JSON.stringify(obligation.payload), obligation.status],
    );
  }

  async getPendingDeliveries(threadKey?: string): Promise<DeliveryObligation[]> {
    const query = threadKey
      ? `SELECT * FROM delivery_obligations WHERE status = 'pending' AND thread_key = $1`
      : `SELECT * FROM delivery_obligations WHERE status = 'pending'`;
    const params = threadKey ? [threadKey] : [];
    const { rows } = await this.pool.query<{
      id: string;
      thread_key: string;
      payload: DeliveryObligation["payload"];
      status: DeliveryObligation["status"];
    }>(query, params);
    return rows.map((r) => ({
      id: r.id,
      threadKey: r.thread_key,
      payload: r.payload,
      status: r.status,
    }));
  }

  async markDeliveryDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE delivery_obligations SET status = 'delivered' WHERE id = $1`, [id]);
  }

  async enqueueAlarm(item: AlarmQueueItem): Promise<void> {
    await this.pool.query(
      `INSERT INTO alarm_queue (id, session_id, kind, run_at_ms, payload, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET run_at_ms = EXCLUDED.run_at_ms`,
      [
        item.id,
        item.sessionId,
        item.kind,
        item.runAtMs,
        item.payload ? JSON.stringify(item.payload) : null,
        item.priority ?? 0,
      ],
    );
  }

  async getDueAlarms(nowMs: number, limit = 10): Promise<AlarmQueueItem[]> {
    const { rows } = await this.pool.query<{
      id: string;
      session_id: string;
      kind: AlarmQueueItem["kind"];
      run_at_ms: string;
      payload: Record<string, unknown> | null;
      priority: number;
    }>(
      `SELECT * FROM alarm_queue WHERE run_at_ms <= $1 ORDER BY priority DESC, run_at_ms ASC LIMIT $2`,
      [nowMs, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      kind: r.kind,
      runAtMs: Number(r.run_at_ms),
      payload: r.payload ?? undefined,
      priority: r.priority,
    }));
  }

  async deleteAlarm(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM alarm_queue WHERE id = $1`, [id]);
  }

  async storeBlobRef(ref: BlobRef & { createdAt: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO blob_storage (log_id, r2_key, bytes, content_type, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (log_id) DO NOTHING`,
      [ref.logId, ref.key, ref.bytes, ref.contentType, ref.createdAt],
    );
  }

  async getBlobRef(logId: string): Promise<BlobRef | null> {
    const { rows } = await this.pool.query<{
      log_id: string;
      r2_key: string;
      bytes: number;
      content_type: string;
    }>(`SELECT * FROM blob_storage WHERE log_id = $1`, [logId]);
    const row = rows[0];
    if (!row) return null;
    return {
      logId: row.log_id,
      key: row.r2_key,
      bytes: row.bytes,
      contentType: row.content_type,
    };
  }

  async getVerificationCache(requestId: string): Promise<unknown | null> {
    const { rows } = await this.pool.query<{ verdict: unknown }>(
      `SELECT verdict FROM verification_cache WHERE request_id = $1`,
      [requestId],
    );
    return rows[0]?.verdict ?? null;
  }

  async setVerificationCache(
    requestId: string,
    verdict: unknown,
    createdAt: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO verification_cache (request_id, verdict, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (request_id) DO NOTHING`,
      [requestId, JSON.stringify(verdict), createdAt],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createAgentContainer(_record: AgentContainerRecord): Promise<void> {
    throw new Error("not implemented on Railway");
  }

  async getAgentContainer(_containerId: string): Promise<AgentContainerRecord | null> {
    throw new Error("not implemented on Railway");
  }

  async updateAgentContainerStatus(
    _containerId: string,
    _status: AgentContainerStatus,
    _fields?: { previewUrl?: string; startedAt?: string; killedAt?: string },
  ): Promise<void> {
    throw new Error("not implemented on Railway");
  }

  async appendHandoff(_record: AgentHandoffRecord): Promise<void> {
    throw new Error("not implemented on Railway");
  }

  async getHandoffs(_sessionId: string): Promise<AgentHandoffRecord[]> {
    throw new Error("not implemented on Railway");
  }

  async appendExecutionLog(_entry: AgentExecutionLogEntry): Promise<void> {
    throw new Error("not implemented on Railway");
  }

  async getExecutionLogs(_sessionId: string, _limit?: number): Promise<AgentExecutionLogEntry[]> {
    throw new Error("not implemented on Railway");
  }

  async appendGithubArtifact(_record: GithubArtifactRecord): Promise<void> {
    throw new Error("not implemented on Railway");
  }
}

export function createPostgresStorage(connectionString?: string): PostgresStorageAdapter {
  const url = connectionString ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required for Postgres storage");
  return new PostgresStorageAdapter(url);
}
