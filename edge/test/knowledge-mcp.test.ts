import { describe, expect, it, vi } from "vitest";
import { handleKnowledgeMcp, KNOWLEDGE_MCP_TOOLS } from "../src/mcp/knowledge-mcp.js";
import { mintKnowledgeActorToken } from "../src/mcp/knowledge-actor-token.js";
import type { Env } from "../src/env.js";

function env(partial: Partial<Env> = {}): Env {
  return {
    BOT_STATE: {} as Env["BOT_STATE"],
    WORKSPACE_CONFIG: {} as Env["WORKSPACE_CONFIG"],
    KNOWLEDGE: {} as Env["KNOWLEDGE"],
    SESSION_EVENTS: {} as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    AGENT_URL: "https://agent.example",
    ADMIN_SECRET: "admin-secret",
    ...partial,
  };
}

describe("knowledge MCP", () => {
  it("lists retrieval tools", () => {
    expect(KNOWLEDGE_MCP_TOOLS).toContain("search_slack");
    expect(KNOWLEDGE_MCP_TOOLS).toContain("search");
    expect(KNOWLEDGE_MCP_TOOLS).toEqual(expect.arrayContaining([
      "code_graph_search",
      "code_path",
      "code_impact",
    ]));
  });

  it("routes an operator code-graph request through the private Graphify binding", async () => {
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://graphify.internal/v1/code/graph-search");
      expect(request.headers.get("x-opentag-graphify-token")).toBe("graph-service-token");
      return Response.json({
        teamId: "T1",
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        artifactKey: "code-graphs/repo-one/0123456789012345678901234567890123456789",
        results: [{ id: "node-1", label: "searchCode", sourceFile: "src/search.ts", sourceLocation: "L42" }],
      });
    };
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({
          tool: "code_graph_search",
          teamId: "T1",
          projectId: "P1",
          repoId: "repo-one",
          query: "search",
          aclPolicyRef: "bundle:code",
        }),
      }),
      env({
        GRAPHIFY: { fetch } as never,
        GRAPHIFY_SERVICE_AUTH_TOKEN: "graph-service-token",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      citations: [expect.objectContaining({
        repoId: "repo-one",
        commitSha: "0123456789012345678901234567890123456789",
        startLine: 42,
        endLine: 42,
      })],
    });
  });

  it("records a durable convergence receipt for an operator Slack search", async () => {
    const calls: string[] = [];
    const sourceKey = "slack:T1:C1:1_0";
    const knowledge = {
      idFromName: () => "T1",
      get: () => ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          calls.push(path);
          if (path === "/mcp-audit") return Response.json({ recorded: true });
          if (path === "/state") {
            return Response.json({ ledger: {
              sourceType: "slack",
              teamId: "T1",
              projectId: "P1",
              channelId: "C1",
              threadTs: "1.0",
              status: "indexed",
              indexedRevision: "sha256:one",
              localDocumentId: "doc-1",
              derivedIndexGeneration: "cloudflare-r2-v1",
            } });
          }
          if (path === "/query-convergence") {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            expect(body).toMatchObject({
              sourceKey,
              contentRevision: "sha256:one",
              indexGeneration: "cloudflare-r2-v1",
              localDocumentId: "doc-1",
              status: "queryable",
              providerResultCount: 1,
              matchingCitationCount: 1,
            });
            expect(body).not.toHaveProperty("query");
            expect(body.queryDigest).toEqual(expect.stringMatching(/^sha256:[0-9a-f]{64}$/));
            return Response.json({ recorded: true });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      }),
    } as unknown as Env["KNOWLEDGE"];
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({
          tool: "search_slack",
          teamId: "T1",
          projectId: "P1",
          channelId: "C1",
          query: "fixture",
          limit: 1,
          aclPolicyRef: "bundle:readers",
        }),
      }),
      env({
        KNOWLEDGE: knowledge,
        SUPERMEMORY: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            expect(new URL(request.url).pathname).toBe("/v4/search");
            const body = JSON.parse(await request.text()) as Record<string, unknown>;
            expect(body).toMatchObject({ q: "fixture", containerTag: "workspace:T1", limit: 1 });
            return Response.json({
              results: [{
                id: "provider-result-1",
                similarity: 0.9,
                chunk: "fixture excerpt",
                metadata: {
                  schemaVersion: 1,
                  workspaceId: "T1",
                  projectId: "P1",
                  channelId: "C1",
                  threadTs: "1.0",
                  sourceKey,
                  contentRevision: "sha256:one",
                  aclPolicyRef: "bundle:readers",
                  status: "active",
                },
              }],
              timing: 1,
              total: 1,
            });
          },
        } as never,
        SUPERMEMORY_SERVICE_AUTH_TOKEN: "service-token",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", citations: [expect.any(Object)] });
    expect(calls).toEqual(["/mcp-audit", "/state", "/query-convergence", "/mcp-audit"]);
  });

  it("requires a current access-bundle repository grant for actor Graphify calls", async () => {
    const graphifyFetch = vi.fn();
    const actorToken = await mintKnowledgeActorToken("actor-secret", {
      jti: "graph-acl-jti",
      teamId: "T1",
      projectId: "P1",
      actor: { kind: "slack_user", id: "U1" },
      aclPolicyRef: "bundle:code",
      scopes: { channelIds: ["C1"], spaceIds: [], repoIds: ["repo-one"], connectorIds: [] },
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 120,
    });
    const workspace = {
      idFromName: () => "T1",
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          if (path === "/getTrackedKnowledgeSource") {
            return Response.json({
              teamId: "T1", projectId: "P1", channelId: "C1", enabled: true,
              readerPolicyRef: "bundle:code",
            });
          }
          if (path === "/getConfig") {
            return Response.json({ teamId: "T1", channelId: "C1", accessBundleId: "bundle-code" });
          }
          if (path === "/getBundle") {
            return Response.json({
              id: "bundle-code", tools: ["code_graph_search"], mcpEndpoints: [], secretRefs: [],
              connectorGrants: [], status: "active", revision: 1,
            });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      }),
    } as unknown as Env["WORKSPACE_CONFIG"];
    const knowledge = {
      idFromName: () => "T1",
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          if (path === "/actor-token/consume") return Response.json({ accepted: true });
          if (path === "/mcp-audit") return Response.json({ recorded: true });
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      }),
    } as unknown as Env["KNOWLEDGE"];
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { "x-opentag-knowledge-actor-token": actorToken, "content-type": "application/json" },
        body: JSON.stringify({
          tool: "code_graph_search",
          teamId: "T1",
          projectId: "P1",
          repoId: "repo-one",
          query: "search",
          channelId: "C1",
          aclPolicyRef: "bundle:code",
        }),
      }),
      env({
        KNOWLEDGE_ACTOR_TOKEN_SECRET: "actor-secret",
        WORKSPACE_CONFIG: workspace,
        KNOWLEDGE: knowledge,
        GRAPHIFY: { fetch: graphifyFetch } as never,
        GRAPHIFY_SERVICE_AUTH_TOKEN: "graph-token",
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
    expect(graphifyFetch).not.toHaveBeenCalled();
  });

  it("rejects missing bearer", async () => {
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      env(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects caller-controlled tags", async () => {
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({
          tool: "search_slack",
          teamId: "T1",
          projectId: "P1",
          query: "hi",
          aclPolicyRef: "bundle:default",
          channelId: "C1",
          containerTag: "workspace:OTHER",
        }),
      }),
      env({ SUPERMEMORY_URL: "https://sm.example", SUPERMEMORY_API_KEY: "sm_x", SUPERMEMORY_MIGRATION_MODE: "true" }),
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { code?: string };
    expect(body.code).toBe("forbidden_addressing");
  });

  it("routes a named raw query template without requiring Supermemory", async () => {
    const fetch = async () => Response.json({
      schemaVersion: 1,
      template: "source_state",
      rows: [],
    });
    const knowledge = {
      idFromName: () => "T1",
      get: () => ({ fetch }),
    } as unknown as Env["KNOWLEDGE"];
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({
          tool: "query_template",
          teamId: "T1",
          aclPolicyRef: "admin-template",
          template: "source_state",
          sourceKey: "slack:T1:C1:123",
        }),
      }),
      env({ KNOWLEDGE: knowledge }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", template: "source_state" });
  });

  it("does not elevate an actor token into the operator-only query-template path", async () => {
    const actorToken = await mintKnowledgeActorToken("actor-secret", {
      jti: "query-template-actor-jti",
      teamId: "T1",
      projectId: "P1",
      actor: { kind: "slack_user", id: "U1" },
      aclPolicyRef: "admin-template",
      scopes: { channelIds: [], spaceIds: [], repoIds: [], connectorIds: [] },
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 120,
    });
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { ["x-opentag-knowledge-actor-token"]: actorToken, "content-type": "application/json" },
        body: JSON.stringify({
          tool: "query_template",
          teamId: "T1",
          aclPolicyRef: "admin-template",
          template: "source_state",
          sourceKey: "slack:T1:C1:123",
        }),
      }),
      env({ KNOWLEDGE_ACTOR_TOKEN_SECRET: "actor-secret" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects wrong-typed named-template fields instead of dropping them", async () => {
    const fetch = async () => Response.json({
      schemaVersion: 1,
      template: "source_state",
      rows: [],
    });
    const knowledge = {
      idFromName: () => "T1",
      get: () => ({ fetch }),
    } as unknown as Env["KNOWLEDGE"];
    const malformedFields = [
      { schemaVersion: "1" },
      { limit: "5" },
      { channelId: 7 },
    ];

    for (const fields of malformedFields) {
      const response = await handleKnowledgeMcp(
        new Request("https://bot.example/mcp/knowledge", {
          method: "POST",
          headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
          body: JSON.stringify({
            tool: "query_template",
            teamId: "T1",
            aclPolicyRef: "admin-template",
            template: "source_state",
            sourceKey: "slack:T1:C1:123",
            ...fields,
          }),
        }),
        env({ KNOWLEDGE: knowledge }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: "error", code: "invalid_request" });
    }
  });

  it("accepts a scoped actor token through the internal header and consumes it", async () => {
    const calls: string[] = [];
    const stub = {
      fetch: async (url: string) => {
        calls.push(url);
        if (url.endsWith("/getTrackedKnowledgeSource")) {
          return Response.json({
            teamId: "T1",
            projectId: "P1",
            channelId: "C1",
            enabled: true,
            readerPolicyRef: "bundle:default",
          });
        }
        if (url.endsWith("/getConfig")) {
          return Response.json({
            teamId: "T1",
            channelId: "C1",
            policies: {},
            accessBundleId: "default",
            updatedAt: "2026-08-01T00:00:00.000Z",
          });
        }
        if (url.endsWith("/getBundle")) {
          return Response.json({
            id: "default",
            tools: ["search_slack"],
            mcpEndpoints: [],
            secretRefs: [],
            connectorGrants: [],
            status: "active",
            revision: 1,
          });
        }
        if (url.endsWith("/acl/authorize")) {
          return Response.json({ authorized: true, leaseId: "lease-1", revision: 1 });
        }
        if (url.endsWith("/acl/check")) return Response.json({ authorized: true });
        if (url.endsWith("/acl/release")) return Response.json({ released: true });
        return Response.json({ accepted: true, recorded: true });
      },
    };
    const actorToken = await mintKnowledgeActorToken("actor-secret", {
      jti: "jti-1",
      teamId: "T1",
      projectId: "P1",
      actor: { kind: "slack_user", id: "U1" },
      aclPolicyRef: "bundle:default",
      scopes: { channelIds: ["C1"], spaceIds: [], repoIds: [], connectorIds: [] },
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 120,
    });
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { "x-opentag-knowledge-actor-token": actorToken, "content-type": "application/json" },
        body: JSON.stringify({
          tool: "search_slack",
          teamId: "T1",
          projectId: "P1",
          query: "hello",
          aclPolicyRef: "bundle:default",
          channelId: "C1",
        }),
      }),
      env({
        KNOWLEDGE_ACTOR_TOKEN_SECRET: "actor-secret",
        WORKSPACE_CONFIG: {
          idFromName: () => "T1",
          get: () => stub,
        } as unknown as Env["WORKSPACE_CONFIG"],
        KNOWLEDGE: {
          idFromName: () => "T1",
          get: () => stub,
        } as unknown as Env["KNOWLEDGE"],
      }),
    );
    expect(response.status).toBe(503);
    expect(calls).toEqual([
      "https://do/getConfig",
      "https://do/getBundle",
      "https://do/getTrackedKnowledgeSource",
      "https://do/acl/authorize",
      "https://do/acl/check",
      "https://do/acl/release",
      "https://do/actor-token/consume",
      "https://do/mcp-audit",
      "https://do/mcp-audit",
    ]);
  });

  it("does not consume an actor token outside its resource scope", async () => {
    const stub = { fetch: async () => Response.json({ accepted: true }) };
    const actorToken = await mintKnowledgeActorToken("actor-secret", {
      jti: "jti-2",
      teamId: "T1",
      projectId: "P1",
      actor: { kind: "slack_user", id: "U1" },
      aclPolicyRef: "bundle:default",
      scopes: { channelIds: ["C1"], spaceIds: [], repoIds: [], connectorIds: [] },
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 120,
    });
    const response = await handleKnowledgeMcp(
      new Request("https://bot.example/mcp/knowledge", {
        method: "POST",
        headers: { "x-opentag-knowledge-actor-token": actorToken, "content-type": "application/json" },
        body: JSON.stringify({
          tool: "search_slack",
          teamId: "T1",
          projectId: "P1",
          query: "hello",
          aclPolicyRef: "bundle:default",
          channelId: "C2",
        }),
      }),
      env({
        KNOWLEDGE_ACTOR_TOKEN_SECRET: "actor-secret",
        WORKSPACE_CONFIG: {
          idFromName: () => "T1",
          get: () => stub,
        } as unknown as Env["WORKSPACE_CONFIG"],
        KNOWLEDGE: { idFromName: () => "T1", get: () => stub } as unknown as Env["KNOWLEDGE"],
      }),
    );
    expect(response.status).toBe(401);
  });
});
