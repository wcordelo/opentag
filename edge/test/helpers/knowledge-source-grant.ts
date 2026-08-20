import {
  KNOWLEDGE_SOURCE_GRANT_TYPE,
  knowledgeSourceAdminRequestDigest,
  type KnowledgeSourceAdminRequest,
} from "../../src/config/knowledge-source-authorization.js";

export const TEST_KNOWLEDGE_SOURCE_ISSUER = "opentag-test-authority";
export const TEST_KNOWLEDGE_SOURCE_KEY_ID = "test-ed25519-v1";

const TEST_PUBLIC_KEY_BYTES = new Uint8Array([
  215, 90, 152, 1, 130, 177, 10, 183,
  213, 75, 254, 211, 201, 100, 7, 58,
  14, 225, 114, 243, 218, 166, 35, 37,
  175, 2, 26, 104, 247, 7, 81, 26,
]);

// RFC 8032 test-vector seed wrapped in the RFC 8410 PKCS#8 Ed25519 prefix.
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
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export const TEST_KNOWLEDGE_SOURCE_PUBLIC_KEY = base64Url(TEST_PUBLIC_KEY_BYTES);

export async function signKnowledgeSourceGrant(
  request: KnowledgeSourceAdminRequest,
  overrides: Partial<{
    grantId: string;
    issuer: string;
    keyId: string;
    actorKind: "human" | "service";
    actorId: string;
    action: KnowledgeSourceAdminRequest["action"];
    teamId: string;
    sourceType: KnowledgeSourceAdminRequest["sourceType"];
    projectId: string;
    channelId: string;
    expectedConfigVersion: number | null;
    requestDigest: string;
    issuedAt: string;
    expiresAt: string;
  }> = {},
): Promise<string> {
  const now = Date.now();
  const keyId = overrides.keyId ?? TEST_KNOWLEDGE_SOURCE_KEY_ID;
  const header = encodedJson({
    alg: "EdDSA",
    typ: KNOWLEDGE_SOURCE_GRANT_TYPE,
    kid: keyId,
  });
  const payload = encodedJson({
    version: 1,
    grantId: overrides.grantId ?? crypto.randomUUID(),
    issuer: overrides.issuer ?? TEST_KNOWLEDGE_SOURCE_ISSUER,
    actorKind: overrides.actorKind ?? "human",
    actorId: overrides.actorId ?? "operator:test-user",
    action: overrides.action ?? request.action,
    teamId: overrides.teamId ?? request.teamId,
    sourceType: overrides.sourceType ?? request.sourceType ?? "slack",
    projectId: overrides.projectId ?? request.projectId,
    channelId: overrides.channelId ?? request.channelId,
    expectedConfigVersion: overrides.expectedConfigVersion === undefined
      ? request.expectedConfigVersion
      : overrides.expectedConfigVersion,
    requestDigest: overrides.requestDigest ?? await knowledgeSourceAdminRequestDigest(request),
    issuedAt: overrides.issuedAt ?? new Date(now - 1_000).toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(now + 60_000).toISOString(),
  });
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    TEST_PRIVATE_KEY_PKCS8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, signingInput);
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}
