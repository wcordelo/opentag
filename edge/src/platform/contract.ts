import type { ActiveTurnRecord } from "../store/active-turn-types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type Platform = "slack" | "buzz" | "teams";
export type ActorClass = "human" | "service" | "automation";

export type CanonicalInternalTenantId = string & {
  readonly __canonicalInternalTenantId: unique symbol;
};

export type CanonicalInternalPrincipalId = string & {
  readonly __canonicalInternalPrincipalId: unique symbol;
};

export type ExternalSubject = Readonly<{
  platform: Platform;
  platformTenantId: string;
  platformSubjectId: string;
}>;

export type InternalPrincipal = Readonly<{
  tenantId: CanonicalInternalTenantId;
  principalId: CanonicalInternalPrincipalId;
  kind: ActorClass;
  status: "active" | "suspended" | "revoked";
  authorizationVersion: number;
}>;

export type VerifiedIdentityLink = Readonly<{
  tenantId: CanonicalInternalTenantId;
  principalId: CanonicalInternalPrincipalId;
  subject: ExternalSubject;
  proofType: string;
  proofDigest: string;
  verifiedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  identityLinkVersion: number;
}>;

export type PlatformRequestContext = Readonly<{
  platform: Platform;
  externalTenantId: string;
  externalConversationId: string;
  externalThreadId: string;
  externalEventId: string;
  actor: ExternalSubject;
  principal: InternalPrincipal;
  identityLink: VerifiedIdentityLink;
  tenantLocatorVersion: number;
  verifiedIngress: Readonly<{
    method: string;
    evidenceDigest: string;
    verifiedAt: string;
  }>;
  preAdmittedTurn: Readonly<{ record: ActiveTurnRecord }>;
}>;

export type TenantLocator = Readonly<{
  platform: Platform;
  platformTenantId: string;
  tenantId: CanonicalInternalTenantId;
  version: number;
  status: "active";
}>;

export type TenantLocatorResolution =
  | Readonly<{ status: "resolved"; locator: TenantLocator }>
  | Readonly<{ status: "not_found" | "ambiguous" | "inactive" }>;

/** Read-only boundary. Locator writes require the separate privileged flow. */
export interface TenantLocatorReader {
  resolve(subject: Pick<ExternalSubject, "platform" | "platformTenantId">): Promise<TenantLocatorResolution>;
}

export class PlatformContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlatformContractError";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalIdentifier(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value !== value.normalize("NFC")
    || CONTROL_RE.test(value)
    || byteLength(value) > MAX_IDENTIFIER_BYTES
  ) {
    throw new PlatformContractError(code);
  }
  return value;
}

function canonicalUuid(value: unknown, code: string): string {
  const id = canonicalIdentifier(value, code);
  if (!UUID_RE.test(id)) throw new PlatformContractError(code);
  return id;
}

function positiveVersion(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PlatformContractError(code);
  }
  return value;
}

function timestamp(value: unknown, code: string): string {
  const result = canonicalIdentifier(value, code);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new PlatformContractError(code);
  }
  return result;
}

function rejectFutureTimestamp(value: string, now: Date, code: string): void {
  if (Date.parse(value) > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new PlatformContractError(code);
  }
}

function validatedPreAdmittedTurn(value: unknown): PlatformRequestContext["preAdmittedTurn"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformContractError("platform_missing_pre_admitted_turn");
  }
  const turn = value as Record<string, unknown>;
  if (typeof turn.record !== "object" || turn.record === null || Array.isArray(turn.record)) {
    throw new PlatformContractError("platform_missing_pre_admitted_turn");
  }
  const record = turn.record as Record<string, unknown>;
  if (typeof record.registeredAt !== "number" || !Number.isSafeInteger(record.registeredAt) || record.registeredAt < 0) {
    throw new PlatformContractError("platform_invalid_pre_admitted_turn");
  }
  const threadTs = record.threadTs === undefined
    ? undefined
    : canonicalIdentifier(record.threadTs, "platform_invalid_pre_admitted_turn");
  const choiceId = record.choiceId === undefined
    ? undefined
    : canonicalIdentifier(record.choiceId, "platform_invalid_pre_admitted_turn");
  const liveClientMessageId = record.liveClientMessageId === undefined
    ? undefined
    : canonicalIdentifier(record.liveClientMessageId, "platform_invalid_pre_admitted_turn");
  return Object.freeze({
    record: Object.freeze({
      channelId: canonicalIdentifier(record.channelId, "platform_invalid_pre_admitted_turn"),
      threadKey: canonicalIdentifier(record.threadKey, "platform_invalid_pre_admitted_turn"),
      conversationKey: canonicalIdentifier(record.conversationKey, "platform_invalid_pre_admitted_turn"),
      executionId: canonicalIdentifier(record.executionId, "platform_invalid_pre_admitted_turn"),
      registeredAt: record.registeredAt,
      ...(threadTs ? { threadTs } : {}),
      ...(choiceId ? { choiceId } : {}),
      ...(liveClientMessageId ? { liveClientMessageId } : {}),
    }),
  });
}

