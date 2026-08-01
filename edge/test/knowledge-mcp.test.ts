import { describe, expect, it } from "vitest";
import { handleKnowledgeMcp, KNOWLEDGE_MCP_TOOLS } from "../src/mcp/knowledge-mcp.js";
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
});
