/**
 * Cloudflare edge worker — thin DO shells over shared lib/research core.
 *
 * Comparison track vs Railway+Postgres. Deploy: cd edge && npm run deploy
 */
import { Orchestrator as OrchestratorCore } from "../../lib/research/orchestrator.js";
import { DurableObjectStorageAdapter } from "../../lib/research/adapters/storage-do.js";
import { DirectLlmAdapter } from "../../lib/research/adapters/llm.js";

export interface Env {
  ORCHESTRATOR: DurableObjectNamespace;
  RESEARCHER: DurableObjectNamespace;
  VERIFIER: DurableObjectNamespace;
  BLOBS: R2Bucket;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  PARALLEL_API_KEY?: string;
}

export class Orchestrator implements DurableObject {
  private core: OrchestratorCore | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private getCore(): OrchestratorCore {
    if (!this.core) {
      const storage = new DurableObjectStorageAdapter(this.state.storage.sql);
      const llm = new DirectLlmAdapter({
        anthropicApiKey: this.env.ANTHROPIC_API_KEY,
        openaiApiKey: this.env.OPENAI_API_KEY,
      });
      this.core = new OrchestratorCore({
        storage,
        llm,
        parallelApiKey: this.env.PARALLEL_API_KEY,
      });
    }
    return this.core;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/handleMention" && request.method === "POST") {
      const body = (await request.json()) as Parameters<OrchestratorCore["handleMention"]>[0];
      const result = await this.getCore().handleMention(body);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Fiber steps scheduled via alarm_queue — handled by Researcher DO
  }
}

export class Researcher implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/runFiberStep" && request.method === "POST") {
      const { taskId } = (await request.json()) as { taskId: string };
      const storage = new DurableObjectStorageAdapter(this.state.storage.sql);
      const llm = new DirectLlmAdapter({
        anthropicApiKey: this.env.ANTHROPIC_API_KEY,
        openaiApiKey: this.env.OPENAI_API_KEY,
      });
      const { Researcher: ResearcherCore } = await import("../../lib/research/researcher.js");
      const researcher = new ResearcherCore({ storage, llm });
      const result = await researcher.runFiberStep(taskId);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const storage = new DurableObjectStorageAdapter(this.state.storage.sql);
    const due = await storage.getDueAlarms(Date.now(), 1);
    if (due.length === 0) return;
    const alarm = due[0]!;
    const llm = new DirectLlmAdapter({
      anthropicApiKey: this.env.ANTHROPIC_API_KEY,
      openaiApiKey: this.env.OPENAI_API_KEY,
    });
    const { Researcher: ResearcherCore } = await import("../../lib/research/researcher.js");
    const researcher = new ResearcherCore({ storage, llm });
    await researcher.runFiberStep(alarm.sessionId);
    await storage.deleteAlarm(alarm.id);
    const next = await storage.getDueAlarms(Date.now(), 1);
    if (next.length > 0) {
      await this.state.storage.setAlarm(next[0]!.runAtMs);
    }
  }
}

export class Verifier implements DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/verify" && request.method === "POST") {
      const body = await request.json();
      const storage = new DurableObjectStorageAdapter(
        (this as unknown as { state: DurableObjectState }).state.storage.sql,
      );
      const llm = new DirectLlmAdapter({
        anthropicApiKey: (this as unknown as { env: Env }).env.ANTHROPIC_API_KEY,
        openaiApiKey: (this as unknown as { env: Env }).env.OPENAI_API_KEY,
      });
      const { Verifier: VerifierCore } = await import("../../lib/research/verifier.js");
      const verifier = new VerifierCore({ storage, llm });
      const result = await verifier.verify(body as never);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, track: "cloudflare-do" });
    }
    if (url.pathname === "/research" && request.method === "POST") {
      const body = (await request.json()) as { threadKey: string; objective: string };
      const id = env.ORCHESTRATOR.idFromName(body.threadKey);
      const stub = env.ORCHESTRATOR.get(id);
      const res = await stub.fetch(new Request("https://do/handleMention", {
        method: "POST",
        body: JSON.stringify(body),
      }));
      return res;
    }
    return new Response("opentag-edge worker", { status: 200 });
  },
};
