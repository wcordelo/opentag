/**
 * OrchestratorDO — one Durable Object per Slack workspace (idFromName(teamId)).
 * See DECISIONS.md §1 (per-workspace OrchestratorDO).
 *
 * Thin shell over lib/research OrchestratorCore + DurableObjectStorageAdapter.
 * Actor code never imports DurableObject directly (invariant #3).
 */
import { Orchestrator as OrchestratorCore } from "../../../../lib/research/orchestrator.js";
import { DurableObjectStorageAdapter } from "../../../../lib/research/adapters/storage-do.js";
import { DirectLlmAdapter } from "../../../../lib/research/adapters/llm.js";
import { postToSlackThread } from "../../../../lib/research/delivery/slack.js";
import { runMigrations } from "./schema";

export interface OrchestratorDOEnv {
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  PARALLEL_API_KEY?: string;
  SLACK_BOT_TOKEN: string;
  SLACK_ALLOWED_CHANNEL_IDS?: string;
  RESEARCHER: DurableObjectNamespace;
  VERIFIER: DurableObjectNamespace;
  BLOBS: R2Bucket;
}

function parseAllowedChannels(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const channels = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return channels.length > 0 ? channels : undefined;
}

export async function deliverResearchSlackObligation(
  obligation: {
    id: string;
    threadKey: string;
    payload: { type?: string; text?: string; taskId?: string };
  },
  botToken: string,
  deliver = postToSlackThread,
) {
  const { payload } = obligation;
  if (!payload.text) return { status: "definitive_failure" as const, error: "missing_delivery_text" };
  return deliver(
    obligation.threadKey,
    payload.text,
    obligation.id,
    botToken,
    payload.type === "final" && payload.taskId
      ? { type: "final", text: payload.text, taskId: payload.taskId }
      : undefined,
  );
}

interface ExecutionLogBody {
  id?: string;
  sessionId?: string;
  containerId?: string;
  step?: string;
  toolName?: string;
  request?: unknown;
  response?: unknown;
  durationMs?: number;
  host?: string;
  path?: string;
  method?: string;
  status?: number;
}

