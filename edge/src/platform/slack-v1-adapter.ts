import {
  slackTurnIdentitySync,
  type RequestActor,
  type RequestContext,
} from "../request-context.js";
import { slackObligationThreadKey } from "../slack/obligation-thread-key.js";
import type { PermissionSnapshotV2 } from "../permissions/contract.js";
import { assertPermissionSnapshotV1SlackOnly } from "../permissions/contract.js";
import {
  type ExternalSubject,
  type InternalPrincipal,
  type PlatformRequestContext,
  type TenantLocatorReader,
  type TenantLocator,
  type VerifiedIdentityLink,
  PlatformContractError,
  requireActiveTenantLocator,
  validateExternalSubject,
  validatePlatformRequestContext,
} from "./contract.js";

function externalSubjectForSlackActor(
  teamId: string,
  actor: RequestActor,
): ExternalSubject {
  const subjectId = actor.kind === "slack_user"
    ? actor.userId
    : actor.appId ?? actor.botId;
  return validateExternalSubject({
    platform: "slack",
    platformTenantId: teamId,
    platformSubjectId: subjectId,
  });
}

/**
 * Compatibility only: callers must supply a separately verified locator and
 * identity link. The adapter never equates Slack's legacy teamId with an
 * internal tenant or derives a principal from a Slack user ID.
 */
type VerifiedSlackRequestContextInput = Readonly<{
  request: RequestContext;
  channelId: string;
  threadId: string;
  eventId: string;
  locator: TenantLocator;
  principal: InternalPrincipal;
  identityLink: VerifiedIdentityLink;
  verifiedIngress: PlatformRequestContext["verifiedIngress"];
}>;

export function adaptVerifiedSlackRequestContext(input: VerifiedSlackRequestContextInput): PlatformRequestContext {
  const actor = externalSubjectForSlackActor(input.request.teamId, input.request.actor);
  const inbound = input.request.inbound;
  if (
    !inbound
    || inbound.channel !== input.channelId
    || (inbound.threadTs ?? inbound.ts) !== input.threadId
    || (inbound.identity ?? inbound.ts) !== input.eventId
    || !input.request.preAdmittedTurn
  ) {
    throw new PlatformContractError("platform_slack_ingress_tuple_mismatch");
  }
  let expectedExecutionId: string;
  try {
    expectedExecutionId = slackTurnIdentitySync(input.request, input.channelId).executionId;
  } catch {
    throw new PlatformContractError("platform_slack_ingress_tuple_mismatch");
  }
  const preAdmittedRecord = input.request.preAdmittedTurn.record;
  if (
    preAdmittedRecord.channelId !== input.channelId
    || preAdmittedRecord.threadKey !== slackObligationThreadKey(input.request.teamId, input.channelId, input.threadId)
    || preAdmittedRecord.executionId !== expectedExecutionId
  ) {
    throw new PlatformContractError("platform_slack_pre_admission_mismatch");
  }
  const locator = requireActiveTenantLocator({ status: "resolved", locator: input.locator }, actor);
  if (locator.tenantId !== input.principal.tenantId) {
    throw new PlatformContractError("platform_slack_compatibility_unverified");
  }
  return validatePlatformRequestContext({
    platform: "slack",
    externalTenantId: input.request.teamId,
    externalConversationId: input.channelId,
    externalThreadId: input.threadId,
    externalEventId: input.eventId,
    actor,
    principal: input.principal,
    identityLink: input.identityLink,
    tenantLocatorVersion: locator.version,
    verifiedIngress: input.verifiedIngress,
    preAdmittedTurn: input.request.preAdmittedTurn,
  });
}

/**
 * Resolve the locator from the server-owned registry before adapting Slack's
 * legacy request shape. Callers cannot select an internal tenant ID.
 */
export async function adaptVerifiedSlackRequestContextFromRegistry(
  input: Omit<VerifiedSlackRequestContextInput, "locator"> & { locatorReader: TenantLocatorReader },
): Promise<PlatformRequestContext> {
  const actor = externalSubjectForSlackActor(input.request.teamId, input.request.actor);
  const resolution = await input.locatorReader.resolve(actor);
  const locator = requireActiveTenantLocator(resolution, actor);
  return adaptVerifiedSlackRequestContext({ ...input, locator });
}

/**
 * Converts a Slack-only V1 snapshot to a V2 presentation only after a caller
 * supplies the verified platform context. It does not authorize Buzz or
 * portable-context reads; central policy enforcement remains a later slice.
 */
export function adaptSlackPermissionSnapshotV1(
  snapshot: unknown,
  context: unknown,
): PermissionSnapshotV2 {
  assertPermissionSnapshotV1SlackOnly(snapshot);
  const verifiedContext = validatePlatformRequestContext(context);
  if (
    verifiedContext.platform !== "slack"
    || verifiedContext.externalTenantId !== snapshot.scope.teamId
    || verifiedContext.externalConversationId !== snapshot.scope.channelId
  ) {
    throw new PlatformContractError("platform_slack_snapshot_scope_mismatch");
  }
  const actorKind = verifiedContext.principal.kind;
  return Object.freeze({
    version: 2,
    scope: Object.freeze({
      tenantId: verifiedContext.principal.tenantId,
      platform: verifiedContext.platform,
      externalTenantId: verifiedContext.externalTenantId,
      conversationId: verifiedContext.externalConversationId,
      principalId: verifiedContext.principal.principalId,
      actorKind,
      identityLinkVersion: verifiedContext.identityLink.identityLinkVersion,
      authorizationVersion: verifiedContext.principal.authorizationVersion,
      tenantLocatorVersion: verifiedContext.tenantLocatorVersion,
      ...(snapshot.scope.conversationKey ? { conversationKey: snapshot.scope.conversationKey } : {}),
      ...(snapshot.scope.executionId ? { executionId: snapshot.scope.executionId } : {}),
    }),
    channelAccess: snapshot.channelAccess,
    runtime: snapshot.runtime,
    ...(snapshot.sandbox ? { sandbox: snapshot.sandbox } : {}),
    generatedAt: snapshot.generatedAt,
  });
}