export function canonicalInternalTenantId(value: unknown): CanonicalInternalTenantId {
  return canonicalUuid(value, "platform_invalid_internal_tenant") as CanonicalInternalTenantId;
}

export function canonicalInternalPrincipalId(value: unknown): CanonicalInternalPrincipalId {
  return canonicalUuid(value, "platform_invalid_internal_principal") as CanonicalInternalPrincipalId;
}

export function validateExternalSubject(value: unknown): ExternalSubject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformContractError("platform_invalid_external_subject");
  }
  const subject = value as Record<string, unknown>;
  if (subject.platform !== "slack" && subject.platform !== "buzz" && subject.platform !== "teams") {
    throw new PlatformContractError("platform_invalid_external_platform");
  }
  return Object.freeze({
    platform: subject.platform,
    platformTenantId: canonicalIdentifier(subject.platformTenantId, "platform_invalid_external_tenant"),
    platformSubjectId: canonicalIdentifier(subject.platformSubjectId, "platform_invalid_external_subject_id"),
  });
}

export function validateInternalPrincipal(value: unknown): InternalPrincipal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformContractError("platform_invalid_principal");
  }
  const principal = value as Record<string, unknown>;
  if (principal.kind !== "human" && principal.kind !== "service" && principal.kind !== "automation") {
    throw new PlatformContractError("platform_invalid_principal_kind");
  }
  if (principal.status !== "active" && principal.status !== "suspended" && principal.status !== "revoked") {
    throw new PlatformContractError("platform_invalid_principal_status");
  }
  return Object.freeze({
    tenantId: canonicalInternalTenantId(principal.tenantId),
    principalId: canonicalInternalPrincipalId(principal.principalId),
    kind: principal.kind,
    status: principal.status,
    authorizationVersion: positiveVersion(principal.authorizationVersion, "platform_invalid_authorization_version"),
  });
}

export function validateVerifiedIdentityLink(value: unknown, now = new Date()): VerifiedIdentityLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformContractError("platform_invalid_identity_link");
  }
  const link = value as Record<string, unknown>;
  const verifiedAt = timestamp(link.verifiedAt, "platform_invalid_link_verified_at");
  const expiresAt = link.expiresAt === undefined ? undefined : timestamp(link.expiresAt, "platform_invalid_link_expiry");
  const revokedAt = link.revokedAt === undefined ? undefined : timestamp(link.revokedAt, "platform_invalid_link_revocation");
  if (revokedAt || (expiresAt && Date.parse(expiresAt) <= now.getTime())) {
    throw new PlatformContractError("platform_identity_link_inactive");
  }
  rejectFutureTimestamp(verifiedAt, now, "platform_identity_link_from_future");
  return Object.freeze({
    tenantId: canonicalInternalTenantId(link.tenantId),
    principalId: canonicalInternalPrincipalId(link.principalId),
    subject: validateExternalSubject(link.subject),
    proofType: canonicalIdentifier(link.proofType, "platform_invalid_link_proof_type"),
    proofDigest: canonicalIdentifier(link.proofDigest, "platform_invalid_link_proof_digest"),
    verifiedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    identityLinkVersion: positiveVersion(link.identityLinkVersion, "platform_invalid_identity_link_version"),
  });
}

