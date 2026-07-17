import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
import worker from "../src/worker.js";
import type { Env } from "../src/env.js";

function env(): Env {
  const stub = {
    fetch: async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/getConfig") {
        return Response.json({
          teamId: "T1",
          channelId: "C1",
          systemPrompt: "sys",
          policies: { allowMemoryWrite: false, allowTasks: false },
          accessBundleId: "restricted",
          runtimeDefaults: {
            harnessType: "claudecode",
            model: "claude-sonnet-5",
          },
          updatedAt: "now",
        });
      }
      return Response.json({
        id: "restricted",
        tools: ["show_status", "memory_write", "start_task"],
        mcpEndpoints: [
          "https://user:pass@example.com/mcp?token=secret#fragment",
        ],
        secretRefs: ["EXAMPLE_TOKEN"],
      });
    },
  };
  return {
    BOT_STATE: {} as Env["BOT_STATE"],
    WORKSPACE_CONFIG: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as Env["WORKSPACE_CONFIG"],
    KNOWLEDGE: {} as Env["KNOWLEDGE"],
    SESSION_EVENTS: {} as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    AGENT_URL: "https://agent",
    ENVIRONMENT: "production",
    ADMIN_SECRET: "admin-secret",
  };
}

describe("GET /admin/permissions", () => {
  it("requires admin auth, rejects invalid ids, and returns no-store redacted data", async () => {
    const missing = await worker.fetch(
      new Request("https://worker/admin/permissions?teamId=T1&channelId=C1"),
      env(),
    );
    expect(missing.status).toBe(401);

    const invalid = await worker.fetch(
      new Request("https://worker/admin/permissions?teamId=T1", {
        headers: { Authorization: "Bearer admin-secret" },
      }),
      env(),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");

    const response = await worker.fetch(
      new Request("https://worker/admin/permissions?teamId=T1&channelId=C1", {
        headers: { Authorization: "Bearer admin-secret" },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as {
      scope: { actorKind: string };
      channelAccess: {
        allowedTools: string[];
        deniedTools: string[];
        mcpEndpoints: Array<{ origin: string; path: string }>;
      };
    };
    expect(body.scope.actorKind).toBe("operator");
    expect(body.channelAccess.allowedTools).toEqual([
      "show_permissions",
      "show_status",
    ]);
    expect(body.channelAccess.deniedTools).toContain("memory_write");
    expect(body.channelAccess.mcpEndpoints).toEqual([
      { origin: "https://example.com", path: "/mcp" },
    ]);
    expect(JSON.stringify(body)).not.toContain("user:pass");
    expect(JSON.stringify(body)).not.toContain("token=secret");
  });
});
