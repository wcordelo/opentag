import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUNDLE,
  resolveAllowedTools,
} from "../src/config/access-bundle.js";
import { startTask } from "../src/tasks/runtime.js";

describe("access bundle resolver", () => {
  it("filters tools to the bundle allowlist", () => {
    const all = ["memory_search", "file_issue", "start_task", "confirm_write"];
    const allowed = resolveAllowedTools(all, DEFAULT_BUNDLE);
    expect(allowed).toContain("memory_search");
    expect(allowed).toContain("start_task");
    expect(allowed).not.toContain("file_issue");
  });

  it("denies everything when bundle tools empty", () => {
    expect(
      resolveAllowedTools(["a", "b"], { ...DEFAULT_BUNDLE, tools: [] }),
    ).toEqual([]);
  });

  it("enforces per-bundle deny for memory_write", () => {
    const restricted = {
      ...DEFAULT_BUNDLE,
      id: "readonly",
      tools: ["memory_search", "show_status"],
    };
    const allowed = resolveAllowedTools(
      ["memory_search", "memory_write", "start_task"],
      restricted,
    );
    expect(allowed).toEqual(["memory_search"]);
  });
});

describe("TaskRuntime", () => {
  it("errors when RESEARCH_TASKS is unbound", async () => {
    const result = await startTask({}, {
      type: "research",
      teamId: "T1",
      threadKey: "slack:C1:1.0",
      channelId: "C1",
      payload: { objective: "edge DOs" },
    });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/RESEARCH_TASKS/);
  });

  it("forwards research when RESEARCH_TASKS is bound", async () => {
    const result = await startTask(
      {
        RESEARCH_TASKS: {
          fetch: async () =>
            Response.json({ taskId: "task_forwarded" }),
        } as unknown as Fetcher,
        INTERNAL_SECRET: "sekrit",
      },
      {
        type: "research",
        teamId: "T1",
        threadKey: "slack:C1:1.0",
        channelId: "C1",
        payload: { objective: "x" },
      },
    );
    expect(result.status).toBe("forwarded");
    expect(result.taskId).toBe("task_forwarded");
  });

  it("sends Authorization when INTERNAL_SECRET set", async () => {
    let sawAuth: string | null = null;
    await startTask(
      {
        RESEARCH_TASKS: {
          fetch: async (_url: RequestInfo, init?: RequestInit) => {
            const h = new Headers(init?.headers);
            sawAuth = h.get("Authorization");
            return Response.json({ taskId: "t1" });
          },
        } as unknown as Fetcher,
        INTERNAL_SECRET: "sekrit",
      },
      {
        type: "research",
        teamId: "T1",
        threadKey: "slack:C1:1.0",
        channelId: "C1",
        payload: { objective: "x" },
      },
    );
    expect(sawAuth).toBe("Bearer sekrit");
  });
});

describe("workspace isolation keys", () => {
  it("scopes threadstate and hitl keys by conversation", () => {
    const channelA = "C_A";
    const channelB = "C_B";
    const threadstate = (ch: string) => `threadstate:${ch}::${ch}`;
    const hitl = (id: string) => `hitl:${id}`;
    expect(threadstate(channelA)).not.toBe(threadstate(channelB));
    expect(hitl("a1")).not.toBe(hitl("b1"));
  });
});
