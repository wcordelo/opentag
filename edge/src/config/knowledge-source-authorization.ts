import {
  parseKnowledgeSourceScope,
  parsePutTrackedKnowledgeSource,
  type KnowledgeSourceScope,
} from "./knowledge-config.js";

export const KNOWLEDGE_SOURCE_GRANT_HEADER = "x-opentag-knowledge-source-grant";
export const KNOWLEDGE_SOURCE_GRANT_TYPE = "OT-KNOWLEDGE-SOURCE-GRANT";
export const KNOWLEDGE_SOURCE_GRANT_MAX_LIFETIME_MS = 5 * 60_000;
const KNOWLEDGE_SOURCE_GRANT_CLOCK_SKEW_MS = 30_000;

export const KNOWLEDGE_SOURCE_ACTIONS = [
  "inspect",
  "list_exact",
  "stage_disabled",
  "update_disabled",
  "enable_first",
  "disable",
] as const;

export type KnowledgeSourceAction = typeof KNOWLEDGE_SOURCE_ACTIONS[number];

export type KnowledgeSourceAdminRequest = KnowledgeSourceScope & {
  action: KnowledgeSourceAction;
  expectedConfigVersion: number | null;
  readerPolicyRef: string | null;
  retentionDays: number | null;
};

export type VerifiedKnowledgeSourceGrant = {
  version: 1;
  grantId: string;
  issuer: string;
  keyId: string;
  actorKind: "human" | "service";
  actorId: string;
  action: KnowledgeSourceAction;
  teamId: string;
  sourceType?: KnowledgeSourceScope["sourceType"];
  projectId: string;
  channelId: string;
  expectedConfigVersion: number | null;
  requestDigest: string;
  artifactDigest: string;
  issuedAt: string;
  expiresAt: string;
};

export type KnowledgeSourceGrantVerifierConfig = {
  publicKey?: string;
  issuer?: string;
  keyId?: string;
};

export class KnowledgeSourceAuthorizationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 503,
  ) {
    super(code);
    this.name = "KnowledgeSourceAuthorizationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeSourceAuthorizationError(`${label}_must_be_an_object`, 400);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new KnowledgeSourceAuthorizationError(
      `${label}_contains_unexpected_fields`,
      400,
    );
  }
}

function boundedText(
  value: unknown,
  field: string,
  maxLength = 256,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new KnowledgeSourceAuthorizationError(`${field}_is_invalid`, 403);
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const text = boundedText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new KnowledgeSourceAuthorizationError(`${field}_is_invalid`, 403);
  }
  return text;
}

function base64UrlBytes(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new KnowledgeSourceAuthorizationError(`${label}_is_invalid`, 403);
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new KnowledgeSourceAuthorizationError(`${label}_is_invalid`, 403);
  }
}

