import type {
  AnalyticsEngineDataset,
  DurableObjectNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import type { ConversationStateDO } from "./store/conversation-state-do.js";
import type { WorkspaceConfigDO } from "./config/workspace-config-do.js";
import type { KnowledgeDO } from "./memory/knowledge-do.js";
import type { SessionEventDO } from "./store/session-event-do.js";
import type { DeferredIngressDO } from "./deferred-ingress-do.js";
import type { SlackRateLimitDO } from "./slack/slack-rate-limit-do.js";

/**
 * Worker bindings for the Claude Tag bot spine (PRODUCT.md).
 */
export interface Env {
  BOT_STATE: DurableObjectNamespace<ConversationStateDO>;
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
  /** Required per-thread durable session log and exact execute/forward dedup. */
  SESSION_EVENTS: DurableObjectNamespace<SessionEventDO>;
  /** Stable click/late-file jobs; alarm retries survive request-isolate loss. */
  DEFERRED_INGRESS?: DurableObjectNamespace<DeferredIngressDO>;
  /** Per-channel cross-isolate Slack dispatch reservations. */
  SLACK_RATE_LIMIT?: DurableObjectNamespace<SlackRateLimitDO>;
  /** Delivery outcome dataset; logs remain a secondary diagnostic sink. */
  DELIVERY_METRICS: AnalyticsEngineDataset;
  BLOBS?: R2Bucket;

  /** Service binding to research task Worker (opentag-orchestrator). */
  RESEARCH_TASKS?: Fetcher;
  /** Self service binding used only by DeferredIngressDO's authenticated alarm. */
  BOT_SELF?: Fetcher;

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
  AGENT_MODEL?: string;
  /** Public bot origin used for signed, read-only session viewer links. */
  SESSION_VIEWER_BASE_URL?: string;
  /** Artifact host suffix whose final URLs receive synthetic-turn action cards. */
  QUICK_BASE_DOMAIN?: string;
  AGENT_AUTH_HEADER?: string;
  ENVIRONMENT?: string;
  DEFAULT_ACCESS_BUNDLE_ID?: string;
  /** Fallback IANA timezone when Slack users.info has no tz (default PDT/PST). */
  DEFAULT_USER_TIMEZONE?: string;

  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  /** Installed OpenTag bot user id, required for trusted rich-payload mentions. */
  SLACK_BOT_USER_ID?: string;
  /** Exact comma/whitespace-separated `bot:B...` / `app:A...` trigger actors. */
  SLACK_TRUSTED_TRIGGER_ACTORS?: string;

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
  /** Required bearer secret for the harness `/turn` endpoint. */
  HARNESS_AUTH_TOKEN?: string;
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
