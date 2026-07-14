/**
 * Durable Object SQLite storage adapter — Cloudflare research task plane.
 *
 * Thin wrapper around ctx.storage.sql implementing StorageAdapter.
 * Used by Cloudflare research DO classes (edge/workers/orchestrator);
 * shares lib/research core logic.
 */
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

/** Minimal SQL executor interface matching DO storage.sql */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): unknown;
}

interface TaskDbRow {
  task_id: string;
  thread_key: string;
  status: TaskRecord["status"];
  objective: string;
  created_at: string;
  deadline_at: string | null;
  event_ts: string | null;
  event_id: string | null;
  metadata: string | null;
}

function mapTaskRow(row: TaskDbRow): TaskRecord {
  return {
    taskId: row.task_id,
    threadKey: row.thread_key,
    status: row.status,
    objective: row.objective,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at ?? undefined,
    eventTs: row.event_ts ?? undefined,
    eventId: row.event_id ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

interface DeliveryDbRow {
  id: string;
  thread_key: string;
  payload: string;
  status: DeliveryObligation["status"];
}

function mapDeliveryRow(row: DeliveryDbRow): DeliveryObligation {
  return {
    id: row.id,
    threadKey: row.thread_key,
    payload: JSON.parse(row.payload) as DeliveryObligation["payload"],
    status: row.status,
  };
}

interface OutboxDbRow {
  id: string;
  session_id: string;
  target_actor: string;
  payload: string;
  status: OutboxMessage["status"];
  created_at: string;
}

function mapOutboxRow(row: OutboxDbRow): OutboxMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    targetActor: row.target_actor,
    payload: JSON.parse(row.payload) as OutboxMessage["payload"],
    status: row.status,
    createdAt: row.created_at,
  };
}

interface AlarmDbRow {
  id: string;
  session_id: string;
  kind: AlarmQueueItem["kind"];
  run_at_ms: number;
  payload: string | null;
  priority: number | null;
}

function mapAlarmRow(row: AlarmDbRow): AlarmQueueItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    runAtMs: row.run_at_ms,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined,
    priority: row.priority ?? undefined,
  };
}

interface AgentContainerDbRow {
  container_id: string;
  session_id: string;
  flavor: AgentContainerRecord["flavor"];
  status: AgentContainerStatus;
  preview_url: string | null;
  started_at: string | null;
  killed_at: string | null;
}

function mapAgentContainerRow(row: AgentContainerDbRow): AgentContainerRecord {
  return {
    containerId: row.container_id,
    sessionId: row.session_id,
    flavor: row.flavor,
    status: row.status,
    previewUrl: row.preview_url ?? undefined,
    startedAt: row.started_at ?? undefined,
    killedAt: row.killed_at ?? undefined,
  };
}

interface AgentHandoffDbRow {
  id: string;
  from_session_id: string;
  to_session_id: string;
  round: number;
  compressed_tokens: number | null;
  validated: number | boolean;
  created_at: string;
}

function mapHandoffRow(row: AgentHandoffDbRow): AgentHandoffRecord {
  return {
    id: row.id,
    fromSessionId: row.from_session_id,
    toSessionId: row.to_session_id,
    round: row.round,
    compressedTokens: row.compressed_tokens ?? undefined,
    validated: Boolean(row.validated),
    createdAt: row.created_at,
  };
}

interface AgentExecutionLogDbRow {
  id: string;
  session_id: string | null;
  container_id: string | null;
  step: string | null;
  tool_name: string | null;
  request: string | null;
  response: string | null;
  duration_ms: number | null;
  created_at: string;
}

function mapExecutionLogRow(row: AgentExecutionLogDbRow): AgentExecutionLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    containerId: row.container_id ?? undefined,
    step: row.step ?? undefined,
    toolName: row.tool_name ?? undefined,
    request: row.request ? JSON.parse(row.request) : undefined,
    response: row.response ? JSON.parse(row.response) : undefined,
    durationMs: row.duration_ms ?? undefined,
    createdAt: row.created_at,
  };
}

export class DurableObjectStorageAdapter implements StorageAdapter {
  constructor(private readonly sql: SqlExecutor) {}

