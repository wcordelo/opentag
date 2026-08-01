import { describe, expect, it } from "vitest";
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
      env({ SUPERMEMORY_URL: "https://sm.example", SUPERMEMORY_API_KEY: "sm_x" }),
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { code?: string };
    expect(body.code).toBe("forbidden_addressing");
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
      "https://do/getTrackedKnowledgeSource",
      "https://do/mcp-audit",
      "https://do/actor-token/consume",
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
