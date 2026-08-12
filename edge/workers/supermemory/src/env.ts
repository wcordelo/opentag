import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { SupermemoryContainer } from "./container.js";

export interface Env {
  SUPERMEMORY: DurableObjectNamespace<SupermemoryContainer>;
  STATE_BUCKET: R2Bucket;
  SUPERMEMORY_SERVICE_AUTH_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  OPENAI_FAST_MODEL?: string;
  OPENAI_TEXT_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  WORKERS_AI_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GOOGLE_VERTEX_PROJECT_ID?: string;
  GOOGLE_VERTEX_LOCATION?: string;
  SUPERMEMORY_EMBEDDING_PROVIDER?: string;
  SUPERMEMORY_EMBEDDING_MODEL?: string;
  SUPERMEMORY_EMBEDDING_DIMENSIONS?: string;
  SUPERMEMORY_EMBEDDING_BASE_URL?: string;
  SUPERMEMORY_LOCAL_EMBEDDING_POOL_SIZE?: string;
  SUPERMEMORY_LOCAL_EMBEDDING_WASM_THREADS?: string;
  SUPERMEMORY_LOCAL_EMBEDDING_BATCH_SIZE?: string;
  SUPERMEMORY_LOCAL_EMBEDDING_IDLE_TIMEOUT_MS?: string;
  SUPERMEMORY_EMBEDDING_RAM_LIMIT?: string;
  SUPERMEMORY_INGEST_CONCURRENCY?: string;
  SUPERMEMORY_SKIP_EMBEDDING_PREWARM?: string;
  SUPERMEMORY_DISABLE_TELEMETRY?: string;
}
