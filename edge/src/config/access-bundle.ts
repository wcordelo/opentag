/**
 * Access bundle types + resolver (no Workers runtime imports).
 */
import { harnessModelMismatchError } from "../slack/overrides.js";
import { expandClaudeModelAlias } from "../slack/model-aliases.js";
import type { ConnectorAccessGrant } from "../connectors/authorization.js";

export type AccessBundleStatus = "active" | "revoked";
export type AccessBundle = {
  id: string;
  tools: string[];
  mcpEndpoints: string[];
  /** Legacy process-level secret names; never treated as connector credentials. */
  secretRefs: string[];
  /** Versioned, connector-scoped grants. Empty means no credentialed connector access. */
  connectorGrants?: ConnectorAccessGrant[];
  /** Additive metadata; omitted on legacy rows and normalized to revision 1/active. */
  schemaVersion?: 1;
  revision?: number;
  status?: AccessBundleStatus;
  revokedAt?: string;
};

export type ChannelRuntimeDefaults = {
  harnessType?: "claudecode" | "claudex" | "nanocodex";
  model?: string;
};

export type SystemPromptOverlay = {
  version: 1;
  revision: number;
  text: string;
  digest: string;
  updatedAt: string;
  source?: "workspace_admin";
};

export type WorkspaceChannelConfig = {
  teamId: string;
  channelId: string | null;
  /** User-editable channel context (formerly systemPrompt). */
  channelContext?: string;
  /**
   * @deprecated Prefer channelContext. Mirrored on reads for transitional callers;
   * writes must not elevate into overlay.
   */
  systemPrompt?: string;
  systemPromptOverlay?: SystemPromptOverlay;
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
  connectorGrants: [],
  schemaVersion: 1,
  revision: 1,
  status: "active",
};

export const DEFAULT_SYSTEM_PROMPT =
  "You are OpenTag, an open-source Claude Tag alternative in Slack. Be helpful, cite sources when researching, and respect channel access limits.";

export function channelContextOf(config: WorkspaceChannelConfig): string {
  return (
    config.channelContext ??
    config.systemPrompt ??
    DEFAULT_SYSTEM_PROMPT
  );
}

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
      : rawHarness === "claudex"
        ? ("claudex" as const)
        : rawHarness === "nanocodex"
          ? ("nanocodex" as const)
          : undefined;
  if (rawHarness && !harnessType) {
    throw new Error(`unsupported channel harness: ${rawHarness}`);
  }
  const rawModel =
    typeof record.model === "string" ? record.model.trim() : undefined;
  const model = rawModel ? expandClaudeModelAlias(rawModel) : undefined;
  if (model && !SAFE_MODEL_ID_RE.test(model)) {
    throw new Error("invalid channel model id");
  }
  if (model && !harnessType) {
    throw new Error("channel model requires harnessType");
  }
  const mismatch = harnessModelMismatchError(harnessType, model);
  if (mismatch) {
    throw new Error(mismatch);
  }
  if (!harnessType && !model) return undefined;
  return Object.freeze({
    ...(harnessType ? { harnessType } : {}),
    ...(model ? { model } : {}),
  });
}
