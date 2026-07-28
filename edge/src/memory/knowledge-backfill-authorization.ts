import type { KnowledgeBackfillManifest } from "./knowledge-backfill.js";

export const KNOWLEDGE_BACKFILL_APPROVAL_HEADER =
  "x-opentag-knowledge-backfill-approval";
export const KNOWLEDGE_BACKFILL_APPROVAL_TYPE =
  "OT-KNOWLEDGE-BACKFILL-APPROVAL";
export const KNOWLEDGE_BACKFILL_APPROVAL_MAX_LIFETIME_MS = 24 * 60 * 60_000;
const KNOWLEDGE_BACKFILL_APPROVAL_CLOCK_SKEW_MS = 30_000;

export type VerifiedKnowledgeBackfillApproval = {
  version: 1;
  approvalId: string;
  issuer: string;
  keyId: string;
  gate: "P1";
  approverKind: "human";
  approverId: string;
  manifestId: string;
  manifestDigest: string;
  teamId: string;
  projectId: string;
  channelIds: string[];
  from: string;
  to: string;
  maximumCount: number;
  maximumRatePerMinute: number;
  maximumErrors: number;
  releaseIds: string[];
  rollbackOwner: string;
  issuedAt: string;
  expiresAt: string;
  artifactDigest: string;
};

export type KnowledgeBackfillApprovalVerifierConfig = {
  publicKey?: string;
  issuer?: string;
  keyId?: string;
};

export class KnowledgeBackfillApprovalError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 503,
  ) {
    super(code);
    this.name = "KnowledgeBackfillApprovalError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeBackfillApprovalError(`${label}_must_be_an_object`, 400);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new KnowledgeBackfillApprovalError(
      `${label}_contains_unexpected_fields`,
      400,
    );
  }
}

function boundedText(value: unknown, field: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new KnowledgeBackfillApprovalError(`${field}_is_invalid`, 403);
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const text = boundedText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new KnowledgeBackfillApprovalError(`${field}_is_invalid`, 403);
  }
  return text;
}

function exactStringArray(
  value: unknown,
  field: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new KnowledgeBackfillApprovalError(`${field}_is_invalid`, 403);
  }
  const parsed = value.map((entry) => boundedText(entry, field, 256));
  if (new Set(parsed).size !== parsed.length) {
    throw new KnowledgeBackfillApprovalError(`${field}_is_invalid`, 403);
  }
  return parsed;
}

function safeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new KnowledgeBackfillApprovalError(`${field}_is_invalid`, 403);
  }
  return value as number;
}

function base64UrlBytes(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new KnowledgeBackfillApprovalError(`${label}_is_invalid`, 403);
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new KnowledgeBackfillApprovalError(`${label}_is_invalid`, 403);
  }
}

