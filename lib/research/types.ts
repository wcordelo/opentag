/** Shared types for the research actor framework. */

export type TaskStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "superseded";

export type SessionStatus =
  | "running"
  | "cancelled"
  | "superseded"
  | "complete";

export type LogStatus = "pending" | "processing" | "completed" | "failed";

export type Verdict = "pass" | "reject" | "revise";

export type AlarmKind =
  | "fiber_step"
  | "outbox_retry"
  | "prune"
  | "external_poll";

export type OutboxStatus = "pending" | "sent" | "failed";

export interface TaskBudget {
  maxAlarms: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxUsdEstimate?: number;
}

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxAlarms: 200,
  maxLlmCalls: 50,
  maxToolCalls: 100,
};

export interface TaskRecord {
  taskId: string;
  threadKey: string;
  status: TaskStatus;
  objective: string;
  createdAt: string;
  deadlineAt?: string;
  eventTs?: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionStateData {
  status: SessionStatus;
  objective: string;
  workingSummary?: string;
  fiberIndex: number;
  estimatedTokens?: number;
  subrequestsConsumed?: number;
  llmCalls?: number;
  toolCalls?: number;
  alarmCount?: number;
  externalJob?: {
    provider: string;
    jobId: string;
    pollIntervalMs: number;
  };
  revisionRound?: number;
  revisionBrief?: string;
  citations?: Citation[];
  summary?: string;
  modelHint?: string;
  threadContext?: ThreadMessage[];
}

export interface SessionState {
  id: string;
  data: SessionStateData;
  versionId: number;
  updatedAt: string;
}

export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
}

export interface ResearchLogEntry {
  id: string;
  sessionId: string;
  stepIndex: number;
  status: LogStatus;
  toolName?: string;
  request?: unknown;
  response?: unknown;
  createdAt: string;
}

export interface VerifiedFact {
  factHash: string;
  content: string;
  sourceUrl?: string;
  confidence?: number;
  createdAt: string;
}

export interface FactEdge {
  fromHash: string;
  toHash: string;
  relation: "supports" | "contradicts" | "cites";
}

export interface OutboxMessage {
  id: string;
  sessionId: string;
  targetActor: string;
  payload: OutboxPayload;
  status: OutboxStatus;
  createdAt: string;
}

export interface OutboxPayload {
  type: "progress" | "complete" | "failed";
  taskId: string;
  threadKey: string;
  message?: string;
  summary?: string;
  citations?: Citation[];
}

export interface Citation {
  url: string;
  title?: string;
  snippet?: string;
}

export interface AlarmQueueItem {
  id: string;
  sessionId: string;
  kind: AlarmKind;
  runAtMs: number;
  payload?: Record<string, unknown>;
  priority?: number;
}

export interface DeliveryObligation {
  id: string;
  threadKey: string;
  payload: {
    type: "interim" | "final" | "error";
    text: string;
    taskId: string;
  };
  /**
   * `in_flight` is a durable effect fence. Once set, cancellation may suppress
   * every still-pending delivery but cannot claim the task is quiescent until
   * this exact Slack request has been resolved or replayed idempotently.
   */
  status: "pending" | "in_flight" | "delivered" | "failed";
}

export type CancelResearchTaskResult =
  | {
      status: "cancelled" | "already_cancelled";
      taskId: string;
      quiescent: boolean;
    }
  | { status: "not_found" | "thread_mismatch"; taskId: string };

export interface VerificationResult {
  verdict: Verdict;
  issues: string[];
  requestId: string;
  cached?: boolean;
}

export interface VerificationRequest {
  objective: string;
  summary: string;
  citations: Citation[];
  requestId: string;
}

export interface StartTaskRequest {
  taskId: string;
  threadKey: string;
  objective: string;
  requestId: string;
  eventId?: string;
  eventTs?: string;
  threadContext?: ThreadMessage[];
  deadlineAt?: string;
}

export interface StartTaskResponse {
  status: "continuing" | "complete" | "failed";
  taskId: string;
  message?: string;
}

export interface FiberStepResult {
  done: boolean;
  nextAlarmMs?: number;
  error?: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  stream?: boolean;
  metadata?: Record<string, string>;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface BlobRef {
  logId: string;
  key: string;
  bytes: number;
  contentType: string;
}

export type AgentFlavor = "pm" | "impl" | "verify";
export type AgentContainerStatus = "starting" | "running" | "terminated" | "zombie" | "failed";

export interface AgentContainerRecord {
  containerId: string;
  sessionId: string;
  flavor: AgentFlavor;
  status: AgentContainerStatus;
  previewUrl?: string;
  startedAt?: string;
  killedAt?: string;
}

export interface AgentHandoffRecord {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  round: number;
  compressedTokens?: number;
  validated: boolean;
  createdAt: string;
}

export interface AgentExecutionLogEntry {
  id: string;
  sessionId?: string;
  containerId?: string;
  step?: string;
  toolName?: string;
  request?: unknown;
  response?: unknown;
  durationMs?: number;
  createdAt: string;
}

export interface GithubArtifactRecord {
  id: string;
  sessionId: string;
  prUrl?: string;
  commitSha?: string;
  branchName?: string;
  createdAt: string;
}
