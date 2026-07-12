import type {
  AlarmKind,
  FiberStepResult,
  SessionStateData,
  TaskBudget,
} from "./types.js";
import { DEFAULT_TASK_BUDGET as DEFAULT_BUDGET } from "./types.js";

export const CPU_BURST_MS = 20_000;
export const DEFAULT_TASK_DEADLINE_MS = 30 * 60 * 1000;
export const MAX_REVISION_ROUNDS = 3;
export const DEFAULT_ALARM_DELAY_MS = 1_000;
export const MAX_ALARM_BACKOFF_MS = 60_000;

export function computeNextAlarmDelay(
  stallCount: number,
  baseMs = DEFAULT_ALARM_DELAY_MS,
): number {
  return Math.min(baseMs * Math.pow(2, stallCount), MAX_ALARM_BACKOFF_MS);
}

export function isDeadlinePassed(deadlineAt?: string, now = Date.now()): boolean {
  if (!deadlineAt) return false;
  return Date.parse(deadlineAt) <= now;
}

export function isBudgetExhausted(
  data: SessionStateData,
  budget: TaskBudget = DEFAULT_BUDGET,
): boolean {
  const alarms = data.alarmCount ?? 0;
  const llm = data.llmCalls ?? 0;
  const tools = data.toolCalls ?? 0;
  return (
    alarms >= budget.maxAlarms ||
    llm >= budget.maxLlmCalls ||
    tools >= budget.maxToolCalls
  );
}

export function shouldCompactContext(data: SessionStateData, threshold = 80_000): boolean {
  return (data.estimatedTokens ?? 0) >= threshold;
}

export function nextAlarmKind(data: SessionStateData): AlarmKind {
  if (data.externalJob) return "external_poll";
  return "fiber_step";
}

export function fiberStepComplete(result: Partial<FiberStepResult> = {}): FiberStepResult {
  return { done: false, nextAlarmMs: DEFAULT_ALARM_DELAY_MS, ...result };
}

export function fiberDone(message?: string): FiberStepResult {
  return { done: true, error: message };
}

export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function generateTaskId(threadKey: string): string {
  const slug = threadKey.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
  return `task_${slug}_${Date.now()}`;
}

export function hashFact(content: string, sourceUrl?: string): string {
  const input = `${content}|${sourceUrl ?? ""}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return `fact_${Math.abs(hash).toString(36)}`;
}
