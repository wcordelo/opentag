import type {
  ActorClass,
  CanonicalInternalPrincipalId,
  CanonicalInternalTenantId,
  Platform,
} from "../platform/contract.js";
import { PlatformContractError } from "../platform/contract.js";

export type RuntimeSelectionSource =
  | "explicit"
  | "sticky"
  | "channel"
  | "deployment";

export type PermissionSnapshotV1 = Readonly<{
  version: 1;
  scope: Readonly<{
    /** Mandatory discriminator: V1 is a Slack-only compatibility contract. */
    platform: "slack";
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
    harnessType?: "claudecode" | "claudex" | "nanocodex";
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

export type PermissionSnapshotV2 = Readonly<{
  version: 2;
  scope: Readonly<{
    tenantId: CanonicalInternalTenantId;
    platform: Platform;
    externalTenantId: string;
    conversationId: string;
    principalId: CanonicalInternalPrincipalId;
    actorKind: ActorClass;
    identityLinkVersion: number;
    authorizationVersion: number;
    tenantLocatorVersion: number;
    conversationKey?: string;
    executionId?: string;
  }>;
  channelAccess: PermissionSnapshotV1["channelAccess"];
  runtime: PermissionSnapshotV1["runtime"];
  sandbox?: PermissionSnapshotV1["sandbox"];
  generatedAt: string;
}>;

/**
 * V1 is intentionally Slack-only. Enforcing this at the binding boundary
 * prevents a future adapter from smuggling a non-Slack subject into legacy
 * `teamId` authorization or tool paths.
 */
export function assertPermissionSnapshotV1SlackOnly(
  value: unknown,
): asserts value is PermissionSnapshotV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformContractError("permission_snapshot_v1_invalid");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== 1 || typeof snapshot.scope !== "object" || snapshot.scope === null) {
    throw new PlatformContractError("permission_snapshot_v1_invalid");
  }
  const scope = snapshot.scope as Record<string, unknown>;
  if (scope.platform !== "slack") {
    throw new PlatformContractError("permission_snapshot_v1_rejects_non_slack");
  }
  if (
    scope.actorKind !== "slack_user"
    && scope.actorKind !== "slack_automation"
    && scope.actorKind !== "operator"
  ) {
    throw new PlatformContractError("permission_snapshot_v1_invalid_actor");
  }
}

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
