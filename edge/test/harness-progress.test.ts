import { describe, expect, it } from "vitest";
import {
  applyProgressEvent,
  humanizeToolProgressTitle,
  rebuildProgressFromEvents,
  renderProgressMarkdown,
} from "../src/slack/harness-progress.js";

describe("harness progress renderer", () => {
  it("does not render model or AG-UI context lines", () => {
    const md = renderProgressMarkdown([
      {
        progressId: "t1",
        sequence: 1,
        category: "tool",
        state: "started",
        title: "Searching Slack",
      },
    ], { heading: "" });
    expect(md).not.toContain("OpenTag AG-UI");
    expect(md).not.toContain("model unconfirmed");
  });

  it("humanizes tool titles and supports an explicit heading", () => {
    expect(humanizeToolProgressTitle("search_slack")).toBe("Searching Slack");
    expect(humanizeToolProgressTitle("show_permissions")).toBe(
      "Checking permissions",
    );
    expect(humanizeToolProgressTitle("weird_custom_tool")).toBe(
      "Weird Custom Tool",
    );
    const md = renderProgressMarkdown(
      [
        {
          progressId: "t1",
          sequence: 1,
          category: "tool",
          state: "started",
          title: "Searching Slack",
        },
      ],
      { heading: "*Coding progress*" },
    );
    expect(md).toContain("*Coding progress*");
    expect(md).toContain("Searching Slack");
    expect(md).not.toContain("Working");
  });

  it("preserves tool titles when completion events only say Tool", () => {
    const started = applyProgressEvent(new Map(), {
      progressId: "tool-1",
      sequence: 1,
      category: "tool",
      state: "started",
      title: "Bash",
      summary: "npm test",
    });
    const completed = applyProgressEvent(started.items, {
      progressId: "tool-1",
      sequence: 2,
      category: "tool",
      state: "completed",
      title: "Tool",
    });
    expect(completed.items.get("tool-1")).toMatchObject({
      title: "Bash",
      state: "completed",
      summary: "npm test",
    });
  });

  it("dedups progress sequences and freezes completed items", () => {
    const empty = new Map();
    const started = applyProgressEvent(empty, {
      progressId: "tool-1",
      sequence: 1,
      category: "tool",
      state: "started",
      title: "Read",
      summary: "a.ts",
    });
    expect(started.changed).toBe(true);
    const dup = applyProgressEvent(started.items, {
      progressId: "tool-1",
      sequence: 1,
      category: "tool",
      state: "started",
      title: "Read",
      summary: "a.ts",
    });
    expect(dup.changed).toBe(false);
    const completed = applyProgressEvent(started.items, {
      progressId: "tool-1",
      sequence: 2,
      category: "tool",
      state: "completed",
      title: "Read",
    });
    expect(completed.changed).toBe(true);
    const afterDone = applyProgressEvent(completed.items, {
      progressId: "tool-1",
      sequence: 3,
      category: "tool",
      state: "updated",
      title: "Read again",
    });
    expect(afterDone.changed).toBe(false);
  });

  it("rebuilds from durable events without concatenating into final text", () => {
    const rebuilt = rebuildProgressFromEvents([
      {
        kind: "context",
        payload: {
          harnessType: "claudecode",
          model: "claude-opus-5",
          modelEvidence: "container_argument",
        },
      },
      {
        kind: "progress",
        payload: {
          progressId: "tool-1",
          sequence: 1,
          category: "tool",
          state: "started",
          title: "Read file",
          summary: "src/x.ts",
        },
      },
      {
        kind: "progress",
        payload: {
          progressId: "tool-1",
          sequence: 2,
          category: "tool",
          state: "completed",
          title: "Read file",
        },
      },
      { kind: "output", payload: { text: "final answer" } },
      { kind: "done", payload: { ok: true } },
    ]);
    expect(rebuilt.context?.model).toBe("claude-opus-5");
    expect(rebuilt.items.get("tool-1")?.state).toBe("completed");
    const md = renderProgressMarkdown(rebuilt.items.values(), { done: true });
    expect(md).toContain("Read file");
    expect(md).toContain("Complete");
    expect(md).not.toContain("final answer");
  });

  it("rebuild keeps higher evidence when equal-rank context appears later", () => {
    const rebuilt = rebuildProgressFromEvents([
      {
        kind: "context",
        payload: {
          harnessType: "claudecode",
          model: "first-model",
          modelEvidence: "provider_reported",
        },
      },
      {
        kind: "context",
        payload: {
          harnessType: "claudecode",
          model: "same-rank-model",
          modelEvidence: "provider_reported",
        },
      },
    ]);
    expect(rebuilt.context?.model).toBe("first-model");
  });

  it("renders progress in first-seen order, not alphabetical progressId", () => {
    // Mutate through successive apply so Map insertion order is chronological.
    let state = applyProgressEvent(new Map(), {
      progressId: "tool-z-late-alphabet",
      sequence: 1,
      category: "tool",
      state: "completed",
      title: "First",
    });
    state = applyProgressEvent(state.items, {
      progressId: "tool-a-early-alphabet",
      sequence: 1,
      category: "tool",
      state: "completed",
      title: "Second",
    });
    const md = renderProgressMarkdown(state.items.values(), { done: true });
    const firstIdx = md.indexOf("First");
    const secondIdx = md.indexOf("Second");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});
