/**
 * Authenticated provider-adapter protocol for OAuth callback completion.
 *
 * The effecter is the only OpenTag Worker that forwards the callback handoff
 * to this boundary. The adapter is responsible for provider exchange and
 * custody outside the application ledger. Requests contain the one-use code
 * only in transit; successful responses contain an opaque custody reference,
 * never provider secret material.
 */

import {
  OAuthCallbackContractError,
  validateOAuthCallbackHandoff,
  type OAuthCallbackHandoff,
} from "./oauth-callback-contract.js";

export const OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SCOPE_LENGTH = 128;
const MAX_SCOPES = 32;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class OAuthProviderAdapterContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthProviderAdapterContractError";
  }
}

export type OAuthProviderAdapterRequest = Readonly<{
  schemaVersion: typeof OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION;
  handoff: OAuthCallbackHandoff;
}>;

export type OAuthProviderAdapterReceipt = Readonly<{
  schemaVersion: typeof OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION;
  tenantId: string;
  principalId: string;
  connectorId: string;
  provider: string;
  marketplaceVersion: string;
  credentialRef: `credential:${string}`;
  providerSubject: string;
  scopes: readonly string[];
  version: number;
  issuedAt: string;
  expiresAt?: string;
}>;

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new OAuthProviderAdapterContractError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new OAuthProviderAdapterContractError(`${field}_invalid`);
  }
  return result;
}

function scopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) {
    throw new OAuthProviderAdapterContractError("oauth_adapter_scopes_invalid");
  }
  return [...new Set(value.map((scope) => identifier(scope, "oauth_adapter_scope", MAX_SCOPE_LENGTH)))];
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OAuthProviderAdapterContractError("oauth_adapter_version_invalid");
  }
  return value as number;
}

function assertObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthProviderAdapterContractError(code);
  }
  return value as Record<string, unknown>;
}

export function validateOAuthProviderAdapterRequest(value: unknown): OAuthProviderAdapterRequest {
  const input = assertObject(value, "oauth_adapter_request_invalid");
  const allowed = new Set(["schemaVersion", "handoff"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new OAuthProviderAdapterContractError("oauth_adapter_field_invalid");
  }
  if (input.schemaVersion !== OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION) {
    throw new OAuthProviderAdapterContractError("oauth_adapter_schema_invalid");
  }
  try {
    return Object.freeze({
      schemaVersion: OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION,
      handoff: validateOAuthCallbackHandoff(input.handoff),
    });
  } catch (error) {
    if (error instanceof OAuthCallbackContractError) {
      throw new OAuthProviderAdapterContractError(error.code);
    }
    throw new OAuthProviderAdapterContractError("oauth_adapter_handoff_invalid");
  }
}

export function validateOAuthProviderAdapterReceipt(value: unknown): OAuthProviderAdapterReceipt {
  const input = assertObject(value, "oauth_adapter_receipt_invalid");
  const allowed = new Set([
    "schemaVersion",
    "tenantId",
    "principalId",
    "connectorId",
    "provider",
    "marketplaceVersion",
    "credentialRef",
    "providerSubject",
    "scopes",
    "version",
    "issuedAt",
    "expiresAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new OAuthProviderAdapterContractError("oauth_adapter_receipt_field_invalid");
  }
  if (input.schemaVersion !== OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION) {
    throw new OAuthProviderAdapterContractError("oauth_adapter_receipt_schema_invalid");
  }
  const credentialRef = identifier(input.credentialRef, "credential_ref");
  if (!credentialRef.startsWith("credential:")) {
    throw new OAuthProviderAdapterContractError("credential_ref_invalid");
  }
  return Object.freeze({
    schemaVersion: OAUTH_PROVIDER_ADAPTER_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    principalId: identifier(input.principalId, "principal_id"),
    connectorId: identifier(input.connectorId, "connector_id"),
    provider: identifier(input.provider, "provider"),
    marketplaceVersion: identifier(input.marketplaceVersion, "marketplace_version"),
    credentialRef: credentialRef as `credential:${string}`,
    providerSubject: identifier(input.providerSubject, "provider_subject"),
    scopes: scopes(input.scopes),
    version: positiveVersion(input.version),
    issuedAt: timestamp(input.issuedAt, "issued_at"),
    ...(input.expiresAt === undefined ? {} : { expiresAt: timestamp(input.expiresAt, "expires_at") }),
  });
}
