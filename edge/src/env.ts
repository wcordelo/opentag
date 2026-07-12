import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { ConversationStateDO } from "./store/conversation-state-do.js";
import type { WorkspaceConfigDO } from "./config/workspace-config-do.js";
import type { KnowledgeDO } from "./memory/knowledge-do.js";
import type { SessionEventDO } from "./store/session-event-do.js";

/**
 * Worker bindings for the Claude Tag bot spine (PRODUCT.md).
 */
export interface Env {
  BOT_STATE: DurableObjectNamespace<ConversationStateDO>;
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
  /**
   * Per-thread session event log (SPEC.md §3.2/§4.1) — replay source for
   * `ConversationStateDO`'s render-obligation alarm fallback (SPEC.md §3.1).
   * Optional: a later phase registers this Durable Object in wrangler.toml;
   * until then, obligation writes fall back to `afterEventId: 0` and the
   * alarm's fallback path degrades to the "please retry" error card.
   */
  SESSION_EVENTS?: DurableObjectNamespace<SessionEventDO>;
  BLOBS?: R2Bucket;

  /** Service binding to research task Worker (opentag-orchestrator). */
  RESEARCH_TASKS?: Fetcher;

  /**
   * Service binding to AG-UI triage Worker (opentag-agent). Required in prod —
   * Worker→Worker fetch via workers.dev returns Cloudflare 1042 on the same zone.
   */
  AGENT_RUNTIME?: Fetcher;

  /** Bearer for research Worker /research (forwarded by TaskRuntime). */
  INTERNAL_SECRET?: string;

  /** Bearer for /admin/* and /debug/* and /tasks/start. */
  ADMIN_SECRET?: string;

  AGENT_URL: string;
  AGENT_AUTH_HEADER?: string;
  ENVIRONMENT?: string;
  DEFAULT_ACCESS_BUNDLE_ID?: string;
  /** Fallback IANA timezone when Slack users.info has no tz (default PDT/PST). */
  DEFAULT_USER_TIMEZONE?: string;

  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;

  /**
   * Fetcher service binding to the Claude Code harness container (GOAL.md
   * Phase A5, SPEC.md §3.6/§4.4). Prefer this over `HARNESS_URL` — same
   * Worker→Worker-avoids-CF-1042 reason `AGENT_RUNTIME` exists alongside
   * `AGENT_URL`. Ships as a separate Worker (`edge/workers/sandbox/` +
   * `containers/harness/` own the container image); deploy is gated
   * (GOAL.md house rule 6) — this binding is optional and unset today.
   */
  HARNESS?: Fetcher;
  /**
   * Base URL for the harness container's HTTP surface (`POST /turn`,
   * `GET /health`) when no `HARNESS` service binding is configured — same
   * dual pattern as `AGENT_URL`/`AGENT_RUNTIME`. `edge/src/harness/client.ts`
   * appends the path itself (`/turn`); do not include it here.
   */
  HARNESS_URL?: string;
  /**
   * Default repo to clone for a harness turn when the caller doesn't supply
   * one (SPEC.md §4.4). Forwarded as `repo.url` in the `/turn` POST body.
   */
  HARNESS_REPO_URL?: string;
}

export type BotVariables = {
  rawBody: string;
  slackPayload: unknown;
};

export type AppEnv = {
  Bindings: Env;
  Variables: BotVariables;
};
