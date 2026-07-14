import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  BOUNDED_TURN_ENVELOPE_MS,
  EGRESS_SENTINEL,
  authorizeGithubWrite,
  buildApprovalScope,
  EXECUTION_BINDING_HEADER,
  isAllowedGithubRead,
  isAllowedGitCloneRequest,
  repositoryAllowlist,
  takeExecutionBinding,
  withCredentialHeader,
} from "../workers/sandbox/src/egress-policy.js";

const allowlist = repositoryAllowlist({
  HARNESS_ALLOWED_REPO_HOSTS: "github.com",
  HARNESS_ALLOWED_REPO_ORGS: "acme",
});

function approved(now = 1_000) {
  return buildApprovalScope({
    sessionId: "session-1234567890",
    executionId: "exec-1",
    repo: { url: "https://github.com/acme/widget.git" },
    requesterContext: "[Requester Context]\nPrompted by: @will",
    remoteGitApproved: true,
    createPullRequest: true,
  }, allowlist, now)!;
}

function readOnly(now = 1_000) {
  return buildApprovalScope({
    sessionId: "session-1234567890",
    executionId: "exec-read",
    repo: { url: "https://github.com/acme/widget.git" },
    remoteGitApproved: false,
  }, allowlist, now)!;
}

describe("harness zero-trust egress policy", () => {
  it("installs an exact read scope without write approval and binds writes to repo, branch, and expiry", () => {
    const unapproved = readOnly();
    expect(unapproved.remoteGitApproved).toBe(false);
    expect(authorizeGithubWrite({
      host: "github.com", method: "GET", pathname: "/acme/widget.git/info/refs",
      search: "?service=git-receive-pack", executionId: "exec-read",
    }, unapproved, 2_000)).toBe(false);
    const scope = approved();
    expect(scope).toMatchObject({
      owner: "acme",
      repo: "widget",
      branch: "opentag/session-session-1234",
      requesterAttribution: "Prompted by: @will",
      remoteGitApproved: true,
    });
    const packet = `003f0000000000000000000000000000000000000000 refs/heads/${scope.branch}\0 report-status`;
    expect(authorizeGithubWrite({
      host: "github.com", method: "GET", pathname: "/acme/widget.git/info/refs",
      search: "?service=git-receive-pack", executionId: "exec-1",
    }, scope, 2_000)).toBe(true);
    expect(authorizeGithubWrite({
      host: "github.com", method: "POST", pathname: "/acme/widget.git/git-receive-pack", search: "", executionId: "exec-1", bodyText: packet,
    }, scope, 2_000)).toBe(true);
    expect(authorizeGithubWrite({
      host: "github.com", method: "POST", pathname: "/acme/widget.git/git-receive-pack", search: "", executionId: "exec-1", bodyText: packet.replace(scope.branch, "main"),
    }, scope, 2_000)).toBe(false);
    expect(authorizeGithubWrite({
      host: "github.com", method: "POST", pathname: "/acme/other.git/git-receive-pack", search: "", executionId: "exec-1", bodyText: packet,
    }, scope, 2_000)).toBe(false);
    expect(authorizeGithubWrite({
      host: "github.com", method: "POST", pathname: "/acme/widget.git/git-receive-pack", search: "", executionId: "exec-1", bodyText: packet,
    }, scope, scope.expiresAt)).toBe(false);
  });

  it("allows upload-pack only for the exact scoped repo and execution", () => {
    const scope = readOnly();
    expect(isAllowedGitCloneRequest({
      host: "github.com", method: "GET", pathname: "/acme/widget.git/info/refs", search: "?service=git-upload-pack",
      executionId: "exec-read",
    }, scope, 2_000)).toBe(true);
    expect(isAllowedGitCloneRequest({
      host: "github.com", method: "GET", pathname: "/other/widget.git/info/refs", search: "?service=git-upload-pack",
      executionId: "exec-read",
    }, scope, 2_000)).toBe(false);
    expect(isAllowedGitCloneRequest({
      host: "github.com", method: "GET", pathname: "/acme/other.git/info/refs", search: "?service=git-upload-pack",
      executionId: "exec-read",
    }, scope, 2_000)).toBe(false);
    expect(isAllowedGitCloneRequest({
      host: "github.com", method: "GET", pathname: "/acme/widget.git/info/refs", search: "?service=git-upload-pack",
      executionId: "exec-other",
    }, scope, 2_000)).toBe(false);
    expect(isAllowedGitCloneRequest({
      host: "github.com", method: "GET", pathname: "/acme/widget.git/info/refs", search: "?service=git-receive-pack",
      executionId: "exec-read",
    }, scope, 2_000)).toBe(false);
  });

  it("permits only an attributed PR create on the approved repo and branch", () => {
    const scope = approved();
    const bodyText = JSON.stringify({
      title: "Fix", body: "Summary\n\nPrompted by: @will", head: scope.branch, base: "main",
    });
    expect(authorizeGithubWrite({
      host: "api.github.com", method: "POST", pathname: "/repos/acme/widget/pulls", search: "", executionId: "exec-1", bodyText,
    }, scope, 2_000)).toBe(true);
    expect(authorizeGithubWrite({
      host: "api.github.com", method: "POST", pathname: "/repos/acme/other/pulls", search: "", executionId: "exec-1", bodyText,
    }, scope, 2_000)).toBe(false);
    expect(authorizeGithubWrite({
      host: "api.github.com", method: "POST", pathname: "/graphql", search: "", executionId: "exec-1", bodyText: '{"query":"mutation { createPullRequest }"}',
    }, scope, 2_000)).toBe(false);
    expect(authorizeGithubWrite({
      host: "api.github.com", method: "POST", pathname: "/repos/acme/widget/pulls", search: "", executionId: "exec-1", bodyText: bodyText.replace("Prompted by: @will", ""),
    }, scope, 2_000)).toBe(false);
  });

  it("binds overlapping approvals to the exact originating execution", () => {
    const scopeA = approved();
    const scopeB = buildApprovalScope({
      sessionId: "session-1234567890",
      executionId: "exec-2",
      repo: { url: "https://github.com/acme/widget.git" },
      requesterContext: "Prompted by: @will",
      remoteGitApproved: true,
      createPullRequest: true,
    }, allowlist, 1_500)!;
    const packet = `003f0000000000000000000000000000000000000000 refs/heads/${scopeB.branch}\0 report-status`;
    const backgroundA = {
      host: "github.com", method: "POST", pathname: "/acme/widget.git/git-receive-pack",
      search: "", executionId: "exec-1", bodyText: packet,
    };
    const currentB = { ...backgroundA, executionId: "exec-2" };
    const { executionId: _ignoredExecutionId, ...unboundA } = backgroundA;

    expect(authorizeGithubWrite(backgroundA, scopeA, 2_000)).toBe(true);
    expect(authorizeGithubWrite(unboundA, scopeA, 2_000)).toBe(false);
    expect(authorizeGithubWrite(backgroundA, scopeB, 2_000)).toBe(false);
    expect(authorizeGithubWrite(currentB, scopeB, 2_000)).toBe(true);
    expect(authorizeGithubWrite({ ...currentB, pathname: "/acme/other.git/git-receive-pack" }, scopeB, 2_000)).toBe(false);
    expect(authorizeGithubWrite({ ...currentB, bodyText: packet.replace(scopeB.branch, "main") }, scopeB, 2_000)).toBe(false);
  });

  it("keeps the exact scope alive through the full bounded turn and expires immediately after TTL", () => {
    const startedAt = 50_000;
    const scope = approved(startedAt);
    expect(APPROVAL_TTL_MS).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(APPROVAL_TTL_MS).toBeGreaterThanOrEqual(BOUNDED_TURN_ENVELOPE_MS);
    const nearExpiry = scope.expiresAt - 1;
    const packet = `003f0000000000000000000000000000000000000000 refs/heads/${scope.branch}\0 report-status`;
    const clone = {
      host: "github.com", method: "GET", pathname: "/acme/widget.git/info/refs",
      search: "?service=git-upload-pack", executionId: "exec-1",
    };
    const push = {
      host: "github.com", method: "POST", pathname: "/acme/widget.git/git-receive-pack",
      search: "", executionId: "exec-1", bodyText: packet,
    };
    const read = {
      host: "api.github.com", method: "GET", pathname: "/repos/acme/widget/pulls",
      search: "", executionId: "exec-1",
    };
    expect(isAllowedGitCloneRequest(clone, scope, startedAt + BOUNDED_TURN_ENVELOPE_MS)).toBe(true);
    expect(authorizeGithubWrite(push, scope, nearExpiry)).toBe(true);
    expect(isAllowedGithubRead(read, scope, nearExpiry)).toBe(true);
    expect(authorizeGithubWrite({ ...push, executionId: "exec-other" }, scope, nearExpiry)).toBe(false);
    expect(authorizeGithubWrite({ ...push, pathname: "/acme/other.git/git-receive-pack" }, scope, nearExpiry)).toBe(false);
    expect(isAllowedGitCloneRequest(clone, scope, scope.expiresAt)).toBe(false);
    expect(authorizeGithubWrite(push, scope, scope.expiresAt)).toBe(false);
    expect(isAllowedGithubRead(read, scope, scope.expiresAt)).toBe(false);
  });

  it("denies GraphQL reads even when a comment spoofs an allowed org", () => {
    const scope = readOnly();
    expect(isAllowedGithubRead({
      host: "api.github.com",
      method: "POST",
      pathname: "/graphql",
      search: "",
      bodyText: JSON.stringify({
        query: 'query { repository(owner: "victim", name: "private") { id } } # "acme"',
      }),
      executionId: "exec-read",
    }, scope, 2_000)).toBe(false);
  });

  it("restricts credentialed REST reads to the exact turn repository", () => {
    const scope = readOnly();
    expect(isAllowedGithubRead({
      host: "api.github.com", method: "GET", pathname: "/repos/acme/widget/pulls",
      search: "", executionId: "exec-read",
    }, scope, 2_000)).toBe(true);
    expect(isAllowedGithubRead({
      host: "api.github.com", method: "GET", pathname: "/repos/acme/other/pulls",
      search: "", executionId: "exec-read",
    }, scope, 2_000)).toBe(false);
    expect(isAllowedGithubRead({
      host: "api.github.com", method: "GET", pathname: "/repos/acme/widget/pulls",
      search: "", executionId: "exec-other",
    }, scope, 2_000)).toBe(false);
  });

  it("extracts and strips the internal execution header before upstream", () => {
    const bound = takeExecutionBinding(new Request("https://github.com/acme/widget.git/git-receive-pack", {
      method: "POST",
      headers: { [EXECUTION_BINDING_HEADER]: "exec-2" },
      body: "packet",
    }));
    expect(bound.executionId).toBe("exec-2");
    expect(bound.request.headers.get(EXECUTION_BINDING_HEADER)).toBeNull();
  });

  it("statically locks ContainerProxy, HTTPS interception, CA trust, and deny-by-default", () => {
    const container = fs.readFileSync(new URL("../workers/sandbox/src/container.ts", import.meta.url), "utf8");
    const entry = fs.readFileSync(new URL("../workers/sandbox/src/index.ts", import.meta.url), "utf8");
    const dockerfile = fs.readFileSync(new URL("../../containers/harness/Dockerfile", import.meta.url), "utf8");
    expect(entry).toContain('export { ContainerProxy } from "@cloudflare/containers"');
    expect(container).toContain("enableInternet = false");
    expect(container).toContain("interceptHttps = true");
    expect(container).toContain("allowedHosts = [...HARNESS_ALLOWED_HOSTS]");
    expect(
      container.match(/request = takeExecutionBinding\(request\)\.request;/g),
    ).toHaveLength(2);
    expect(dockerfile).toContain("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(dockerfile).toContain("NODE_EXTRA_CA_CERTS");
    expect(dockerfile).toContain('x-opentag-execution-id: ${OPENTAG_EXECUTION_ID:-}');
    expect(EGRESS_SENTINEL).not.toMatch(/sk-ant|ghp_|github_pat_/);
  });

  it("strips container-supplied credentials before trusted injection", () => {
    const outgoing = withCredentialHeader(new Request("https://api.anthropic.com/v1/messages", {
      headers: { authorization: `Bearer ${EGRESS_SENTINEL}`, "x-api-key": EGRESS_SENTINEL },
    }), "x-api-key", "real-worker-only-secret");
    expect(outgoing.headers.get("authorization")).toBeNull();
    expect(outgoing.headers.get("x-api-key")).toBe("real-worker-only-secret");
  });
});
