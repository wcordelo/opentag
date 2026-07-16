const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

type SessionViewToken = {
  v: 1;
  threadKey: string;
  exp: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionViewToken(
  threadKey: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (!threadKey || !secret) throw new Error("session_view_config_required");
  const payload = stringToBase64Url(JSON.stringify({
    v: 1,
    threadKey,
    exp: now + TOKEN_TTL_MS,
  } satisfies SessionViewToken));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(payload),
  ));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifySessionViewToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionViewToken | undefined> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !secret) return undefined;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return undefined;
  }
  if (!valid) return undefined;
  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload)),
    ) as Partial<SessionViewToken>;
    if (
      decoded.v !== 1 ||
      typeof decoded.threadKey !== "string" ||
      !decoded.threadKey ||
      typeof decoded.exp !== "number" ||
      decoded.exp < now
    ) return undefined;
    return decoded as SessionViewToken;
  } catch {
    return undefined;
  }
}

export async function buildSessionViewUrl(args: {
  baseUrl: string;
  secret: string;
  threadKey: string;
}): Promise<string> {
  const token = await createSessionViewToken(args.threadKey, args.secret);
  return `${args.baseUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(token)}`;
}
