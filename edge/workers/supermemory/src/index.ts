import { SupermemoryContainer } from "./container.js";
import type { Env } from "./env.js";

export { SupermemoryContainer };
export { ContainerProxy } from "@cloudflare/sandbox";

const MAX_API_KEY_BYTES = 4_096;
const CONTAINER_WAKE_TIMEOUT_MS = 90_000;
type ContainerStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  getState?: () => Promise<{ status?: string }>;
};

async function boundedContainerFetch(
  container: ContainerStub,
  request: Request,
  timeoutMs = CONTAINER_WAKE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      container.fetch(new Request(request, { signal: controller.signal })),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("container_request_timeout"));
        }, timeoutMs);
      }),
    ]);
    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tokenMatches(actual: string | null, expected: string | undefined): Promise<boolean> {
  if (!actual || !expected) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function routeAllowed(pathname: string, method: string): boolean {
  if (pathname === "/v3/documents") return method === "POST";
  if (pathname === "/v3/documents/list") return method === "POST";
  if (/^\/v3\/documents\/[^/]+$/.test(pathname)) {
    return method === "GET" || method === "PATCH" || method === "DELETE";
  }
  if (pathname === "/v4/search" || pathname === "/v4/profile") return method === "POST";
  return pathname === "/v3/openapi" || pathname === "/v4/openapi" ? method === "GET" : false;
}

async function serverKey(
  env: Env,
  container: ContainerStub,
): Promise<string | undefined> {
  const bootstrapDeadline = Date.now() + CONTAINER_WAKE_TIMEOUT_MS;
  const read = async (): Promise<string | undefined> => {
    const object = await env.STATE_BUCKET.get("api-key");
    if (!object || object.size > MAX_API_KEY_BYTES) return undefined;
    const value = (await object.text()).trim();
    return value.length > 0 && value.length <= MAX_API_KEY_BYTES ? value : undefined;
  };
  const existing = await read();
  if (existing) return existing;
  // The first Supermemory boot creates api-key inside the mounted R2 data
  // directory. Wake the singleton before polling the Worker-side R2 binding so
  // a cold first request can complete the documented bootstrap contract.
  try {
    console.log(JSON.stringify({ event: "supermemory_bootstrap_wake_begin" }));
    await boundedContainerFetch(container, new Request("https://supermemory.internal/health"));
    console.log(JSON.stringify({ event: "supermemory_bootstrap_wake_complete" }));
  } catch {
    console.log(JSON.stringify({ event: "supermemory_bootstrap_wake_failed" }));
    // The unauthenticated wake may return 401 while still starting the process.
  }
  for (let attempt = 0; attempt < 20 && Date.now() < bootstrapDeadline; attempt += 1) {
    const value = await read();
    if (value) return value;
    const remaining = bootstrapDeadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
  return undefined;
}

async function containerRequest(request: Request, apiKey: string): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-opentag-service-token");
  headers.delete("x-opentag-container-token");
  headers.delete("transfer-encoding");
  headers.set("authorization", `Bearer ${apiKey}`);
  if (request.method === "GET" || request.method === "HEAD") {
    return new Request(request, { headers });
  }
  const body = await request.arrayBuffer();
  headers.set("content-length", String(body.byteLength));
  return new Request(request, { headers, body });
}

async function probe(container: ContainerStub, apiKey: string): Promise<Response> {
  const containerState = await container.getState?.().catch(() => undefined);
  const readyResponse = await boundedContainerFetch(
    container,
    new Request("https://supermemory.internal/ready"),
  );
  if (!readyResponse.ok) {
    console.log(JSON.stringify({
      event: "supermemory_probe",
      stage: "readiness",
      ok: false,
      status: readyResponse.status,
    }));
    return Response.json({
      status: "degraded",
      service: "opentag-supermemory",
      storage: "r2-fuse",
      code: "provider_not_ready",
    }, { status: 503 });
  }

  const searchPayload = JSON.stringify({
    q: "opentag readiness probe",
    searchMode: "hybrid",
    limit: 1,
  });
  const makeSearchRequest = () => containerRequest(new Request("https://supermemory.internal/v4/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: searchPayload,
  }), apiKey);
  let searchAttempt = 1;
  let searchResponse = await boundedContainerFetch(
    container,
    await makeSearchRequest(),
  );
  if (searchResponse.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    searchAttempt = 2;
    searchResponse = await boundedContainerFetch(
      container,
      await makeSearchRequest(),
      15_000,
    );
  }
  let validSearchResponse = false;
  const searchDiagnostics: Record<string, unknown> = {
    contentType: searchResponse.headers.get("content-type") ?? "",
    contentLength: searchResponse.headers.get("content-length") ?? "",
  };
  if (searchResponse.ok) {
    try {
      const body = await searchResponse.clone().json() as unknown;
      validSearchResponse = Boolean(
        body && typeof body === "object" && !Array.isArray(body) &&
        Array.isArray((body as { results?: unknown }).results),
      );
    } catch {
      validSearchResponse = false;
    }
  } else if (searchResponse.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await searchResponse.clone().json() as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        searchDiagnostics.bodyKeys = Object.keys(body).sort().slice(0, 16);
        for (const key of ["code", "error", "type"]) {
          const value = (body as Record<string, unknown>)[key];
          if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
            searchDiagnostics[key] = value;
          }
        }
      }
    } catch {
      searchDiagnostics.bodyType = "invalid_json";
    }
  } else {
    const preview = (await searchResponse.clone().text()).trim().replace(/\s+/g, " ").slice(0, 256);
    if (preview) {
      searchDiagnostics.bodyPreview = preview.replace(/\b(?:sm_[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/g, "[REDACTED]");
    }
  }
  console.log(JSON.stringify({
    event: "supermemory_probe",
    stage: "search",
    ok: validSearchResponse,
    status: searchResponse.status,
    attempt: searchAttempt,
    containerState: containerState?.status ?? "unknown",
    ...searchDiagnostics,
  }));
  return Response.json({
    status: validSearchResponse ? "ok" : "degraded",
    service: "opentag-supermemory",
    storage: "r2-fuse",
    containerState: containerState?.status ?? "unknown",
    ...(validSearchResponse ? {} : { code: "provider_search_failed" }),
  }, { status: validSearchResponse ? 200 : 503 });
}

async function forwardContainerRequest(
  container: ContainerStub,
  request: Request,
  apiKey: string,
  pathname: string,
): Promise<Response> {
  const makeContainerRequest = () => containerRequest(request.clone(), apiKey);
  let attempt = 1;
  let response = await boundedContainerFetch(container, await makeContainerRequest());
  const retryableRead = request.method === "GET" ||
    (request.method === "POST" && (pathname === "/v4/search" || pathname === "/v4/profile"));
  if (retryableRead && response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    attempt = 2;
    response = await boundedContainerFetch(container, await makeContainerRequest(), 15_000);
  }
  const details: Record<string, unknown> = {
    event: "supermemory_route_response",
    method: request.method,
    pathname,
    status: response.status,
    attempt,
    contentType: response.headers.get("content-type") ?? "",
    contentLength: response.headers.get("content-length") ?? "",
  };
  if (!pathname.endsWith("/openapi") && response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await response.clone().json() as unknown;
      details.bodyType = body === null ? "null" : Array.isArray(body) ? "array" : typeof body;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        details.bodyKeys = Object.keys(body).sort().slice(0, 16);
      }
    } catch {
      details.bodyType = "invalid_json";
    }
  } else if (response.status >= 500) {
    const preview = (await response.clone().text()).trim().replace(/\s+/g, " ").slice(0, 256);
    if (preview) {
      details.bodyPreview = preview.replace(
        /\b(?:sm_[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/g,
        "[REDACTED]",
      );
    }
  }
  console.log(JSON.stringify(details));
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const serviceToken = request.headers.get("x-opentag-service-token");
    if (!(await tokenMatches(serviceToken, env.SUPERMEMORY_SERVICE_AUTH_TOKEN))) return unauthorized();

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
    }
    if (url.pathname !== "/health" && !routeAllowed(url.pathname, request.method)) {
      return new Response("Not found", { status: 404 });
    }
    const container = env.SUPERMEMORY.getByName("supermemory");
    let apiKey: string | undefined;
    try {
      apiKey = await serverKey(env, container);
    } catch {
      return Response.json({ status: "degraded", code: "state_unavailable" }, { status: 503 });
    }
    if (!apiKey) return Response.json({ status: "degraded", code: "api_key_unavailable" }, { status: 503 });

    if (url.pathname === "/health") {
      try {
        return await probe(container, apiKey);
      } catch {
        return Response.json({ status: "degraded", service: "opentag-supermemory" }, { status: 503 });
      }
    }
    return forwardContainerRequest(container, request, apiKey, url.pathname);
  },
};
