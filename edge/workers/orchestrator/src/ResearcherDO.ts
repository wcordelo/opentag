/**
 * ResearcherDO — one Durable Object per research task (idFromName(taskId)).
 * Runs fiber steps against DurableObjectStorageAdapter; actor core unchanged.
 */
import { DurableObjectStorageAdapter } from "../../../../lib/research/adapters/storage-do.js";
import { DirectLlmAdapter } from "../../../../lib/research/adapters/llm.js";
import { runMigrations } from "./schema";

export interface ResearcherDOEnv {
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  PARALLEL_API_KEY?: string;
}

export class ResearcherDO implements DurableObject {
  private migrated = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: ResearcherDOEnv,
  ) {}

  private ensureMigrated(): void {
    if (this.migrated) return;
    runMigrations(this.ctx.storage.sql);
    this.migrated = true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/runFiberStep" && request.method === "POST") {
      this.ensureMigrated();
      const { taskId } = (await request.json()) as { taskId: string };
      const storage = new DurableObjectStorageAdapter(this.ctx.storage.sql);
      const llm = new DirectLlmAdapter({
        anthropicApiKey: this.env.ANTHROPIC_API_KEY,
        openaiApiKey: this.env.OPENAI_API_KEY,
      });
      const { Researcher: ResearcherCore } = await import(
        "../../../../lib/research/researcher.js"
      );
      const researcher = new ResearcherCore({
        storage,
        llm,
        parallelApiKey: this.env.PARALLEL_API_KEY,
      });
      const result = await researcher.runFiberStep(taskId);
      return Response.json(result);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    this.ensureMigrated();
    const storage = new DurableObjectStorageAdapter(this.ctx.storage.sql);
    const due = await storage.getDueAlarms(Date.now(), 1);
    if (due.length === 0) return;
    const alarm = due[0]!;
    const llm = new DirectLlmAdapter({
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      openaiApiKey: this.env.OPENAI_API_KEY,
    });
    const { Researcher: ResearcherCore } = await import(
      "../../../../lib/research/researcher.js"
    );
    const researcher = new ResearcherCore({ storage, llm });
    await researcher.runFiberStep(alarm.sessionId);
    await storage.deleteAlarm(alarm.id);
    const next = await storage.getDueAlarms(Date.now(), 1);
    if (next.length > 0) {
      await this.ctx.storage.setAlarm(next[0]!.runAtMs);
    }
  }
}
