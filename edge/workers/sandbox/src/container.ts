import { Container, type OutboundHandler, type OutboundHandlerContext } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import {
  EGRESS_SENTINEL,
  authorizeGithubWrite,
  buildApprovalScope,
  isAllowedGitCloneRequest,
  isAllowedGithubRead,
  repositoryAllowlist,
  takeExecutionBinding,
  withCredentialHeader,
  type GithubApprovalScope,
  type GithubOutboundAttempt,
} from "./egress-policy.js";

export interface Env {
  HARNESS_CONTAINER: DurableObjectNamespace<HarnessContainer>;
  CLAUDEX_PROXY?: Fetcher;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CLAUDEX_PROXY_URL?: string;
  CLAUDEX_MODEL?: string;
  GITHUB_TOKEN?: string;
  OPENTAG_TOOL_BIN?: string;
  HARNESS_AUTH_TOKEN?: string;
  HARNESS_ALLOWED_REPO_HOSTS?: string;
  HARNESS_ALLOWED_REPO_ORGS?: string;
  BLOBS?: R2Bucket;
}

const APPROVAL_KEY = "github-approval-scope";

/** Public destinations reachable from repository-controlled code. */
export const HARNESS_ALLOWED_HOSTS = [
  "api.anthropic.com",
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "nodejs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "storage.googleapis.com",
] as const;

export function harnessEnvVars(workerEnv: Env = env as Env): Record<string, string> {
  const values: Record<string, string> = {
    PORT: "8080",
    ANTHROPIC_API_KEY: EGRESS_SENTINEL,
    GITHUB_TOKEN: EGRESS_SENTINEL,
    GH_TOKEN: EGRESS_SENTINEL,
    HARNESS_AUTH_TOKEN: EGRESS_SENTINEL,
  };
  for (const key of ["OPENTAG_TOOL_BIN", "HARNESS_ALLOWED_REPO_HOSTS", "HARNESS_ALLOWED_REPO_ORGS", "CLAUDEX_PROXY_URL", "CLAUDEX_MODEL"] as const) {
    const value = workerEnv[key];
    if (typeof value === "string" && value.length > 0) values[key] = value;
  }
  return values;
}

function deny(message: string, status = 403): Response {
  return new Response(message, { status });
}

function attemptFor(request: Request, executionId?: string, bodyText?: string): GithubOutboundAttempt {
  const url = new URL(request.url);
  return {
    host: url.hostname.toLowerCase(),
    method: request.method.toUpperCase(),
    pathname: url.pathname,
    search: url.search,
    ...(executionId === undefined ? {} : { executionId }),
    ...(bodyText === undefined ? {} : { bodyText }),
  };
}

async function requestBodyText(request: Request): Promise<string> {
  const bytes = await request.clone().arrayBuffer();
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("outbound body too large");
  return new TextDecoder("latin1").decode(bytes);
}

export const anthropicOutbound: OutboundHandler<Env> = (request, workerEnv) => {
  request = takeExecutionBinding(request).request;
  if (new URL(request.url).hostname.toLowerCase() !== "api.anthropic.com") return deny("host denied");
  if (workerEnv.ANTHROPIC_API_KEY) {
    return fetch(withCredentialHeader(request, "x-api-key", workerEnv.ANTHROPIC_API_KEY));
  }
  if (workerEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    return fetch(withCredentialHeader(request, "authorization", `Bearer ${workerEnv.CLAUDE_CODE_OAUTH_TOKEN}`));
  }
  return deny("Anthropic credential unavailable", 503);
};

function claudexProxyOrigin(workerEnv: Env): URL | undefined {
  if (!workerEnv.CLAUDEX_PROXY_URL) return undefined;
  try {
    const url = new URL(workerEnv.CLAUDEX_PROXY_URL);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function harnessAllowedHosts(workerEnv: Env = env as Env): string[] {
  const proxy = claudexProxyOrigin(workerEnv);
  return [...HARNESS_ALLOWED_HOSTS, ...(proxy ? [proxy.hostname.toLowerCase()] : [])];
}

const CLAUDEX_ENDPOINTS = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/models",
]);
const MAX_CLAUDEX_REQUEST_BYTES = 48 * 1024 * 1024;

