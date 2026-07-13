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
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  OPENTAG_TOOL_BIN?: string;
  HARNESS_AUTH_TOKEN?: string;
  HARNESS_ALLOWED_REPO_HOSTS?: string;
  HARNESS_ALLOWED_REPO_ORGS?: string;
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
  for (const key of ["OPENTAG_TOOL_BIN", "HARNESS_ALLOWED_REPO_HOSTS", "HARNESS_ALLOWED_REPO_ORGS"] as const) {
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
  const isClone = isAllowedGitCloneRequest(attempt, repositoryAllowlist(workerEnv));
  const isWrite = !isClone && await approvalStub(workerEnv, ctx).authorizeGithubOutbound(attempt);
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
  const allowed = isAllowedGithubRead(attempt, repositoryAllowlist(workerEnv))
    || await approvalStub(workerEnv, ctx).authorizeGithubOutbound(attempt);
  if (!allowed) return deny("GitHub API request denied");
  if (!workerEnv.GITHUB_TOKEN) return deny("GitHub credential unavailable", 503);
  return fetch(withCredentialHeader(request, "authorization", `Bearer ${workerEnv.GITHUB_TOKEN}`));
};

export const sourceDownloadOutbound: OutboundHandler<Env> = (request) => {
  request = takeExecutionBinding(request).request;
  if (request.method !== "GET" && request.method !== "HEAD") return deny("source host is read-only", 405);
  return fetch(request);
};

/** One recyclable Claude Code harness container per durable session name. */
export class HarnessContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "30m";
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [...HARNESS_ALLOWED_HOSTS];
  pingEndpoint = "/health";

  // DECISIONS.md §10: this must be a class field, not a getter.
  envVars = harnessEnvVars();

  static outboundByHost = {
    "api.anthropic.com": anthropicOutbound,
    "github.com": githubWebOutbound,
    "api.github.com": githubApiOutbound,
  };

  static outbound = sourceDownloadOutbound;

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
}
