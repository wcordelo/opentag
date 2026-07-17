/**
 * Access bundle types + resolver (no Workers runtime imports).
 */
export type AccessBundle = {
  id: string;
  tools: string[];
  mcpEndpoints: string[];
  secretRefs: string[];
};

export type ChannelRuntimeDefaults = {
  harnessType?: "claudecode";
  model?: string;
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
  runtimeDefaults?: ChannelRuntimeDefaults;
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
    "show_permissions",
    "research_progress",
    "memory_search",
    "memory_write",
    "start_task",
    "react_message",
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
  // Keep the code-defined default bundle in sync even if the DO was seeded
  // with an older tools list (e.g. missing react_message after a deploy).
  const tools =
    bundle.id === DEFAULT_BUNDLE.id
      ? [...new Set([...DEFAULT_BUNDLE.tools, ...bundle.tools])]
      : bundle.tools;
  const allowed = new Set(tools);
  return allToolNames.filter((name) => allowed.has(name));
}

const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const CHANNEL_MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
};

export function normalizeChannelRuntimeDefaults(
  value: unknown,
): ChannelRuntimeDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtimeDefaults must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== "harnessType" && key !== "model",
  );
  if (unknown.length > 0) {
    throw new Error(`unknown runtimeDefaults field: ${unknown[0]}`);
  }
  const rawHarness =
    typeof record.harnessType === "string"
      ? record.harnessType.trim().toLowerCase()
      : undefined;
  const harnessType =
    rawHarness === "claudecode" ||
    rawHarness === "claude-code" ||
    rawHarness === "claude"
      ? ("claudecode" as const)
      : undefined;
  if (rawHarness && !harnessType) {
    throw new Error(`unsupported channel harness: ${rawHarness}`);
  }
  const rawModel =
    typeof record.model === "string" ? record.model.trim() : undefined;
  const model = rawModel
    ? CHANNEL_MODEL_ALIASES[rawModel.toLowerCase()] ?? rawModel
    : undefined;
  if (model && !SAFE_MODEL_ID_RE.test(model)) {
    throw new Error("invalid channel model id");
  }
  if (model && !harnessType) {
    throw new Error("channel model requires harnessType=claudecode");
  }
  if (!harnessType && !model) return undefined;
  return Object.freeze({
    ...(harnessType ? { harnessType } : {}),
    ...(model ? { model } : {}),
  });
}
