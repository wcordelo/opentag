import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { TriageContainer } from "./container.js";

/**
 * Bindings for the opentag-agent Worker that proxies AG-UI to a Container.
 * Secrets are set via `wrangler secret put` and forwarded into the container.
 */
export interface Env {
  TRIAGE: DurableObjectNamespace<TriageContainer>;

  /** When set, inbound requests must send matching Authorization. */
  AGENT_AUTH_HEADER?: string;

  OPENAI_API_KEY?: string;
  AGENT_MODEL?: string;
  LINEAR_API_KEY?: string;
  LINEAR_MCP_URL?: string;
  LINEAR_TEAM_KEY?: string;
  NOTION_TOKEN?: string;
  NOTION_MCP_AUTH_TOKEN?: string;
  NOTION_MCP_PORT?: string;
  NOTION_MCP_URL?: string;
}
