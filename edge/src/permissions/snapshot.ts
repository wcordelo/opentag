import type {
  AccessBundle,
  WorkspaceChannelConfig,
} from "../config/access-bundle.js";
import type { RequestActor } from "../request-context.js";
import {
  AUTOMATION_SAFE_TOOLS,
  PERMISSION_SNAPSHOT_MAX_BYTES,
  type PermissionSnapshotV1,
  type RuntimeSelectionSource,
} from "./contract.js";

const MAX_ITEMS = 200;
const MAX_STRING = 256;

function bounded(value: unknown): string {
  return String(value ?? "").normalize("NFKC").slice(0, MAX_STRING);
}

function boundedList(values: Iterable<unknown>): string[] {
  return [...new Set([...values].map(bounded).filter(Boolean))]
    .sort()
    .slice(0, MAX_ITEMS);
}

function redactedEndpoint(value: string): { origin: string; path: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { origin: "[invalid]", path: "" };
    return {
      origin: bounded(url.origin),
      path: bounded(url.pathname),
    };
  } catch {
    return { origin: "[invalid]", path: "" };
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export type BuildPermissionSnapshotArgs = {
  teamId: string;
  channelId: string;
  conversationKey?: string;
  executionId?: string;
  actor: RequestActor | { kind: "operator" };
  config: WorkspaceChannelConfig;
  bundle: AccessBundle;
  allToolNames: readonly string[];
  allowedTools: Iterable<string>;
  runtime: {
    harnessType?: "claudecode";
    model?: string;
    harnessSource?: RuntimeSelectionSource;
    modelSource?: RuntimeSelectionSource;
    harnessConnected: boolean;
  };
  sandbox?: PermissionSnapshotV1["sandbox"];
  generatedAt?: string;
};

export function buildPermissionSnapshot(
  args: BuildPermissionSnapshotArgs,
): PermissionSnapshotV1 {
  const automation = args.actor.kind === "slack_automation";
  const requestedAllowed = new Set(args.allowedTools);
  const allowed = boundedList(
    args.allToolNames.filter(
      (name) =>
        requestedAllowed.has(name) &&
        (!automation || AUTOMATION_SAFE_TOOLS.has(name)),
    ),
  );
  const allowedSet = new Set(allowed);
  const denied = boundedList(
    args.allToolNames.filter((name) => !allowedSet.has(name)),
  );
  const endpoints = automation
    ? []
    : [
        ...new Map(
          args.bundle.mcpEndpoints
            .slice(0, MAX_ITEMS)
            .map(redactedEndpoint)
            .map((endpoint) => [
              `${endpoint.origin}\u0000${endpoint.path}`,
              endpoint,
            ]),
        ).values(),
      ].sort((a, b) =>
        `${a.origin}${a.path}`.localeCompare(`${b.origin}${b.path}`),
      );
  const snapshot = deepFreeze({
    version: 1 as const,
    scope: {
      teamId: bounded(args.teamId),
      channelId: bounded(args.channelId),
      ...(args.conversationKey
        ? { conversationKey: bounded(args.conversationKey) }
        : {}),
      ...(args.executionId ? { executionId: bounded(args.executionId) } : {}),
      actorKind: args.actor.kind,
    },
    channelAccess: {
      bundleId: bounded(args.bundle.id),
      metadataVisibility: automation
        ? ("restricted" as const)
        : ("full_names" as const),
      allowedTools: allowed,
      deniedTools: denied,
      policies: {
        allowMemoryWrite: args.config.policies.allowMemoryWrite !== false,
        allowTasks: args.config.policies.allowTasks !== false,
      },
      mcpEndpoints: endpoints,
      secretRefs: automation ? [] : boundedList(args.bundle.secretRefs),
    },
    runtime: {
      ...(args.runtime.harnessType
        ? { harnessType: args.runtime.harnessType }
        : {}),
      ...(args.runtime.model ? { model: bounded(args.runtime.model) } : {}),
      harnessSource: args.runtime.harnessSource ?? "deployment",
      modelSource: args.runtime.modelSource ?? "deployment",
      harnessConnected: args.runtime.harnessConnected,
    },
    ...(args.sandbox
      ? {
          sandbox: {
            network: "denied_by_default" as const,
            credentialExposure: "sentinel_only" as const,
            allowedRepoHosts: boundedList(args.sandbox.allowedRepoHosts),
            allowedRepoOrgs: boundedList(args.sandbox.allowedRepoOrgs),
            remoteGitApproved: args.sandbox.remoteGitApproved === true,
            createPullRequest: args.sandbox.createPullRequest === true,
          },
        }
      : {}),
    generatedAt: bounded(args.generatedAt ?? new Date().toISOString()),
  }) satisfies PermissionSnapshotV1;
  assertPermissionSnapshotSize(snapshot);
  return snapshot;
}

export function assertPermissionSnapshotSize(
  snapshot: PermissionSnapshotV1,
): void {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > PERMISSION_SNAPSHOT_MAX_BYTES) {
    throw new Error("permission_snapshot_too_large");
  }
}