function utf8Json(value: string, label: string): Record<string, unknown> {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(base64UrlBytes(value, label))),
      label,
    );
  } catch (error) {
    if (error instanceof KnowledgeBackfillApprovalError) throw error;
    throw new KnowledgeBackfillApprovalError(`${label}_is_invalid`, 403);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export async function verifyKnowledgeBackfillApproval(
  artifact: string | undefined,
  manifest: KnowledgeBackfillManifest,
  manifestDigest: string,
  config: KnowledgeBackfillApprovalVerifierConfig,
  now = Date.now(),
): Promise<VerifiedKnowledgeBackfillApproval> {
  if (!config.publicKey || !config.issuer || !config.keyId) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_verifier_not_configured",
      503,
    );
  }
  if (!artifact) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_required",
      403,
    );
  }
  if (artifact.length > 16_384) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_is_invalid",
      403,
    );
  }
  const parts = artifact.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_is_invalid",
      403,
    );
  }
  const protectedPart = parts[0]!;
  const payloadPart = parts[1]!;
  const signaturePart = parts[2]!;
  const header = utf8Json(
    protectedPart,
    "knowledge_backfill_approval_header",
  );
  assertExactKeys(
    header,
    ["alg", "typ", "kid"],
    "knowledge_backfill_approval_header",
  );
  if (
    header.alg !== "EdDSA" ||
    header.typ !== KNOWLEDGE_BACKFILL_APPROVAL_TYPE ||
    header.kid !== config.keyId
  ) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_header_mismatch",
      403,
    );
  }

  let key: CryptoKey;
  try {
    const publicKey = base64UrlBytes(
      config.publicKey,
      "knowledge_backfill_approval_public_key",
    );
    if (publicKey.byteLength !== 32) throw new Error("invalid Ed25519 key");
    key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_verifier_not_configured",
      503,
    );
  }
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64UrlBytes(
      signaturePart,
      "knowledge_backfill_approval_signature",
    ),
    new TextEncoder().encode(`${protectedPart}.${payloadPart}`),
  );
  if (!verified) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_signature_invalid",
      403,
    );
  }

  const payload = utf8Json(
    payloadPart,
    "knowledge_backfill_approval_payload",
  );
  assertExactKeys(
    payload,
    [
      "version",
      "approvalId",
      "issuer",
      "gate",
      "approverKind",
      "approverId",
      "manifestId",
      "manifestDigest",
      "teamId",
      "projectId",
      "channelIds",
      "from",
      "to",
      "maximumCount",
      "maximumRatePerMinute",
      "maximumErrors",
      "releaseIds",
      "rollbackOwner",
      "issuedAt",
      "expiresAt",
    ],
    "knowledge_backfill_approval_payload",
  );
  if (
    payload.version !== 1 ||
    payload.gate !== "P1" ||
    payload.approverKind !== "human"
  ) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_payload_invalid",
      403,
    );
  }
  const approvalId = boundedText(
    payload.approvalId,
    "knowledge_backfill_approval_id",
    128,
  );
  const issuer = boundedText(
    payload.issuer,
    "knowledge_backfill_approval_issuer",
  );
  const approverId = boundedText(
    payload.approverId,
    "knowledge_backfill_approver",
  );
  const manifestId = boundedText(
    payload.manifestId,
    "knowledge_backfill_manifest_id",
    128,
  );
  const signedManifestDigest = boundedText(
    payload.manifestDigest,
    "knowledge_backfill_manifest_digest",
    80,
  );
  const teamId = boundedText(payload.teamId, "knowledge_backfill_team_id");
  const projectId = boundedText(
    payload.projectId,
    "knowledge_backfill_project_id",
  );
  const channelIds = exactStringArray(
    payload.channelIds,
    "knowledge_backfill_channel_ids",
    50,
  );
  const from = canonicalTimestamp(payload.from, "knowledge_backfill_from");
  const to = canonicalTimestamp(payload.to, "knowledge_backfill_to");
  const maximumCount = safeInteger(
    payload.maximumCount,
    "knowledge_backfill_maximum_count",
    1,
    1_000,
  );
  const maximumRatePerMinute = safeInteger(
    payload.maximumRatePerMinute,
    "knowledge_backfill_maximum_rate",
    1,
    1_000,
  );
  const maximumErrors = safeInteger(
    payload.maximumErrors,
    "knowledge_backfill_maximum_errors",
    0,
    1_000,
  );
  const releaseIds = exactStringArray(
    payload.releaseIds,
    "knowledge_backfill_release_ids",
    10,
  );
  const rollbackOwner = boundedText(
    payload.rollbackOwner,
    "knowledge_backfill_rollback_owner",
  );
  const issuedAt = canonicalTimestamp(
    payload.issuedAt,
    "knowledge_backfill_approval_issued_at",
  );
  const expiresAt = canonicalTimestamp(
    payload.expiresAt,
    "knowledge_backfill_approval_expires_at",
  );
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);

  if (
    issuer !== config.issuer ||
    manifestId !== manifest.manifestId ||
    signedManifestDigest !== manifestDigest ||
    teamId !== manifest.teamId ||
    projectId !== manifest.projectId ||
    !sameStrings(channelIds, manifest.channelIds) ||
    from !== manifest.from ||
    to !== manifest.to ||
    maximumCount < manifest.count ||
    maximumCount > manifest.executionBudget.maximumCount ||
    maximumRatePerMinute >
      manifest.executionBudget.maximumRatePerMinute ||
    maximumErrors > manifest.executionBudget.maximumErrors ||
    !sameStrings(releaseIds, manifest.releaseIds) ||
    rollbackOwner !== manifest.rollbackOwner
  ) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_scope_budget_or_release_mismatch",
      403,
    );
  }
  if (
    issuedAtMs > now + KNOWLEDGE_BACKFILL_APPROVAL_CLOCK_SKEW_MS ||
    expiresAtMs <= now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs >
      KNOWLEDGE_BACKFILL_APPROVAL_MAX_LIFETIME_MS
  ) {
    throw new KnowledgeBackfillApprovalError(
      "knowledge_backfill_approval_expired_or_invalid",
      403,
    );
  }
  return {
    version: 1,
    approvalId,
    issuer,
    keyId: config.keyId,
    gate: "P1",
    approverKind: "human",
    approverId,
    manifestId,
    manifestDigest: signedManifestDigest,
    teamId,
    projectId,
    channelIds,
    from,
    to,
    maximumCount,
    maximumRatePerMinute,
    maximumErrors,
    releaseIds,
    rollbackOwner,
    issuedAt,
    expiresAt,
    artifactDigest: await sha256(artifact),
  };
}
