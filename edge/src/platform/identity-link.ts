import {
  canonicalInternalPrincipalId,
  canonicalInternalTenantId,
  type ExternalSubject,
  type InternalPrincipal,
  type Platform,
  type VerifiedIdentityLink,
  validateExternalSubject,
} from "./contract.js";
import { platformTenantObjectName } from "./tenant-routing.js";
import type { PlatformStateNamespace, PlatformStateStub } from "./tenant-locator.js";

export const IDENTITY_LINK_SCHEMA_VERSION = 1 as const;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type IdentityLinkRecord = Readonly<{
  schemaVersion: typeof IDENTITY_LINK_SCHEMA_VERSION;
  tenantId: string;
  subject: ExternalSubject;
  principal: InternalPrincipal;
  identityLink: VerifiedIdentityLink;
  version: number;
  status: "active" | "revoked";
  updatedAt: string;
  revokedAt?: string;
}>;

export type IdentityLinkLookup = Readonly<{
  schemaVersion: typeof IDENTITY_LINK_SCHEMA_VERSION;
  platform: Platform;
  platformTenantId: string;
  platformSubjectId: string;
}>;

export type IdentityLinkRevocation = Readonly<{
  schemaVersion: typeof IDENTITY_LINK_SCHEMA_VERSION;
  platform: Platform;
  platformTenantId: string;
  platformSubjectId: string;
  version: number;
  revokedAt: string;
}>;

export type IdentityLinkResolution =
  | Readonly<{ status: "resolved"; principal: InternalPrincipal; identityLink: VerifiedIdentityLink }>
  | Readonly<{ status: "not_found" | "ambiguous" | "inactive" }>;

export interface IdentityLinkReader {
  resolve(
    subject: Pick<ExternalSubject, "platform" | "platformTenantId" | "platformSubjectId">,
    tenantId: string,
  ): Promise<IdentityLinkResolution>;
}

export class IdentityLinkContractError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(code);
    this.name = "IdentityLinkContractError";
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IdentityLinkContractError(code);
  }
  return value as Record<string, unknown>;
}

function exactFields(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new IdentityLinkContractError(code);
  }
}

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    CONTROL_RE.test(value)
  ) {
    throw new IdentityLinkContractError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new IdentityLinkContractError(`${field}_invalid`);
  }
  return result;
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IdentityLinkContractError(`${field}_invalid`);
  }
  return value as number;
}

function platform(value: unknown): Platform {
  if (value !== "slack" && value !== "buzz" && value !== "teams") {
    throw new IdentityLinkContractError("platform_invalid");
  }
  return value;
}

function canonicalTenantId(value: unknown): string {
  const result = identifier(value, "tenant_id");
  if (!UUID_RE.test(result)) throw new IdentityLinkContractError("tenant_id_invalid");
  try {
    return canonicalInternalTenantId(result);
  } catch {
    throw new IdentityLinkContractError("tenant_id_invalid");
  }
}

function principal(value: unknown): InternalPrincipal {
  const input = object(value, "identity_principal_invalid");
  exactFields(
    input,
    ["tenantId", "principalId", "kind", "status", "authorizationVersion"],
    "identity_principal_field_invalid",
  );
  try {
    const result = {
      tenantId: canonicalInternalTenantId(input.tenantId),
      principalId: canonicalInternalPrincipalId(input.principalId),
      kind: input.kind,
      status: input.status,
      authorizationVersion: input.authorizationVersion,
    };
    if (result.kind !== "human" && result.kind !== "service" && result.kind !== "automation") {
      throw new IdentityLinkContractError("identity_principal_kind_invalid");
    }
    if (result.status !== "active" && result.status !== "suspended" && result.status !== "revoked") {
      throw new IdentityLinkContractError("identity_principal_status_invalid");
    }
    return Object.freeze({
      tenantId: result.tenantId,
      principalId: result.principalId,
      kind: result.kind,
      status: result.status,
      authorizationVersion: version(result.authorizationVersion, "authorization_version"),
    });
  } catch (error) {
    if (error instanceof IdentityLinkContractError) throw error;
    throw new IdentityLinkContractError("identity_principal_invalid");
  }
}

function subject(value: unknown): ExternalSubject {
  try {
    return validateExternalSubject(value);
  } catch {
    throw new IdentityLinkContractError("identity_subject_invalid");
  }
}

