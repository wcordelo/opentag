/**
 * TaskRuntime — long-running jobs. Research is the only public task type until Track F.
 */
export type TaskType = "research";

export type StartTaskRequest = {
  type: TaskType;
  teamId: string;
  threadKey: string;
  channelId: string;
  threadTs?: string;
  payload: Record<string, unknown>;
  /**
   * Effective thread model override (GOAL.md Phase A3 / SPEC §5 Phase A3).
   * The orchestrator Worker may ignore this today — real model passthrough
   * targets the Phase A5 container. This field is the contract A5 builds on;
   * callers that don't pass it are unchanged.
   */
  model?: string;
};

export type StartTaskResult = {
  taskId: string;
  type: TaskType;
  status: "accepted" | "forwarded" | "error";
  detail?: string;
};

/**
 * Enqueue a research task via RESEARCH_TASKS → orchestrator POST /research.
 */
export async function startTask(
  env: {
    RESEARCH_TASKS?: Fetcher;
    INTERNAL_SECRET?: string;
  },
  req: StartTaskRequest,
): Promise<StartTaskResult> {
  const taskId = crypto.randomUUID();

  if (req.type !== "research") {
    return {
      taskId,
      type: "research",
      status: "error",
      detail: `unsupported task type`,
    };
  }

  if (!env.RESEARCH_TASKS) {
    return {
      taskId,
      type: req.type,
      status: "error",
      detail: "RESEARCH_TASKS binding missing — start `npm run dev:research` (or deploy opentag-orchestrator) and ensure the service binding in wrangler.toml",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.INTERNAL_SECRET) {
    headers.Authorization = `Bearer ${env.INTERNAL_SECRET}`;
  }

  const res = await env.RESEARCH_TASKS.fetch("https://research/research", {
    method: "POST",
    headers,
    body: JSON.stringify({
      threadKey: req.threadKey,
      objective: String(req.payload["objective"] ?? ""),
      teamId: req.teamId,
      channelId: req.channelId,
      eventId: taskId,
      eventTs: req.threadTs,
      model: req.model,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      taskId,
      type: req.type,
      status: "error",
      detail: `research forward failed: ${res.status} ${text.slice(0, 120)}`,
    };
  }

  const body = (await res.json().catch(() => ({}))) as {
    taskId?: string;
    status?: string;
    message?: string;
  };
  if (body.status === "failed") {
    return {
      taskId: body.taskId ?? taskId,
      type: req.type,
      status: "error",
      detail: body.message ?? "research start failed",
    };
  }
  return {
    taskId: body.taskId ?? taskId,
    type: req.type,
    status: "forwarded",
  };
}
