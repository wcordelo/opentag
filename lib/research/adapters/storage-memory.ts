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
import type { StorageAdapter } from "./storage.js";

/** In-memory storage adapter for unit tests. */
export class MemoryStorageAdapter implements StorageAdapter {
  private sessions = new Map<string, SessionState>();
  private logs: ResearchLogEntry[] = [];
  private facts: (VerifiedFact & { sessionId: string })[] = [];
  private edges: (FactEdge & { sessionId: string })[] = [];
  private outbox: OutboxMessage[] = [];
  private processedRequests = new Set<string>();
  private processedSlackEvents = new Set<string>();
  private tasks = new Map<string, TaskRecord>();
  private deliveries: DeliveryObligation[] = [];
  private alarms: AlarmQueueItem[] = [];
  private blobs = new Map<string, BlobRef>();
  private verificationCache = new Map<string, unknown>();
  private agentContainers = new Map<string, AgentContainerRecord>();
  private handoffs: AgentHandoffRecord[] = [];
  private executionLogs: AgentExecutionLogEntry[] = [];
  private githubArtifacts: GithubArtifactRecord[] = [];

  async migrate(): Promise<void> {}

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async getSession(id: string): Promise<SessionState | null> {
    return this.sessions.get(id) ?? null;
  }

  async createSession(id: string, data: SessionStateData, updatedAt: string): Promise<void> {
    this.sessions.set(id, { id, data, versionId: 1, updatedAt });
  }

