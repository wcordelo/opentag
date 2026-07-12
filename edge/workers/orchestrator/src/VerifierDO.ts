/**
 * VerifierDO — one Durable Object per research task (idFromName(taskId)).
 * Runs verification against DurableObjectStorageAdapter; actor core unchanged.
 */
import { DurableObjectStorageAdapter } from "../../../../lib/research/adapters/storage-do.js";
import { DirectLlmAdapter } from "../../../../lib/research/adapters/llm.js";
import { runMigrations } from "./schema";

export interface VerifierDOEnv {
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
}

export class VerifierDO implements DurableObject {
  private migrated = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: VerifierDOEnv,
  ) {}

  private ensureMigrated(): void {
    if (this.migrated) return;
    runMigrations(this.ctx.storage.sql);
    this.migrated = true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/verify" && request.method === "POST") {
      this.ensureMigrated();
      const body = await request.json();
      const storage = new DurableObjectStorageAdapter(this.ctx.storage.sql);
      const llm = new DirectLlmAdapter({
        anthropicApiKey: this.env.ANTHROPIC_API_KEY,
        openaiApiKey: this.env.OPENAI_API_KEY,
      });
      const { Verifier: VerifierCore } = await import(
        "../../../../lib/research/verifier.js"
      );
      const verifier = new VerifierCore({ storage, llm });
      const result = await verifier.verify(body as never);
      return Response.json(result);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
