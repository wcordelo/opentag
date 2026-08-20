import { describe, expect, it, vi } from "vitest";
import { GraphifyAdapter } from "../src/memory/graphify-adapter.js";
import { createGraphifyClient, GraphifyClientError } from "../src/memory/graphify-client.js";
import type { GraphifyClient } from "../src/memory/graphify-client.js";

describe("Graphify citation adapter", () => {
  it("preserves the pinned revision and treats a point location as a one-line range", async () => {
    const fake = {
      search: async () => ({
        teamId: "team-one",
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
        results: [{ id: "node-1", label: "searchCode", sourceFile: "src/search.ts", sourceLocation: "L42", score: 0.9, confidence: 0.8 }],
      }),
    } as unknown as GraphifyClient;
    const [citation] = await new GraphifyAdapter(fake).search({
      teamId: "team-one",
      repoId: "repo-one",
      projectId: "project-one",
      aclPolicyRef: "bundle:code",
      query: "search",
      limit: 5,
    });
    expect(citation).toMatchObject({
      sourceType: "code_graph",
      repoId: "repo-one",
      commitSha: "0123456789012345678901234567890123456789",
      path: "src/search.ts",
      startLine: 42,
      endLine: 42,
      artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
      contentRevision: "graph:0123456789012345678901234567890123456789",
    });
  });

  it("rejects a response that does not carry an exact commit-keyed artifact", async () => {
    const client = createGraphifyClient({
      GRAPHIFY: {
        fetch: async () => Response.json({
          teamId: "team-one",
          repoId: "repo-one",
          commitSha: "not-a-commit",
          artifactKey: "code-graphs/repo-one/not-a-commit",
          results: [],
        }),
      },
      GRAPHIFY_SERVICE_AUTH_TOKEN: "graph-service-token",
    });
    await expect(client!.search({
      teamId: "team-one",
      repoId: "repo-one",
      projectId: "project-one",
      query: "search",
      limit: 1,
    })).rejects.toMatchObject({
      name: "GraphifyClientError",
      status: 502,
      retryable: false,
    } satisfies Partial<GraphifyClientError>);
  });

  it("rejects a response whose artifact key is not bound to its returned repository and commit", async () => {
    const fetch = vi.fn(async () => Response.json({
        teamId: "T1",
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        artifactKey: "code-graphs/other-repo/0123456789012345678901234567890123456789",
        results: [],
      }));
    const client = createGraphifyClient({
      GRAPHIFY: { fetch },
      GRAPHIFY_SERVICE_AUTH_TOKEN: "token",
    });
    await expect(client?.search({
      teamId: "T1", repoId: "repo-one", projectId: "P1", query: "x", limit: 5,
    })).rejects.toMatchObject({
      name: "GraphifyClientError",
      retryable: false,
    });
  });

  it("rejects a response scoped to a different repository or team", async () => {
    const fetch = vi.fn(async () => Response.json({
      teamId: "T2",
      repoId: "repo-two",
      commitSha: "0123456789012345678901234567890123456789",
      artifactKey: "code-graphs/repo-two/0123456789012345678901234567890123456789",
      results: [],
    }));
    const client = createGraphifyClient({
      GRAPHIFY: { fetch },
      GRAPHIFY_SERVICE_AUTH_TOKEN: "token",
    });
    await expect(client?.search({
      teamId: "T1", repoId: "repo-one", projectId: "P1", query: "x", limit: 5,
    })).rejects.toMatchObject({
      name: "GraphifyClientError",
      retryable: false,
    });
  });

  it("carries qualitative edge confidence into path citations", async () => {
    const fake = {
      path: async () => ({
        teamId: "team-one",
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
        nodes: [
          { id: "node-0", label: "source", sourceFile: "src/source.ts", sourceLocation: "L1" },
          { id: "node-1", label: "target", sourceFile: "src/target.ts", sourceLocation: "L42" },
        ],
        edges: [{ source: "node-0", target: "node-1", relation: "calls", confidenceLabel: "EXTRACTED" }],
      }),
    } as unknown as GraphifyClient;
    const citations = await new GraphifyAdapter(fake).path({
      teamId: "team-one",
      repoId: "repo-one",
      projectId: "project-one",
      aclPolicyRef: "bundle:code",
      source: "node-0",
      target: "node-1",
      maxHops: 2,
    });
    expect(citations[1]).toMatchObject({ relation: "calls", confidenceLabel: "EXTRACTED" });
  });

  it("binds each path citation to the edge immediately preceding that node", async () => {
    const fake = {
      path: async () => ({
        teamId: "team-one",
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
        nodes: [
          { id: "source", label: "source", sourceFile: "src/source.ts", sourceLocation: "L1" },
          { id: "middle", label: "middle", sourceFile: "src/middle.ts", sourceLocation: "L2" },
          { id: "target", label: "target", sourceFile: "src/target.ts", sourceLocation: "L3" },
        ],
        edges: [
          { source: "source", target: "middle", relation: "imports", confidenceLabel: "EXTRACTED" },
          { source: "middle", target: "target", relation: "calls", confidenceLabel: "INFERRED" },
        ],
      }),
    } as unknown as GraphifyClient;
    const citations = await new GraphifyAdapter(fake).path({
      teamId: "team-one",
      repoId: "repo-one",
      projectId: "project-one",
      aclPolicyRef: "bundle:code",
      source: "source",
      target: "target",
      maxHops: 3,
    });
    expect(citations[1]).toMatchObject({ relation: "imports", confidenceLabel: "EXTRACTED" });
    expect(citations[2]).toMatchObject({ relation: "calls", confidenceLabel: "INFERRED" });
  });

  it("does not turn untrusted path or location text into filesystem or line citations", async () => {
    const fake = {
      search: async () => ({
        teamId: "team-one",
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
        results: [{ id: "node-1", label: "unsafe", sourceFile: "../secret.ts", sourceLocation: "secret:99" }],
      }),
    } as unknown as GraphifyClient;
    const [citation] = await new GraphifyAdapter(fake).search({
      teamId: "team-one",
      repoId: "repo-one",
      projectId: "project-one",
      aclPolicyRef: "bundle:code",
      query: "unsafe",
      limit: 1,
    });
    expect(citation).not.toHaveProperty("path");
    expect(citation).not.toHaveProperty("startLine");
    expect(citation).not.toHaveProperty("endLine");
  });
});
