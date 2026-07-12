import type {
  AlarmQueueItem,
  DeliveryObligation,
  OutboxMessage,
  ResearchLogEntry,
  SessionState,
  SessionStateData,
  TaskRecord,
  VerifiedFact,
  FactEdge,
  BlobRef,
  AgentContainerRecord,
  AgentContainerStatus,
  AgentHandoffRecord,
  AgentExecutionLogEntry,
  GithubArtifactRecord,
} from "../types.js";

/** Storage adapter — Postgres or Durable Object SQLite behind this interface. */
export interface StorageAdapter {
  // Session state (OCC)
  getSession(id: string): Promise<SessionState | null>;
  updateSession(
    id: string,
    data: SessionStateData,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<boolean>;
  createSession(
    id: string,
    data: SessionStateData,
    updatedAt: string,
  ): Promise<void>;

  // Research log
  appendLog(entry: ResearchLogEntry): Promise<void>;
  updateLogStatus(id: string, status: ResearchLogEntry["status"], response?: unknown): Promise<void>;
  getLastLog(sessionId: string): Promise<ResearchLogEntry | null>;
  getLogs(sessionId: string, limit?: number): Promise<ResearchLogEntry[]>;

  // Verified facts
  upsertFact(fact: VerifiedFact): Promise<void>;
  getFacts(sessionId: string): Promise<VerifiedFact[]>;
  addFactEdge(edge: FactEdge): Promise<void>;

  // Outbox
  appendOutbox(msg: OutboxMessage): Promise<void>;
  getPendingOutbox(sessionId: string): Promise<OutboxMessage[]>;
  markOutboxSent(id: string): Promise<void>;

  // Idempotency
  isRequestProcessed(requestId: string): Promise<boolean>;
  markRequestProcessed(requestId: string, processedAt: string): Promise<void>;
  isSlackEventProcessed(eventId: string): Promise<boolean>;
  markSlackEventProcessed(eventId: string, processedAt: string): Promise<void>;

  // Tasks (orchestrator)
  createTask(task: TaskRecord): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  updateTaskStatus(taskId: string, status: TaskRecord["status"], metadata?: Record<string, unknown>): Promise<void>;
  getTasksByThread(threadKey: string): Promise<TaskRecord[]>;

  // Delivery obligations
  appendDeliveryObligation(obligation: DeliveryObligation): Promise<void>;
  getPendingDeliveries(threadKey?: string): Promise<DeliveryObligation[]>;
  markDeliveryDelivered(id: string): Promise<void>;

  // Alarm queue
  enqueueAlarm(item: AlarmQueueItem): Promise<void>;
  getDueAlarms(nowMs: number, limit?: number): Promise<AlarmQueueItem[]>;
  deleteAlarm(id: string): Promise<void>;

  // Blob pointers
  storeBlobRef(ref: BlobRef & { createdAt: string }): Promise<void>;
  getBlobRef(logId: string): Promise<BlobRef | null>;

  // Verification cache
  getVerificationCache(requestId: string): Promise<unknown | null>;
  setVerificationCache(requestId: string, verdict: unknown, createdAt: string): Promise<void>;

  // Transactions
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  // Migrations
  migrate(): Promise<void>;

  // Agent containers
  createAgentContainer(record: AgentContainerRecord): Promise<void>;
  getAgentContainer(containerId: string): Promise<AgentContainerRecord | null>;
  updateAgentContainerStatus(
    containerId: string,
    status: AgentContainerStatus,
    fields?: { previewUrl?: string; startedAt?: string; killedAt?: string },
  ): Promise<void>;

  // Agent handoffs
  appendHandoff(record: AgentHandoffRecord): Promise<void>;
  getHandoffs(sessionId: string): Promise<AgentHandoffRecord[]>;

  // Agent execution logs
  appendExecutionLog(entry: AgentExecutionLogEntry): Promise<void>;
  getExecutionLogs(sessionId: string, limit?: number): Promise<AgentExecutionLogEntry[]>;

  // GitHub artifacts
  appendGithubArtifact(record: GithubArtifactRecord): Promise<void>;
}
