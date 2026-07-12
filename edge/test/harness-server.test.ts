/**
 * Pure-logic unit tests for edge/workers/sandbox/harness-server.ts (GOAL.md
 * Phase A5). Importing this module must never bind a port — see the
 * `isMain` guard in harness-server.ts — so these tests run entirely without
 * Docker, git, or a real `claude` binary.
 */
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  buildClaudeArgs,
  createExecutionTracker,
  createSessionQueue,
  decideTurnAdmission,
  finalizeEvents,
  mapStreamJsonLine,
  summarizeToolInput,
  truncateSummary,
  workBranchName,
  type NdjsonEvent,
} from "../workers/sandbox/harness-server.js";

describe("assemblePrompt", () => {
  it("joins requesterContext + transcript + inputLines with blank lines", () => {
    const prompt = assemblePrompt({
      requesterContext: "[Requester Context]\nSlack: Will (@will)",
      transcript: "[Transcript]\nUser: hi\nAssistant: hello",
      inputLines: ["do the thing"],
    });
    expect(prompt).toBe(
      "[Requester Context]\nSlack: Will (@will)\n\n[Transcript]\nUser: hi\nAssistant: hello\n\ndo the thing",
    );
  });

  it("omits transcript when absent", () => {
    const prompt = assemblePrompt({
      requesterContext: "[Requester Context]\nSlack: Will",
      inputLines: ["fix the bug"],
    });
    expect(prompt).toBe("[Requester Context]\nSlack: Will\n\nfix the bug");
  });

  it("omits requesterContext when absent", () => {
    const prompt = assemblePrompt({
      transcript: "[Transcript]\nUser: hi",
      inputLines: ["continue"],
    });
    expect(prompt).toBe("[Transcript]\nUser: hi\n\ncontinue");
  });

  it("is just the joined input lines when neither context nor transcript is present", () => {
    const prompt = assemblePrompt({ inputLines: ["line one", "line two"] });
    expect(prompt).toBe("line one\nline two");
  });

  it("treats whitespace-only context/transcript as absent", () => {
    const prompt = assemblePrompt({
      requesterContext: "   ",
      transcript: "\n\n",
      inputLines: ["hello"],
    });
    expect(prompt).toBe("hello");
  });
});

describe("mapStreamJsonLine — claude-code stream-json -> NDJSON event mapping", () => {
  it("maps an assistant text block to an output text event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is the answer." }] },
    });
    expect(mapStreamJsonLine(line)).toEqual([
      { kind: "output", payload: { text: "Here is the answer." } },
    ]);
  });

  it("maps an assistant tool_use block to an output tool summary event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(mapStreamJsonLine(line)).toEqual([
      { kind: "output", payload: { tool: "Bash", summary: "Bash: npm test" } },
    ]);
  });

  it("maps a mixed text + tool_use assistant message to both events in order", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    });
    expect(mapStreamJsonLine(line)).toEqual([
      { kind: "output", payload: { text: "Let me check." } },
      { kind: "output", payload: { tool: "Read", summary: "Read: a.ts" } },
    ]);
  });

  it("maps a successful result event to a done event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "All done.",
    });
    expect(mapStreamJsonLine(line)).toEqual([
      { kind: "done", payload: { ok: true, summary: "All done." } },
    ]);
  });

  it("maps a failed result event to a done{ok:false} event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Something broke.",
    });
    expect(mapStreamJsonLine(line)).toEqual([
      { kind: "done", payload: { ok: false, summary: "Something broke." } },
    ]);
  });

  it("truncates an overlong result to 500 chars", () => {
    const longResult = "x".repeat(600);
    const line = JSON.stringify({ type: "result", is_error: false, result: longResult });
    const events = mapStreamJsonLine(line);
    expect(events).toHaveLength(1);
    const done = events[0] as Extract<NdjsonEvent, { kind: "done" }>;
    expect(done.payload.summary).toHaveLength(500);
    expect(done.payload.summary.endsWith("…")).toBe(true);
  });

  it("ignores system and user event types", () => {
    expect(mapStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
    expect(
      mapStreamJsonLine(JSON.stringify({ type: "user", message: { content: [] } })),
    ).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(mapStreamJsonLine("")).toEqual([]);
    expect(mapStreamJsonLine("   ")).toEqual([]);
  });

  it("never throws on a malformed line — returns no events", () => {
    expect(() => mapStreamJsonLine("{not valid json")).not.toThrow();
    expect(mapStreamJsonLine("{not valid json")).toEqual([]);
    expect(mapStreamJsonLine("null")).toEqual([]);
    expect(mapStreamJsonLine('"just a string"')).toEqual([]);
  });
});