function utf8Json(value: string, label: string): Record<string, unknown> {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        base64UrlBytes(value, label),
      )),
      label,
    );
  } catch (error) {
    if (error instanceof KnowledgeSourceAuthorizationError) throw error;
    throw new KnowledgeSourceAuthorizationError(`${label}_is_invalid`, 403);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function isKnowledgeSourceAction(value: unknown): value is KnowledgeSourceAction {
  return typeof value === "string" &&
    (KNOWLEDGE_SOURCE_ACTIONS as readonly string[]).includes(value);
}

function expectedConfigVersion(
  value: unknown,
  action: KnowledgeSourceAction,
): number | null {
  if (action === "inspect" || action === "list_exact") {
    if (value !== undefined && value !== null) {
      throw new KnowledgeSourceAuthorizationError(
        "read_action_must_not_choose_config_version",
        400,
      );
    }
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new KnowledgeSourceAuthorizationError(
      "expected_config_version_is_invalid",
      400,
    );
  }
  if (action === "stage_disabled" && value !== 0) {
    throw new KnowledgeSourceAuthorizationError(
      "stage_disabled_requires_missing_version",
      400,
    );
  }
  if (action !== "stage_disabled" && value === 0) {
    throw new KnowledgeSourceAuthorizationError(
      "transition_requires_existing_version",
      400,
    );
  }
  return value as number;
}

export function parseKnowledgeSourceAdminRequest(
  action: KnowledgeSourceAction,
  value: unknown,
): KnowledgeSourceAdminRequest {
  const input = record(value, "knowledge_source_request");
  const mutatesSettings = action === "stage_disabled" || action === "update_disabled";
  assertExactKeys(
    input,
    [
      "teamId",
      "sourceType",
      "projectId",
      "channelId",
      "expectedConfigVersion",
      ...(mutatesSettings ? ["readerPolicyRef", "retentionDays"] : []),
    ],
    "knowledge_source_request",
  );
  let scope: KnowledgeSourceScope;
  try {
    scope = parseKnowledgeSourceScope(input);
  } catch {
    throw new KnowledgeSourceAuthorizationError("knowledge_source_scope_is_invalid", 400);
  }
  const version = expectedConfigVersion(input.expectedConfigVersion, action);
  if (mutatesSettings) {
    let source;
    try {
      source = parsePutTrackedKnowledgeSource({
        ...scope,
        enabled: false,
        readerPolicyRef: input.readerPolicyRef,
        retentionDays: input.retentionDays,
      });
    } catch {
      throw new KnowledgeSourceAuthorizationError("knowledge_source_settings_are_invalid", 400);
    }
    return {
      ...scope,
      action,
      expectedConfigVersion: version,
      readerPolicyRef: source.readerPolicyRef,
      retentionDays: source.retentionDays ?? null,
    };
  }
  return {
    ...scope,
    action,
    expectedConfigVersion: version,
    readerPolicyRef: null,
    retentionDays: null,
  };
}

export async function knowledgeSourceAdminRequestDigest(
  request: KnowledgeSourceAdminRequest,
): Promise<string> {
  return sha256(JSON.stringify([
    1,
    request.action,
    request.teamId,
    request.projectId,
    request.channelId,
    request.sourceType ?? "slack",
    request.expectedConfigVersion,
    request.readerPolicyRef,
    request.retentionDays,
  ]));
}

export async function verifyKnowledgeSourceGrant(
  artifact: string | undefined,
  request: KnowledgeSourceAdminRequest,
  config: KnowledgeSourceGrantVerifierConfig,
  now = Date.now(),
): Promise<VerifiedKnowledgeSourceGrant> {
  if (!config.publicKey || !config.issuer || !config.keyId) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_verifier_not_configured",
      503,
    );
  }
  if (!artifact) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_required",
      403,
    );
  }
  if (artifact.length > 8_192) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_is_invalid",
      403,
    );
  }
  const parts = artifact.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_is_invalid",
      403,
    );
  }
  const protectedPart = parts[0]!;
  const payloadPart = parts[1]!;
  const signaturePart = parts[2]!;
  const header = utf8Json(protectedPart, "knowledge_source_grant_header");
  assertExactKeys(header, ["alg", "typ", "kid"], "knowledge_source_grant_header");
  if (
    header.alg !== "EdDSA" ||
    header.typ !== KNOWLEDGE_SOURCE_GRANT_TYPE ||
    header.kid !== config.keyId
  ) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_header_mismatch",
      403,
    );
  }

  let publicKey: Uint8Array;
  let key: CryptoKey;
  try {
    publicKey = base64UrlBytes(config.publicKey, "knowledge_source_grant_public_key");
    if (publicKey.byteLength !== 32) throw new Error("invalid Ed25519 public key");
    key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_verifier_not_configured",
      503,
    );
  }
  const signed = new TextEncoder().encode(`${protectedPart}.${payloadPart}`);
  const signature = base64UrlBytes(signaturePart, "knowledge_source_grant_signature");
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signature,
    signed,
  );
  if (!verified) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_signature_invalid",
      403,
    );
  }

  const payload = utf8Json(payloadPart, "knowledge_source_grant_payload");
  assertExactKeys(
    payload,
    [
      "version",
      "grantId",
      "issuer",
      "actorKind",
      "actorId",
      "action",
      "teamId",
      "sourceType",
      "projectId",
      "channelId",
      "expectedConfigVersion",
      "requestDigest",
      "issuedAt",
      "expiresAt",
    ],
    "knowledge_source_grant_payload",
  );
  if (payload.version !== 1 || !isKnowledgeSourceAction(payload.action)) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_payload_invalid",
      403,
    );
  }
  if (payload.actorKind !== "human" && payload.actorKind !== "service") {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_actor_invalid",
      403,
    );
  }
  let scope: KnowledgeSourceScope;
  try {
    scope = parseKnowledgeSourceScope(payload);
  } catch {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_scope_invalid",
      403,
    );
  }
  const grantVersion = expectedConfigVersion(payload.expectedConfigVersion, payload.action);
  const grantId = boundedText(payload.grantId, "knowledge_source_grant_id", 128);
  const issuer = boundedText(payload.issuer, "knowledge_source_grant_issuer");
  const actorId = boundedText(payload.actorId, "knowledge_source_grant_actor", 256);
  const requestDigest = boundedText(
    payload.requestDigest,
    "knowledge_source_grant_request_digest",
    80,
  );
  const issuedAt = canonicalTimestamp(payload.issuedAt, "knowledge_source_grant_issued_at");
  const expiresAt = canonicalTimestamp(payload.expiresAt, "knowledge_source_grant_expires_at");
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    issuer !== config.issuer ||
    payload.action !== request.action ||
    scope.teamId !== request.teamId ||
    scope.projectId !== request.projectId ||
    scope.channelId !== request.channelId ||
    (scope.sourceType ?? "slack") !== (request.sourceType ?? "slack") ||
    grantVersion !== request.expectedConfigVersion
  ) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_scope_or_action_mismatch",
      403,
    );
  }
  if (
    issuedAtMs > now + KNOWLEDGE_SOURCE_GRANT_CLOCK_SKEW_MS ||
    expiresAtMs <= now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > KNOWLEDGE_SOURCE_GRANT_MAX_LIFETIME_MS
  ) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_expired_or_invalid",
      403,
    );
  }
  const expectedDigest = await knowledgeSourceAdminRequestDigest(request);
  if (requestDigest !== expectedDigest) {
    throw new KnowledgeSourceAuthorizationError(
      "knowledge_source_grant_request_mismatch",
      403,
    );
  }
  return {
    version: 1,
    grantId,
    issuer,
    keyId: config.keyId,
    actorKind: payload.actorKind,
    actorId,
    action: payload.action,
    ...scope,
    expectedConfigVersion: grantVersion,
    requestDigest,
    artifactDigest: await sha256(artifact),
    issuedAt,
    expiresAt,
  };
}
