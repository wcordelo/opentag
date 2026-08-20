import {
  canonicalInternalTenantId,
  type ExternalSubject,
  type Platform,
  type TenantLocator,
  type TenantLocatorReader,
  type TenantLocatorResolution,
} from "./contract.js";

export const TENANT_LOCATOR_SCHEMA_VERSION = 1 as const;
/** Reserved metadata object used for the server-owned external tenant index. */
export const TENANT_LOCATOR_OBJECT_NAME = "__platform_marketplace__";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_IDENTIFIER_LENGTH = 256;

export type TenantLocatorRecord = Readonly<{
  schemaVersion: typeof TENANT_LOCATOR_SCHEMA_VERSION;
  platform: Platform;
  platformTenantId: string;
  tenantId: string;
  version: number;
  status: "active" | "revoked";
  updatedAt: string;
  revokedAt?: string;
}>;

export type TenantLocatorRevocation = Readonly<{
  schemaVersion: typeof TENANT_LOCATOR_SCHEMA_VERSION;
  platform: Platform;
  platformTenantId: string;
  version: number;
  revokedAt: string;
}>;

export type TenantLocatorLookup = Readonly<{
  schemaVersion: typeof TENANT_LOCATOR_SCHEMA_VERSION;
  platform: Platform;
  platformTenantId: string;
}>;

export class TenantLocatorContractError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(code);
    this.name = "TenantLocatorContractError";
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TenantLocatorContractError(code);
  }
  return value as Record<string, unknown>;
}

function exactFields(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new TenantLocatorContractError(code);
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    CONTROL_RE.test(value)
  ) {
    throw new TenantLocatorContractError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new TenantLocatorContractError(`${field}_invalid`);
  }
  return result;
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TenantLocatorContractError(`${field}_invalid`);
  }
  return value as number;
}

function platform(value: unknown): Platform {
  if (value !== "slack" && value !== "buzz" && value !== "teams") {
    throw new TenantLocatorContractError("platform_invalid");
  }
  return value;
}

function tenantId(value: unknown): string {
  const result = identifier(value, "tenant_id");
  if (!UUID_RE.test(result)) {
    throw new TenantLocatorContractError("tenant_id_invalid");
  }
  try {
    return canonicalInternalTenantId(result);
  } catch {
    throw new TenantLocatorContractError("tenant_id_invalid");
  }
}

export function validateTenantLocatorRecord(value: unknown): TenantLocatorRecord {
  const input = object(value, "tenant_locator_invalid");
  exactFields(
    input,
    ["schemaVersion", "platform", "platformTenantId", "tenantId", "version", "status", "updatedAt", "revokedAt"],
    "tenant_locator_field_invalid",
  );
  if (input.schemaVersion !== TENANT_LOCATOR_SCHEMA_VERSION) {
    throw new TenantLocatorContractError("tenant_locator_schema_invalid");
  }
  const status = input.status === "active" || input.status === "revoked"
    ? input.status
    : undefined;
  if (!status) throw new TenantLocatorContractError("tenant_locator_status_invalid");
  const revokedAt = input.revokedAt === undefined
    ? undefined
    : timestamp(input.revokedAt, "revoked_at");
  if (status === "active" && revokedAt !== undefined) {
    throw new TenantLocatorContractError("tenant_locator_active_has_revocation");
  }
  if (status === "revoked" && revokedAt === undefined) {
    throw new TenantLocatorContractError("tenant_locator_revoked_missing_revocation");
  }
  return Object.freeze({
    schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
    platform: platform(input.platform),
    platformTenantId: identifier(input.platformTenantId, "platform_tenant_id"),
    tenantId: tenantId(input.tenantId),
    version: version(input.version, "version"),
    status,
    updatedAt: timestamp(input.updatedAt, "updated_at"),
    ...(revokedAt ? { revokedAt } : {}),
  });
}

