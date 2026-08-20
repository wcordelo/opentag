import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {
    env: Record<string, unknown>;
    constructor(_ctx?: unknown, env?: Record<string, unknown>) {
      this.env = env ?? {};
    }
  },
  ContainerProxy: class {},
}));

const { default: graphifyWorker, GraphQueryContainer, putImmutableArtifact, reconcileTrackedRepositories } = await import("../workers/graphify/src/index.js");

const COMMIT = "0123456789012345678901234567890123456789";

function graphEnv(queryFetch: ReturnType<typeof vi.fn>, registryFetch: ReturnType<typeof vi.fn>) {
  return {
    GRAPHIFY: { getByName: () => ({ fetch: queryFetch }) },
    GRAPHIFY_BUILDER: { getByName: () => ({ fetch: vi.fn() }) },
    REGISTRY: { getByName: () => ({ fetch: registryFetch }) },
    ARTIFACTS: {},
    R2_ACCOUNT_ID: "account",
    R2_BUCKET_NAME: "opentag-code-graphs",
    GRAPHIFY_COMMIT: "00efd6e7969837ae4a9f11d8d504dcd3b20b09df",
    GRAPHIFY_ALLOWED_REPO_ORGS: "wcordelo",
    GRAPHIFY_DEFAULT_TEAM_ID: "T1",
    GRAPHIFY_DEFAULT_PROJECT_ID: "P1",
    GRAPHIFY_REPOSITORY_CATALOG: JSON.stringify({
      "repo-one": { cloneUrl: "https://github.com/wcordelo/opentag.git", defaultBranch: "main" },
    }),
    GRAPHIFY_SERVICE_AUTH_TOKEN: "service-token",
    GRAPHIFY_CONTAINER_AUTH_TOKEN: "container-token",
  } as never;
}

