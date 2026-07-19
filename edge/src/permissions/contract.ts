export type RuntimeSelectionSource =
  | "explicit"
  | "sticky"
  | "channel"
  | "deployment";

export type PermissionSnapshotV1 = Readonly<{
  version: 1;
  scope: Readonly<{
    teamId: string;
    channelId: string;
    conversationKey?: string;
    executionId?: string;
    actorKind: "slack_user" | "slack_automation" | "operator";
  }>;
  channelAccess: Readonly<{
    bundleId: string;
    metadataVisibility: "full_names" | "restricted";
    allowedTools: readonly string[];
    deniedTools: readonly string[];
    policies: Readonly<{
      allowMemoryWrite: boolean;
      allowTasks: boolean;
    }>;
    mcpEndpoints: ReadonlyArray<Readonly<{ origin: string; path: string }>>;
    secretRefs: readonly string[];
  }>;
  runtime: Readonly<{
    harnessType?: "claudecode" | "claudex";
    model?: string;
    harnessSource: RuntimeSelectionSource;
    modelSource: RuntimeSelectionSource;
    harnessConnected: boolean;
  }>;
  sandbox?: Readonly<{
    network: "denied_by_default";
    credentialExposure: "sentinel_only";
    allowedRepoHosts: readonly string[];
    allowedRepoOrgs: readonly string[];
    remoteGitApproved: boolean;
    createPullRequest: boolean;
  }>;
  generatedAt: string;
}>;

export const AUTOMATION_SAFE_TOOLS = new Set([
  "lookup_slack_user",
  "read_thread",
  "issue_list",
  "page_list",
  "show_status",
  "show_links",
  "show_incident",
  "memory_search",
  "show_permissions",
]);

export const PERMISSION_SNAPSHOT_MAX_BYTES = 64 * 1024;
