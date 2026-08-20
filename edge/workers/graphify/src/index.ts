import { GraphBuilderContainer, GraphQueryContainer } from "./container.js";
import { GraphifyRegistryDO, type GraphifyArtifact, type GraphifyRepository } from "./registry-do.js";
import type { Env } from "./env.js";
export { ContainerProxy } from "@cloudflare/sandbox";

export { GraphBuilderContainer, GraphQueryContainer, GraphifyRegistryDO };

const PINNED_GRAPHIFY_COMMIT = "00efd6e7969837ae4a9f11d8d504dcd3b20b09df";
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\.git$/;
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_BODY = 1_000_000;

function safeGraphifyErrorMessage(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240);
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

function registry(env: Env): DurableObjectStub {
  return env.REGISTRY.getByName("registry");
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) return undefined;
    }
    // Service bindings and chunked requests may omit content-length. Enforce
    // the limit on the bytes actually received instead of trusting a header.
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY) return undefined;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function serviceUnauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function validId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && value !== "." && value !== "..";
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && GIT_BRANCH.test(value) &&
    value !== "." && value !== ".." &&
    !value.includes("..") && !value.includes("//") &&
    !value.includes("@{") && !value.endsWith("/");
}

function allowedRepositoryOrg(env: Env, cloneUrl: string): boolean {
  const match = /^https:\/\/github\.com\/([^/]+)\/[^/]+\.git$/.exec(cloneUrl);
  const configured = new Set(
    (env.GRAPHIFY_ALLOWED_REPO_ORGS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  return Boolean(match && configured.size > 0 && configured.has(match[1]!.toLowerCase()));
}

type TrackedRepositorySource = {
  cloneUrl: string;
  defaultBranch: string;
};

type GraphifyRegistrationScope = {
  teamId: string;
  projectId: string;
};

function trackedRepositoryCatalog(env: Env): Record<string, unknown> | undefined {
  const raw = env.GRAPHIFY_REPOSITORY_CATALOG?.trim();
  if (!raw || raw.length > 256 * 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function trackedRepositorySource(env: Env, repoId: string): TrackedRepositorySource | undefined {
  const value = trackedRepositoryCatalog(env)?.[repoId];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.cloneUrl !== "string" ||
    !GITHUB_REPO.test(source.cloneUrl) ||
    !allowedRepositoryOrg(env, source.cloneUrl) ||
    !validBranch(source.defaultBranch)
  ) {
    return undefined;
  }
  return { cloneUrl: source.cloneUrl, defaultBranch: source.defaultBranch };
}

function defaultRegistrationScope(env: Env): GraphifyRegistrationScope | undefined {
  return validId(env.GRAPHIFY_DEFAULT_TEAM_ID) && validId(env.GRAPHIFY_DEFAULT_PROJECT_ID)
    ? { teamId: env.GRAPHIFY_DEFAULT_TEAM_ID, projectId: env.GRAPHIFY_DEFAULT_PROJECT_ID }
    : undefined;
}

async function registerCatalogRepository(
  env: Env,
  repoId: string,
  source: TrackedRepositorySource,
  scope: GraphifyRegistrationScope,
  enabled: boolean,
): Promise<void> {
  const response = await registryFetch(env, "/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoId,
      teamId: scope.teamId,
      projectId: scope.projectId,
      cloneUrl: source.cloneUrl,
      defaultBranch: source.defaultBranch,
      enabled,
    }),
  });
  if (!response.ok) throw new Error("Graphify catalog registration failed");
}

/**
 * Reconcile the server-owned catalog before the hourly pass. This makes the
 * first build deterministic without putting the admin token in a caller or a
 * public URL. Existing disabled registrations stay disabled; catalog/source
 * changes still advance the registry revision and invalidate old pointers.
 */