function verifiedLink(value: unknown, now = new Date(), allowExpired = false): VerifiedIdentityLink {
  const input = object(value, "identity_link_invalid");
  exactFields(
    input,
    ["tenantId", "principalId", "subject", "proofType", "proofDigest", "verifiedAt", "expiresAt", "identityLinkVersion"],
    "identity_link_field_invalid",
  );
  const verifiedAt = timestamp(input.verifiedAt, "verified_at");
  const expiresAt = input.expiresAt === undefined ? undefined : timestamp(input.expiresAt, "expires_at");
  const tenant = canonicalTenantId(input.tenantId);
  let principalId: string;
  try {
    principalId = canonicalInternalPrincipalId(input.principalId);
  } catch {
    throw new IdentityLinkContractError("principal_id_invalid");
  }
  const linkedSubject = subject(input.subject);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(verifiedAt)) {
    throw new IdentityLinkContractError("identity_link_expiry_invalid");
  }
  if (!allowExpired && expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    throw new IdentityLinkContractError("identity_link_inactive");
  }
  if (Date.parse(verifiedAt) > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new IdentityLinkContractError("identity_link_from_future");
  }
  const proofDigest = identifier(input.proofDigest, "proof_digest");
  if (!/^sha256:[A-Za-z0-9_-]{1,128}$/.test(proofDigest)) {
    throw new IdentityLinkContractError("proof_digest_invalid");
  }
  return Object.freeze({
    tenantId: canonicalInternalTenantId(tenant),
    principalId: canonicalInternalPrincipalId(principalId),
    subject: linkedSubject,
    proofType: identifier(input.proofType, "proof_type"),
    proofDigest,
    verifiedAt,
    ...(expiresAt ? { expiresAt } : {}),
    identityLinkVersion: version(input.identityLinkVersion, "identity_link_version"),
  });
}

function checkRelationships(record: IdentityLinkRecord): void {
  if (record.tenantId !== record.principal.tenantId || record.identityLink.tenantId !== record.principal.tenantId) {
    throw new IdentityLinkContractError("identity_link_tenant_mismatch", 409);
  }
  if (
    record.identityLink.principalId !== record.principal.principalId ||
    record.identityLink.subject.platform !== record.subject.platform ||
    record.identityLink.subject.platformTenantId !== record.subject.platformTenantId ||
    record.identityLink.subject.platformSubjectId !== record.subject.platformSubjectId
  ) {
    throw new IdentityLinkContractError("identity_link_subject_mismatch", 409);
  }
  if (record.version !== record.identityLink.identityLinkVersion) {
    throw new IdentityLinkContractError("identity_link_version_mismatch", 409);
  }
}

export function validateIdentityLinkRecord(value: unknown, now = new Date()): IdentityLinkRecord {
  const input = object(value, "identity_link_record_invalid");
  exactFields(
    input,
    ["schemaVersion", "tenantId", "subject", "principal", "identityLink", "version", "status", "updatedAt", "revokedAt"],
    "identity_link_record_field_invalid",
  );
  if (input.schemaVersion !== IDENTITY_LINK_SCHEMA_VERSION) {
    throw new IdentityLinkContractError("identity_link_schema_invalid");
  }
  const status = input.status === "active" || input.status === "revoked" ? input.status : undefined;
  if (!status) throw new IdentityLinkContractError("identity_link_status_invalid");
  const revokedAt = input.revokedAt === undefined ? undefined : timestamp(input.revokedAt, "revoked_at");
  if (status === "active" && revokedAt !== undefined) {
    throw new IdentityLinkContractError("identity_link_active_has_revocation");
  }
  if (status === "revoked" && revokedAt === undefined) {
    throw new IdentityLinkContractError("identity_link_revoked_missing_revocation");
  }
  const record = Object.freeze({
    schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
    tenantId: canonicalTenantId(input.tenantId),
    subject: subject(input.subject),
    principal: principal(input.principal),
    identityLink: verifiedLink(input.identityLink, now, status === "revoked"),
    version: version(input.version, "version"),
    status,
    updatedAt: timestamp(input.updatedAt, "updated_at"),
    ...(revokedAt ? { revokedAt } : {}),
  });
  checkRelationships(record);
  return record;
}

