import type { StorageAdapter } from "./adapters/storage.js";
import type { LlmAdapter } from "./adapters/llm.js";
import type { BlobAdapter } from "./adapters/blob.js";
import { createPostgresStorage } from "./adapters/storage-postgres.js";
import { DirectLlmAdapter } from "./adapters/llm.js";
import { FilesystemBlobAdapter } from "./adapters/blob.js";
import { Orchestrator } from "./orchestrator.js";

export interface ResearchContext {
  storage: StorageAdapter;
  llm: LlmAdapter;
  blob?: BlobAdapter;
  orchestrator: Orchestrator;
}

export async function createResearchContext(): Promise<ResearchContext> {
  const storage = createPostgresStorage();
  await storage.migrate();

  const llm = new DirectLlmAdapter({
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    openaiApiKey: process.env["OPENAI_API_KEY"],
    defaultModel: process.env["RESEARCH_MODEL"] ?? "claude-sonnet-4-20250514",
    fallbackModel: process.env["RESEARCH_FALLBACK_MODEL"] ?? "gpt-4o",
    aiGatewayAccountId: process.env["CF_AI_GATEWAY_ACCOUNT_ID"],
    aiGatewayId: process.env["CF_AI_GATEWAY_ID"],
  });

  const blobPath = process.env["BLOB_STORAGE_PATH"] ?? "./data/blobs";
  const blob = new FilesystemBlobAdapter(blobPath);

  const allowedChannels = process.env["SLACK_ALLOWED_CHANNEL_IDS"]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const orchestrator = new Orchestrator({
    storage,
    llm,
    blob,
    allowedChannelIds: allowedChannels,
    parallelApiKey: process.env["PARALLEL_API_KEY"],
    model: process.env["RESEARCH_MODEL"],
  });

  return { storage, llm, blob, orchestrator };
}

export * from "./types.js";
export * from "./orchestrator.js";
export * from "./researcher.js";
export * from "./verifier.js";
export * from "./fiber.js";
export * from "./mutex.js";
export * from "./occ.js";
