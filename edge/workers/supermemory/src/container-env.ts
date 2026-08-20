import type { Env } from "./env.js";

export function supermemoryContainerEnv(source: Env): Record<string, string> {
  const values: Record<string, string> = {
    PORT: "6768",
    SUPERMEMORY_DATA_DIR: "/var/lib/supermemory",
  };
  const storage = [
    ["AWS_ACCESS_KEY_ID", source.R2_ACCESS_KEY_ID],
    ["AWS_SECRET_ACCESS_KEY", source.R2_SECRET_ACCESS_KEY],
    ["R2_ACCOUNT_ID", source.R2_ACCOUNT_ID],
    ["R2_BUCKET_NAME", source.R2_BUCKET_NAME],
  ] as const;
  for (const [key, value] of storage) {
    if (typeof value === "string" && value.length > 0) values[key] = value;
  }
  const providerKey = source.DEEPSEEK_API_KEY?.trim() || source.OPENAI_API_KEY?.trim();
  const configurable = [
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_FAST_MODEL",
    "OPENAI_TEXT_MODEL",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "WORKERS_AI_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "GOOGLE_VERTEX_PROJECT_ID",
    "GOOGLE_VERTEX_LOCATION",
    "SUPERMEMORY_EMBEDDING_PROVIDER",
    "SUPERMEMORY_EMBEDDING_MODEL",
    "SUPERMEMORY_EMBEDDING_DIMENSIONS",
    "SUPERMEMORY_EMBEDDING_BASE_URL",
    "SUPERMEMORY_LOCAL_EMBEDDING_POOL_SIZE",
    "SUPERMEMORY_LOCAL_EMBEDDING_WASM_THREADS",
    "SUPERMEMORY_LOCAL_EMBEDDING_BATCH_SIZE",
    "SUPERMEMORY_LOCAL_EMBEDDING_IDLE_TIMEOUT_MS",
    "SUPERMEMORY_EMBEDDING_RAM_LIMIT",
    "SUPERMEMORY_INGEST_CONCURRENCY",
    "SUPERMEMORY_SKIP_EMBEDDING_PREWARM",
    "SUPERMEMORY_DISABLE_TELEMETRY",
  ] as const;
  for (const key of configurable) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) values[key] = value;
  }
  if (providerKey) values.OPENAI_API_KEY = providerKey;
  return values;
}
