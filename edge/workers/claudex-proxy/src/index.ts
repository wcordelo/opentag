import { Container } from "@cloudflare/containers";
import {
  CLAUDEX_INTERNAL_HEADER,
  authObjectKey,
  isAllowedClaudexRequest,
  readBoundedResponseBody,
  withoutCallerCredentials,
} from "./policy.js";

const CONTAINER_NAME = "codex-primary";
const MAX_AUTH_BYTES = 128 * 1024;

// Remote Worker secrets are intentionally absent from wrangler config and
// therefore cannot be emitted by `wrangler types`; only those secret fields
// augment the generated binding contract here.
type ProxyEnv = ClaudexBindings & {
  CLIPROXY_CLIENT_KEY?: string;
  CLIPROXY_INTERNAL_KEY?: string;
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function internalRequest(env: ProxyEnv, pathname: string, init?: RequestInit): Request {
  if (!env.CLIPROXY_INTERNAL_KEY) throw new Error("CLIPROXY_INTERNAL_KEY is not configured");
  const headers = new Headers(init?.headers);
  headers.set(CLAUDEX_INTERNAL_HEADER, env.CLIPROXY_INTERNAL_KEY);
  return new Request(`https://claudex.internal${pathname}`, { ...init, headers });
}

async function containerHasAuth(env: ProxyEnv, container: DurableObjectStub<ClaudexProxyContainer>): Promise<boolean> {
  const response = await container.fetch(internalRequest(env, "/_internal/auth/status"));
  if (!response.ok) return false;
  const payload = await response.json<{ configured?: boolean }>();
  return payload.configured === true;
}

async function importAuth(env: ProxyEnv, container: DurableObjectStub<ClaudexProxyContainer>): Promise<boolean> {
  if (await containerHasAuth(env, container)) return true;
  const object = await env.AUTH_BUCKET.get(authObjectKey(env.CODEX_AUTH_OBJECT));
  if (!object || object.size <= 0 || object.size > MAX_AUTH_BYTES) return false;
  const response = await container.fetch(internalRequest(env, "/_internal/auth", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: object.body,
  }));
  return response.ok;
}

async function persistAuth(env: ProxyEnv, container: DurableObjectStub<ClaudexProxyContainer>): Promise<void> {
  const response = await container.fetch(internalRequest(env, "/_internal/auth"));
  const body = await readBoundedResponseBody(response, MAX_AUTH_BYTES);
  await env.AUTH_BUCKET.put(authObjectKey(env.CODEX_AUTH_OBJECT), body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { managedBy: "opentag-claudex-proxy" },
  });
}

let authPersistQueue: Promise<void> = Promise.resolve();

function scheduleAuthPersist(
  env: ProxyEnv,
  container: DurableObjectStub<ClaudexProxyContainer>,
  ctx: ExecutionContext,
): void {
  authPersistQueue = authPersistQueue
    .then(() => persistAuth(env, container))
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: "claudex_auth_persist_failed", error: String(error) }));
    });
  ctx.waitUntil(authPersistQueue);
}

function proxyContainer(env: ProxyEnv): DurableObjectStub<ClaudexProxyContainer> {
  return env.CLAUDEX_PROXY_CONTAINER.getByName(CONTAINER_NAME);
}

export class ClaudexProxyContainer extends Container<ProxyEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "30m";
  enableInternet = true;
  pingEndpoint = "/health";
  envVars = {
    CLIPROXY_CLIENT_KEY: this.env.CLIPROXY_CLIENT_KEY ?? "",
    CLIPROXY_INTERNAL_KEY: this.env.CLIPROXY_INTERNAL_KEY ?? "",
  };

  override onError(error: unknown): never {
    console.error(JSON.stringify({ event: "claudex_proxy_container_error", error: String(error) }));
    throw error;
  }
}

export default {
  async fetch(request: Request, env: ProxyEnv, ctx: ExecutionContext): Promise<Response> {
    if (!env.CLIPROXY_CLIENT_KEY || !env.CLIPROXY_INTERNAL_KEY) {
      return json({ ok: false, error: "proxy_secrets_unavailable" }, 503);
    }

    const url = new URL(request.url);
    const container = proxyContainer(env);
    const hasAuth = await importAuth(env, container);

    if (url.pathname === "/health" && request.method === "GET") {
      if (!hasAuth) return json({ ok: false, proxy: "ready", auth: "missing" }, 503);
      const upstream = await container.fetch(new Request("https://claudex.internal/health"));
      return json({ ok: upstream.ok, proxy: upstream.ok ? "ready" : "unavailable", auth: "configured" }, upstream.ok ? 200 : 503);
    }

    if (!isAllowedClaudexRequest(request)) {
      return json({ ok: false, error: "endpoint_denied" }, 403);
    }
    if (!hasAuth) return json({ ok: false, error: "codex_auth_missing" }, 503);

    const response = await container.fetch(withoutCallerCredentials(request));
    if (request.method !== "GET" && request.method !== "HEAD") {
      scheduleAuthPersist(env, container, ctx);
    }
    return response;
  },
} satisfies ExportedHandler<ProxyEnv>;