describe("Graphify private Worker boundary", () => {
  it("routes Sandbox fetches to the query application port", async () => {
    const container = new GraphQueryContainer({} as never, {} as never);
    const containerFetch = vi.fn(async () => Response.json({ ok: true }));
    container.containerFetch = containerFetch;
    await container.fetch(new Request("https://graphify/health"));
    expect(containerFetch).toHaveBeenCalledWith(expect.any(Request), 8080);
  });

  it("bootstraps missing catalog registrations from server-owned scope", async () => {
    const registryFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/repository") return new Response("not found", { status: 404 });
      if (url.pathname === "/repositories") {
        const body = await request.json() as Record<string, unknown>;
        expect(body).toMatchObject({
          repoId: "repo-one",
          teamId: "T1",
          projectId: "P1",
          cloneUrl: "https://github.com/wcordelo/opentag.git",
          defaultBranch: "main",
          enabled: true,
        });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(reconcileTrackedRepositories(graphEnv(vi.fn(), registryFetch))).resolves.toBeUndefined();
    expect(registryFetch).toHaveBeenCalledTimes(2);
  });

  it("publishes immutable artifacts with an atomic create-if-absent write", async () => {
    const value = new ArrayBuffer(5);
    new Uint8Array(value).set(new TextEncoder().encode("graph"));
    const matchingHead = vi.fn(async () => ({
      size: value.byteLength,
      customMetadata: { sha256: "digest" },
    }));
    const put = vi.fn(async (_key: string, _value: ArrayBuffer, options: Record<string, unknown>) => {
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
      return null;
    });
    await expect(putImmutableArtifact(
      { put, head: matchingHead } as never,
      "code-graphs/repo-one/0123456789012345678901234567890123456789/graph.json",
      value,
      "digest",
      "application/json",
      { repoId: "repo-one", commitSha: COMMIT },
      "artifact",
    )).resolves.toBeUndefined();
    expect(matchingHead).toHaveBeenCalledTimes(1);

    const conflictingHead = vi.fn(async () => ({
      size: value.byteLength + 1,
      customMetadata: { sha256: "other" },
    }));
    await expect(putImmutableArtifact(
      { put, head: conflictingHead } as never,
      "code-graphs/repo-one/0123456789012345678901234567890123456789/graph.json",
      value,
      "digest",
      "application/json",
      { repoId: "repo-one", commitSha: COMMIT },
      "artifact",
    )).rejects.toThrow("immutable Graphify artifact conflict");
  });

  it("probes the read-only query role for health and rejects non-GET health", async () => {
    const queryFetch = vi.fn(async () => Response.json({ status: "ok" }));
    const registryFetch = vi.fn();
    const env = graphEnv(queryFetch, registryFetch);

    const health = await graphifyWorker.fetch(new Request("https://graphify/health", {
      headers: { "x-opentag-graphify-token": "service-token" },
    }), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", storage: "r2-fuse-read-only" });
    expect(queryFetch).toHaveBeenCalledWith(expect.any(Request));

    const post = await graphifyWorker.fetch(new Request("https://graphify/health", {
      method: "POST",
      headers: { "x-opentag-graphify-token": "service-token" },
    }), env);
    expect(post.status).toBe(405);
  });

  it("binds graph queries to the registered team and project before waking the container", async () => {
    const queryFetch = vi.fn(async () => Response.json({
      teamId: "T1",
      repoId: "repo-one",
      commitSha: COMMIT,
      artifactKey: `code-graphs/repo-one/${COMMIT}`,
      results: [],
    }));
    const registryFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/repository") {
        return Response.json({
          repoId: "repo-one", teamId: "T1", projectId: "P1",
          cloneUrl: "https://github.com/wcordelo/opentag.git", defaultBranch: "main",
          enabled: true, updatedAt: 1,
        });
      }
      if (path === "/artifact") {
        return Response.json({
          repoId: "repo-one", teamId: "T1", projectId: "P1", commitSha: COMMIT,
          artifactKey: `code-graphs/repo-one/${COMMIT}`, manifest: {}, updatedAt: 1,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const env = graphEnv(queryFetch, registryFetch);
    const headers = {
      "content-type": "application/json",
      "x-opentag-graphify-token": "service-token",
    };

    const denied = await graphifyWorker.fetch(new Request("https://graphify/v1/code/graph-search", {
      method: "POST", headers,
      body: JSON.stringify({ teamId: "T2", repoId: "repo-one", projectId: "P1", query: "x" }),
    }), env);
    expect(denied.status).toBe(403);
    expect(queryFetch).not.toHaveBeenCalled();

    const allowed = await graphifyWorker.fetch(new Request("https://graphify/v1/code/graph-search", {
      method: "POST", headers,
      body: JSON.stringify({ teamId: "T1", repoId: "repo-one", projectId: "P1", query: "x" }),
    }), env);
    expect(allowed.status).toBe(200);
    expect(queryFetch).toHaveBeenCalledTimes(1);
    const forwarded = (queryFetch.mock.calls[0] as unknown as [Request])[0];
    expect(forwarded.headers.get("x-graphify-team")).toBe("T1");
  });

  it("rejects ambiguous Git ref names at the admin registration boundary", async () => {
    const env = graphEnv(vi.fn(), vi.fn());
    const response = await graphifyWorker.fetch(new Request("https://graphify/v1/repositories", {
      method: "POST",
      headers: { authorization: "Bearer admin-token" },
      body: JSON.stringify({
        repoId: "repo-one",
        teamId: "T1",
        projectId: "P1",
        cloneUrl: "https://github.com/wcordelo/opentag.git",
        defaultBranch: "../main",
        enabled: true,
      }),
    }), Object.assign({}, env, { GRAPHIFY_ADMIN_TOKEN: "admin-token" }) as never);
    expect(response.status).toBe(400);
  });

  it("resolves registration sources from the server catalog instead of caller URL fields", async () => {
    const registryFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/repositories");
      const body = await request.json() as Record<string, unknown>;
      expect(body.cloneUrl).toBe("https://github.com/wcordelo/opentag.git");
      expect(body.defaultBranch).toBe("main");
      return Response.json({ ok: true });
    });
    const env = graphEnv(vi.fn(), registryFetch);
    const response = await graphifyWorker.fetch(new Request("https://graphify/v1/repositories", {
      method: "POST",
      headers: { authorization: "Bearer admin-token" },
      body: JSON.stringify({
        repoId: "repo-one",
        teamId: "T1",
        projectId: "P1",
        // An admin caller may select the catalog key, but cannot override its
        // source with a different repository.
        cloneUrl: "https://github.com/other-org/other.git",
        enabled: true,
      }),
    }), Object.assign({}, env, { GRAPHIFY_ADMIN_TOKEN: "admin-token" }) as never);
    expect(response.status).toBe(400);
    expect(registryFetch).not.toHaveBeenCalled();

    const valid = await graphifyWorker.fetch(new Request("https://graphify/v1/repositories", {
      method: "POST",
      headers: { authorization: "Bearer admin-token" },
      body: JSON.stringify({ repoId: "repo-one", teamId: "T1", projectId: "P1", enabled: true }),
    }), Object.assign({}, env, { GRAPHIFY_ADMIN_TOKEN: "admin-token" }) as never);
    expect(valid.status).toBe(200);
    expect(registryFetch).toHaveBeenCalledTimes(1);
  });

  it("does not serve a registration after its catalog source is removed or changed", async () => {
    const queryFetch = vi.fn();
    const registryFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/repository") {
        return Response.json({
          repoId: "repo-one", teamId: "T1", projectId: "P1",
          cloneUrl: "https://github.com/wcordelo/opentag.git", defaultBranch: "main",
          enabled: true, revision: 1, updatedAt: 1,
        });
      }
      if (path === "/artifact") {
        return Response.json({
          repoId: "repo-one", teamId: "T1", projectId: "P1", commitSha: COMMIT,
          artifactKey: `code-graphs/repo-one/${COMMIT}`, manifest: {}, updatedAt: 1,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const env = Object.assign({}, graphEnv(queryFetch, registryFetch), {
      GRAPHIFY_REPOSITORY_CATALOG: JSON.stringify({
        "repo-one": {
          cloneUrl: "https://github.com/wcordelo/graphify.git",
          defaultBranch: "main",
        },
      }),
    }) as never;
    const response = await graphifyWorker.fetch(new Request("https://graphify/v1/code/graph-search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opentag-graphify-token": "service-token",
      },
      body: JSON.stringify({ teamId: "T1", repoId: "repo-one", projectId: "P1", query: "x" }),
    }), env);
    expect(response.status).toBe(404);
    expect(queryFetch).not.toHaveBeenCalled();
  });

  it("enforces the query body limit even when content-length is absent", async () => {
    const queryFetch = vi.fn();
    const registryFetch = vi.fn();
    const env = graphEnv(queryFetch, registryFetch);
    const response = await graphifyWorker.fetch(new Request("https://graphify/v1/code/graph-search", {
      method: "POST",
      headers: { "x-opentag-graphify-token": "service-token" },
      body: JSON.stringify({
        teamId: "T1",
        repoId: "repo-one",
        projectId: "P1",
        query: "x".repeat(1_100_000),
      }),
    }), env);
    expect(response.status).toBe(400);
    expect(registryFetch).not.toHaveBeenCalled();
    expect(queryFetch).not.toHaveBeenCalled();
  });
});
