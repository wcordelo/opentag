import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const FIRST_COMMIT = "1111111111111111111111111111111111111111";
const SECOND_COMMIT = "2222222222222222222222222222222222222222";
const THIRD_COMMIT = "3333333333333333333333333333333333333333";

function endpoint(path: string, registryName: string): string {
  const url = new URL(`https://graphify-test${path}`);
  url.searchParams.set("name", registryName);
  return url.toString();
}

async function addRepository(registryName: string, repoId = "repo-one"): Promise<Response> {
  return SELF.fetch(endpoint("/repositories", registryName), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoId,
      teamId: "team-one",
      projectId: "project-one",
      cloneUrl: "https://github.com/wcordelo/opentag.git",
      defaultBranch: "main",
      enabled: true,
    }),
  });
}

async function activate(
  registryName: string,
  commitSha: string,
  expectedPreviousCommitSha: string | null,
  repoId = "repo-one",
  expectedRepositoryRevision?: number,
): Promise<Response> {
  const repository = await SELF.fetch(endpoint(`/repository?repoId=${encodeURIComponent(repoId)}`, registryName));
  const repositoryBody = await repository.json() as { revision?: unknown };
  const repositoryRevision = expectedRepositoryRevision ?? repositoryBody.revision;
  return SELF.fetch(endpoint("/activate", registryName), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoId,
      commitSha,
      artifactKey: `code-graphs/${repoId}/${commitSha}`,
      expectedPreviousCommitSha,
      expectedRepositoryRevision: repositoryRevision,
      manifest: { repoId, commitSha, graphifyCommit: "00efd6e7969837ae4a9f11d8d504dcd3b20b09df" },
    }),
  });
}

describe("Graphify registry Durable Object", () => {
  it("rejects traversal-shaped default branches at the authoritative registry boundary", async () => {
    const registryName = `branch-${crypto.randomUUID()}`;
    const response = await SELF.fetch(endpoint("/repositories", registryName), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "repo-one",
        teamId: "team-one",
        projectId: "project-one",
        cloneUrl: "https://github.com/wcordelo/opentag.git",
        defaultBranch: "../main",
        enabled: true,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("activates the first artifact and rejects stale compare-and-swap publishers", async () => {
    const registryName = `cas-${crypto.randomUUID()}`;
    expect((await addRepository(registryName)).status).toBe(200);

    expect((await activate(registryName, FIRST_COMMIT, null)).status).toBe(200);
    const stale = await activate(registryName, THIRD_COMMIT, SECOND_COMMIT);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_activation", currentCommit: FIRST_COMMIT });

    const current = await SELF.fetch(endpoint("/artifact?repoId=repo-one", registryName));
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      repoId: "repo-one",
      teamId: "team-one",
      projectId: "project-one",
      commitSha: FIRST_COMMIT,
      artifactKey: `code-graphs/repo-one/${FIRST_COMMIT}`,
    });
  });

  it("allows an exact next revision only when its predecessor is still active", async () => {
    const registryName = `advance-${crypto.randomUUID()}`;
    expect((await addRepository(registryName)).status).toBe(200);
    expect((await activate(registryName, FIRST_COMMIT, null)).status).toBe(200);
    expect((await activate(registryName, SECOND_COMMIT, FIRST_COMMIT)).status).toBe(200);
    expect((await activate(registryName, FIRST_COMMIT, null)).status).toBe(409);
  });

  it("invalidates the active pointer when the tracked repository identity changes", async () => {
    const registryName = `identity-${crypto.randomUUID()}`;
    expect((await addRepository(registryName)).status).toBe(200);
    expect((await activate(registryName, FIRST_COMMIT, null)).status).toBe(200);

    const updated = await SELF.fetch(endpoint("/repositories", registryName), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "repo-one",
        teamId: "team-one",
        projectId: "project-one",
        cloneUrl: "https://github.com/wcordelo/graphify.git",
        defaultBranch: "main",
        enabled: true,
      }),
    });
    expect(updated.status).toBe(200);

    const current = await SELF.fetch(endpoint("/artifact?repoId=repo-one", registryName));
    expect(current.status).toBe(404);
  });

  it("rejects an old build after repository registration changes", async () => {
    const registryName = `repo-cas-${crypto.randomUUID()}`;
    expect((await addRepository(registryName)).status).toBe(200);
    const repository = await SELF.fetch(endpoint("/repository?repoId=repo-one", registryName));
    const before = await repository.json() as { revision: number };

    const updated = await SELF.fetch(endpoint("/repositories", registryName), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "repo-one",
        teamId: "team-one",
        projectId: "project-one",
        cloneUrl: "https://github.com/wcordelo/graphify.git",
        defaultBranch: "main",
        enabled: true,
      }),
    });
    expect(updated.status).toBe(200);

    const stale = await activate(registryName, FIRST_COMMIT, null, "repo-one", before.revision);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_repository" });
  });
});
