/**
 * Shared Cloudflare Worker env types for the orchestrator Worker.
 * Kept separate from index.ts so Slack handlers can import without cycles.
 */
export interface CloudflareEnv {
  ORCHESTRATOR: DurableObjectNamespace;
  RESEARCHER: DurableObjectNamespace;
  VERIFIER: DurableObjectNamespace;
  BLOBS: R2Bucket;
  AGENT_STATE: KVNamespace;
  WASM_DISPATCH: Fetcher;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  PARALLEL_API_KEY?: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ENVIRONMENT: string;
  ALLOWED_HOSTS: string[];
  EGRESS_PROXY_URL: string;
}

export interface SlackVariables {
  rawBody: string;
  slackPayload: unknown;
}

export type AppEnv = {
  Bindings: CloudflareEnv;
  Variables: SlackVariables;
};