export function validateTenantLocatorRevocation(value: unknown): TenantLocatorRevocation {
  const input = object(value, "tenant_locator_revocation_invalid");
  exactFields(
    input,
    ["schemaVersion", "platform", "platformTenantId", "version", "revokedAt"],
    "tenant_locator_revocation_field_invalid",
  );
  if (input.schemaVersion !== TENANT_LOCATOR_SCHEMA_VERSION) {
    throw new TenantLocatorContractError("tenant_locator_schema_invalid");
  }
  return Object.freeze({
    schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
    platform: platform(input.platform),
    platformTenantId: identifier(input.platformTenantId, "platform_tenant_id"),
    version: version(input.version, "version"),
    revokedAt: timestamp(input.revokedAt, "revoked_at"),
  });
}

export function validateTenantLocatorLookup(value: unknown): TenantLocatorLookup {
  const input = object(value, "tenant_locator_lookup_invalid");
  exactFields(input, ["schemaVersion", "platform", "platformTenantId"], "tenant_locator_lookup_field_invalid");
  if (input.schemaVersion !== TENANT_LOCATOR_SCHEMA_VERSION) {
    throw new TenantLocatorContractError("tenant_locator_schema_invalid");
  }
  return Object.freeze({
    schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
    platform: platform(input.platform),
    platformTenantId: identifier(input.platformTenantId, "platform_tenant_id"),
  });
}

export function tenantLocatorResolutionFromRecord(record: TenantLocatorRecord): TenantLocatorResolution {
  if (record.status === "revoked") return { status: "inactive" };
  const locator: TenantLocator = {
    platform: record.platform,
    platformTenantId: record.platformTenantId,
    tenantId: canonicalInternalTenantId(record.tenantId),
    version: record.version,
    status: "active",
  };
  return Object.freeze({ status: "resolved", locator: Object.freeze(locator) });
}

export function validateTenantLocatorResolution(value: unknown): TenantLocatorResolution {
  const input = object(value, "tenant_locator_resolution_invalid");
  if (input.status === "not_found" || input.status === "ambiguous" || input.status === "inactive") {
    return Object.freeze({ status: input.status });
  }
  if (input.status !== "resolved") {
    throw new TenantLocatorContractError("tenant_locator_resolution_status_invalid");
  }
  return tenantLocatorResolutionFromRecord(validateTenantLocatorRecord({
    ...input.locator as Record<string, unknown>,
    schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
    status: "active",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }));
}

export function tenantLocatorSubject(value: Pick<ExternalSubject, "platform" | "platformTenantId">): TenantLocatorLookup {
  return validateTenantLocatorLookup({
    schemaVersion: TENANT_LOCATOR_SCHEMA_VERSION,
    platform: value.platform,
    platformTenantId: value.platformTenantId,
  });
}

export type PlatformStateStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type PlatformStateNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): PlatformStateStub;
};

/** Read-only production adapter for the server-owned locator registry. */
export class PlatformStateTenantLocatorReader implements TenantLocatorReader {
  constructor(
    private readonly namespace: PlatformStateNamespace,
    private readonly objectName = TENANT_LOCATOR_OBJECT_NAME,
  ) {}

  async resolve(subject: Pick<ExternalSubject, "platform" | "platformTenantId">): Promise<TenantLocatorResolution> {
    const lookup = tenantLocatorSubject(subject);
    let response: Response;
    try {
      const stub = this.namespace.get(this.namespace.idFromName(this.objectName));
      response = await stub.fetch("https://platform-state/tenant-locator/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lookup),
      });
    } catch {
      throw new TenantLocatorContractError("tenant_locator_unavailable", 503);
    }
    if (!response.ok) throw new TenantLocatorContractError("tenant_locator_unavailable", 503);
    try {
      return validateTenantLocatorResolution(await response.json());
    } catch {
      throw new TenantLocatorContractError("tenant_locator_response_invalid", 503);
    }
  }
}
