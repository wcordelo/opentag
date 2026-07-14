import { describe, expect, it, vi } from "vitest";
import worker from "../workers/orchestrator/src/index.js";

describe("research cancellation route", () => {
  it("requires internal auth", async () => {
    const response = await worker.fetch(
      new Request("https://research/internal/tasks/task-1/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: "T1", threadKey: "slack:C1:1.0" }),
      }),
      { INTERNAL_SECRET: "sekrit", ENVIRONMENT: "production" } as never,
      {} as never,
    );
    expect(response.status).toBe(401);
  });

  it("routes team identity and exact task/thread cancellation to the workspace DO", async () => {
    const doFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/tasks/task-1/cancel");
      expect(await request.json()).toEqual({ threadKey: "slack:C1:1.0" });
      return Response.json({ cancelled: true, quiescent: true, taskId: "task-1" });
    });
    const idFromName = vi.fn(() => ({ id: "workspace-T1" }));
    const get = vi.fn(() => ({ fetch: doFetch }));
    const response = await worker.fetch(
      new Request("https://research/internal/tasks/task-1/cancel", {
        method: "POST",
        headers: {
          authorization: "Bearer sekrit",
          "content-type": "application/json",
        },
        body: JSON.stringify({ teamId: "T1", threadKey: "slack:C1:1.0" }),
      }),
      {
        INTERNAL_SECRET: "sekrit",
        ENVIRONMENT: "production",
        ORCHESTRATOR: { idFromName, get },
      } as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cancelled: true,
      quiescent: true,
      taskId: "task-1",
    });
    expect(idFromName).toHaveBeenCalledWith("T1");
    expect(get).toHaveBeenCalledOnce();
  });

  it("preserves a non-quiescent cancellation result for Stop retry", async () => {
    const doFetch = vi.fn(async () => Response.json({
      cancelled: true,
      quiescent: false,
      taskId: "task-in-flight",
    }));
    const response = await worker.fetch(
      new Request("https://research/internal/tasks/task-in-flight/cancel", {
        method: "POST",
        headers: {
          authorization: "Bearer sekrit",
          "content-type": "application/json",
        },
        body: JSON.stringify({ teamId: "T1", threadKey: "slack:C1:1.0" }),
      }),
      {
        INTERNAL_SECRET: "sekrit",
        ENVIRONMENT: "production",
        ORCHESTRATOR: {
          idFromName: () => ({ id: "workspace-T1" }),
          get: () => ({ fetch: doFetch }),
        },
      } as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cancelled: true,
      quiescent: false,
      taskId: "task-in-flight",
    });
  });
});