export function validateIdentityLinkLookup(value: unknown): IdentityLinkLookup {
  const input = object(value, "identity_link_lookup_invalid");
  exactFields(
    input,
    ["schemaVersion", "platform", "platformTenantId", "platformSubjectId"],
    "identity_link_lookup_field_invalid",
  );
  if (input.schemaVersion !== IDENTITY_LINK_SCHEMA_VERSION) {
    throw new IdentityLinkContractError("identity_link_schema_invalid");
  }
  return Object.freeze({
    schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
    platform: platform(input.platform),
    platformTenantId: identifier(input.platformTenantId, "platform_tenant_id"),
    platformSubjectId: identifier(input.platformSubjectId, "platform_subject_id"),
  });
}

export function validateIdentityLinkRevocation(value: unknown): IdentityLinkRevocation {
  const input = object(value, "identity_link_revocation_invalid");
  exactFields(
    input,
    ["schemaVersion", "platform", "platformTenantId", "platformSubjectId", "version", "revokedAt"],
    "identity_link_revocation_field_invalid",
  );
  if (input.schemaVersion !== IDENTITY_LINK_SCHEMA_VERSION) {
    throw new IdentityLinkContractError("identity_link_schema_invalid");
  }
  return Object.freeze({
    schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
    platform: platform(input.platform),
    platformTenantId: identifier(input.platformTenantId, "platform_tenant_id"),
    platformSubjectId: identifier(input.platformSubjectId, "platform_subject_id"),
    version: version(input.version, "version"),
    revokedAt: timestamp(input.revokedAt, "revoked_at"),
  });
}

export function identityLinkResolutionFromRecord(record: IdentityLinkRecord, now = new Date()): IdentityLinkResolution {
  if (record.status === "revoked" || record.principal.status !== "active") return { status: "inactive" };
  try {
    const identityLink = verifiedLink(record.identityLink, now);
    return Object.freeze({
      status: "resolved",
      principal: record.principal,
      identityLink,
    });
  } catch (error) {
    if (error instanceof IdentityLinkContractError && error.code === "identity_link_inactive") {
      return { status: "inactive" };
    }
    throw error;
  }
}

export function validateIdentityLinkResolution(value: unknown, now = new Date()): IdentityLinkResolution {
  const input = object(value, "identity_link_resolution_invalid");
  if (input.status === "not_found" || input.status === "ambiguous" || input.status === "inactive") {
    return Object.freeze({ status: input.status });
  }
  if (input.status !== "resolved") {
    throw new IdentityLinkContractError("identity_link_resolution_status_invalid");
  }
  const principalValue = principal(input.principal);
  const identityLinkValue = verifiedLink(input.identityLink, now);
  const record = validateIdentityLinkRecord({
    schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
    tenantId: principalValue.tenantId,
    subject: identityLinkValue.subject,
    principal: principalValue,
    identityLink: identityLinkValue,
    version: identityLinkValue.identityLinkVersion,
    status: "active",
    updatedAt: identityLinkValue.verifiedAt,
  }, now);
  return identityLinkResolutionFromRecord(record, now);
}

/** Read-only adapter for identity links after a locator has selected a tenant object. */
export class PlatformStateIdentityLinkReader implements IdentityLinkReader {
  constructor(private readonly namespace: PlatformStateNamespace) {}

  async resolve(
    subjectValue: Pick<ExternalSubject, "platform" | "platformTenantId" | "platformSubjectId">,
    tenantIdValue: string,
  ): Promise<IdentityLinkResolution> {
    const lookup = validateIdentityLinkLookup({
      schemaVersion: IDENTITY_LINK_SCHEMA_VERSION,
      ...subjectValue,
    });
    const tenantId = canonicalTenantId(tenantIdValue);
    let response: Response;
    try {
      const stub: PlatformStateStub = this.namespace.get(
        this.namespace.idFromName(platformTenantObjectName(tenantId)),
      );
      response = await stub.fetch("https://platform-state/identity-link/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lookup),
      });
    } catch {
      throw new IdentityLinkContractError("identity_link_unavailable", 503);
    }
    if (!response.ok) throw new IdentityLinkContractError("identity_link_unavailable", 503);
    try {
      return validateIdentityLinkResolution(await response.json());
    } catch {
      throw new IdentityLinkContractError("identity_link_response_invalid", 503);
    }
  }
}
