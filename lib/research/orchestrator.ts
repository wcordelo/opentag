import type { StorageAdapter } from "./adapters/storage.js";
import type { LlmAdapter } from "./adapters/llm.js";
import type { BlobAdapter } from "./adapters/blob.js";
import { Researcher } from "./researcher.js";
import { Verifier, shouldRevise, shouldReject, MAX_REVISION_ROUNDS } from "./verifier.js";
import type {
  Citation,
  OutboxPayload,
  StartTaskRequest,
  StartTaskResponse,
  ThreadMessage,
  VerificationRequest,
} from "./types.js";
import {
  DEFAULT_TASK_DEADLINE_MS,
  generateRequestId,
  generateTaskId,
} from "./fiber.js";

export interface OrchestratorDeps {
  storage: StorageAdapter;
  llm: LlmAdapter;
  blob?: BlobAdapter;
  allowedChannelIds?: string[];
  parallelApiKey?: string;
  model?: string;
}

export interface HandleMentionRequest {
  threadKey: string;
  objective: string;
  eventId?: string;
  eventTs?: string;
  channelId?: string;
  threadContext?: ThreadMessage[];
  requestId?: string;
  useDeepResearch?: boolean;
}

export class Orchestrator {
  private researcher: Researcher;
  private verifier: Verifier;

  constructor(private readonly deps: OrchestratorDeps) {
    this.researcher = new Researcher({
      storage: deps.storage,
      llm: deps.llm,
      blob: deps.blob,
      model: deps.model,
      parallelApiKey: deps.parallelApiKey,
    });
    this.verifier = new Verifier({
      storage: deps.storage,
      llm: deps.llm,
      model: deps.model,
    });
  }

  async handleMention(req: HandleMentionRequest): Promise<StartTaskResponse> {
    if (req.channelId && this.deps.allowedChannelIds?.length) {
      if (!this.deps.allowedChannelIds.includes(req.channelId)) {
        return { status: "failed", taskId: "", message: "Channel not allowed" };
      }
    }

    const requestId = req.requestId ?? generateRequestId();
    if (req.eventId && (await this.deps.storage.isSlackEventProcessed(req.eventId))) {
      const tasks = await this.deps.storage.getTasksByThread(req.threadKey);
      const latest = tasks[0];
      return {
        status: latest?.status === "complete" ? "complete" : "continuing",
        taskId: latest?.taskId ?? "",
      };
    }

    // Supersede older running tasks on same thread
    const existingTasks = await this.deps.storage.getTasksByThread(req.threadKey);
    for (const t of existingTasks) {
      if (t.status === "running" || t.status === "pending") {
        if (req.eventTs && t.eventTs && req.eventTs > t.eventTs) {
          await this.deps.storage.updateTaskStatus(t.taskId, "superseded");
          const session = await this.deps.storage.getSession(t.taskId);
          if (session) {
            await this.deps.storage.updateSession(
              t.taskId,
              { ...session.data, status: "superseded" },
              session.versionId,
              new Date().toISOString(),
            );
          }
        }
      }
    }

    const taskId = generateTaskId(req.threadKey);
    const now = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + DEFAULT_TASK_DEADLINE_MS).toISOString();

    await this.deps.storage.createTask({
      taskId,
      threadKey: req.threadKey,
      status: "running",
      objective: req.objective,
      createdAt: now,
      deadlineAt,
      eventTs: req.eventTs,
      eventId: req.eventId,
    });

    await this.deps.storage.appendDeliveryObligationIfTaskActive({
      id: `del_${generateRequestId()}`,
      threadKey: req.threadKey,
      payload: {
        type: "interim",
        text: `🔍 Research started: _${req.objective.slice(0, 100)}_`,
        taskId,
      },
      status: "pending",
    });

    const startReq: StartTaskRequest = {
      taskId,
      threadKey: req.threadKey,
      objective: req.objective,
      requestId,
      eventId: req.eventId,
      eventTs: req.eventTs,
      threadContext: req.threadContext,
      deadlineAt,
    };

    if (req.useDeepResearch) {
      await this.researcher.startTask(startReq);
      await this.researcher.startDeepResearchJob(taskId, req.objective);
      if (req.eventId) {
        await this.deps.storage.markSlackEventProcessed(req.eventId, now);
      }
      return { status: "continuing", taskId };
    }

