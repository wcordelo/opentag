import type { StorageAdapter } from "./adapters/storage.js";
import type { BlobAdapter } from "./adapters/blob.js";
import type { LlmAdapter } from "./adapters/llm.js";
import { redactForLog } from "./adapters/llm.js";
import type {
  Citation,
  FiberStepResult,
  SessionStateData,
  StartTaskRequest,
  StartTaskResponse,
} from "./types.js";
import { getSessionMutex } from "./mutex.js";
import {
  computeNextAlarmDelay,
  DEFAULT_ALARM_DELAY_MS,
  fiberDone,
  fiberStepComplete,
  generateRequestId,
  hashFact,
  isBudgetExhausted,
  isDeadlinePassed,
  nextAlarmKind,
  shouldCompactContext,
} from "./fiber.js";
import { webSearch, pollExternalJob, startDeepResearch } from "./tools/websearch.js";
import { scrapeUrl } from "./tools/scrape.js";
import { shouldSpillToBlob, blobKeyForLog } from "./adapters/blob.js";

export interface ResearcherDeps {
  storage: StorageAdapter;
  llm: LlmAdapter;
  blob?: BlobAdapter;
  model?: string;
  parallelApiKey?: string;
}

const RESEARCHER_SYSTEM = [
  "You are a deep research assistant. Given an objective and context, produce a",
  "thorough, well-cited summary. Use search results and scraped content provided.",
  "Be factual; cite sources. If information is insufficient, say so.",
].join("\n");

export class Researcher {
  constructor(private readonly deps: ResearcherDeps) {}

  async startTask(req: StartTaskRequest): Promise<StartTaskResponse> {
    const mutex = getSessionMutex(req.taskId);
    return mutex.serialize(async () => {
      if (await this.deps.storage.isRequestProcessed(req.requestId)) {
        const session = await this.deps.storage.getSession(req.taskId);
        return {
          status: session?.data.status === "complete" ? "complete" : "continuing",
          taskId: req.taskId,
        };
      }

      const now = new Date().toISOString();
      const initialData: SessionStateData = {
        status: "running",
        objective: req.objective,
        fiberIndex: 0,
        llmCalls: 0,
        toolCalls: 0,
        alarmCount: 0,
        threadContext: req.threadContext,
        revisionRound: 0,
      };

      const existing = await this.deps.storage.getSession(req.taskId);
      if (!existing) {
        await this.deps.storage.createSession(req.taskId, initialData, now);
      }

      await this.deps.storage.markRequestProcessed(req.requestId, now);
      await this.scheduleNextStep(req.taskId, 0);

      return { status: "continuing", taskId: req.taskId };
    });
  }

  async runFiberStep(taskId: string): Promise<FiberStepResult> {
    const mutex = getSessionMutex(taskId);
    return mutex.serialize(() => this._runFiberStep(taskId));
  }

