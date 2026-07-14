/**
 * Phase A3 (GOAL.md / SPEC §5 Phase A3): `StartTaskRequest.model` forwarding.
 * The orchestrator may ignore `model` today; this test locks the contract
 * that the field is threaded through to the POST /research body so the
 * Phase A5 container can pick it up later.
 */
import { describe, expect, it } from "vitest";
import { startTask } from "../src/tasks/runtime.js";

describe("TaskRuntime model override forwarding", () => {
  it("includes model in the /research POST body when provided", async () => {
    let sawBody: Record<string, unknown> | undefined;
    await startTask(
      {
        RESEARCH_TASKS: {
          fetch: async (_url: RequestInfo, init?: RequestInit) => {
            sawBody = JSON.parse(String(init?.body ?? "{}"));
            return Response.json({ taskId: "t1" });
          },
        } as unknown as Fetcher,
      },
      {
        type: "research",
        teamId: "T1",
        threadKey: "slack:C1:1.0",
        channelId: "C1",
        payload: { objective: "x" },
        model: "claude-opus-4-8",
      },
    );
    expect(sawBody?.model).toBe("claude-opus-4-8");
  });

  it("omits model as undefined when not provided (callers unchanged)", async () => {
    let sawBody: Record<string, unknown> | undefined;
    await startTask(
      {
        RESEARCH_TASKS: {
          fetch: async (_url: RequestInfo, init?: RequestInit) => {
            sawBody = JSON.parse(String(init?.body ?? "{}"));
            return Response.json({ taskId: "t1" });
          },
        } as unknown as Fetcher,
      },
      {
        type: "research",
        teamId: "T1",
        threadKey: "slack:C1:1.0",
        channelId: "C1",
        payload: { objective: "x" },
      },
    );
    expect(sawBody?.model).toBeUndefined();
    expect("model" in (sawBody ?? {})).toBe(false);
  });
});