  async updateSession(
    id: string,
    data: SessionStateData,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.versionId !== expectedVersion) return false;
    this.sessions.set(id, { id, data, versionId: s.versionId + 1, updatedAt });
    return true;
  }

  async appendLog(entry: ResearchLogEntry): Promise<void> {
    this.logs.push(entry);
  }

  async updateLogStatus(
    id: string,
    status: ResearchLogEntry["status"],
    response?: unknown,
  ): Promise<void> {
    const log = this.logs.find((l) => l.id === id);
    if (log) {
      log.status = status;
      if (response !== undefined) log.response = response;
    }
  }

  async getLastLog(sessionId: string): Promise<ResearchLogEntry | null> {
    const filtered = this.logs.filter((l) => l.sessionId === sessionId);
    return filtered[filtered.length - 1] ?? null;
  }

  async getLogs(sessionId: string, limit = 100): Promise<ResearchLogEntry[]> {
    return this.logs.filter((l) => l.sessionId === sessionId).slice(0, limit);
  }

  async upsertFact(fact: VerifiedFact & { sessionId?: string }): Promise<void> {
    const sessionId = fact.sessionId ?? "default";
    const idx = this.facts.findIndex((f) => f.factHash === fact.factHash);
    const entry = { ...fact, sessionId };
    if (idx >= 0) this.facts[idx] = entry;
    else this.facts.push(entry);
  }

  async getFacts(sessionId: string): Promise<VerifiedFact[]> {
    return this.facts.filter((f) => f.sessionId === sessionId);
  }

  async addFactEdge(edge: FactEdge & { sessionId?: string }): Promise<void> {
    this.edges.push({ ...edge, sessionId: edge.sessionId ?? "default" });
  }

  async appendOutbox(msg: OutboxMessage): Promise<void> {
    this.outbox.push(msg);
  }

  async getPendingOutbox(sessionId: string): Promise<OutboxMessage[]> {
    return this.outbox.filter((m) => m.sessionId === sessionId && m.status === "pending");
  }

  async markOutboxSent(id: string): Promise<void> {
    const m = this.outbox.find((o) => o.id === id);
    if (m) m.status = "sent";
  }

  async isRequestProcessed(requestId: string): Promise<boolean> {
    return this.processedRequests.has(requestId);
  }

  async markRequestProcessed(requestId: string, _processedAt: string): Promise<void> {
    this.processedRequests.add(requestId);
  }

  async isSlackEventProcessed(eventId: string): Promise<boolean> {
    return this.processedSlackEvents.has(eventId);
  }

  async markSlackEventProcessed(eventId: string): Promise<void> {
    this.processedSlackEvents.add(eventId);
  }

  async createTask(task: TaskRecord): Promise<void> {
    this.tasks.set(task.taskId, task);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskRecord["status"],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (t) this.tasks.set(taskId, { ...t, status, metadata: metadata ?? t.metadata });
  }

  async getTasksByThread(threadKey: string): Promise<TaskRecord[]> {
    return [...this.tasks.values()].filter((t) => t.threadKey === threadKey);
  }

  async appendDeliveryObligation(obligation: DeliveryObligation): Promise<void> {
    this.deliveries.push(obligation);
  }

  async getPendingDeliveries(threadKey?: string): Promise<DeliveryObligation[]> {
    return this.deliveries.filter(
      (d) => d.status === "pending" && (!threadKey || d.threadKey === threadKey),
    );
  }

  async markDeliveryDelivered(id: string): Promise<void> {
    const d = this.deliveries.find((o) => o.id === id);
    if (d) d.status = "delivered";
  }

  async enqueueAlarm(item: AlarmQueueItem): Promise<void> {
    const idx = this.alarms.findIndex((a) => a.id === item.id);
    if (idx >= 0) this.alarms[idx] = item;
    else this.alarms.push(item);
  }

  async getDueAlarms(nowMs: number, limit = 10): Promise<AlarmQueueItem[]> {
    return this.alarms
      .filter((a) => a.runAtMs <= nowMs)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.runAtMs - b.runAtMs)
      .slice(0, limit);
  }

  async deleteAlarm(id: string): Promise<void> {
    this.alarms = this.alarms.filter((a) => a.id !== id);
  }

  async storeBlobRef(ref: BlobRef & { createdAt: string }): Promise<void> {
    this.blobs.set(ref.logId, ref);
  }

  async getBlobRef(logId: string): Promise<BlobRef | null> {
    return this.blobs.get(logId) ?? null;
  }

  async getVerificationCache(requestId: string): Promise<unknown | null> {
    return this.verificationCache.get(requestId) ?? null;
  }

  async setVerificationCache(requestId: string, verdict: unknown, _createdAt: string): Promise<void> {
    this.verificationCache.set(requestId, verdict);
  }

  async createAgentContainer(record: AgentContainerRecord): Promise<void> {
    this.agentContainers.set(record.containerId, record);
  }

  async getAgentContainer(containerId: string): Promise<AgentContainerRecord | null> {
    return this.agentContainers.get(containerId) ?? null;
  }

  async updateAgentContainerStatus(
    containerId: string,
    status: AgentContainerStatus,
    fields?: { previewUrl?: string; startedAt?: string; killedAt?: string },
  ): Promise<void> {
    const record = this.agentContainers.get(containerId);
    if (!record) return;
    this.agentContainers.set(containerId, {
      ...record,
      status,
      previewUrl: fields?.previewUrl ?? record.previewUrl,
      startedAt: fields?.startedAt ?? record.startedAt,
      killedAt: fields?.killedAt ?? record.killedAt,
    });
  }

  async appendHandoff(record: AgentHandoffRecord): Promise<void> {
    this.handoffs.push(record);
  }

  async getHandoffs(sessionId: string): Promise<AgentHandoffRecord[]> {
    return this.handoffs
      .filter((h) => h.fromSessionId === sessionId || h.toSessionId === sessionId)
      .sort((a, b) => a.round - b.round);
  }

  async appendExecutionLog(entry: AgentExecutionLogEntry): Promise<void> {
    this.executionLogs.push(entry);
  }

  async getExecutionLogs(sessionId: string, limit = 100): Promise<AgentExecutionLogEntry[]> {
    return this.executionLogs.filter((e) => e.sessionId === sessionId).slice(0, limit);
  }

  async appendGithubArtifact(record: GithubArtifactRecord): Promise<void> {
    this.githubArtifacts.push(record);
  }
}
