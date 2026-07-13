import { EXECUTION_BINDING_HEADER, requesterAttribution } from "../turn-contract.js";

export const EGRESS_SENTINEL = "opentag-egress-injected-not-a-secret";
export const APPROVAL_TTL_MS = 12 * 60_000;
export { EXECUTION_BINDING_HEADER };

export interface RepositoryIdentity {
  host: string;
  owner: string;
  repo: string;
}

export interface GithubApprovalScope extends RepositoryIdentity {
  executionId: string;
  branch: string;
  expiresAt: number;
  createPullRequest: boolean;
  requesterAttribution?: string;
}

export interface GithubOutboundAttempt {
  host: string;
  method: string;
  pathname: string;
  search: string;
  executionId?: string;
  bodyText?: string;
}

export interface RepositoryAllowlist {
  hosts: ReadonlySet<string>;
  orgs: ReadonlySet<string>;
}

const SAFE_REF = /^(?![./])(?!.*(?:\.\.|@\{|\/\/|\\))[A-Za-z0-9._/-]{1,200}(?<![/.])$/;

export function csvSet(value?: string): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Replace any untrusted/sentinel credential before forwarding upstream. */
export function withCredentialHeader(request: Request, name: string, value: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.set(name, value);
  return new Request(request, { headers });
}

/** Read the per-process execution binding and remove it before forwarding. */
export function takeExecutionBinding(request: Request): {
  request: Request;
  executionId?: string;
} {
  const headers = new Headers(request.headers);
  const executionId = headers.get(EXECUTION_BINDING_HEADER) ?? undefined;
  headers.delete(EXECUTION_BINDING_HEADER);
  return {
    request: new Request(request, { headers }),
    ...(executionId ? { executionId } : {}),
  };
}

export function repositoryAllowlist(env: {
  HARNESS_ALLOWED_REPO_HOSTS?: string;
  HARNESS_ALLOWED_REPO_ORGS?: string;
}): RepositoryAllowlist {
  const hosts = csvSet(env.HARNESS_ALLOWED_REPO_HOSTS);
  if (hosts.size === 0) hosts.add("github.com");
  return { hosts, orgs: csvSet(env.HARNESS_ALLOWED_REPO_ORGS) };
}

export function parseAllowedRepository(
  value: unknown,
  allowlist: RepositoryAllowlist,
): RepositoryIdentity | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !allowlist.hosts.has(host) ||
    parts.length !== 2
  ) return undefined;
  const owner = parts[0]?.toLowerCase();
  const repo = parts[1]?.replace(/\.git$/i, "").toLowerCase();
  if (!owner || !repo || !/^[a-z0-9_.-]+$/.test(owner) || !/^[a-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  if (!allowlist.orgs.has(owner)) return undefined;
  return { host, owner, repo };
}

export function temporaryBranch(sessionId: string): string {
  const prefix = sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "session";
  return `opentag/session-${prefix}`;
}

export function buildApprovalScope(
  body: Record<string, unknown>,
  allowlist: RepositoryAllowlist,
  now = Date.now(),
): GithubApprovalScope | undefined {
  if (body.remoteGitApproved !== true || typeof body.executionId !== "string") return undefined;
  if (typeof body.sessionId !== "string") return undefined;
  const repoSpec = body.repo;
  const repoUrl = repoSpec && typeof repoSpec === "object"
    ? (repoSpec as Record<string, unknown>).url
    : undefined;
  const repository = parseAllowedRepository(repoUrl, allowlist);
  if (!repository) return undefined;
  const attribution = requesterAttribution(
    typeof body.requesterContext === "string" ? body.requesterContext : undefined,
  );
  return {
    ...repository,
    executionId: body.executionId,
    branch: temporaryBranch(body.sessionId),
    expiresAt: now + APPROVAL_TTL_MS,
    createPullRequest: body.createPullRequest === true,
    ...(attribution ? { requesterAttribution: attribution } : {}),
  };
}

function repositoryFromGitPath(pathname: string): RepositoryIdentity | undefined {
  const match = pathname.match(/^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/i);
  if (!match) return undefined;
  return { host: "github.com", owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() };
}

function matchesRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.host === right.host && left.owner === right.owner && left.repo === right.repo;
}

