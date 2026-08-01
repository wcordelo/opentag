import type {
  AnalyticsEngineDataset,
  DurableObjectNamespace,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types";
import type { KnowledgeJob } from "./memory/knowledge-contract.js";
import type { ConversationStateDO } from "./store/conversation-state-do.js";
import type { WorkspaceConfigDO } from "./config/workspace-config-do.js";
import type { KnowledgeDO } from "./memory/knowledge-do.js";
import type { SessionEventDO } from "./store/session-event-do.js";
import type { DeferredIngressDO } from "./deferred-ingress-do.js";
import type { SlackRateLimitDO } from "./slack/slack-rate-limit-do.js";
import type { PlatformStateDO } from "./platform/platform-state-do.js";
import type { RouterMeasurementDO } from "./router/measurement-do.js";

/**
 * Worker bindings for the Claude Tag bot spine (PRODUCT.md).
 */
export interface Env {
  BOT_STATE: DurableObjectNamespace<ConversationStateDO>;
  WORKSPACE_CONFIG: DurableObjectNamespace<WorkspaceConfigDO>;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>;
  /** Optional until Queue/DLQ names and the C1 deployment gate are approved. */
  KNOWLEDGE_QUEUE?: Queue<KnowledgeJob>;
  /** Exact future C1 primary Queue name; required by any Queue delivery. */
  KNOWLEDGE_QUEUE_NAME?: string;
  /** Exact future C1 DLQ name; must be distinct and end in `-dlq`. */
  KNOWLEDGE_DLQ_NAME?: string;
  /** Explicit C1 scheduler gate; only the exact string `true` activates it. */
  KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED?: string;
  /** Exact comma-separated team IDs covered by scheduled reconciliation. */
  KNOWLEDGE_RECONCILIATION_TEAM_IDS?: string;
  /** Required per-thread durable session log and exact execute/forward dedup. */
  SESSION_EVENTS: DurableObjectNamespace<SessionEventDO>;
  /** Stable click/late-file jobs; alarm retries survive request-isolate loss. */
  DEFERRED_INGRESS?: DurableObjectNamespace<DeferredIngressDO>;
  /** Per-channel cross-isolate Slack dispatch reservations. */
  SLACK_RATE_LIMIT?: DurableObjectNamespace<SlackRateLimitDO>;
  /** Optional until the platform-state migration is deployed to every bot. */
  PLATFORM_STATE?: DurableObjectNamespace<PlatformStateDO>;
  /** Workspace-scoped, shadow-only router measurements and misroute feedback. */
  ROUTER_MEASUREMENTS?: DurableObjectNamespace<RouterMeasurementDO>;
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

  /**
   * Optional internal credential-reference resolver. It returns short-lived
   * material only for a verified authorization digest; the bot never stores
   * provider tokens in Durable Objects or access bundles.
   */
  CONNECTOR_CREDENTIALS?: Fetcher;
  /** Shared internal bearer for the credential-broker service binding. */
  CONNECTOR_CREDENTIAL_BROKER_TOKEN?: string;

  /** Bearer for research Worker /research (forwarded by TaskRuntime). */
  INTERNAL_SECRET?: string;

  /** Bearer for /admin/* and /debug/* and /tasks/start. */
  ADMIN_SECRET?: string;
  /**
   * External Ed25519 verifier for one-use source lifecycle grants. These stay
   * unset until C1/S1 approves the issuer/key and exact administration scope;
   * the Worker has no grant-issuance endpoint or private key.
   */
  KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY?: string;
  KNOWLEDGE_SOURCE_AUTH_ISSUER?: string;
  KNOWLEDGE_SOURCE_AUTH_KEY_ID?: string;
  /**
   * External Ed25519 verifier for one-use P1 backfill approvals. The Worker
   * verifies public artifacts only; no issuer/private key or minting route is
   * part of this service. Unset until the external P1 authority is approved.
   */
  KNOWLEDGE_BACKFILL_APPROVAL_PUBLIC_KEY?: string;
  KNOWLEDGE_BACKFILL_APPROVAL_ISSUER?: string;
  KNOWLEDGE_BACKFILL_APPROVAL_KEY_ID?: string;

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
  /** Public HTTPS origin for the approval-gated Supermemory Local service. */
  SUPERMEMORY_URL?: string;
  /** Local bearer credential; never logged or accepted from tool callers. */
  SUPERMEMORY_API_KEY?: string;
  /** Workers Secret used only to mint and verify short-lived internal knowledge actor tokens. */
  KNOWLEDGE_ACTOR_TOKEN_SECRET?: string;
  /**
   * Exact gate for Local document update/delete. Only the string `verified`
   * enables mutations; unset/any other value keeps fail-closed unsupported_* paths.
   * SDK shapes are known; Local server-v0.0.5 live behavior remains unproven until R1 smoke.
   */
  SUPERMEMORY_MUTATION_CONTRACT?: string;
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
  /** Exact `true` enables the native typed Nanocodex Responses adapter for non-coding turns. */
  NANOCODEX_NATIVE_RESPONSES?: string;
  /**
   * Default repo to clone for a harness turn when the caller doesn't supply
   * one (SPEC.md §4.4). Forwarded as `repo.url` in the `/turn` POST body.
   */
  HARNESS_REPO_URL?: string;

  /**
   * Buzz M1 test-only OpenTag signer — 64-hex secp256k1 private key.
   * Cloudflare Worker secret ONLY; never commit a value. Named seam for
   * NIP-98 `/query` (Task #27). Unset → `/buzz/wake` stays 503.
   */
  BUZZ_OPEN_TAG_SIGNER_SECRET?: string;
  /**
   * Optional NIP-OA owner-attestation tag JSON for the OpenTag signer pubkey.
   * Cloudflare Worker secret ONLY. When set, `/query` sends `x-auth-tag`.
   * Unset/empty → explicit NIP-98-only mode (standalone relay-member path).
   * Present but malformed → `/buzz/wake` 503 `buzz_auth_tag_invalid_shape`
   * (fail closed; never silently omit and hit a confusing relay 403).
   */
  BUZZ_OPEN_TAG_AUTH_TAG?: string;
  /**
   * Absolute HTTPS origin of the Buzz community host (no trailing slash),
   * e.g. `https://berendo.communities.buzz.xyz`. Non-secret.
   */
  BUZZ_RELAY_HTTP_BASE_URL?: string;
  /**
   * Distinct allowed relay origin for this installation (non-secret).
   * Must be provisioned independently of `BUZZ_RELAY_HTTP_BASE_URL` — never
   * derived from it. Compared at the wake→admit allowlist chokepoint.
   */
  BUZZ_OPEN_TAG_ALLOWED_RELAY_ORIGIN?: string;
  /**
   * JSON object mapping Buzz channel UUID → canonical internal tenant UUID.
   * Server-side directory only; never populated from a wake body.
   */
  BUZZ_CHANNEL_TENANT_MAP?: string;
}

export type BotVariables = {
  rawBody: string;
  slackPayload: unknown;
};

export type AppEnv = {
  Bindings: Env;
  Variables: BotVariables;
};
