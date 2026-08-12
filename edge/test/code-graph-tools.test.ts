import { describe, expect, it, vi } from "vitest";
import type { AccessBundle, WorkspaceChannelConfig } from "../src/config/access-bundle.js";
import type { Env } from "../src/env.js";
import { buildPermissionSnapshot } from "../src/permissions/snapshot.js";
import { bindPermissionSnapshot } from "../src/permissions/context.js";
import { bindRequestContext } from "../src/request-context.js";
import { bindTurnExecutionContext } from "../src/slack/turn-execution-context.js";
import { createCodeGraphSearchTool } from "../src/tools/code-graph.js";

function threadWithGrant(grant: boolean, repositoryId: string | null = grant ? "repo-one" : null): object {
  const thread = { conversationKey: "C1::1.0" };
  const config: WorkspaceChannelConfig = {
    teamId: "T1",
    channelId: "C1",
    policies: {},
    accessBundleId: "code-readers",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const bundle: AccessBundle = {
    id: "code-readers",
    tools: ["code_graph_search"],
    mcpEndpoints: [],
    secretRefs: [],
    connectorGrants: grant
      ? [{
          connectorId: "code_graph",
          actions: ["code_graph_search"],
          scope: "project",
          projectId: "P1",
          ...(repositoryId ? { repoId: repositoryId } : {}),
        }]
      : [],
  };
  bindRequestContext(thread, { teamId: "T1", requesterId: "U1" });
  bindPermissionSnapshot(thread, buildPermissionSnapshot({
    teamId: "T1",
    channelId: "C1",
    conversationKey: "C1::1.0",
    executionId: "exec-graph",
    actor: { kind: "slack_user", userId: "U1" },
    config,
    bundle,
    allToolNames: ["code_graph_search"],
    allowedTools: ["code_graph_search"],
    runtime: { harnessConnected: false },
  }));
  bindTurnExecutionContext(thread, { threadKey: "slack:C1:1.0", executionId: "exec-graph" });
  return thread;
}

function graphEnv(fetch: ReturnType<typeof vi.fn>): Env {
  const workspaceConfig = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/getConfig") {
          return Response.json({
            teamId: "T1",
            channelId: "C1",
            accessBundleId: "code-readers",
          });
        }
        if (path === "/getBundle") {
          return Response.json({
            id: "code-readers",
            revision: 1,
            status: "active",
            tools: ["code_graph_search"],
            mcpEndpoints: [],
            secretRefs: [],
            connectorGrants: [{
              connectorId: "code_graph",
              actions: ["code_graph_search"],
              scope: "project",
              projectId: "P1",
              repoId: "repo-one",
            }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    }),
  } as never;
  return {
    BOT_STATE: {} as Env["BOT_STATE"],
    WORKSPACE_CONFIG: workspaceConfig,
    KNOWLEDGE: {} as Env["KNOWLEDGE"],
    SESSION_EVENTS: {} as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    AGENT_URL: "https://agent.example",
    GRAPHIFY: { fetch } as never,
    GRAPHIFY_SERVICE_AUTH_TOKEN: "graph-service-token",
  };
}

describe("Graphify tool authorization", () => {
  it("requires an explicit code_graph repository grant before the binding call", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const tool = createCodeGraphSearchTool({
      env: () => graphEnv(fetch),
      channel: () => "C1",
      assertActive: async () => undefined,
    });
    const denied = await tool.handler(
      { query: "search", repoId: "repo-one", projectId: "P1" },
      { thread: threadWithGrant(false) } as never,
    );
    expect(denied).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
    expect(fetch).not.toHaveBeenCalled();

    const unboundRepository = await tool.handler(
      { query: "search", repoId: "repo-one", projectId: "P1" },
      { thread: threadWithGrant(true, null) } as never,
    );
    expect(unboundRepository).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });

    fetch.mockResolvedValueOnce(Response.json({
      teamId: "T1",
      repoId: "repo-one",
      commitSha: "0123456789012345678901234567890123456789",
      artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
      results: [],
    }));
    const allowed = await tool.handler(
      { query: "search", repoId: "repo-one", projectId: "P1" },
      { thread: threadWithGrant(true) } as never,
    );
    expect(allowed).toMatchObject({ status: "ok", citations: [] });
    expect(fetch).toHaveBeenCalledWith(
      "https://graphify.internal/v1/code/graph-search",
      expect.objectContaining({ headers: expect.objectContaining({ "x-opentag-graphify-token": "graph-service-token" }) }),
    );

    const wrongRepository = await tool.handler(
      { query: "search", repoId: "another-repo", projectId: "P1" },
      { thread: threadWithGrant(true) } as never,
    );
    expect(wrongRepository).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a missing Graphify binding as a non-retryable configuration result", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const env = graphEnv(fetch);
    env.GRAPHIFY = undefined;
    const tool = createCodeGraphSearchTool({
      env: () => env,
      channel: () => "C1",
      assertActive: async () => undefined,
    });

    await expect(tool.handler(
      { query: "search", repoId: "repo-one", projectId: "P1" },
      { thread: threadWithGrant(true) } as never,
    )).resolves.toEqual({
      status: "knowledge_unavailable",
      citations: [],
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