describe("finalizeEvents — done-always-last invariant", () => {
  it("appends a fallback done{ok:false} when the stream never produced one", () => {
    const events: NdjsonEvent[] = [{ kind: "output", payload: { text: "partial" } }];
    const finalized = finalizeEvents(events);
    expect(finalized).toHaveLength(2);
    expect(finalized.at(-1)).toEqual({
      kind: "done",
      payload: { ok: false, summary: "No result received from Claude Code" },
    });
  });

  it("leaves an already-terminated stream unchanged", () => {
    const events: NdjsonEvent[] = [
      { kind: "output", payload: { text: "hi" } },
      { kind: "done", payload: { ok: true, summary: "done" } },
    ];
    expect(finalizeEvents(events)).toEqual(events);
  });

  it("truncates anything emitted after the first done, so done is still last", () => {
    const events: NdjsonEvent[] = [
      { kind: "output", payload: { text: "hi" } },
      { kind: "done", payload: { ok: true, summary: "done" } },
      { kind: "output", payload: { text: "should not appear" } },
      { kind: "error", payload: { message: "neither should this" } },
    ];
    const finalized = finalizeEvents(events);
    expect(finalized).toHaveLength(2);
    expect(finalized.at(-1)).toEqual({ kind: "done", payload: { ok: true, summary: "done" } });
  });

  it("supports a caller-provided fallback event", () => {
    const finalized = finalizeEvents([], {
      kind: "error",
      payload: { message: "custom fallback" },
    });
    expect(finalized).toEqual([{ kind: "error", payload: { message: "custom fallback" } }]);
  });

  it("handles an empty event list with the default fallback", () => {
    expect(finalizeEvents([])).toEqual([
      { kind: "done", payload: { ok: false, summary: "No result received from Claude Code" } },
    ]);
  });
});

describe("decideTurnAdmission — duplicate-execution 409 decision", () => {
  it("accepts a fresh executionId", () => {
    const tracker = createExecutionTracker();
    expect(decideTurnAdmission(tracker, "exec-1")).toBe("accept");
  });

  it("rejects a second /turn for an executionId still in flight", () => {
    const tracker = createExecutionTracker();
    expect(decideTurnAdmission(tracker, "exec-1")).toBe("accept");
    expect(decideTurnAdmission(tracker, "exec-1")).toBe("duplicate");
  });

  it("accepts the same executionId again once it has ended", () => {
    const tracker = createExecutionTracker();
    expect(decideTurnAdmission(tracker, "exec-1")).toBe("accept");
    tracker.end("exec-1");
    expect(decideTurnAdmission(tracker, "exec-1")).toBe("accept");
  });

  it("tracks distinct executionIds independently", () => {
    const tracker = createExecutionTracker();
    expect(decideTurnAdmission(tracker, "exec-1")).toBe("accept");
    expect(decideTurnAdmission(tracker, "exec-2")).toBe("accept");
    expect(tracker.has("exec-1")).toBe(true);
    expect(tracker.has("exec-2")).toBe(true);
  });
});

describe("createSessionQueue — same-session serialization, cross-session concurrency", () => {
  it("serializes two turns for the same session in submission order", async () => {
    const queue = createSessionQueue();
    const order: string[] = [];
    const first = queue.run("session-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
    });
    const second = queue.run("session-a", async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("does not block a different session behind a slow one", async () => {
    const queue = createSessionQueue();
    const order: string[] = [];
    const slow = queue.run("session-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow-session-a");
    });
    const fast = queue.run("session-b", async () => {
      order.push("fast-session-b");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["fast-session-b", "slow-session-a"]);
  });

  it("continues the queue for a session even after a task throws", async () => {
    const queue = createSessionQueue();
    const order: string[] = [];
    const failing = queue.run("session-a", async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const next = queue.run("session-a", async () => {
      order.push("next");
    });
    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(order).toEqual(["failing", "next"]);
  });
});

describe("buildClaudeArgs", () => {
  it("builds the pinned invocation shape with the prompt as the final positional arg", () => {
    const args = buildClaudeArgs({ prompt: "do the thing", systemPromptText: "" });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "do the thing",
    ]);
  });

  it("adds --model when a model override is given", () => {
    const args = buildClaudeArgs({ prompt: "p", model: "claude-opus-4-8" });
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-8");
    expect(args.at(-1)).toBe("p");
  });

  it("adds --append-system-prompt when system prompt text is non-empty", () => {
    const args = buildClaudeArgs({ prompt: "p", systemPromptText: "You are OpenTag." });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("You are OpenTag.");
  });

  it("omits --permission-mode when explicitly disabled", () => {
    const args = buildClaudeArgs({ prompt: "p", permissionMode: "" });
    expect(args).not.toContain("--permission-mode");
  });
});

describe("misc formatting helpers", () => {
  it("truncateSummary leaves short text untouched", () => {
    expect(truncateSummary("short", 500)).toBe("short");
  });

  it("truncateSummary caps at maxLen with an ellipsis", () => {
    const result = truncateSummary("x".repeat(10), 5);
    expect(result).toHaveLength(5);
    expect(result.endsWith("…")).toBe(true);
  });

  it("summarizeToolInput picks the first preferred key present", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("Bash: ls -la");
    expect(summarizeToolInput("Read", { file_path: "src/index.ts" })).toBe(
      "Read: src/index.ts",
    );
    expect(summarizeToolInput("Unknown", {})).toBe("Unknown");
    expect(summarizeToolInput("Unknown", null)).toBe("Unknown");
  });

  it("workBranchName sanitizes and prefixes the sessionId", () => {
    expect(workBranchName("abc-123")).toBe("opentag/session-abc-123");
    expect(workBranchName("sess:with/slashes!")).toBe("opentag/session-sesswithslas");
    expect(workBranchName("")).toBe("opentag/session-session");
  });
});