/** Binding-aware route for the synthetic Claudex hostname. */
export const claudexOutbound: OutboundHandler<Env> = async (request, workerEnv) => {
  request = takeExecutionBinding(request).request;
  const url = new URL(request.url);
  const proxy = claudexProxyOrigin(workerEnv);
  if (!proxy || url.origin !== proxy.origin) return deny("Claudex host denied");
  if (!CLAUDEX_ENDPOINTS.has(url.pathname)) return deny("Claudex endpoint denied");
  if (!workerEnv.CLAUDEX_PROXY) return deny("Claudex service unavailable", 503);

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  const startedAt = Date.now();
  try {
    let body: ReadableStream<Uint8Array> | null = null;
    let bodyPump: Promise<void> | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const declared = request.headers.get("content-length");
      const parsedLength = declared && /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
      if (Number.isSafeInteger(parsedLength) && parsedLength > 0) {
        if (parsedLength > MAX_CLAUDEX_REQUEST_BYTES) return deny("Claudex request too large", 413);
        if (!request.body) return deny("Claudex request body required", 400);
        const fixed = new FixedLengthStream(parsedLength);
        body = fixed.readable;
        bodyPump = request.body.pipeTo(fixed.writable);
        headers.set("content-length", String(parsedLength));
      } else {
        const bytes = await request.arrayBuffer();
        const length = bytes.byteLength;
        if (length <= 0) return deny("Claudex request body required", 400);
        if (length > MAX_CLAUDEX_REQUEST_BYTES) return deny("Claudex request too large", 413);
        body = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        });
        headers.set("content-length", String(length));
      }
    }
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    const responsePromise = workerEnv.CLAUDEX_PROXY.fetch(forwarded);
    const response = bodyPump
      ? (await Promise.all([responsePromise, bodyPump]))[0]
      : await responsePromise;
    if (!response.ok) {
      console.error(JSON.stringify({
        event: "claudex_proxy_response_error",
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      }));
    }
    return response;
  } catch (error) {
    console.error(JSON.stringify({
      event: "claudex_proxy_fetch_failed",
      method: request.method,
      path: url.pathname,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    return deny("Claudex proxy unavailable", 502);
  }
};

function approvalStub(
  workerEnv: Env,
  ctx: OutboundHandlerContext,
): DurableObjectStub<HarnessContainer> {
  return workerEnv.HARNESS_CONTAINER.get(workerEnv.HARNESS_CONTAINER.idFromString(ctx.containerId));
}

export const githubWebOutbound: OutboundHandler<Env> = async (request, workerEnv, ctx) => {
  const bound = takeExecutionBinding(request);
  request = bound.request;
  let bodyText: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try { bodyText = await requestBodyText(request); } catch { return deny("body denied", 413); }
  }
  const attempt = attemptFor(request, bound.executionId, bodyText);
  const stub = approvalStub(workerEnv, ctx);
  const isClone = await stub.authorizeGithubRead(attempt);
  const isWrite = !isClone && await stub.authorizeGithubOutbound(attempt);
  if (!isClone && !isWrite) return deny("GitHub git request denied");
  if (!workerEnv.GITHUB_TOKEN) return fetch(request);
  return fetch(withCredentialHeader(request, "authorization", `Basic ${btoa(`x-access-token:${workerEnv.GITHUB_TOKEN}`)}`));
};

export const githubApiOutbound: OutboundHandler<Env> = async (request, workerEnv, ctx) => {
  const bound = takeExecutionBinding(request);
  request = bound.request;
  let bodyText: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try { bodyText = await requestBodyText(request); } catch { return deny("body denied", 413); }
  }
  const attempt = attemptFor(request, bound.executionId, bodyText);
  const stub = approvalStub(workerEnv, ctx);
  const allowed = await stub.authorizeGithubRead(attempt)
    || await stub.authorizeGithubOutbound(attempt);
  if (!allowed) return deny("GitHub API request denied");
  if (!workerEnv.GITHUB_TOKEN) return deny("GitHub credential unavailable", 503);
  return fetch(withCredentialHeader(request, "authorization", `Bearer ${workerEnv.GITHUB_TOKEN}`));
};

export const sourceDownloadOutbound: OutboundHandler<Env> = (request) => {
  request = takeExecutionBinding(request).request;
  if (request.method !== "GET" && request.method !== "HEAD") return deny("source host is read-only", 405);
  return fetch(request);
};

/** Route Claudex hosts from CLAUDEX_PROXY_URL when outboundByHost keys do not match. */
export const harnessFallbackOutbound: OutboundHandler<Env> = (request, workerEnv, ctx) => {
  const host = new URL(request.url).hostname.toLowerCase();
  const proxy = claudexProxyOrigin(workerEnv);
  if (proxy && host === proxy.hostname.toLowerCase()) {
    return claudexOutbound(request, workerEnv, ctx);
  }
  return sourceDownloadOutbound(request, workerEnv, ctx);
};

/** One recyclable Claude Code harness container per durable session name. */
export class HarnessContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "30m";
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = harnessAllowedHosts();
  pingEndpoint = "/health";

  // DECISIONS.md §10: this must be a class field, not a getter.
  envVars = harnessEnvVars();

  async setTurnApproval(body: Record<string, unknown>): Promise<void> {
    const scope = buildApprovalScope(body, repositoryAllowlist(this.env));
    if (!scope) await this.ctx.storage.delete(APPROVAL_KEY);
    else await this.ctx.storage.put(APPROVAL_KEY, scope);
  }

  /** Clear only the scope owned by this terminalizing execution. */
  async clearTurnApproval(executionId: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const scope = await transaction.get<GithubApprovalScope>(APPROVAL_KEY);
      if (!scope || scope.executionId !== executionId) return false;
      await transaction.delete(APPROVAL_KEY);
      return true;
    });
  }

  async authorizeGithubOutbound(attempt: GithubOutboundAttempt): Promise<boolean> {
    const scope = await this.ctx.storage.get<GithubApprovalScope>(APPROVAL_KEY);
    const allowed = authorizeGithubWrite(attempt, scope);
    if (!allowed && scope && scope.expiresAt <= Date.now()) await this.ctx.storage.delete(APPROVAL_KEY);
    return allowed;
  }

  async authorizeGithubRead(attempt: GithubOutboundAttempt): Promise<boolean> {
    const scope = await this.ctx.storage.get<GithubApprovalScope>(APPROVAL_KEY);
    const allowed = attempt.host === "github.com"
      ? isAllowedGitCloneRequest(attempt, scope)
      : isAllowedGithubRead(attempt, scope);
    if (!allowed && scope && scope.expiresAt <= Date.now()) await this.ctx.storage.delete(APPROVAL_KEY);
    return allowed;
  }
}

// Register after class construction. The Containers runtime discovers these
// class properties during export initialization; in-class static fields are
// too late for its interception metadata scan and silently bypass handlers.
HarnessContainer.outboundByHost = {
  "api.anthropic.com": anthropicOutbound,
  "github.com": githubWebOutbound,
  "api.github.com": githubApiOutbound,
  "claudex.internal": claudexOutbound,
};
HarnessContainer.outbound = harnessFallbackOutbound;
