import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { ConversationStateDO } from "./store/conversation-state-do.js";
import type { WorkspaceConfigDO } from "./config/workspace-config-do.js";
import type { KnowledgeDO } from "./memory/knowledge-do.js";

/**
 * Worker bindings for the Claude Tag bot spine (PRODUCT.md).
 */
export interface Env {
  BOT_STATE: DurableObjectNamespace<ConversationStateDO>;
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
  BLOBS?: R2Bucket;

  /** Service binding to research task Worker (opentag-orchestrator). */
  RESEARCH_TASKS?: Fetcher;

  /** Bearer for research Worker /research (forwarded by TaskRuntime). */
  INTERNAL_SECRET?: string;

  /** Bearer for /admin/* and /debug/* and /tasks/start. */
  ADMIN_SECRET?: string;

  AGENT_URL: string;
  AGENT_AUTH_HEADER?: string;
  ENVIRONMENT?: string;
  DEFAULT_ACCESS_BUNDLE_ID?: string;

  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  /** @deprecated Socket Mode — unused on CF. */
  SLACK_APP_TOKEN?: string;
}

export type BotVariables = {
  rawBody: string;
  slackPayload: unknown;
};

export type AppEnv = {
  Bindings: Env;
  Variables: BotVariables;
};
