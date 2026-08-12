import type { AccessBundle, WorkspaceChannelConfig } from "../config/access-bundle.js";
import { readerPolicyRefForBundle } from "../config/knowledge-config.js";
import { connectorGrantsOf, type ConnectorAccessGrant } from "../connectors/authorization.js";
import type { Env } from "../env.js";
import type { PermissionSnapshotV1 } from "../permissions/contract.js";
import { tenantStub } from "../tenancy.js";

export type CurrentKnowledgeReadAccess = Readonly<{
  config: WorkspaceChannelConfig;
  bundle: AccessBundle;
}>;

export type KnowledgeReadGrantRequest = Readonly<{
  teamId: string;
  channelId: string;
  projectId: string;
  connectorId: string;
  action: string;
  aclPolicyRef?: string;
  repoId?: string;
  spaceId?: string;
  permissionSnapshot?: PermissionSnapshotV1;
}>;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function currentBundle(raw: unknown, expectedId: string): AccessBundle | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const tools = strings(value.tools);
  const mcpEndpoints = strings(value.mcpEndpoints);
  const secretRefs = strings(value.secretRefs);
  if (value.id !== expectedId || !tools || !mcpEndpoints || !secretRefs) return undefined;
  try {
    const connectorGrants = value.connectorGrants === undefined
      ? []
      : connectorGrantsOf({
          id: expectedId,
          tools,
          mcpEndpoints,
          secretRefs,
          connectorGrants: value.connectorGrants as AccessBundle["connectorGrants"],
        });
    return {
      id: expectedId,
      tools,
      mcpEndpoints,
      secretRefs,
      connectorGrants: [...connectorGrants],
      ...(value.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
      revision: typeof value.revision === "number" ? value.revision : 1,
      status: value.status === "revoked" ? "revoked" : "active",
      ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function loadCurrentKnowledgeReadAccess(
  env: Env,
  teamId: string,
  channelId: string,
): Promise<CurrentKnowledgeReadAccess | undefined> {
  if (!env.WORKSPACE_CONFIG) return undefined;
  try {
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    const configResponse = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    });
    if (!configResponse.ok) return undefined;
    const rawConfig = await configResponse.json() as Partial<WorkspaceChannelConfig>;
    if (
      rawConfig.teamId !== teamId ||
      (rawConfig.channelId !== null && rawConfig.channelId !== channelId) ||
      typeof rawConfig.accessBundleId !== "string" ||
      !rawConfig.accessBundleId
    ) return undefined;
    const bundleResponse = await stub.fetch("https://do/getBundle", {
      method: "POST",
      body: JSON.stringify({ id: rawConfig.accessBundleId }),
    });
    if (!bundleResponse.ok) return undefined;
    const bundle = currentBundle(await bundleResponse.json(), rawConfig.accessBundleId);
    if (!bundle) return undefined;
    return {
      config: rawConfig as WorkspaceChannelConfig,
      bundle,
    };
  } catch {
    return undefined;
  }
}

function snapshotMatches(
  snapshot: PermissionSnapshotV1 | undefined,
  access: CurrentKnowledgeReadAccess,
  request: KnowledgeReadGrantRequest,
): boolean {
  if (!snapshot) return true;
  if (snapshot.version !== 1) return false;
  if (
    snapshot.scope.teamId !== request.teamId ||
    snapshot.scope.channelId !== request.channelId ||
    snapshot.channelAccess.bundleId !== access.bundle.id ||
    snapshot.channelAccess.bundleRevision !== (access.bundle.revision ?? 1) ||
    snapshot.channelAccess.bundleStatus === "revoked"
  ) return false;
  return snapshot.channelAccess.allowedTools.includes(request.action);
}

function grantMatches(grant: ConnectorAccessGrant, request: KnowledgeReadGrantRequest): boolean {
  if (grant.connectorId !== request.connectorId || !grant.actions.includes(request.action)) return false;
  if (grant.projectId && grant.projectId !== request.projectId) return false;
  if (grant.channelId && grant.channelId !== request.channelId) return false;
  if (grant.repoId && grant.repoId !== request.repoId) return false;
  if (grant.spaceId && grant.spaceId !== request.spaceId) return false;
  if (grant.scope === "workspace") return true;
  if (grant.scope === "project") return request.projectId.length > 0;
  return request.channelId.length > 0;
}

export function currentKnowledgeReadGrantAllows(
  access: CurrentKnowledgeReadAccess | undefined,
  request: KnowledgeReadGrantRequest,
): boolean {
  if (!access || access.bundle.status === "revoked") return false;
  if (!snapshotMatches(request.permissionSnapshot, access, request)) return false;
  if (request.aclPolicyRef) {
    try {
      if (readerPolicyRefForBundle(access.bundle.id) !== request.aclPolicyRef) return false;
    } catch {
      return false;
    }
  }
  try {
    return connectorGrantsOf(access.bundle).some((grant) => grantMatches(grant, request));
  } catch {
    return false;
  }
}

export function currentKnowledgeToolAllows(
  access: CurrentKnowledgeReadAccess | undefined,
  input: Readonly<{ teamId: string; channelId: string; action: string; permissionSnapshot?: PermissionSnapshotV1 }>,
): boolean {
  if (!access || access.bundle.status === "revoked") return false;
  if (access.config.teamId !== input.teamId ||
      (access.config.channelId !== null && access.config.channelId !== input.channelId)) return false;
  const snapshot = input.permissionSnapshot;
  if (!access.bundle.tools.includes(input.action)) return false;
  if (!snapshot) return true;
  return snapshot.version === 1 &&
    snapshot.scope.teamId === input.teamId &&
    snapshot.scope.channelId === input.channelId &&
    snapshot.channelAccess.bundleId === access.bundle.id &&
    snapshot.channelAccess.bundleRevision === (access.bundle.revision ?? 1) &&
    snapshot.channelAccess.bundleStatus !== "revoked" &&
    snapshot.channelAccess.allowedTools.includes(input.action);
}