export async function reconcileTrackedRepositories(env: Env): Promise<void> {
  const catalog = trackedRepositoryCatalog(env);
  const scope = defaultRegistrationScope(env);
  if (!catalog || !scope) throw new Error("Graphify catalog bootstrap scope is unavailable");
  for (const repoId of Object.keys(catalog).sort()) {
    if (!validId(repoId)) throw new Error("Graphify catalog repository id is invalid");
    const source = trackedRepositorySource(env, repoId);
    if (!source) throw new Error("Graphify catalog repository source is invalid");
    const currentResponse = await registryFetch(env, `/repository?repoId=${encodeURIComponent(repoId)}`);
    if (currentResponse.status === 404) {
      await registerCatalogRepository(env, repoId, source, scope, true);
      continue;
    }
    if (!currentResponse.ok) throw new Error("Graphify registry unavailable");
    const current = await currentResponse.json() as Partial<GraphifyRepository>;
    if (
      current.teamId !== scope.teamId ||
      current.projectId !== scope.projectId ||
      current.cloneUrl !== source.cloneUrl ||
      current.defaultBranch !== source.defaultBranch
    ) {
      await registerCatalogRepository(env, repoId, source, scope, current.enabled !== false);
    }
  }
}

function isCurrentTrackedRepository(env: Env, repo: Pick<GraphifyRepository, "repoId" | "cloneUrl" | "defaultBranch">): boolean {
  const source = trackedRepositorySource(env, repo.repoId);
  return Boolean(
    source &&
    source.cloneUrl === repo.cloneUrl &&
    source.defaultBranch === repo.defaultBranch,
  );
}

async function registryFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return registry(env).fetch(new Request(`https://registry.internal${path}`, init));
}

async function repository(env: Env, repoId: string): Promise<GraphifyRepository | undefined> {
  const response = await registryFetch(env, `/repository?repoId=${encodeURIComponent(repoId)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("registry unavailable");
  return await response.json() as GraphifyRepository;
}

async function activeArtifact(env: Env, repoId: string): Promise<GraphifyArtifact | undefined> {
  const response = await registryFetch(env, `/artifact?repoId=${encodeURIComponent(repoId)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("registry unavailable");
  return await response.json() as GraphifyArtifact;
}

function repoParts(cloneUrl: string): { owner: string; name: string } {
  if (!GITHUB_REPO.test(cloneUrl)) throw new Error("repository is not allowlisted");
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/.exec(cloneUrl);
  if (!match) throw new Error("repository is not allowlisted");
  return { owner: match[1]!, name: match[2]! };
}

async function resolveCommit(env: Env, repo: GraphifyRepository): Promise<string> {
  if (!isCurrentTrackedRepository(env, repo) || !allowedRepositoryOrg(env, repo.cloneUrl)) {
    throw new Error("repository is not currently tracked");
  }
  const { owner, name } = repoParts(repo.cloneUrl);
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "opentag-graphify-builder",
  });
  if (env.GITHUB_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(repo.defaultBranch)}`, { headers });
  if (!response.ok) throw new Error("GitHub commit resolution failed");
  const value = await response.json() as { sha?: unknown };
  if (typeof value.sha !== "string" || !COMMIT.test(value.sha)) throw new Error("GitHub returned an invalid commit");
  return value.sha;
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value)) ?? "";
}

type FetchService = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type ArtifactBucket = Pick<R2Bucket, "head" | "put">;

export async function putImmutableArtifact(
  bucket: ArtifactBucket,
  key: string,
  value: ArrayBuffer,
  digest: string,
  contentType: string,
  customMetadata: Record<string, string>,
  kind: "artifact" | "manifest",
): Promise<void> {
  // R2 evaluates this precondition with the write. The `*` value follows the
  // HTTP If-None-Match semantics: create only when no representation exists.
  // A preceding head() check would leave a same-key rebuild vulnerable to a
  // check-then-put race.
  const stored = await bucket.put(key, value, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType },
    customMetadata: { ...customMetadata, sha256: digest },
  });
  if (stored) return;

  // A concurrent publisher may have won the conditional write. Reusing that
  // object is safe only when it is the exact immutable content we validated;
  // otherwise fail closed rather than overwriting or activating ambiguity.
  const existing = await bucket.head(key);
  if (
    !existing ||
    existing.size !== value.byteLength ||
    existing.customMetadata?.sha256 !== digest
  ) {
    throw new Error(`immutable Graphify ${kind} conflict`);
  }
}

async function downloadArtifact(
  builder: FetchService,
  token: string,
  jobId: string,
  name: string,
): Promise<ArrayBuffer> {
  const response = await builder.fetch(new Request(`https://graphify.internal/v1/build/${jobId}/${name}`, {
    headers: { "x-graphify-container-token": token },
  }));
  if (!response.ok) throw new Error("builder artifact unavailable");
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 512 * 1024 * 1024) throw new Error("artifact too large");
  const value = await response.arrayBuffer();
  if (value.byteLength > 512 * 1024 * 1024) throw new Error("artifact too large");
  return value;
}

