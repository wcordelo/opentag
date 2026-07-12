/**
 * Research TaskRuntime → RESEARCH_TASKS delivery path (mocked binding).
 */
import { describe, expect, it } from "vitest";
import { startTask } from "../src/tasks/runtime.js";

describe("research TaskRuntime E2E (mocked RESEARCH_TASKS)", () => {
  it("forwards objective and returns orchestrator taskId", async () => {
    let seenBody: unknown;
    let seenAuth: string | null = null;

    const result = await startTask(
      {
        RESEARCH_TASKS: {
          fetch: async (_url: RequestInfo, init?: RequestInit) => {
            const h = new Headers(init?.headers);
            seenAuth = h.get("Authorization");
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            return Response.json({ taskId: "task_e2e_1", status: "accepted" });
          },
        } as unknown as Fetcher,
        INTERNAL_SECRET: "internal-sekrit",
      },
      {
        type: "research",
        teamId: "T_E2E",
        threadKey: "slack:C_E2E:1234.5678",
        channelId: "C_E2E",
        threadTs: "1234.5678",
        payload: { objective: "Summarize Durable Objects for agents" },
      },
    );

    expect(result.status).toBe("forwarded");
    expect(result.taskId).toBe("task_e2e_1");
    expect(seenAuth).toBe("Bearer internal-sekrit");
    expect(seenBody).toMatchObject({
      teamId: "T_E2E",
      threadKey: "slack:C_E2E:1234.5678",
      channelId: "C_E2E",
      objective: "Summarize Durable Objects for agents",
    });
  });

  it("surfaces orchestrator HTTP errors", async () => {
    const result = await startTask(
      {
        RESEARCH_TASKS: {
          fetch: async () =>
            new Response("boom", { status: 503, statusText: "Unavailable" }),
        } as unknown as Fetcher,
      },
      {
        type: "research",
        teamId: "T1",
        threadKey: "slack:C1:1",
        channelId: "C1",
        payload: { objective: "x" },
      },
    );
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/503/);
  });
});