export function requireActiveTenantLocator(
  resolution: TenantLocatorResolution,
  subject: Pick<ExternalSubject, "platform" | "platformTenantId">,
): TenantLocator {
  if (resolution.status !== "resolved") {
    throw new PlatformContractError(`platform_tenant_locator_${resolution.status}`);
  }
  const locator = resolution.locator;
  if (
    locator.status !== "active"
    || locator.platform !== subject.platform
    || locator.platformTenantId !== subject.platformTenantId
  ) {
    throw new PlatformContractError("platform_tenant_locator_mismatch");
  }
  return Object.freeze({
    platform: locator.platform,
    platformTenantId: canonicalIdentifier(locator.platformTenantId, "platform_invalid_external_tenant"),
    tenantId: canonicalInternalTenantId(locator.tenantId),
    version: positiveVersion(locator.version, "platform_invalid_tenant_locator_version"),
    status: "active",
  });
}

/** Effect boundaries must re-read the locator and reject changed mappings. */
export function requireCurrentTenantLocatorVersion(
  context: Pick<PlatformRequestContext, "tenantLocatorVersion">,
  currentVersion: unknown,
): void {
  if (positiveVersion(currentVersion, "platform_invalid_tenant_locator_version") !== context.tenantLocatorVersion) {
    throw new PlatformContractError("platform_stale_tenant_locator");
  }
}

export function validatePlatformRequestContext(value: unknown, now = new Date()): PlatformRequestContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformContractError("platform_invalid_request_context");
  }
  const context = value as Record<string, unknown>;
  const actor = validateExternalSubject(context.actor);
  const principal = validateInternalPrincipal(context.principal);
  const identityLink = validateVerifiedIdentityLink(context.identityLink, now);
  const tenantLocatorVersion = positiveVersion(
    context.tenantLocatorVersion,
    "platform_invalid_tenant_locator_version",
  );
  const externalTenantId = canonicalIdentifier(context.externalTenantId, "platform_invalid_external_tenant");
  const externalConversationId = canonicalIdentifier(context.externalConversationId, "platform_invalid_external_conversation");
  const externalThreadId = canonicalIdentifier(context.externalThreadId, "platform_invalid_external_thread");
  const externalEventId = canonicalIdentifier(context.externalEventId, "platform_invalid_external_event");
  if (context.platform !== "slack" && context.platform !== "buzz" && context.platform !== "teams") {
    throw new PlatformContractError("platform_invalid_external_platform");
  }
  if (
    context.platform !== actor.platform
    || externalTenantId !== actor.platformTenantId
    || principal.status !== "active"
    || identityLink.tenantId !== principal.tenantId
    || identityLink.principalId !== principal.principalId
    || identityLink.subject.platform !== actor.platform
    || identityLink.subject.platformTenantId !== actor.platformTenantId
    || identityLink.subject.platformSubjectId !== actor.platformSubjectId
  ) {
    throw new PlatformContractError("platform_request_identity_mismatch");
  }
  if (typeof context.verifiedIngress !== "object" || context.verifiedIngress === null || Array.isArray(context.verifiedIngress)) {
    throw new PlatformContractError("platform_invalid_verified_ingress");
  }
  const ingress = context.verifiedIngress as Record<string, unknown>;
  const ingressVerifiedAt = timestamp(ingress.verifiedAt, "platform_invalid_verified_ingress");
  rejectFutureTimestamp(ingressVerifiedAt, now, "platform_verified_ingress_from_future");
  const preAdmittedTurn = validatedPreAdmittedTurn(context.preAdmittedTurn);
  return Object.freeze({
    platform: actor.platform,
    externalTenantId,
    externalConversationId,
    externalThreadId,
    externalEventId,
    actor,
    principal,
    identityLink,
    tenantLocatorVersion,
    verifiedIngress: Object.freeze({
      method: canonicalIdentifier(ingress.method, "platform_invalid_verified_ingress"),
      evidenceDigest: canonicalIdentifier(ingress.evidenceDigest, "platform_invalid_verified_ingress"),
      verifiedAt: ingressVerifiedAt,
    }),
    preAdmittedTurn,
  });
}