async function cleanupBuild(builder: FetchService, token: string, jobId: string): Promise<void> {
  try {
    await builder.fetch(new Request(`https://graphify.internal/v1/build/${jobId}`, {
      method: "DELETE",
      headers: { "x-graphify-container-token": token },
    }));
  } catch {
    // Cleanup is best effort; the builder's ephemeral disk is not an artifact
    // store, and a later container restart removes any orphaned job directory.
  }
}

async function buildAndPublish(
  env: Env,
  repo: GraphifyRepository,
  commitSha: string,
): Promise<{ repoId: string; commitSha: string; artifactKey: string }> {
  if (!COMMIT.test(commitSha)) throw new Error("commit invalid");
  if (!isCurrentTrackedRepository(env, repo) || !allowedRepositoryOrg(env, repo.cloneUrl)) {
    throw new Error("repository is not currently tracked");
  }
  const graphifyCommit = env.GRAPHIFY_COMMIT || PINNED_GRAPHIFY_COMMIT;
  if (graphifyCommit !== PINNED_GRAPHIFY_COMMIT) throw new Error("Graphify commit pin mismatch");
  const existing = await activeArtifact(env, repo.repoId);
  const expectedPreviousCommitSha = existing?.commitSha ?? null;
  const artifactKey = `code-graphs/${repo.repoId}/${commitSha}`;
  const containerToken = env.GRAPHIFY_CONTAINER_AUTH_TOKEN;
  if (!containerToken) throw new Error("Graphify container auth is unavailable");
  const builder = env.GRAPHIFY_BUILDER.getByName("builder");
  const buildResponse = await builder.fetch(new Request("https://graphify.internal/v1/build", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-graphify-container-token": containerToken,
    },
    body: JSON.stringify({
      repoUrl: repo.cloneUrl,
      commitSha,
      artifactKey,
    }),
  }));
  if (!buildResponse.ok) throw new Error("Graphify build failed");
  const buildPayload = await buildResponse.json() as Record<string, unknown>;
  const jobId = buildPayload.jobId;
  if (typeof jobId !== "string" || !/^[a-f0-9-]{36}$/.test(jobId)) {
    throw new Error("Graphify manifest failed validation");
  }
  try {
    const { jobId: _jobId, ...manifest } = buildPayload;
    const files = manifest.files;
    if (manifest.repoId !== repo.repoId || manifest.commitSha !== commitSha ||
      manifest.artifactKey !== artifactKey || manifest.graphifyCommit !== graphifyCommit ||
      !files || typeof files !== "object" || Array.isArray(files)) {
      throw new Error("Graphify artifact checksum validation failed");
    }

    const names = ["graph.json", "report.md", "source.tar.gz"] as const;
    const contents = new Map<string, { value: ArrayBuffer; digest: string }>();
    for (const name of names) {
      const value = await downloadArtifact(builder, containerToken, jobId, name);
      const expected = (files as Record<string, unknown>)[name];
      if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
        typeof (expected as Record<string, unknown>).sha256 !== "string" ||
        typeof (expected as Record<string, unknown>).size !== "number" ||
        (expected as Record<string, unknown>).size !== value.byteLength ||
        await sha256(value) !== (expected as Record<string, unknown>).sha256) {
        throw new Error("Graphify artifact checksum validation failed");
      }
      contents.set(name, { value, digest: await sha256(value) });
    }
    // Validate and retain the exact manifest emitted by the pinned builder.
    // Re-serializing an unverified payload here would make the R2 manifest a
    // Worker-side reconstruction rather than the checksum-bearing build
    // record that was produced alongside the artifact files.
    const manifestBuffer = await downloadArtifact(builder, containerToken, jobId, "manifest.json");
    let storedManifest: unknown;
    try {
      storedManifest = JSON.parse(new TextDecoder().decode(manifestBuffer));
    } catch {
      throw new Error("Graphify manifest is not valid JSON");
    }
    if (canonicalJson(storedManifest) !== canonicalJson(manifest)) {
      throw new Error("Graphify manifest does not match the builder response");
    }
    for (const [name, content] of contents) {
      const key = `${artifactKey}/${name}`;
      await putImmutableArtifact(
        env.ARTIFACTS,
        key,
        content.value,
        content.digest,
        name === "graph.json"
          ? "application/json"
          : name === "report.md"
            ? "text/markdown"
            : "application/octet-stream",
        { repoId: repo.repoId, commitSha },
        "artifact",
      );
    }
    const manifestDigest = await sha256(manifestBuffer);
    const manifestKey = `${artifactKey}/manifest.json`;
    await putImmutableArtifact(
      env.ARTIFACTS,
      manifestKey,
      manifestBuffer,
      manifestDigest,
      "application/json",
      { repoId: repo.repoId, commitSha },
      "manifest",
    );
    const activation = await registryFetch(env, "/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: repo.repoId,
        commitSha,
        artifactKey,
        expectedPreviousCommitSha,
        expectedRepositoryRevision: repo.revision,
        manifest,
      }),
    });
    if (!activation.ok) throw new Error(activation.status === 409 ? "stale Graphify build" : "artifact activation failed");
    return { repoId: repo.repoId, commitSha, artifactKey };
  } finally {
    await cleanupBuild(builder, containerToken, jobId);
  }
}

