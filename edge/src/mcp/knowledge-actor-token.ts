export const KNOWLEDGE_ACTOR_TOKEN_HEADER = "x-opentag-knowledge-actor-token";
export const KNOWLEDGE_ACTOR_TOKEN_ISSUER = "opentag";
export const KNOWLEDGE_ACTOR_TOKEN_AUDIENCE = "opentag-knowledge-mcp";
export const KNOWLEDGE_ACTOR_TOKEN_VERSION = 1 as const;
export const KNOWLEDGE_ACTOR_TOKEN_MAX_TTL_MS = 5 * 60 * 1000;

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_SCOPE_VALUES = 100;
const MAX_SCOPE_VALUE_BYTES = 256;
const CLOCK_SKEW_MS = 30 * 1000;

export type KnowledgeActorKind = "slack_user" | "slack_automation";

export type KnowledgeActorTokenScope = {
  channelIds: string[];
  spaceIds: string[];
  repoIds: string[];
  connectorIds: string[];
};

export type KnowledgeActorTokenClaims = {
  v: typeof KNOWLEDGE_ACTOR_TOKEN_VERSION;
  iss: typeof KNOWLEDGE_ACTOR_TOKEN_ISSUER;
  aud: typeof KNOWLEDGE_ACTOR_TOKEN_AUDIENCE;
  jti: string;
  teamId: string;
  projectId: string;
  actor: {
    kind: KnowledgeActorKind;
    id: string;
  };
  aclPolicyRef: string;
  rev: number;
  scopes: KnowledgeActorTokenScope;
  iat: number;
  exp: number;
};

export type KnowledgeActorTokenVerification =
  | { ok: true; claims: KnowledgeActorTokenClaims }
  | {
      ok: false;
      code:
        | "malformed"
        | "invalid_signature"
        | "invalid_claims"
        | "not_yet_valid"
        | "expired";
    };

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isBoundedString(value: unknown, maxBytes = MAX_SCOPE_VALUE_BYTES): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxBytes &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    new TextEncoder().encode(value).length <= maxBytes
  );
}

function normalizeScopeValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_VALUES) return null;
  const values = [...new Set(value)];
  if (!values.every((entry) => isBoundedString(entry))) return null;
  return values.sort();
}

function isClaims(value: unknown): value is KnowledgeActorTokenClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<KnowledgeActorTokenClaims>;
  if (
    claims.v !== KNOWLEDGE_ACTOR_TOKEN_VERSION ||
    claims.iss !== KNOWLEDGE_ACTOR_TOKEN_ISSUER ||
    claims.aud !== KNOWLEDGE_ACTOR_TOKEN_AUDIENCE ||
    !isBoundedString(claims.jti) ||
    !isBoundedString(claims.teamId) ||
    !isBoundedString(claims.projectId) ||
    !isBoundedString(claims.aclPolicyRef) ||
    typeof claims.rev !== "number" ||
    !Number.isSafeInteger(claims.rev) ||
    claims.rev < 0 ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    !claims.actor ||
    typeof claims.actor !== "object" ||
    !isBoundedString(claims.actor.id) ||
    (claims.actor.kind !== "slack_user" && claims.actor.kind !== "slack_automation") ||
    !claims.scopes ||
    typeof claims.scopes !== "object"
  ) {
    return false;
  }

  const scopes = claims.scopes as Partial<KnowledgeActorTokenScope>;
  return (
    normalizeScopeValues(scopes.channelIds) !== null &&
    normalizeScopeValues(scopes.spaceIds) !== null &&
    normalizeScopeValues(scopes.repoIds) !== null &&
    normalizeScopeValues(scopes.connectorIds) !== null
  );
}

function normalizeClaims(claims: KnowledgeActorTokenClaims): KnowledgeActorTokenClaims {
  return {
    ...claims,
    scopes: {
      channelIds: [...claims.scopes.channelIds].sort(),
      spaceIds: [...claims.scopes.spaceIds].sort(),
      repoIds: [...claims.scopes.repoIds].sort(),
      connectorIds: [...claims.scopes.connectorIds].sort(),
    },
  };
}

async function importSecret(secret: string, usage: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", textBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function mintKnowledgeActorToken(
  secret: string,
  claims: Omit<KnowledgeActorTokenClaims, "v" | "iss" | "aud" | "rev"> & {
    v?: typeof KNOWLEDGE_ACTOR_TOKEN_VERSION;
    iss?: typeof KNOWLEDGE_ACTOR_TOKEN_ISSUER;
    aud?: typeof KNOWLEDGE_ACTOR_TOKEN_AUDIENCE;
    rev?: number;
  },
): Promise<string> {
  if (!secret.trim()) throw new Error("knowledge actor token secret is required");
  const fullClaims: KnowledgeActorTokenClaims = {
    ...claims,
    v: KNOWLEDGE_ACTOR_TOKEN_VERSION,
    iss: KNOWLEDGE_ACTOR_TOKEN_ISSUER,
    aud: KNOWLEDGE_ACTOR_TOKEN_AUDIENCE,
    rev: claims.rev ?? 0,
  };
  if (!isClaims(fullClaims) || fullClaims.exp <= fullClaims.iat || (fullClaims.exp - fullClaims.iat) * 1_000 > KNOWLEDGE_ACTOR_TOKEN_MAX_TTL_MS) {
    throw new Error("invalid knowledge actor token claims");
  }
  const payload = encodeBase64Url(textBytes(JSON.stringify(normalizeClaims(fullClaims))));
  const key = await importSecret(secret.trim(), ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textBytes(payload));
  return `kat.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyKnowledgeActorToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<KnowledgeActorTokenVerification> {
  if (!secret.trim() || token.length > MAX_TOKEN_BYTES) return { ok: false, code: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "kat") return { ok: false, code: "malformed" };
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (!payloadPart || !signaturePart) return { ok: false, code: "malformed" };
  const payloadBytes = decodeBase64Url(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!payloadBytes || !signature || signature.length !== 32) return { ok: false, code: "malformed" };

  let validSignature = false;
  try {
    const key = await importSecret(secret.trim(), ["verify"]);
    validSignature = await crypto.subtle.verify("HMAC", key, signature, textBytes(payloadPart));
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (!validSignature) return { ok: false, code: "invalid_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (!isClaims(parsed)) return { ok: false, code: "invalid_claims" };
  if (parsed.iat * 1000 > nowMs + CLOCK_SKEW_MS) return { ok: false, code: "not_yet_valid" };
  if (parsed.exp * 1000 <= nowMs) return { ok: false, code: "expired" };
  if ((parsed.exp - parsed.iat) * 1000 > KNOWLEDGE_ACTOR_TOKEN_MAX_TTL_MS) return { ok: false, code: "invalid_claims" };
  return { ok: true, claims: normalizeClaims(parsed) };
}
