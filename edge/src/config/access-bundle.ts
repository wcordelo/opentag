/**
 * Access bundle types + resolver (no Workers runtime imports).
 */
export type AccessBundle = {
  id: string;
  tools: string[];
  mcpEndpoints: string[];
  secretRefs: string[];
};

export type WorkspaceChannelConfig = {
  teamId: string;
  channelId: string | null;
  systemPrompt: string;
  policies: {
    allowMemoryWrite?: boolean;
    allowTasks?: boolean;
  };
  accessBundleId: string;
  updatedAt: string;
};

export const DEFAULT_BUNDLE: AccessBundle = {
  id: "default",
  tools: [
    "lookup_slack_user",
    "read_thread",
    "confirm_write",
    "issue_card",
    "issue_list",
    "page_list",
    "show_status",
    "show_links",
    "show_incident",
    "research_progress",
    "memory_search",
    "memory_write",
    "start_task",
  ],
  mcpEndpoints: [],
  secretRefs: [
    "OPENAI_API_KEY",
    "LITELLM_API_KEY",
    "LINEAR_API_KEY",
    "NOTION_MCP_AUTH_TOKEN",
  ],
};

export const DEFAULT_SYSTEM_PROMPT =
  "You are OpenTag, an open-source Claude Tag alternative in Slack. Be helpful, cite sources when researching, and respect channel access limits.";

export function resolveAllowedTools(
  allToolNames: string[],
  bundle: AccessBundle,
): string[] {
  const allowed = new Set(bundle.tools);
  return allToolNames.filter((name) => allowed.has(name));
}