    const result = await this.researcher.startTask(startReq);
    if (req.eventId) {
      await this.deps.storage.markSlackEventProcessed(req.eventId, now);
    }
    return result;
  }

  async processOutbox(sessionId: string): Promise<void> {
    const messages = await this.deps.storage.getPendingOutbox(sessionId);
    for (const msg of messages) {
      const task = await this.deps.storage.getTask(msg.payload.taskId);
      if (!task || (task.status !== "pending" && task.status !== "running")) {
        await this.deps.storage.markOutboxSent(msg.id);
        continue;
      }
      await this.handleOutboxMessage(msg.payload);
      await this.deps.storage.markOutboxSent(msg.id);
    }
  }

  private async handleOutboxMessage(payload: OutboxPayload): Promise<void> {
    if (payload.type === "progress") {
      await this.deps.storage.appendDeliveryObligationIfTaskActive({
        id: `del_${generateRequestId()}`,
        threadKey: payload.threadKey,
        payload: {
          type: "interim",
          text: payload.message ?? "Research in progress…",
          taskId: payload.taskId,
        },
        status: "pending",
      });
      return;
    }

    if (payload.type === "failed") {
      const appended = await this.deps.storage.appendDeliveryObligationIfTaskActive({
        id: `del_${generateRequestId()}`,
        threadKey: payload.threadKey,
        payload: {
          type: "error",
          text: `Research failed: ${payload.message ?? "unknown error"}`,
          taskId: payload.taskId,
        },
        status: "pending",
      });
      if (appended) {
        await this.deps.storage.updateTaskStatusIfActive(payload.taskId, "failed");
      }
      return;
    }

    if (payload.type === "complete" && payload.summary) {
      const task = await this.deps.storage.getTask(payload.taskId);
      if (!task) return;

      const verifyResult = await this.runVerifyLoop(
        task.objective,
        payload.summary,
        payload.citations ?? [],
        payload.taskId,
      );

      let finalText: string;
      if (shouldReject(verifyResult.verdict)) {
        finalText = `Could not verify research results.\n\n${verifyResult.issues.join("\n")}\n\nPartial summary:\n${payload.summary.slice(0, 1000)}`;
      } else {
        finalText = payload.summary;
        if (payload.citations?.length) {
          finalText += "\n\n*Sources:*\n" + payload.citations
            .slice(0, 10)
            .map((c) => `• <${c.url}|${c.title ?? c.url}>`)
            .join("\n");
        }
      }

      const appended = await this.deps.storage.appendDeliveryObligationIfTaskActive({
        id: `del_${generateRequestId()}`,
        threadKey: payload.threadKey,
        payload: { type: "final", text: finalText, taskId: payload.taskId },
        status: "pending",
      });
      if (appended) {
        await this.deps.storage.updateTaskStatusIfActive(payload.taskId, "complete", {
          verdict: verifyResult.verdict,
          issues: verifyResult.issues,
        });
      }
    }
  }

  private async runVerifyLoop(
    objective: string,
    summary: string,
    citations: Citation[],
    taskId: string,
  ) {
    let round = 0;
    let currentSummary = summary;
    let currentCitations = citations;

    while (round <= MAX_REVISION_ROUNDS) {
      const requestId = generateRequestId();
      const req: VerificationRequest = {
        objective,
        summary: currentSummary,
        citations: currentCitations,
        requestId,
      };
      const result = await this.verifier.verify(req);

      if (result.verdict === "pass" || shouldReject(result.verdict)) {
        return result;
      }

      if (shouldRevise(round, result.verdict)) {
        round++;
        const session = await this.deps.storage.getSession(taskId);
        if (session) {
          const data = {
            ...session.data,
            revisionRound: round,
            revisionBrief: result.issues.join("; "),
            fiberIndex: 0,
            status: "running" as const,
          };
          await this.deps.storage.updateSession(
            taskId,
            data,
            session.versionId,
            new Date().toISOString(),
          );
          await this.researcher.startTask({
            taskId,
            threadKey: "",
            objective,
            requestId: generateRequestId(),
          });
        }
        // Wait for revision via outbox — return revise for now
        return result;
      }

      return result;
    }

    return { verdict: "pass" as const, issues: [], requestId: generateRequestId() };
  }

  async getPendingDeliveries(threadKey?: string) {
    return this.deps.storage.getPendingDeliveries(threadKey);
  }

  async markDeliveryDelivered(id: string) {
    return this.deps.storage.markDeliveryDelivered(id);
  }

  async cancelTask(taskId: string, threadKey: string) {
    return this.deps.storage.cancelResearchTask(taskId, threadKey);
  }

  getResearcher(): Researcher {
    return this.researcher;
  }
}
