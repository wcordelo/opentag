/**
 * Resolve connector authorization from the verified platform turn, never from
 * caller-selected tenant or principal fields.
 *
 * The workspace DO still owns channel access bundles. PlatformState owns the
 * external-to-internal identity link, OAuth grant, curated marketplace row,
 * and custody reference. This module composes both sides before a connector
 * tool can issue labels or ask the broker for a provider bearer.
 */

import type { Env } from "../env.js";
import { loadConnectorAuthorization } from "../config/workspace-config-do.js";
import {
  parseConnectorAuthorizationPlatformBinding,
  type ConnectorAuthorizationPlatformBinding,
} from "./authorization.js";
import {
  assertConnectorAuthorizationSnapshotMatchesBinding,
  ConnectorAuthorizationSnapshotError,
  PlatformStateConnectorAuthorizationReader,
  type ConnectorAuthorizationSnapshot,
} from "./authorization-snapshot.js";
import { PlatformStateIdentityLinkReader } from "../platform/identity-link.js";
import { adaptVerifiedSlackRequestContextFromPlatformState } from "../platform/slack-v1-adapter.js";
import { PlatformStateTenantLocatorReader } from "../platform/tenant-locator.js";
import type { PlatformRequestContext } from "../platform/contract.js";
import type { RequestContext } from "../request-context.js";

type ConnectorAuthorizationResult = Awaited<ReturnType<typeof loadConnectorAuthorization>>;

export type PlatformConnectorAuthorization = Readonly<{
  authorization: ConnectorAuthorizationResult;
  platformContext: PlatformRequestContext;
  snapshot: ConnectorAuthorizationSnapshot;
  platformBinding: ConnectorAuthorizationPlatformBinding;
}>;

function unavailable(code: string): ConnectorAuthorizationSnapshotError {
  return new ConnectorAuthorizationSnapshotError(code, 503);
}

function requirePlatformState(env: Env): NonNullable<Env["PLATFORM_STATE"]> {
  if (!env.PLATFORM_STATE) throw unavailable("platform_state_unavailable");
  return env.PLATFORM_STATE;
}

/**
 * Load a platform-bound label for one connector action. This intentionally
 * resolves the platform records before calling WorkspaceConfigDO, so the DO
 * cannot issue an otherwise valid legacy label from a caller-supplied actor.
 */
export async function loadPlatformConnectorAuthorization(input: Readonly<{
  env: Env;
  context: RequestContext;
  channelId: string;
  projectId: string;
  executionId: string;
  threadKey: string;
  connectorId: string;
  action: string;
}>): Promise<PlatformConnectorAuthorization> {
  const { env, context } = input;
  if (!context.verifiedIngress) {
    throw new ConnectorAuthorizationSnapshotError(
      "connector_verified_ingress_required",
      403,
    );
  }
  if (!context.inbound) {
    throw new ConnectorAuthorizationSnapshotError(
      "connector_inbound_identity_required",
      403,
    );
  }

  const platformState = requirePlatformState(env);
  const threadId = context.inbound.threadTs ?? context.inbound.ts;
  const eventId = context.inbound.identity ?? context.inbound.ts;
  const platformContext = await adaptVerifiedSlackRequestContextFromPlatformState({
    request: context,
    channelId: input.channelId,
    threadId,
    eventId,
    verifiedIngress: context.verifiedIngress,
    tenantLocatorReader: new PlatformStateTenantLocatorReader(platformState),
    identityLinkReader: new PlatformStateIdentityLinkReader(platformState),
  });

  const snapshot = await new PlatformStateConnectorAuthorizationReader(platformState).resolve({
    tenantId: platformContext.principal.tenantId,
    principalId: platformContext.principal.principalId,
    platform: platformContext.platform,
    platformTenantId: platformContext.actor.platformTenantId,
    platformSubjectId: platformContext.actor.platformSubjectId,
    connectorId: input.connectorId,
    action: input.action,
  });

  const platformBinding = parseConnectorAuthorizationPlatformBinding({
    schemaVersion: 1,
    platform: platformContext.platform,
    platformTenantId: platformContext.actor.platformTenantId,
    platformSubjectId: platformContext.actor.platformSubjectId,
    tenantId: platformContext.principal.tenantId,
    principalId: platformContext.principal.principalId,
    identityLinkVersion: platformContext.identityLink.identityLinkVersion,
    authorizationVersion: platformContext.principal.authorizationVersion,
    tenantLocatorVersion: platformContext.tenantLocatorVersion,
    oauthGrantVersion: snapshot.grant.version,
    marketplaceVersion: snapshot.marketplace.version,
  });

  const authorization = await loadConnectorAuthorization(env.WORKSPACE_CONFIG, {
    workspaceId: context.teamId,
    projectId: input.projectId,
    channelId: input.channelId,
    requesterId: context.requesterId,
    principalId: platformContext.principal.principalId,
    actorKind: platformContext.principal.kind,
    executionId: input.executionId,
    threadKey: input.threadKey,
    connectorId: input.connectorId,
    action: input.action,
    platformBinding,
  });

  if (!authorization.credential) {
    throw new ConnectorAuthorizationSnapshotError(
      "connector_credential_reference_required",
      403,
    );
  }
  if (
    authorization.credential.ref !== snapshot.credential.credentialRef ||
    authorization.credential.version !== snapshot.credential.version
  ) {
    throw new ConnectorAuthorizationSnapshotError(
      "connector_credential_snapshot_mismatch",
      403,
    );
  }
  assertConnectorAuthorizationSnapshotMatchesBinding(
    snapshot,
    platformBinding,
    {
      connectorId: input.connectorId,
      action: input.action,
      credentialRef: authorization.credential.ref,
      credentialVersion: authorization.credential.version,
    },
  );

  return Object.freeze({
    authorization,
    platformContext,
    snapshot,
    platformBinding,
  });
}

/** Distinguish an un-deployed foundation from a real policy denial. */
export function isConnectorAuthorizationUnavailable(error: unknown): boolean {
  if (error instanceof ConnectorAuthorizationSnapshotError) {
    return error.status >= 500;
  }
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; message?: unknown };
  if (typeof candidate.status === "number" && candidate.status >= 500) return true;
  return typeof candidate.message === "string" && /(?:^|_)unavailable(?:$|_)/.test(candidate.message);
}