export function isAllowedGitCloneRequest(
  attempt: GithubOutboundAttempt,
  allowlist: RepositoryAllowlist,
): boolean {
  if (attempt.host !== "github.com") return false;
  const repo = repositoryFromGitPath(attempt.pathname);
  if (!repo || !allowlist.hosts.has(repo.host) || !allowlist.orgs.has(repo.owner)) return false;
  if (attempt.method === "GET" && attempt.pathname.endsWith("/info/refs")) {
    return new URLSearchParams(attempt.search).get("service") === "git-upload-pack";
  }
  return attempt.method === "POST" && attempt.pathname.endsWith("/git-upload-pack");
}

function receivePackTargetsOnlyBranch(bodyText: string, branch: string): boolean {
  const refs = bodyText.match(/refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+/g) ?? [];
  return refs.length > 0 && refs.every((ref) => ref === `refs/heads/${branch}`);
}

function jsonBody(value?: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function exactRestRepository(pathname: string): RepositoryIdentity | undefined {
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/i);
  return match
    ? { host: "github.com", owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() }
    : undefined;
}

export function authorizeGithubWrite(
  attempt: GithubOutboundAttempt,
  scope: GithubApprovalScope | undefined,
  now = Date.now(),
): boolean {
  if (!scope || scope.expiresAt <= now) return false;
  // The binding is not a secret. It ties a mutation to the exact child
  // process whose turn installed this Worker-side repo/branch approval.
  if (attempt.executionId !== scope.executionId) return false;
  if (attempt.host === "github.com") {
    const repo = repositoryFromGitPath(attempt.pathname);
    if (!repo || !matchesRepository(repo, scope)) return false;
    if (attempt.method === "GET" && attempt.pathname.endsWith("/info/refs")) {
      return new URLSearchParams(attempt.search).get("service") === "git-receive-pack";
    }
    return attempt.method === "POST" &&
      attempt.pathname.endsWith("/git-receive-pack") &&
      receivePackTargetsOnlyBranch(attempt.bodyText ?? "", scope.branch);
  }
  if (attempt.host !== "api.github.com" || !scope.createPullRequest) return false;
  // Deliberately reject GraphQL mutations: opaque node IDs cannot be proven to
  // belong to the approved repository. The image's gh wrapper uses REST.
  if (attempt.pathname === "/graphql") return false;
  if (attempt.method !== "POST" || attempt.pathname.toLowerCase() !== `/repos/${scope.owner}/${scope.repo}/pulls`) {
    return false;
  }
  const body = jsonBody(attempt.bodyText);
  if (!body || body.head !== scope.branch || typeof body.base !== "string" || !SAFE_REF.test(body.base)) {
    return false;
  }
  if (scope.requesterAttribution) {
    const prBody = body.body;
    if (typeof prBody !== "string" || !prBody.split(/\r?\n/).includes(scope.requesterAttribution)) {
      return false;
    }
  }
  return true;
}

export function isAllowedGithubRead(
  attempt: GithubOutboundAttempt,
  allowlist: RepositoryAllowlist,
): boolean {
  // GraphQL operations can span multiple repositories and comments/aliases
  // make substring authorization a confused-deputy risk. Current clone/PR
  // flows use git smart HTTP plus repository-scoped REST, so fail closed.
  if (attempt.pathname === "/graphql") return false;
  if (!new Set(["GET", "HEAD"]).has(attempt.method)) return false;
  const repo = exactRestRepository(attempt.pathname);
  return !!repo && allowlist.orgs.has(repo.owner);
}