  private async _runFiberStep(taskId: string): Promise<FiberStepResult> {
    const session = await this.deps.storage.getSession(taskId);
    if (!session) return fiberDone("Session not found");

    let data = session.data;
    if (data.status === "cancelled" || data.status === "superseded") {
      return fiberDone(`Task ${data.status}`);
    }

    const task = await this.deps.storage.getTask(taskId);
    if (task && isDeadlinePassed(task.deadlineAt)) {
      await this.completeWithPartial(taskId, data, "Task deadline exceeded.");
      return fiberDone("deadline");
    }

    if (isBudgetExhausted(data)) {
      await this.completeWithPartial(taskId, data, "Task budget exhausted.");
      return fiberDone("budget");
    }

    // Recovery: last log stuck in processing
    const lastLog = await this.deps.storage.getLastLog(taskId);
    if (lastLog?.status === "processing") {
      await this.deps.storage.updateLogStatus(lastLog.id, "failed", { error: "recovered" });
    }

    if (data.externalJob) {
      return this.handleExternalJob(taskId, session.versionId, data);
    }

    const stepIndex = data.fiberIndex;
    const logId = `log_${taskId}_${stepIndex}`;
    const now = new Date().toISOString();

    await this.deps.storage.appendLog({
      id: logId,
      sessionId: taskId,
      stepIndex,
      status: "processing",
      toolName: stepIndex === 0 ? "web_search" : "synthesize",
      createdAt: now,
    });

    try {
      if (stepIndex === 0) {
        return await this.runSearchStep(taskId, session.versionId, data, logId);
      }

      if (shouldCompactContext(data)) {
        await this.compactContext(taskId, session.versionId, data);
        const refreshed = await this.deps.storage.getSession(taskId);
        if (refreshed) data = refreshed.data;
      }

      return await this.runSynthesizeStep(taskId, session.versionId, data, logId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.storage.updateLogStatus(logId, "failed", { error: msg });
      await this.notifyOrchestrator(taskId, "failed", msg);
      return fiberDone(msg);
    }
  }

  private async runSearchStep(
    taskId: string,
    versionId: number,
    data: SessionStateData,
    logId: string,
  ): Promise<FiberStepResult> {
    const query = data.revisionBrief
      ? `${data.objective} (revision: ${data.revisionBrief})`
      : data.objective;

    const results = await webSearch({ query, maxResults: 5 }, this.deps.parallelApiKey);
    data.toolCalls = (data.toolCalls ?? 0) + 1;

    // Scrape top result if allowed
    const topUrl = results[0]?.url;
    let scrapeText = "";
    if (topUrl) {
      try {
        const scraped = await scrapeUrl(topUrl);
        scrapeText = scraped.text.slice(0, 5000);
        data.toolCalls = (data.toolCalls ?? 0) + 1;
      } catch {
        // non-fatal
      }
    }

    for (const r of results) {
      const hash = hashFact(r.snippet, r.url);
      await this.deps.storage.upsertFact({
        factHash: hash,
        content: r.snippet,
        sourceUrl: r.url,
        confidence: 0.7,
        createdAt: new Date().toISOString(),
        sessionId: taskId,
      } as never);
    }

    const response = { results, scrapeText: scrapeText.slice(0, 500) };
    await this.storeLogResponse(logId, response);
    await this.deps.storage.updateLogStatus(logId, "completed", redactForLog(response));

    data.fiberIndex = (data.fiberIndex ?? 0) + 1;
    data.alarmCount = (data.alarmCount ?? 0) + 1;
    const now = new Date().toISOString();
    const updated = await this.deps.storage.updateSession(taskId, data, versionId, now);
    if (!updated) {
      return fiberStepComplete({ nextAlarmMs: DEFAULT_ALARM_DELAY_MS });
    }

    await this.scheduleNextStep(taskId, DEFAULT_ALARM_DELAY_MS);
    await this.notifyOrchestrator(taskId, "progress", `Search complete (${results.length} results)`);
    return fiberStepComplete();
  }

  private async runSynthesizeStep(
    taskId: string,
    versionId: number,
    data: SessionStateData,
    logId: string,
  ): Promise<FiberStepResult> {
    const facts = await this.deps.storage.getFacts(taskId);
    const citations: Citation[] = facts.map((f) => ({
      url: f.sourceUrl ?? "",
      snippet: f.content,
    }));

    const contextBlock = [
      data.threadContext?.length
        ? `Thread context:\n${data.threadContext.map((m) => `${m.user}: ${m.text}`).join("\n")}`
        : "",
      data.workingSummary ? `Working summary: ${data.workingSummary}` : "",
      `Facts:\n${facts.map((f) => `- ${f.content} (${f.sourceUrl ?? "no url"})`).join("\n")}`,
    ].filter(Boolean).join("\n\n");

    const model =
      this.deps.model ??
      (typeof (this.deps.llm as unknown as { getActiveModel?: () => string })
        .getActiveModel === "function"
        ? (
            this.deps.llm as unknown as { getActiveModel: () => string }
          ).getActiveModel()
        : "claude-sonnet-4-20250514");
    let llmResponse: { content: string; model: string };
    try {
      llmResponse = await this.deps.llm.complete({
        model: data.modelHint ?? model,
        messages: [
          { role: "system", content: RESEARCHER_SYSTEM },
          {
            role: "user",
            content: `Objective: ${data.objective}\n\n${contextBlock}\n\nProduce a comprehensive research summary.`,
          },
        ],
        metadata: { actor: "researcher", taskId },
      });
    } catch {
      // Offline / no API key: synthesize from facts only
      llmResponse = {
        content: `Research summary for: ${data.objective}\n\n${facts.map((f) => `- ${f.content} (${f.sourceUrl ?? "source"})`).join("\n")}`,
        model: "offline-fallback",
      };
    }

    data.llmCalls = (data.llmCalls ?? 0) + 1;
    data.summary = llmResponse.content;
    data.citations = citations;
    data.fiberIndex = (data.fiberIndex ?? 0) + 1;
    data.alarmCount = (data.alarmCount ?? 0) + 1;
    data.status = "complete";

    await this.storeLogResponse(logId, { summary: llmResponse.content });
    await this.deps.storage.updateLogStatus(logId, "completed", {
      summaryLength: llmResponse.content.length,
    });

    const now = new Date().toISOString();
    await this.deps.storage.updateSession(taskId, data, versionId, now);
    await this.notifyOrchestrator(taskId, "complete", undefined, llmResponse.content, citations);
    await this.deps.storage.updateTaskStatus(taskId, "running");

    return fiberDone();
  }

  private async handleExternalJob(
    taskId: string,
    versionId: number,
    data: SessionStateData,
  ): Promise<FiberStepResult> {
    const job = data.externalJob!;
    const result = await pollExternalJob(job, this.deps.parallelApiKey);

    if (result.status === "running" || result.status === "pending") {
      data.alarmCount = (data.alarmCount ?? 0) + 1;
      const delay = computeNextAlarmDelay(data.alarmCount);
      const now = new Date().toISOString();
      await this.deps.storage.updateSession(taskId, data, versionId, now);
      await this.scheduleExternalPoll(taskId, delay);
      return fiberStepComplete({ nextAlarmMs: delay });
    }

    if (result.status === "failed") {
      await this.completeWithPartial(taskId, data, "External research job failed.");
      return fiberDone("external_job_failed");
    }

    data.summary = result.result ?? "External research complete.";
    data.status = "complete";
    data.externalJob = undefined;
    const now = new Date().toISOString();
    await this.deps.storage.updateSession(taskId, data, versionId, now);
    await this.notifyOrchestrator(taskId, "complete", undefined, data.summary, data.citations ?? []);
    return fiberDone();
  }

  async startDeepResearchJob(taskId: string, objective: string): Promise<void> {
    const handle = await startDeepResearch(objective, this.deps.parallelApiKey);
    const session = await this.deps.storage.getSession(taskId);
    if (!session) return;

    const data: SessionStateData = {
      ...session.data,
      externalJob: {
        provider: handle.provider,
        jobId: handle.jobId,
        pollIntervalMs: 5000,
      },
    };
    await this.deps.storage.updateSession(
      taskId,
      data,
      session.versionId,
      new Date().toISOString(),
    );
    await this.scheduleExternalPoll(taskId, 5000);
  }

  private async compactContext(
    taskId: string,
    versionId: number,
    data: SessionStateData,
  ): Promise<void> {
    const logs = await this.deps.storage.getLogs(taskId, 20);
    const summary = logs
      .map((l) => `${l.toolName}: ${JSON.stringify(l.response ?? "").slice(0, 200)}`)
      .join("\n");
    data.workingSummary = summary.slice(0, 4000);
    data.estimatedTokens = 0;
    await this.deps.storage.updateSession(
      taskId,
      data,
      versionId,
      new Date().toISOString(),
    );
  }

  private async completeWithPartial(
    taskId: string,
    data: SessionStateData,
    reason: string,
  ): Promise<void> {
    data.status = "complete";
    data.summary = data.summary ?? `Partial result: ${reason}`;
    const session = await this.deps.storage.getSession(taskId);
    if (session) {
      await this.deps.storage.updateSession(
        taskId,
        data,
        session.versionId,
        new Date().toISOString(),
      );
    }
    await this.notifyOrchestrator(taskId, "complete", reason, data.summary, data.citations ?? []);
    await this.deps.storage.updateTaskStatus(taskId, "complete");
  }

  private async notifyOrchestrator(
    taskId: string,
    type: "progress" | "complete" | "failed",
    message?: string,
    summary?: string,
    citations?: Citation[],
  ): Promise<void> {
    const task = await this.deps.storage.getTask(taskId);
    if (!task) return;

    const now = new Date().toISOString();
    await this.deps.storage.appendOutbox({
      id: `outbox_${generateRequestId()}`,
      sessionId: taskId,
      targetActor: "orchestrator",
      payload: {
        type,
        taskId,
        threadKey: task.threadKey,
        message,
        summary,
        citations,
      },
      status: "pending",
      createdAt: now,
    });
  }

  private async storeLogResponse(logId: string, response: unknown): Promise<void> {
    const serialized = JSON.stringify(response);
    if (this.deps.blob && shouldSpillToBlob(serialized.length)) {
      const key = blobKeyForLog(logId);
      const ref = await this.deps.blob.put(key, serialized, "application/json");
      await this.deps.storage.storeBlobRef({
        ...ref,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private async scheduleNextStep(taskId: string, delayMs: number): Promise<void> {
    const id = `alarm_${taskId}_${Date.now()}`;
    await this.deps.storage.enqueueAlarm({
      id,
      sessionId: taskId,
      kind: nextAlarmKind({} as SessionStateData),
      runAtMs: Date.now() + delayMs,
      priority: 10,
    });
  }

  private async scheduleExternalPoll(taskId: string, delayMs: number): Promise<void> {
    await this.deps.storage.enqueueAlarm({
      id: `alarm_ext_${taskId}_${Date.now()}`,
      sessionId: taskId,
      kind: "external_poll",
      runAtMs: Date.now() + delayMs,
      priority: 10,
    });
  }
}
