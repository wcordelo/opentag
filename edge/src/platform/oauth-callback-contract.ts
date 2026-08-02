/**
 * One-request OAuth callback handoff.
 *
 * The code and nonce are intentionally present only in transit between the
 * callback and effecter Workers. Neither Worker persists or logs this value;
 * the effecter must exchange it with the provider and return only a custody
 * reference to the platform ledger.
 */

export const OAUTH_CALLBACK_SCHEMA_VERSION = 1 as const;

const MAX_STATE_LENGTH = 256;
const MIN_STATE_LENGTH = 16;
const MAX_CODE_LENGTH = 4_096;
const MAX_ERROR_LENGTH = 128;
const MAX_ERROR_DESCRIPTION_LENGTH = 512;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type OAuthCallbackHandoff = Readonly<{
  schemaVersion: typeof OAUTH_CALLBACK_SCHEMA_VERSION;
  state: string;
  nonce: string;
  callbackOrigin: string;
  receivedAt: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}>;

export class OAuthCallbackContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthCallbackContractError";
  }
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || CONTROL_RE.test(value)) {
    throw new OAuthCallbackContractError(`${field}_invalid`);
  }
  return value;
}

function opaque(value: unknown, field: string): string {
  const result = bounded(value, field, MAX_STATE_LENGTH);
  if (result.length < MIN_STATE_LENGTH) throw new OAuthCallbackContractError(`${field}_invalid`);
  return result;
}

function origin(value: unknown): string {
  const result = bounded(value, "oauth_callback_origin", 512);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new OAuthCallbackContractError("oauth_callback_origin_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OAuthCallbackContractError("oauth_callback_origin_invalid");
  }
  return url.origin;
}

function timestamp(value: unknown): string {
  const result = bounded(value, "oauth_callback_received_at", 32);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new OAuthCallbackContractError("oauth_callback_received_at_invalid");
  }
  return result;
}

export function validateOAuthCallbackHandoff(value: unknown): OAuthCallbackHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthCallbackContractError("oauth_callback_handoff_invalid");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "state",
    "nonce",
    "callbackOrigin",
    "receivedAt",
    "code",
    "error",
    "errorDescription",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new OAuthCallbackContractError("oauth_callback_field_invalid");
  }
  if (input.schemaVersion !== OAUTH_CALLBACK_SCHEMA_VERSION) {
    throw new OAuthCallbackContractError("oauth_callback_schema_invalid");
  }
  const state = opaque(input.state, "oauth_state");
  const nonce = opaque(input.nonce, "oauth_nonce");
  const callbackOrigin = origin(input.callbackOrigin);
  const receivedAt = timestamp(input.receivedAt);
  const code = input.code === undefined ? undefined : bounded(input.code, "oauth_code", MAX_CODE_LENGTH);
  const error = input.error === undefined ? undefined : bounded(input.error, "oauth_error", MAX_ERROR_LENGTH);
  const errorDescription = input.errorDescription === undefined
    ? undefined
    : bounded(input.errorDescription, "oauth_error_description", MAX_ERROR_DESCRIPTION_LENGTH);
  if (!code && !error) throw new OAuthCallbackContractError("oauth_result_missing");
  if (code && error) throw new OAuthCallbackContractError("oauth_result_conflict");
  if (error && !/^[a-z][a-z0-9_.:-]*$/i.test(error)) {
    throw new OAuthCallbackContractError("oauth_error_invalid");
  }
  if (errorDescription && !error) {
    throw new OAuthCallbackContractError("oauth_error_description_without_error");
  }
  return Object.freeze({
    schemaVersion: OAUTH_CALLBACK_SCHEMA_VERSION,
    state,
    nonce,
    callbackOrigin,
    receivedAt,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(errorDescription ? { errorDescription } : {}),
  });
}