  async migrate(): Promise<void> {
    // Schema applied via DO SQLite migrations in wrangler
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.sql.exec("BEGIN TRANSACTION");
    try {
      const result = await fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    }
  }

  async getSession(id: string): Promise<SessionState | null> {
    const cursor = this.sql.exec(
      "SELECT id, data, version_id, updated_at FROM session_state WHERE id = ?",
      id,
    );
    const rows = cursor as { toArray: () => Array<{ id: string; data: string; version_id: number; updated_at: string }> };
    const row = rows.toArray?.()?.[0];
    if (!row) return null;
    return {
      id: row.id,
      data: JSON.parse(row.data) as SessionStateData,
      versionId: row.version_id,
      updatedAt: row.updated_at,
    };
  }

  async createSession(id: string, data: SessionStateData, updatedAt: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO session_state (id, data, version_id, updated_at) VALUES (?, ?, 1, ?)",
      id,
      JSON.stringify(data),
      updatedAt,
    );
  }

  async updateSession(
    id: string,
    data: SessionStateData,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<boolean> {
    const cursor = this.sql.exec(
      "UPDATE session_state SET data = ?, version_id = version_id + 1, updated_at = ? WHERE id = ? AND version_id = ?",
      JSON.stringify(data),
      updatedAt,
      id,
      expectedVersion,
    );
    const meta = cursor as { rowsWritten?: number };
    return (meta.rowsWritten ?? 0) > 0;
  }

  async appendLog(entry: ResearchLogEntry): Promise<void> {
    this.sql.exec(
      `INSERT INTO research_log (id, session_id, step_index, status, tool_name, request, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.sessionId,
      entry.stepIndex,
      entry.status,
      entry.toolName ?? null,
      entry.request ? JSON.stringify(entry.request) : null,
      entry.response ? JSON.stringify(entry.response) : null,
      entry.createdAt,
    );
  }

  async updateLogStatus(id: string, status: ResearchLogEntry["status"], response?: unknown): Promise<void> {
    this.sql.exec(
      "UPDATE research_log SET status = ?, response = COALESCE(?, response) WHERE id = ?",
      status,
      response ? JSON.stringify(response) : null,
      id,
    );
  }

  async getLastLog(sessionId: string): Promise<ResearchLogEntry | null> {
    const cursor = this.sql.exec(
      "SELECT * FROM research_log WHERE session_id = ? ORDER BY step_index DESC LIMIT 1",
      sessionId,
    );
    const rows = cursor as { toArray: () => ResearchLogEntry[] };
    return rows.toArray?.()?.[0] ?? null;
  }

  async getLogs(sessionId: string, limit = 100): Promise<ResearchLogEntry[]> {
    const cursor = this.sql.exec(
      "SELECT * FROM research_log WHERE session_id = ? ORDER BY step_index ASC LIMIT ?",
      sessionId,
      limit,
    );
    const rows = cursor as { toArray: () => ResearchLogEntry[] };
    return rows.toArray?.() ?? [];
  }

  async upsertFact(fact: VerifiedFact & { sessionId?: string }): Promise<void> {
    const sessionId = fact.sessionId ?? "default";
    this.sql.exec(
      `INSERT INTO verified_facts (fact_hash, session_id, content, source_url, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(fact_hash) DO UPDATE SET content = excluded.content`,
      fact.factHash,
      sessionId,
      fact.content,
      fact.sourceUrl ?? null,
      fact.confidence ?? null,
      fact.createdAt,
    );
  }

  async getFacts(sessionId: string): Promise<VerifiedFact[]> {
    const cursor = this.sql.exec(
      "SELECT * FROM verified_facts WHERE session_id = ?",
      sessionId,
    );
    return (cursor as { toArray: () => VerifiedFact[] }).toArray?.() ?? [];
  }

  async addFactEdge(edge: FactEdge & { sessionId?: string }): Promise<void> {
    const sessionId = edge.sessionId ?? "default";
    this.sql.exec(
      "INSERT INTO fact_edges (session_id, from_hash, to_hash, relation) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      sessionId,
      edge.fromHash,
      edge.toHash,
      edge.relation,
    );
  }

  async appendOutbox(msg: OutboxMessage): Promise<void> {
    this.sql.exec(
      "INSERT INTO outbox (id, session_id, target_actor, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      msg.id,
      msg.sessionId,
      msg.targetActor,
      JSON.stringify(msg.payload),
      msg.status,
      msg.createdAt,
    );
  }

  async appendOutboxIfTaskActive(msg: OutboxMessage): Promise<boolean> {
    const cursor = this.sql.exec(
      `INSERT INTO outbox (id, session_id, target_actor, payload, status, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM tasks WHERE task_id = ? AND status IN ('pending', 'running')
       )`,
      msg.id,
      msg.sessionId,
      msg.targetActor,
      JSON.stringify(msg.payload),
      msg.status,
      msg.createdAt,
      msg.sessionId,
    );
    return ((cursor as { rowsWritten?: number }).rowsWritten ?? 0) > 0;
  }

  async getPendingOutbox(sessionId: string): Promise<OutboxMessage[]> {
    const cursor = this.sql.exec(
      "SELECT * FROM outbox WHERE session_id = ? AND status = 'pending'",
      sessionId,
    );
    const rows = (cursor as { toArray: () => OutboxDbRow[] }).toArray?.() ?? [];
    return rows.map(mapOutboxRow);
  }

  async markOutboxSent(id: string): Promise<void> {
    this.sql.exec("UPDATE outbox SET status = 'sent' WHERE id = ?", id);
  }

  async isRequestProcessed(requestId: string): Promise<boolean> {
    const cursor = this.sql.exec(
      "SELECT 1 FROM processed_requests WHERE request_id = ?",
      requestId,
    );
    return ((cursor as { toArray: () => unknown[] }).toArray?.() ?? []).length > 0;
  }

  async markRequestProcessed(requestId: string, processedAt: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO processed_requests (request_id, processed_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
      requestId,
      processedAt,
    );
  }

  async isSlackEventProcessed(eventId: string): Promise<boolean> {
    const cursor = this.sql.exec(
      "SELECT 1 FROM processed_slack_events WHERE event_id = ?",
      eventId,
    );
    return ((cursor as { toArray: () => unknown[] }).toArray?.() ?? []).length > 0;
  }

  async markSlackEventProcessed(eventId: string, processedAt: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO processed_slack_events (event_id, processed_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
      eventId,
      processedAt,
    );
  }

  async createTask(task: TaskRecord): Promise<void> {
    this.sql.exec(
      `INSERT INTO tasks (task_id, thread_key, status, objective, created_at, deadline_at, event_ts, event_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.taskId,
      task.threadKey,
      task.status,
      task.objective,
      task.createdAt,
      task.deadlineAt ?? null,
      task.eventTs ?? null,
      task.eventId ?? null,
      task.metadata ? JSON.stringify(task.metadata) : null,
    );
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const cursor = this.sql.exec("SELECT * FROM tasks WHERE task_id = ?", taskId);
    const rows = (cursor as { toArray: () => TaskDbRow[] }).toArray?.() ?? [];
    const row = rows[0];
    return row ? mapTaskRow(row) : null;
  }

  async updateTaskStatus(taskId: string, status: TaskRecord["status"], metadata?: Record<string, unknown>): Promise<void> {
    this.sql.exec(
      "UPDATE tasks SET status = ?, metadata = COALESCE(?, metadata) WHERE task_id = ?",
      status,
      metadata ? JSON.stringify(metadata) : null,
      taskId,
    );
  }

  async updateTaskStatusIfActive(
    taskId: string,
    status: TaskRecord["status"],
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const cursor = this.sql.exec(
      `UPDATE tasks SET status = ?, metadata = COALESCE(?, metadata)
       WHERE task_id = ? AND status IN ('pending', 'running')`,
      status,
      metadata ? JSON.stringify(metadata) : null,
      taskId,
    );
    return ((cursor as { rowsWritten?: number }).rowsWritten ?? 0) > 0;
  }

  async getTasksByThread(threadKey: string): Promise<TaskRecord[]> {
    const cursor = this.sql.exec(
      "SELECT * FROM tasks WHERE thread_key = ? ORDER BY created_at DESC",
      threadKey,
    );
    const rows = (cursor as { toArray: () => TaskDbRow[] }).toArray?.() ?? [];
    return rows.map(mapTaskRow);
  }

  async cancelResearchTask(taskId: string, expectedThreadKey: string) {
    this.sql.exec("BEGIN TRANSACTION");
    try {
      const task = this.getTaskSync(taskId);
      if (!task) {
        this.sql.exec("ROLLBACK");
        return { status: "not_found" as const, taskId };
      }
      if (task.threadKey !== expectedThreadKey) {
        this.sql.exec("ROLLBACK");
        return { status: "thread_mismatch" as const, taskId };
      }
      const already = task.status === "cancelled";
      this.sql.exec(
        `UPDATE tasks SET status = 'cancelled',
           metadata = json_patch(COALESCE(metadata, '{}'), json_object('cancelledAt', ?))
         WHERE task_id = ?`,
        new Date().toISOString(),
        taskId,
      );
      const cursor = this.sql.exec(
        "SELECT data FROM session_state WHERE id = ?",
        taskId,
      ) as { toArray?: () => Array<{ data: string }> };
      const row = cursor.toArray?.()[0];
      if (row) {
        const data = JSON.parse(row.data) as SessionStateData;
        this.sql.exec(
          `UPDATE session_state SET data = ?, version_id = version_id + 1,
             updated_at = ? WHERE id = ?`,
          JSON.stringify({ ...data, status: "cancelled", externalJob: undefined }),
          new Date().toISOString(),
          taskId,
        );
      }
      this.sql.exec(
        "UPDATE outbox SET status = 'failed' WHERE session_id = ? AND status = 'pending'",
        taskId,
      );
      this.sql.exec(
        `UPDATE delivery_obligations SET status = 'failed'
         WHERE status = 'pending' AND json_extract(payload, '$.taskId') = ?`,
        taskId,
      );
      const inFlightCursor = this.sql.exec(
        `SELECT COUNT(*) AS count FROM delivery_obligations
         WHERE status = 'in_flight' AND json_extract(payload, '$.taskId') = ?`,
        taskId,
      ) as { toArray?: () => Array<{ count: number }> };
      const quiescent = Number(inFlightCursor.toArray?.()[0]?.count ?? 0) === 0;
      this.sql.exec("DELETE FROM alarm_queue WHERE session_id = ?", taskId);
      this.sql.exec("COMMIT");
      return {
        status: already ? "already_cancelled" as const : "cancelled" as const,
        taskId,
        quiescent,
      };
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    }
  }

  private getTaskSync(taskId: string): TaskRecord | null {
    const cursor = this.sql.exec("SELECT * FROM tasks WHERE task_id = ?", taskId);
    const rows = (cursor as { toArray: () => TaskDbRow[] }).toArray?.() ?? [];
    return rows[0] ? mapTaskRow(rows[0]) : null;
  }

  async appendDeliveryObligation(obligation: DeliveryObligation): Promise<void> {
    this.sql.exec(
      "INSERT INTO delivery_obligations (id, thread_key, payload, status) VALUES (?, ?, ?, ?)",
      obligation.id,
      obligation.threadKey,
      JSON.stringify(obligation.payload),
      obligation.status,
    );
  }

  async appendDeliveryObligationIfTaskActive(obligation: DeliveryObligation): Promise<boolean> {
    const cursor = this.sql.exec(
      `INSERT INTO delivery_obligations (id, thread_key, payload, status)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM tasks WHERE task_id = ? AND status IN ('pending', 'running')
       )`,
      obligation.id,
      obligation.threadKey,
      JSON.stringify(obligation.payload),
      obligation.status,
      obligation.payload.taskId,
    );
    return ((cursor as { rowsWritten?: number }).rowsWritten ?? 0) > 0;
  }

  async getPendingDeliveries(threadKey?: string): Promise<DeliveryObligation[]> {
    const query = threadKey
      ? "SELECT * FROM delivery_obligations WHERE status = 'pending' AND thread_key = ?"
      : "SELECT * FROM delivery_obligations WHERE status = 'pending'";
    const cursor = threadKey
      ? this.sql.exec(query, threadKey)
      : this.sql.exec(query);
    const rows = (cursor as { toArray: () => DeliveryDbRow[] }).toArray?.() ?? [];
    return rows.map(mapDeliveryRow);
  }

  async getDeliveriesToDrain(threadKey?: string): Promise<DeliveryObligation[]> {
    const query = threadKey
      ? "SELECT * FROM delivery_obligations WHERE status IN ('pending', 'in_flight') AND thread_key = ?"
      : "SELECT * FROM delivery_obligations WHERE status IN ('pending', 'in_flight')";
    const cursor = threadKey ? this.sql.exec(query, threadKey) : this.sql.exec(query);
    const rows = (cursor as { toArray: () => DeliveryDbRow[] }).toArray?.() ?? [];
    return rows.map(mapDeliveryRow);
  }

  async claimDelivery(id: string): Promise<DeliveryObligation | null> {
    this.sql.exec(
      `UPDATE delivery_obligations SET status = 'in_flight'
       WHERE id = ? AND status = 'pending' AND EXISTS (
         SELECT 1 FROM tasks
         WHERE task_id = json_extract(delivery_obligations.payload, '$.taskId')
           AND status IN ('pending', 'running')
       )`,
      id,
    );
    const cursor = this.sql.exec(
      "SELECT * FROM delivery_obligations WHERE id = ? AND status = 'in_flight'",
      id,
    );
    const row = (cursor as { toArray: () => DeliveryDbRow[] }).toArray?.()[0];
    return row ? mapDeliveryRow(row) : null;
  }

  async markDeliveryDelivered(id: string): Promise<void> {
    this.sql.exec(
      "UPDATE delivery_obligations SET status = 'delivered' WHERE id = ? AND status = 'in_flight'",
      id,
    );
  }

  async markDeliverySuppressed(id: string): Promise<void> {
    this.sql.exec(
      "UPDATE delivery_obligations SET status = 'failed' WHERE id = ? AND status = 'in_flight'",
      id,
    );
  }

  async enqueueAlarm(item: AlarmQueueItem): Promise<void> {
    this.sql.exec(
      `INSERT INTO alarm_queue (id, session_id, kind, run_at_ms, payload, priority)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET run_at_ms = excluded.run_at_ms`,
      item.id,
      item.sessionId,
      item.kind,
      item.runAtMs,
      item.payload ? JSON.stringify(item.payload) : null,
      item.priority ?? 0,
    );
  }

  async enqueueAlarmIfTaskActive(item: AlarmQueueItem): Promise<boolean> {
    const cursor = this.sql.exec(
      `INSERT INTO alarm_queue (id, session_id, kind, run_at_ms, payload, priority)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM tasks WHERE task_id = ? AND status IN ('pending', 'running')
       )
       ON CONFLICT(id) DO UPDATE SET run_at_ms = excluded.run_at_ms`,
      item.id,
      item.sessionId,
      item.kind,
      item.runAtMs,
      item.payload ? JSON.stringify(item.payload) : null,
      item.priority ?? 0,
      item.sessionId,
    );
    return ((cursor as { rowsWritten?: number }).rowsWritten ?? 0) > 0;
  }

  async getDueAlarms(nowMs: number, limit = 10): Promise<AlarmQueueItem[]> {
    const cursor = this.sql.exec(
      "SELECT * FROM alarm_queue WHERE run_at_ms <= ? ORDER BY priority DESC, run_at_ms ASC LIMIT ?",
      nowMs,
      limit,
    );
    const rows = (cursor as { toArray: () => AlarmDbRow[] }).toArray?.() ?? [];
    return rows.map(mapAlarmRow);
  }

  async deleteAlarm(id: string): Promise<void> {
    this.sql.exec("DELETE FROM alarm_queue WHERE id = ?", id);
  }

  async storeBlobRef(ref: BlobRef & { createdAt: string }): Promise<void> {
    this.sql.exec(
      "INSERT INTO blob_storage (log_id, r2_key, bytes, content_type, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      ref.logId,
      ref.key,
      ref.bytes,
      ref.contentType,
      ref.createdAt,
    );
  }

  async getBlobRef(logId: string): Promise<BlobRef | null> {
    const cursor = this.sql.exec("SELECT * FROM blob_storage WHERE log_id = ?", logId);
    return (cursor as { toArray: () => BlobRef[] }).toArray?.()?.[0] ?? null;
  }

  async getVerificationCache(requestId: string): Promise<unknown | null> {
    const cursor = this.sql.exec(
      "SELECT verdict FROM verification_cache WHERE request_id = ?",
      requestId,
    );
    const rows = (cursor as { toArray: () => Array<{ verdict: string }> }).toArray?.() ?? [];
    return rows[0] ? JSON.parse(rows[0].verdict) : null;
  }

  async setVerificationCache(requestId: string, verdict: unknown, createdAt: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO verification_cache (request_id, verdict, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      requestId,
      JSON.stringify(verdict),
      createdAt,
    );
  }

  async createAgentContainer(record: AgentContainerRecord): Promise<void> {
    this.sql.exec(
      `INSERT INTO agent_containers (container_id, session_id, flavor, status, preview_url, started_at, killed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.containerId,
      record.sessionId,
      record.flavor,
      record.status,
      record.previewUrl ?? null,
      record.startedAt ?? null,
      record.killedAt ?? null,
    );
  }

  async getAgentContainer(containerId: string): Promise<AgentContainerRecord | null> {
    const cursor = this.sql.exec(
      "SELECT * FROM agent_containers WHERE container_id = ?",
      containerId,
    );
    const rows = (cursor as { toArray: () => AgentContainerDbRow[] }).toArray?.() ?? [];
    const row = rows[0];
    return row ? mapAgentContainerRow(row) : null;
  }

  async updateAgentContainerStatus(
    containerId: string,
    status: AgentContainerStatus,
    fields?: { previewUrl?: string; startedAt?: string; killedAt?: string },
  ): Promise<void> {
    this.sql.exec(
      `UPDATE agent_containers
       SET status = ?, preview_url = COALESCE(?, preview_url), started_at = COALESCE(?, started_at), killed_at = COALESCE(?, killed_at)
       WHERE container_id = ?`,
      status,
      fields?.previewUrl ?? null,
      fields?.startedAt ?? null,
      fields?.killedAt ?? null,
      containerId,
    );
  }

  async appendHandoff(record: AgentHandoffRecord): Promise<void> {
    this.sql.exec(
      `INSERT INTO agent_handoffs (id, from_session_id, to_session_id, round, compressed_tokens, validated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.fromSessionId,
      record.toSessionId,
      record.round,
      record.compressedTokens ?? null,
      record.validated ? 1 : 0,
      record.createdAt,
    );
  }

  async getHandoffs(sessionId: string): Promise<AgentHandoffRecord[]> {
    const cursor = this.sql.exec(
      `SELECT * FROM agent_handoffs WHERE from_session_id = ? OR to_session_id = ? ORDER BY round ASC`,
      sessionId,
      sessionId,
    );
    const rows = (cursor as { toArray: () => AgentHandoffDbRow[] }).toArray?.() ?? [];
    return rows.map(mapHandoffRow);
  }

  async appendExecutionLog(entry: AgentExecutionLogEntry): Promise<void> {
    this.sql.exec(
      `INSERT INTO agent_execution_logs (id, session_id, container_id, step, tool_name, request, response, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.sessionId ?? null,
      entry.containerId ?? null,
      entry.step ?? null,
      entry.toolName ?? null,
      entry.request ? JSON.stringify(entry.request) : null,
      entry.response ? JSON.stringify(entry.response) : null,
      entry.durationMs ?? null,
      entry.createdAt,
    );
  }

  async getExecutionLogs(sessionId: string, limit = 100): Promise<AgentExecutionLogEntry[]> {
    const cursor = this.sql.exec(
      "SELECT * FROM agent_execution_logs WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
      sessionId,
      limit,
    );
    const rows = (cursor as { toArray: () => AgentExecutionLogDbRow[] }).toArray?.() ?? [];
    return rows.map(mapExecutionLogRow);
  }

  async appendGithubArtifact(record: GithubArtifactRecord): Promise<void> {
    this.sql.exec(
      `INSERT INTO github_artifacts (id, session_id, pr_url, commit_sha, branch_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.id,
      record.sessionId,
      record.prUrl ?? null,
      record.commitSha ?? null,
      record.branchName ?? null,
      record.createdAt,
    );
  }
}
