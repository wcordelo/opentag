import {
  KNOWLEDGE_BACKFILL_APPROVAL_TYPE,
} from "../../src/memory/knowledge-backfill-authorization.js";
import type {
  KnowledgeBackfillManifest,
} from "../../src/memory/knowledge-backfill.js";

export const TEST_KNOWLEDGE_BACKFILL_ISSUER =
  "opentag-test-p1-authority";
export const TEST_KNOWLEDGE_BACKFILL_KEY_ID =
  "test-backfill-ed25519-v1";

const TEST_PUBLIC_KEY_BYTES = new Uint8Array([
  215, 90, 152, 1, 130, 177, 10, 183,
  213, 75, 254, 211, 201, 100, 7, 58,
  14, 225, 114, 243, 218, 166, 35, 37,
  175, 2, 26, 104, 247, 7, 81, 26,
]);

const TEST_PRIVATE_KEY_PKCS8 = new Uint8Array([
  48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32,
  157, 97, 177, 157, 239, 253, 90, 96,
  186, 132, 74, 244, 146, 236, 44, 196,
  68, 73, 197, 105, 123, 50, 105, 25,
  112, 59, 172, 3, 28, 174, 127, 96,
]);

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export const TEST_KNOWLEDGE_BACKFILL_PUBLIC_KEY =
  base64Url(TEST_PUBLIC_KEY_BYTES);

export async function signKnowledgeBackfillApproval(
  manifest: KnowledgeBackfillManifest,
  manifestDigest: string,
  overrides: Partial<{
    approvalId: string;
    issuer: string;
    keyId: string;
    gate: string;
    approverKind: string;
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
  }> = {},
): Promise<string> {
  const now = Date.now();
  const header = encodedJson({
    alg: "EdDSA",
    typ: KNOWLEDGE_BACKFILL_APPROVAL_TYPE,
    kid: overrides.keyId ?? TEST_KNOWLEDGE_BACKFILL_KEY_ID,
  });
  const payload = encodedJson({
    version: 1,
    approvalId: overrides.approvalId ?? crypto.randomUUID(),
    issuer: overrides.issuer ?? TEST_KNOWLEDGE_BACKFILL_ISSUER,
    gate: overrides.gate ?? "P1",
    approverKind: overrides.approverKind ?? "human",
    approverId: overrides.approverId ?? "operator:p1-test-approver",
    manifestId: overrides.manifestId ?? manifest.manifestId,
    manifestDigest: overrides.manifestDigest ?? manifestDigest,
    teamId: overrides.teamId ?? manifest.teamId,
    projectId: overrides.projectId ?? manifest.projectId,
    channelIds: overrides.channelIds ?? manifest.channelIds,
    from: overrides.from ?? manifest.from,
    to: overrides.to ?? manifest.to,
    maximumCount: overrides.maximumCount ??
      manifest.executionBudget.maximumCount,
    maximumRatePerMinute: overrides.maximumRatePerMinute ??
      manifest.executionBudget.maximumRatePerMinute,
    maximumErrors: overrides.maximumErrors ??
      manifest.executionBudget.maximumErrors,
    releaseIds: overrides.releaseIds ?? manifest.releaseIds,
    rollbackOwner: overrides.rollbackOwner ?? manifest.rollbackOwner,
    issuedAt: overrides.issuedAt ??
      new Date(now - 1_000).toISOString(),
    expiresAt: overrides.expiresAt ??
      new Date(now + 60_000).toISOString(),
  });
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    TEST_PRIVATE_KEY_PKCS8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}
