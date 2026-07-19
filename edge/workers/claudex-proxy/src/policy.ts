export const CLAUDEX_INTERNAL_HEADER = "x-opentag-claudex-internal";

const API_METHODS = new Map<string, ReadonlySet<string>>([
  ["/v1/models", new Set(["GET"])],
  ["/v1/messages", new Set(["POST"])],
  ["/v1/messages/count_tokens", new Set(["POST"])],
]);

export function isAllowedClaudexRequest(request: Request): boolean {
  const url = new URL(request.url);
  return API_METHODS.get(url.pathname)?.has(request.method.toUpperCase()) === true;
}

export function withoutCallerCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete(CLAUDEX_INTERNAL_HEADER);
  return new Request(request, { headers });
}

export function authObjectKey(value: string | undefined): string {
  const candidate = value?.trim() || "codex-primary.json";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(candidate) || candidate.includes("..")) {
    throw new Error("invalid CODEX_AUTH_OBJECT");
  }
  return candidate;
}

/** Buffer a small response whose declared size must be exact before R2 storage. */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`response failed with status ${response.status}`);
  const declared = response.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared)) throw new Error("response length unavailable");
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) {
    throw new Error("response length out of bounds");
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength !== length) throw new Error("response length mismatch");
  return body;
}
