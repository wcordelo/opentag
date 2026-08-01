/**
 * Secret-free, replay-safe OAuth authorization state contracts.
 *
 * The state service only stores hashes of the browser-facing state and nonce.
 * Provider authorization codes and access/refresh tokens are deliberately not
 * accepted by these contracts; a separately authenticated effecter owns that
 * provider exchange and custody boundary.
 */

export const OAUTH_STATE_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_SCOPE_LENGTH = 128;
const MAX_SCOPES = 32;
const MIN_STATE_LENGTH = 16;
const MAX_STATE_LENGTH = 256;
const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 900;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SECRET_KEY_RE = /^(access.?token|api.?key|authorization|code|cookie|password|private.?key|secret|token|value)$/i;

export class OAuthStateError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(code);
    this.name = "OAuthStateError";
  }
}

export type OAuthStateIssueRequest = Readonly<{
  schemaVersion: typeof OAUTH_STATE_SCHEMA_VERSION;
  tenantId: string;
  principalId: string;
  connectorId: string;
  marketplaceVersion: string;
  redirectUri: string;
  scopes: readonly string[];
  ttlSeconds?: number;
}>;

export type OAuthStateIssued = Readonly<{
  schemaVersion: typeof OAUTH_STATE_SCHEMA_VERSION;
  state: string;
  nonce: string;
  tenantId: string;
  principalId: string;
  connectorId: string;
  marketplaceVersion: string;
  redirectUri: string;
  scopes: readonly string[];
  issuedAt: string;
  expiresAt: string;
}>;

export type OAuthStateConsumeRequest = Readonly<{
  schemaVersion: typeof OAUTH_STATE_SCHEMA_VERSION;
  state: string;
  nonce: string;
  tenantId: string;
  principalId: string;
  connectorId: string;
  marketplaceVersion: string;
  redirectUri: string;
}>;

export type OAuthStateConsumed = Readonly<{
  schemaVersion: typeof OAUTH_STATE_SCHEMA_VERSION;
  tenantId: string;
  principalId: string;
  connectorId: string;
  marketplaceVersion: string;
  redirectUri: string;
  scopes: readonly string[];
  issuedAt: string;
  expiresAt: string;
  consumedAt: string;
}>;

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new OAuthStateError(`${field}_invalid`);
  }
  return value;
}

function opaqueValue(value: unknown, field: string): string {
  const result = identifier(value, field, MAX_STATE_LENGTH);
  if (result.length < MIN_STATE_LENGTH) throw new OAuthStateError(`${field}_invalid`);
  return result;
}

function scopeList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) {
    throw new OAuthStateError("oauth_scopes_invalid");
  }
  return [...new Set(value.map((item) => identifier(item, "oauth_scope", MAX_SCOPE_LENGTH)))];
}

function rejectSecretMaterial(value: unknown, depth = 0): void {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretMaterial(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) throw new OAuthStateError("oauth_secret_material_forbidden");
    rejectSecretMaterial(child, depth + 1);
  }
}

export function parseAllowedRedirectOrigins(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 32) {
    throw new OAuthStateError("oauth_redirect_origins_invalid");
  }
  const origins = parts.map((part) => {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      throw new OAuthStateError("oauth_redirect_origins_invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new OAuthStateError("oauth_redirect_origins_invalid");
    }
    return url.origin;
  });
  return Object.freeze([...new Set(origins)]);
}

function redirectUri(value: unknown, allowedOrigins: readonly string[]): string {
  const input = identifier(value, "redirect_uri", MAX_REDIRECT_URI_LENGTH);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OAuthStateError("redirect_uri_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new OAuthStateError("redirect_uri_not_allowed");
  }
  return url.toString();
}

export function validateOAuthStateIssueRequest(
  value: unknown,
  allowedOrigins: readonly string[],
): OAuthStateIssueRequest {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthStateError("oauth_state_issue_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== OAUTH_STATE_SCHEMA_VERSION) {
    throw new OAuthStateError("oauth_state_schema_invalid");
  }
  const ttlSeconds = input.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : input.ttlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || (ttlSeconds as number) < MIN_TTL_SECONDS || (ttlSeconds as number) > MAX_TTL_SECONDS) {
    throw new OAuthStateError("oauth_state_ttl_invalid");
  }
  return Object.freeze({
    schemaVersion: OAUTH_STATE_SCHEMA_VERSION,
    tenantId: identifier(input.tenantId, "tenant_id"),
    principalId: identifier(input.principalId, "principal_id"),
    connectorId: identifier(input.connectorId, "connector_id"),
    marketplaceVersion: identifier(input.marketplaceVersion, "marketplace_version"),
    redirectUri: redirectUri(input.redirectUri, allowedOrigins),
    scopes: scopeList(input.scopes),
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: ttlSeconds as number }),
  });
}

export function validateOAuthStateConsumeRequest(
  value: unknown,
  allowedOrigins: readonly string[],
): OAuthStateConsumeRequest {
  rejectSecretMaterial(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthStateError("oauth_state_consume_invalid");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== OAUTH_STATE_SCHEMA_VERSION) {
    throw new OAuthStateError("oauth_state_schema_invalid");
  }
  return Object.freeze({
    schemaVersion: OAUTH_STATE_SCHEMA_VERSION,
    state: opaqueValue(input.state, "state"),
    nonce: opaqueValue(input.nonce, "nonce"),
    tenantId: identifier(input.tenantId, "tenant_id"),
    principalId: identifier(input.principalId, "principal_id"),
    connectorId: identifier(input.connectorId, "connector_id"),
    marketplaceVersion: identifier(input.marketplaceVersion, "marketplace_version"),
    redirectUri: redirectUri(input.redirectUri, allowedOrigins),
  });
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function randomOAuthSecret(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new OAuthStateError("oauth_random_size_invalid");
  }
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

export async function hashOAuthSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export function expiryFrom(now: number, ttlSeconds: number): string {
  return nowIso(now + ttlSeconds * 1_000);
}