export class OrchestratorDO implements DurableObject {
  private core: OrchestratorCore | null = null;
  private storage: DurableObjectStorageAdapter | null = null;
  private migrated = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: OrchestratorDOEnv,
  ) {}

  private ensureMigrated(): void {
    if (this.migrated) return;
    runMigrations(this.ctx.storage.sql);
    this.migrated = true;
  }

  private getStorage(): DurableObjectStorageAdapter {
    this.ensureMigrated();
    if (!this.storage) {
      this.storage = new DurableObjectStorageAdapter(this.ctx.storage.sql);
    }
    return this.storage;
  }

  private getCore(): OrchestratorCore {
    if (!this.core) {
      const storage = this.getStorage();
      const hasAnthropic = Boolean(this.env.ANTHROPIC_API_KEY?.trim());
      const defaultModel = hasAnthropic ? undefined : "gpt-4o";
      const llm = new DirectLlmAdapter({
        anthropicApiKey: this.env.ANTHROPIC_API_KEY,
        openaiApiKey: this.env.OPENAI_API_KEY,
        // Prefer OpenAI when Anthropic isn't configured (common CF secret set).
        defaultModel,
        fallbackModel: "gpt-4o",
      });
      this.core = new OrchestratorCore({
        storage,
        llm,
        model: defaultModel,
        parallelApiKey: this.env.PARALLEL_API_KEY,
        allowedChannelIds: parseAllowedChannels(this.env.SLACK_ALLOWED_CHANNEL_IDS),
      });
    }
    return this.core;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/handleMention" && request.method === "POST") {
        const body = (await request.json()) as Parameters<
          OrchestratorCore["handleMention"]
        >[0];
        const result = await this.getCore().handleMention(body);
        // Schedule alarm to drain deliveries / outbox shortly after start.
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
        return Response.json(result);
      }

      if (path === "/deliveries" && request.method === "GET") {
        const threadKey = url.searchParams.get("threadKey") ?? undefined;
        const pending = await this.getStorage().getPendingDeliveries(threadKey);
        return Response.json(pending);
      }

      if (
        path.startsWith("/deliveries/") &&
        path.endsWith("/delivered") &&
        request.method === "POST"
      ) {
        const id = path.slice("/deliveries/".length, -"/delivered".length);
        await this.getStorage().markDeliveryDelivered(id);
        return Response.json({ ok: true });
      }

      if (path.startsWith("/tasks/") && request.method === "GET") {
        const taskId = path.slice("/tasks/".length);
        const task = await this.getStorage().getTask(taskId);
        if (!task) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json(task);
      }

      if (
        path.startsWith("/tasks/") &&
        path.endsWith("/cancel") &&
        request.method === "POST"
      ) {
        const taskId = decodeURIComponent(
          path.slice("/tasks/".length, -"/cancel".length),
        );
        const body = (await request.json().catch(() => ({}))) as {
          threadKey?: string;
        };
        const storage = this.getStorage();
        const task = await storage.getTask(taskId);
        if (!task) {
          return Response.json({ error: "not_found", taskId }, { status: 404 });
        }
        const threadKey = body.threadKey ?? task.threadKey;
        const result = await this.getCore().cancelTask(taskId, threadKey);
        if (result.status === "thread_mismatch") {
          return Response.json(
            { error: "thread_mismatch", taskId },
            { status: 409 },
          );
        }
        if (result.status === "not_found") {
          return Response.json({ error: "not_found", taskId }, { status: 404 });
        }
        return Response.json({
          cancelled: true,
          quiescent: "quiescent" in result && result.quiescent,
          taskId,
        });
      }

      if (path === "/import-task" && request.method === "POST") {
        const task = (await request.json()) as {
          taskId: string;
          threadKey: string;
          status: "pending" | "running" | "complete" | "failed" | "cancelled" | "superseded";
          objective: string;
          createdAt: string;
          deadlineAt?: string;
          eventTs?: string;
          eventId?: string;
          metadata?: Record<string, unknown>;
        };
        const storage = this.getStorage();
        const existing = await storage.getTask(task.taskId);
        if (existing) {
          return Response.json({ ok: true, skipped: true, taskId: task.taskId });
        }
        await storage.createTask(task);
        return Response.json({ ok: true, written: true, taskId: task.taskId });
      }

      if (path === "/execution-logs" && request.method === "POST") {
        const body = (await request.json()) as ExecutionLogBody;
        const id = body.id ?? crypto.randomUUID();
        this.ctx.storage.sql.exec(
          `INSERT INTO agent_execution_logs
             (id, session_id, container_id, step, tool_name, request, response, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          id,
          body.sessionId ?? null,
          body.containerId ?? null,
          body.step ?? (body.method && body.host ? `${body.method} ${body.host}${body.path ?? ""}` : null),
          body.toolName ?? "egress_proxy",
          JSON.stringify({
            host: body.host,
            path: body.path,
            method: body.method,
            status: body.status,
            ...(typeof body.request === "object" && body.request !== null
              ? body.request
              : {}),
          }),
          body.response ? JSON.stringify(body.response) : null,
          body.durationMs ?? null,
        );
        return Response.json({ ok: true, id });
      }

      if (path === "/health" && request.method === "GET") {
        this.ensureMigrated();
        return Response.json({ ok: true, do: "OrchestratorDO" });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (err) {
      console.error("OrchestratorDO error", err);
      return Response.json(
        {
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  async alarm(): Promise<void> {
    this.ensureMigrated();
    const storage = this.getStorage();
    const core = this.getCore();
    const researcher = core.getResearcher();

    await this.drainDeliveries(storage, core);

    const due = await storage.getDueAlarms(Date.now(), 10);
    for (const item of due) {
      if (item.kind === "fiber_step" || item.kind === "external_poll") {
        const result = await researcher.runFiberStep(item.sessionId);
        await core.processOutbox(item.sessionId);
        await this.drainDeliveries(storage, core);

        if (!result.done && result.nextAlarmMs) {
          await storage.enqueueAlarmIfTaskActive({
            id: `alarm_${item.sessionId}_${Date.now()}`,
            sessionId: item.sessionId,
            kind: item.kind,
            runAtMs: Date.now() + result.nextAlarmMs,
            priority: 10,
          });
        }
      } else if (item.kind === "outbox_retry") {
        await core.processOutbox(item.sessionId);
        await this.drainDeliveries(storage, core);
      }
      await storage.deleteAlarm(item.id);
    }

    const next = await storage.getDueAlarms(Date.now() + 60_000, 1);
    if (next.length > 0) {
      await this.ctx.storage.setAlarm(next[0]!.runAtMs);
      return;
    }

    // Keep retrying undelivered Slack posts (e.g. transient Slack errors).
    const stillPending = await storage.getDeliveriesToDrain();
    if (stillPending.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  private async drainDeliveries(
    storage: DurableObjectStorageAdapter,
    core: OrchestratorCore,
  ): Promise<void> {
    const drainable = await storage.getDeliveriesToDrain();
    for (const candidate of drainable) {
      const obligation = await storage.claimDelivery(candidate.id);
      // A pending delivery whose task was cancelled between enumeration and
      // claim is never allowed to start. Already-in-flight effects remain
      // claimable so restart/alarm recovery can resolve their ambiguity.
      if (!obligation) continue;
      const payload = obligation.payload as {
        type?: string;
        text?: string;
        taskId?: string;
      };
      if (!payload.text || !this.env.SLACK_BOT_TOKEN) {
        console.error(
          "[orchestrator] delivery configuration missing",
          obligation.id,
        );
        await storage.markDeliverySuppressed(obligation.id);
        continue;
      }
      const outcome = await deliverResearchSlackObligation(
        { id: obligation.id, threadKey: obligation.threadKey, payload },
        this.env.SLACK_BOT_TOKEN,
      );
      if (outcome.status === "delivered") {
        await storage.markDeliveryDelivered(obligation.id);
      } else if (outcome.status === "definitive_failure") {
        await storage.markDeliverySuppressed(obligation.id);
        console.error(
          "[orchestrator] Slack delivery rejected",
          obligation.id,
          outcome.error,
        );
      } else {
        // Ambiguous transport/parse outcomes retain the durable in-flight
        // effect. The alarm below replays the same client_msg_id.
          console.error(
            "[orchestrator] Slack delivery ambiguous",
            obligation.id,
            outcome.error,
          );
      }
      if (payload.taskId) {
        await core.processOutbox(payload.taskId);
      }
    }
  }
}