async function queryArtifact(request: Request, env: Env, pathname: string): Promise<Response> {
  const body = await jsonBody(request);
  if (!body || !validId(body.teamId) || !validId(body.repoId) || !validId(body.projectId)) {
    return Response.json({ error: "query_scope_invalid" }, { status: 400 });
  }
  const repo = await repository(env, body.repoId);
  const artifact = await activeArtifact(env, body.repoId);
  if (!repo || !artifact || !repo.enabled || !isCurrentTrackedRepository(env, repo) ||
      !allowedRepositoryOrg(env, repo.cloneUrl)) {
    return Response.json({ error: "repository_unavailable" }, { status: 404 });
  }
  // Project binding is checked again at the facade. The bot/MCP still owns the
  // actor/channel ACL decision; Graphify is not an authorization boundary.
  if (
    repo.teamId !== body.teamId ||
    artifact.projectId !== body.projectId ||
    repo.projectId !== body.projectId
  ) {
    return Response.json({ error: "repository_scope_denied" }, { status: 403 });
  }
  const token = env.GRAPHIFY_CONTAINER_AUTH_TOKEN;
  if (!token) return Response.json({ error: "container_unavailable" }, { status: 503 });
  const container = env.GRAPHIFY.getByName("query");
  const headers = new Headers({
    "content-type": "application/json",
    "x-graphify-container-token": token,
    "x-graphify-repo": artifact.repoId,
    "x-graphify-team": repo.teamId,
    "x-graphify-commit": artifact.commitSha,
    "x-graphify-artifact-key": artifact.artifactKey,
  });
  const forwarded = await container.fetch(new Request(`https://graphify.internal${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
  return new Response(forwarded.body, forwarded);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const service = await tokenMatches(request.headers.get("x-opentag-graphify-token"), env.GRAPHIFY_SERVICE_AUTH_TOKEN);
    const admin = await tokenMatches(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null, env.GRAPHIFY_ADMIN_TOKEN);

    if (url.pathname === "/health") {
      if (!service) return serviceUnauthorized();
      if (request.method !== "GET") {
        return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
      }
      let containerState: { status?: string } | undefined;
      try {
        const query = env.GRAPHIFY.getByName("query");
        containerState = typeof query.getState === "function"
          ? await query.getState().catch(() => undefined)
          : undefined;
        const probe = await query.fetch(
          new Request("https://graphify.internal/health"),
        );
        if (!probe.ok) {
          console.log(JSON.stringify({
            event: "graphify_health_probe",
            ok: false,
            containerState: containerState?.status ?? "unknown",
            status: probe.status,
          }));
          return Response.json({ status: "degraded", service: "opentag-graphify" }, { status: 503 });
        }
        console.log(JSON.stringify({
          event: "graphify_health_probe",
          ok: true,
          containerState: containerState?.status ?? "unknown",
          status: probe.status,
        }));
      } catch {
        return Response.json({ status: "degraded", service: "opentag-graphify" }, { status: 503 });
      }
      return Response.json({
        status: "ok",
        service: "opentag-graphify",
        storage: "r2-fuse-read-only",
        graphifyCommit: PINNED_GRAPHIFY_COMMIT,
        containerState: containerState?.status ?? "unknown",
      });
    }
    if (url.pathname === "/v1/repositories" && admin) {
      if (request.method === "GET") {
        return registryFetch(env, "/repositories");
      }
      if (request.method === "POST") {
        const body = await jsonBody(request);
        const source = body && validId(body.repoId)
          ? trackedRepositorySource(env, body.repoId)
          : undefined;
        if (
          !body ||
          !validId(body.repoId) ||
          !validId(body.teamId) ||
          !validId(body.projectId) ||
          typeof body.enabled !== "boolean" ||
          !source ||
          // Registration is deliberately catalog-backed. Reject URL/ref
          // fields even for an admin caller so a future UI cannot turn this
          // route into a caller-controlled clone boundary.
          "cloneUrl" in body ||
          "defaultBranch" in body
        ) {
          return Response.json({ error: "repository_invalid" }, { status: 400 });
        }
        return registryFetch(env, "/repositories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repoId: body.repoId,
            teamId: body.teamId,
            projectId: body.projectId,
            cloneUrl: source.cloneUrl,
            defaultBranch: source.defaultBranch,
            enabled: body.enabled,
          }),
        });
      }
    }
    if (url.pathname === "/v1/rebuild" && admin && request.method === "POST") {
      const body = await jsonBody(request);
      if (!body || !validId(body.repoId)) return Response.json({ error: "repository_invalid" }, { status: 400 });
      try {
        const repo = await repository(env, body.repoId);
        if (!repo || !repo.enabled || !isCurrentTrackedRepository(env, repo)) {
          return Response.json({ error: "repository_unavailable" }, { status: 404 });
        }
        const commitSha = typeof body.commitSha === "string" ? body.commitSha : await resolveCommit(env, repo);
        if (!COMMIT.test(commitSha)) return Response.json({ error: "commit_invalid" }, { status: 400 });
        return Response.json({ status: "published", ...(await buildAndPublish(env, repo, commitSha)) });
      } catch {
        return Response.json({ error: "rebuild_failed" }, { status: 502 });
      }
    }
    if (service && request.method === "POST" && ["/v1/code/graph-search", "/v1/code/path", "/v1/code/impact"].includes(url.pathname)) {
      try {
        return await queryArtifact(request, env, url.pathname);
      } catch {
        return Response.json({ error: "graph_query_unavailable" }, { status: 503 });
      }
    }
    return service ? new Response("Not found", { status: 404 }) : serviceUnauthorized();
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await reconcileTrackedRepositories(env);
    } catch (error) {
      console.error("[opentag-graphify] catalog reconciliation failed", {
        errorType: error instanceof Error ? error.constructor.name : "unknown",
        errorMessage: safeGraphifyErrorMessage(error, [env.GITHUB_TOKEN, env.GRAPHIFY_CONTAINER_AUTH_TOKEN]),
      });
      return;
    }
    const response = await registryFetch(env, "/repositories?enabled=true");
    if (!response.ok) {
      console.error("[opentag-graphify] repository listing failed", { status: response.status });
      return;
    }
    const repositories = await response.json() as GraphifyRepository[];
    console.log("[opentag-graphify] scheduled pass started", { repositories: repositories.length });
    ctx.waitUntil((async () => {
      for (const repo of repositories.slice(0, 32)) {
        try {
          const commitSha = await resolveCommit(env, repo);
          const current = await activeArtifact(env, repo.repoId);
          if (current?.commitSha === commitSha) continue;
          console.log("[opentag-graphify] scheduled build started", { repoId: repo.repoId, commitSha });
          await buildAndPublish(env, repo, commitSha);
          console.log("[opentag-graphify] scheduled build published", { repoId: repo.repoId, commitSha });
        } catch (error) {
          // One repository must not prevent the hourly pass from trying the rest.
          console.error("[opentag-graphify] scheduled build failed", {
            repoId: repo.repoId,
            errorType: error instanceof Error ? error.constructor.name : "unknown",
            errorMessage: safeGraphifyErrorMessage(error, [env.GITHUB_TOKEN, env.GRAPHIFY_CONTAINER_AUTH_TOKEN]),
          });
        }
      }
    })());
  },
};
