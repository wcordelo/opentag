/**
 * Pure-logic unit tests for edge/workers/sandbox/harness-server.ts (GOAL.md
 * Phase A5). Importing this module must never bind a port — see the
 * `isMain` guard in harness-server.ts — so these tests run entirely without
 * Docker, git, or a real `claude` binary.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assemblePrompt,
  buildClaudeArgs,
  buildClaudeEnv,
  buildClaudeSpawnOptions,
  cleanupExecutionHome,
  createExecutionTracker,
  createChildTerminator,
  createHarnessServer,
  createSessionQueue,
  decideTurnAdmission,
  defaultWorkdirFilesystem,
  ensureWorkdir,
  finalizeEvents,
  gitPolicyPrompt,
  gitAuthenticationEnv,
  hasValidBearerToken,
  loadAuthoritativeSystemPrompt,
  mapStreamJsonLine,
  materializeTurnAttachments,
  prepareExecutionHome,
  resolveExecutionHome,
  resolveSessionWorkdir,
  requesterAttribution,
  runAbortableCommand,
  outcomeTerminalEvents,
  summarizeToolInput,
  truncateSummary,
  validateRepoSpec,
  validateTurnRequest,
  verifyTurnOutcome,
  workBranchName,
  type HarnessServerOptions,
  type NdjsonEvent,
  type WorkdirFilesystem,
} from "../workers/sandbox/harness-server.js";

const repoPolicy = {
  allowedHosts: new Set(["github.com"]),
  allowedOrgs: new Set(["wcordelo"]),
};

const validTurn = {
  sessionId: "session-1",
  executionId: `ot1e_${"A".repeat(43)}`,
  forwardedMessageId: `ot1m_${"A".repeat(43)}`,
  threadKey: "slack:C123:171234.0001",
  inputLines: ["fix it"],
};

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

  it("lists materialized attachment paths before the user input", () => {
    const prompt = assemblePrompt({ inputLines: ["inspect it"], attachmentPaths: ["/tmp/a.pdf (application/pdf)"] });
    expect(prompt).toBe("[Attachments]\n- /tmp/a.pdf (application/pdf)\n\ninspect it");
  });
});

describe("attachment materialization", () => {
  it("writes exact inline bytes outside the repository checkout", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opentag-attachments-"));
    try {
      const paths = await materializeTurnAttachments(root, [{
        kind: "inline", id: "F1", name: "design plan.pdf", mimeType: "application/pdf",
        size: 4, dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }]);
      const filePath = paths[0]!.split(" (")[0]!;
      expect(filePath).toContain(path.join(root, "attachments"));
      expect([...await fs.promises.readFile(filePath)]).toEqual([1, 2, 3, 4]);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("git approval and outcome contract", () => {
  const requesterContext = [
    "[Requester Context]",
    "Slack: @will",
    "GitHub: @wcordelo",
    "Prompted by: @wcordelo",
  ].join("\n");

  it("defaults remote writes to false and rejects PR creation without approval", () => {
    const validated = validateTurnRequest(validTurn, repoPolicy);
    expect(validated.ok && validated.body.remoteGitApproved).toBe(false);
    expect(
      validateTurnRequest(
        {
          ...validTurn,
          repo: { url: "https://github.com/wcordelo/opentag" },
          codingTask: true,
          createPullRequest: true,
          requesterContext,
        },
        repoPolicy,
      ),
    ).toEqual({ ok: false, error: "remote_git_not_approved" });
  });

  it("extracts only exact requester attribution and pins it in an approved PR prompt", () => {
    expect(requesterAttribution(requesterContext)).toBe("Prompted by: @wcordelo");
    expect(requesterAttribution("[Requester Context]\nGitHub: @wcordelo")).toBeUndefined();
    expect(requesterAttribution("[Requester Context]\n Prompted by: @wcordelo")).toBeUndefined();
    expect(requesterAttribution("Prompted by: @one\nPrompted by: @two")).toBeUndefined();
    expect(
      gitPolicyPrompt({
        ...validTurn,
        requesterContext,
        codingTask: true,
        remoteGitApproved: true,
        createPullRequest: true,
      }),
    ).toContain("exact standalone line: Prompted by: @wcordelo");
    expect(gitPolicyPrompt(validTurn)).toContain("Remote git approval was NOT obtained");
  });

  it.each([
    "Prompted by: @slack.handle",
    "Prompted by: Renée O'Connor",
  ])("accepts safe fallback attribution for createPullRequest: %s", (attribution) => {
    const context = `[Requester Context]\n${attribution}`;
    expect(requesterAttribution(context)).toBe(attribution);
    expect(
      validateTurnRequest(
        {
          ...validTurn,
          repo: { url: "https://github.com/wcordelo/opentag" },
          codingTask: true,
          remoteGitApproved: true,
          createPullRequest: true,
          requesterContext: context,
        },
        repoPolicy,
      ).ok,
    ).toBe(true);
  });

  it("requires a new commit on the dedicated branch", async () => {
    const execFile = vi.fn((_file: string, args: string[], options: { cwd: string }) => {
      expect(options.cwd).toBe("/work/session-1");
      return args.includes("--show-current") ? "opentag/session-session-1" : "base-head";
    });
    const result = await verifyTurnOutcome(
      { ...validTurn, codingTask: true },
      "/work/session-1",
      { head: "base-head", tree: "base-tree" },
      { execFile },
    );
    expect(result).toEqual({ ok: false, error: "coding turn produced no new commit" });
    expect(outcomeTerminalEvents(result, "complete")).toEqual([
      { kind: "error", payload: { message: "postcondition_failed: coding turn produced no new commit" } },
      { kind: "done", payload: { ok: false, summary: "postcondition_failed: coding turn produced no new commit" } },
    ]);
  });

  it("verifies an approved PR and its exact standalone attribution", async () => {
    const body = {
      ...validTurn,
      repo: { url: "https://github.com/wcordelo/opentag.git" },
      codingTask: true,
      remoteGitApproved: true,
      createPullRequest: true,
      requesterContext,
    };
    let pr = {
      body: "Implements the requested script.\n\nPrompted by: @wcordelo\n",
      html_url: "https://github.com/wcordelo/opentag/pull/123",
      head: { ref: "opentag/session-session-1", sha: "new-head" },
    };
    const execFile = vi.fn((file: string, args: string[], options: { cwd: string }) => {
      expect(options.cwd).toBe("/work/session-1");
      if (file === "/usr/bin/gh") return JSON.stringify([pr]);
      if (args.includes("--show-current")) return "opentag/session-session-1";
      if (args.includes("HEAD^{tree}")) return "new-tree";
      return "new-head";
    });
    const operations = { execFile };
    expect(
      await verifyTurnOutcome(
        body,
        "/work/session-1",
        { head: "base-head", tree: "base-tree" },
        operations,
      ),
    ).toEqual({
      ok: true,
      prUrl: "https://github.com/wcordelo/opentag/pull/123",
    });
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/gh",
      [
        "api", "--method", "GET", "--header",
        `x-opentag-execution-id: ${body.executionId}`,
        "repos/wcordelo/opentag/pulls?head=wcordelo%3Aopentag%2Fsession-session-1&state=open",
      ],
      expect.objectContaining({ cwd: "/work/session-1" }),
    );
    for (const args of [
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "HEAD^{tree}"],
      ["merge-base", "--is-ancestor", "base-head", "new-head"],
    ]) {
      expect(execFile).toHaveBeenCalledWith(
        "/usr/bin/git",
        args,
        expect.objectContaining({ cwd: "/work/session-1" }),
      );
    }
    pr = {
      body: "Prompted by: @someone-else",
      html_url: "https://github.com/wcordelo/opentag/pull/123",
      head: { ref: "opentag/session-session-1", sha: "new-head" },
    };
    expect(
      await verifyTurnOutcome(
        body,
        "/work/session-1",
        { head: "base-head", tree: "base-tree" },
        operations,
      ),
    ).toEqual({
      ok: false,
      error: "pull request body must contain exactly 'Prompted by: @wcordelo'",
    });
  });

  it("rejects reset/empty-tree outcomes, non-descendants, and PRs for another SHA", async () => {
    const body = {
      ...validTurn,
      repo: { url: "https://github.com/wcordelo/opentag.git" },
      codingTask: true,
      remoteGitApproved: true,
      createPullRequest: true,
      requesterContext,
    };
    const baseline = { head: "base-head", tree: "base-tree" };
    const operation = (tree: string, prHead = "new-head", rejectAncestor = false) => ({
      execFile(file: string, args: string[]) {
        if (file === "/usr/bin/gh") {
          return JSON.stringify([{
            body: "Prompted by: @wcordelo",
            head: { ref: "opentag/session-session-1", sha: prHead },
          }]);
        }
        if (args.includes("--show-current")) return "opentag/session-session-1";
        if (args.includes("HEAD^{tree}")) return tree;
        if (args.includes("merge-base") && rejectAncestor) throw new Error("not an ancestor");
        return "new-head";
      },
    });
    expect(await verifyTurnOutcome(body, "/work/session-1", baseline, operation("base-tree"))).toEqual({
      ok: false,
      error: "coding turn produced no changed tree",
    });
    expect(await verifyTurnOutcome(body, "/work/session-1", baseline, operation("new-tree", "new-head", true))).toMatchObject({
      ok: false,
      error: expect.stringContaining("git outcome verification failed"),
    });
    const mismatchedPr = await verifyTurnOutcome(
      body,
      "/work/session-1",
      baseline,
      operation("new-tree", "other-head"),
    );
    expect(mismatchedPr).toEqual({
      ok: false,
      error: "pull request head does not match the verified local commit",
    });
    expect(outcomeTerminalEvents(mismatchedPr, "complete")).toEqual([
      {
        kind: "error",
        payload: {
          message: "postcondition_failed: pull request head does not match the verified local commit",
        },
      },
      {
        kind: "done",
        payload: {
          ok: false,
          summary: "postcondition_failed: pull request head does not match the verified local commit",
        },
      },
    ]);
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

  it("rejects exactly one turn when interrupt beats container admission", () => {
    const tracker = createExecutionTracker();
    expect(tracker.interrupt("session-1", "exec-early")).toBe(false);
    expect(decideTurnAdmission(tracker, "exec-early", "session-other")).toBe("accept");
    tracker.end("exec-early");
    expect(decideTurnAdmission(tracker, "exec-early", "session-1")).toBe("duplicate");
    expect(decideTurnAdmission(tracker, "exec-early", "session-1")).toBe("accept");
    tracker.dispose();
  });

  it("bounds wrong-ID floods by evicting the oldest pending interrupt", () => {
    const tracker = createExecutionTracker({ maxPending: 3, pendingTtlMs: 60_000 });
    for (let index = 0; index < 10; index += 1) {
      expect(tracker.interrupt("session-1", `wrong-${index}`)).toBe(false);
    }
    expect(tracker.pendingCount()).toBe(3);
    expect(decideTurnAdmission(tracker, "wrong-0", "session-1")).toBe("accept");
    tracker.end("wrong-0");
    expect(decideTurnAdmission(tracker, "wrong-9", "session-1")).toBe("duplicate");
    expect(decideTurnAdmission(tracker, "wrong-9", "session-1")).toBe("accept");
    tracker.dispose();
  });

  it("sweeps expired pending interrupts independently and keeps Stop one-shot", async () => {
    const tracker = createExecutionTracker({ pendingTtlMs: 10, sweepIntervalMs: 2 });
    tracker.interrupt("session-1", "expired");
    expect(tracker.pendingCount()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tracker.pendingCount()).toBe(0);

    expect(decideTurnAdmission(tracker, "completed", "session-1")).toBe("accept");
    tracker.end("completed");
    expect(tracker.interrupt("session-1", "completed")).toBe(false);
    expect(decideTurnAdmission(tracker, "completed", "session-1")).toBe("accept");
    tracker.dispose();
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
  it("fails closed instead of omitting an empty authoritative system prompt", () => {
    expect(() => buildClaudeArgs({ prompt: "do the thing", systemPromptText: "" }))
      .toThrow("authoritative system prompt is empty");
  });

  it("adds --model when a model override is given", () => {
    const args = buildClaudeArgs({
      prompt: "p",
      model: "claude-opus-4-8",
      systemPromptText: "OpenTag instructions",
    });
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
    const args = buildClaudeArgs({
      prompt: "p",
      permissionMode: "",
      systemPromptText: "OpenTag instructions",
    });
    expect(args).not.toContain("--permission-mode");
  });
});

describe("loadAuthoritativeSystemPrompt", () => {
  it("returns a bounded non-empty regular file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-prompt-"));
    const promptPath = path.join(root, "SYSTEM_PROMPT.md");
    fs.writeFileSync(promptPath, "# Required instructions\n");
    await expect(
      loadAuthoritativeSystemPrompt(promptPath, 1024, new AbortController().signal),
    ).resolves.toBe("# Required instructions\n");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["missing", (root: string) => path.join(root, "missing.md")],
    ["non-regular", (root: string) => root],
  ])("rejects a %s prompt", async (_label, promptPath) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-prompt-"));
    await expect(
      loadAuthoritativeSystemPrompt(promptPath(root), 1024, new AbortController().signal),
    ).rejects.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects empty and oversized prompts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-prompt-"));
    const promptPath = path.join(root, "SYSTEM_PROMPT.md");
    fs.writeFileSync(promptPath, " \n\t");
    await expect(
      loadAuthoritativeSystemPrompt(promptPath, 1024, new AbortController().signal),
    ).rejects.toThrow("system prompt is empty");
    fs.writeFileSync(promptPath, "x".repeat(1025));
    await expect(
      loadAuthoritativeSystemPrompt(promptPath, 1024, new AbortController().signal),
    ).rejects.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("buildClaudeSpawnOptions", () => {
  it("creates a detached process group on Linux only", () => {
    const env = { PATH: "/usr/bin" };
    expect(buildClaudeSpawnOptions("/work/session-1", env, "linux")).toEqual({
      cwd: "/work/session-1",
      env,
      detached: true,
    });
    expect(buildClaudeSpawnOptions("/work/session-1", env, "darwin").detached).toBe(false);
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

describe("security validation", () => {
  it("uses constant-shape bearer authentication and fails closed without a secret", () => {
    expect(hasValidBearerToken("Bearer secret", "secret")).toBe(true);
    expect(hasValidBearerToken(undefined, "secret")).toBe(false);
    expect(hasValidBearerToken("Bearer wrong", "secret")).toBe(false);
    expect(hasValidBearerToken("Bearer secret", undefined)).toBe(false);
  });

  it("does not expose the harness bearer secret to Claude", () => {
    expect(
      buildClaudeEnv({ HARNESS_AUTH_TOKEN: "server-secret", KEEP_ME: "yes" }, "opus"),
    ).toMatchObject({
      KEEP_ME: "yes",
      CLAUDE_MODEL: "opus",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/local/bin/opentag-git-askpass",
    });
  });

  it("never exposes real Anthropic, OAuth, GitHub, or bearer credentials to Claude", () => {
    const child = buildClaudeEnv({
      ANTHROPIC_API_KEY: "real-anthropic",
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth",
      GITHUB_TOKEN: "real-github",
      GH_TOKEN: "real-gh",
      HARNESS_AUTH_TOKEN: "real-bearer",
    }, undefined, true, { url: "https://github.com/acme/widget.git" }, "sess-1", "exec-1");
    expect(JSON.stringify(child)).not.toContain("real-");
    expect(child).toMatchObject({
      ANTHROPIC_API_KEY: "opentag-egress-injected-not-a-secret",
      GITHUB_TOKEN: "opentag-egress-injected-not-a-secret",
      GH_TOKEN: "opentag-egress-injected-not-a-secret",
      OPENTAG_REPO_SLUG: "acme/widget",
      OPENTAG_WORK_BRANCH: "opentag/session-sess-1",
      OPENTAG_EXECUTION_ID: "exec-1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: "x-opentag-execution-id: exec-1",
    });
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(child.HARNESS_AUTH_TOKEN).toBeUndefined();
    expect(child.OPENTAG_REMOTE_GIT_APPROVED).toBeUndefined();
  });

  it("replaces inherited execution bindings with the exact child execution", () => {
    const child = buildClaudeEnv({
      OPENTAG_EXECUTION_ID: "stale-exec",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "x-opentag-execution-id: stale-exec",
      GIT_CONFIG_KEY_1: "http.proxy",
      GIT_CONFIG_VALUE_1: "https://evil.example",
    }, undefined, true, undefined, "sess-1", "exec-current");
    expect(child).toMatchObject({
      OPENTAG_EXECUTION_ID: "exec-current",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: "x-opentag-execution-id: exec-current",
    });
    expect(child.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(child.GIT_CONFIG_VALUE_1).toBeUndefined();
  });

  it("binds Claude and tool config to only the execution-scoped HOME", () => {
    const home = "/work/ot1e_execution/home";
    const child = buildClaudeEnv({
      HOME: "/home/harness",
      USERPROFILE: "/global-user",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\global",
      XDG_CONFIG_HOME: "/global-config",
      XDG_CACHE_HOME: "/global-cache",
      CLAUDE_CONFIG_DIR: "/global-claude",
    }, undefined, false, undefined, "session-1", "ot1e_execution", home);
    expect(child).toMatchObject({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_CACHE_HOME: `${home}/.cache`,
      XDG_DATA_HOME: `${home}/.local/share`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
    });
    expect(child.HOMEDRIVE).toBeUndefined();
    expect(child.HOMEPATH).toBeUndefined();
  });

  it("keeps clone credentials in askpass and binds the exact execution outside argv", () => {
    const env = gitAuthenticationEnv({
      GITHUB_TOKEN: "private-token",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.proxy",
      GIT_CONFIG_VALUE_0: "https://evil.example",
    }, "exec-clone");
    expect(env).toMatchObject({
      GITHUB_TOKEN: "private-token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/local/bin/opentag-git-askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: "x-opentag-execution-id: exec-clone",
    });
    expect(["clone", "https://github.com/wcordelo/opentag.git"].join(" ")).not.toContain(
      "private-token",
    );
  });

  it("rejects path-bearing or oversized identifiers before workdir resolution", () => {
    for (const sessionId of ["../escape", "a/b", ".hidden", "x".repeat(129)]) {
      expect(validateTurnRequest({ ...validTurn, sessionId }, repoPolicy)).toEqual({
        ok: false,
        error: "invalid_session_id",
      });
    }
    expect(() => resolveSessionWorkdir("/work", "../escape")).toThrow("invalid sessionId");
    expect(resolveSessionWorkdir("/work", "safe-session")).toBe("/work/safe-session");
  });

  it("validates executionId, threadKey, model, line types, and context bounds", () => {
    expect(validateTurnRequest({ ...validTurn, executionId: "../x" }, repoPolicy)).toMatchObject({
      ok: false,
      error: "invalid_execution_id",
    });
    expect(validateTurnRequest({ ...validTurn, threadKey: "slack/C1" }, repoPolicy)).toMatchObject({
      ok: false,
      error: "invalid_thread_key",
    });
    expect(validateTurnRequest({ ...validTurn, model: "opus; rm -rf /" }, repoPolicy)).toMatchObject({
      ok: false,
      error: "invalid_model",
    });
    expect(validateTurnRequest({ ...validTurn, inputLines: [42] }, repoPolicy)).toMatchObject({
      ok: false,
      error: "invalid_input_lines",
    });
    expect(
      validateTurnRequest({ ...validTurn, requesterContext: "x".repeat(16_385) }, repoPolicy),
    ).toMatchObject({ ok: false, error: "invalid_context" });
  });

  it("permits only HTTPS repositories on configured hosts and orgs", () => {
    expect(validateRepoSpec({ url: "https://github.com/wcordelo/opentag" }, repoPolicy)).toEqual({
      ok: true,
      normalizedUrl: "https://github.com/wcordelo/opentag.git",
    });
    for (const url of [
      "git@github.com:wcordelo/opentag.git",
      "https://github.com/other/opentag",
      "https://evil.example/wcordelo/opentag",
      "https://token@github.com/wcordelo/opentag",
      "https://github.com/wcordelo/opentag?upload-pack=evil",
    ]) {
      expect(validateRepoSpec({ url }, repoPolicy).ok).toBe(false);
    }
    expect(
      validateRepoSpec({ url: "https://github.com/wcordelo/opentag", branch: "../main" }, repoPolicy),
    ).toMatchObject({ ok: false, error: "invalid_repo_branch" });
  });
});

describe("clone and child lifecycle cleanup", () => {
  it("aborts a real async subprocess and awaits its cleanup", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const command = runAbortableCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30_000)"],
      { signal: controller.signal, timeoutMs: 30_000 },
    );
    setTimeout(() => controller.abort(), 25);
    await expect(command).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("bounds captured subprocess output", async () => {
    await expect(runAbortableCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1024 * 1024 + 1))"],
      { signal: new AbortController().signal, timeoutMs: 5000 },
    )).rejects.toThrow("exceeded 1048576 output bytes");
  });

  it("reclones an existing git workdir whose canonical origin is another repo", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-harness-"));
    const workdir = path.join(root, "session-1");
    fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, ".git", "opentag-workdir.json"),
      JSON.stringify({ repoUrl: "https://github.com/wcordelo/other.git", baseBranch: null }),
    );
    const calls: string[][] = [];
    const result = await ensureWorkdir(
      workdir,
      { url: "https://github.com/wcordelo/opentag.git" },
      "session-1",
      {
        execFile(_file, args) {
          calls.push(args);
          if (args.includes("get-url")) return "https://github.com/wcordelo/other.git";
          if (args[0] === "clone") fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
          return "";
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(calls.some((args) => args[0] === "clone")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(workdir, ".git", "opentag-workdir.json"), "utf8"))).toEqual({
      repoUrl: "https://github.com/wcordelo/opentag.git",
      baseBranch: null,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a fresh private execution HOME and quarantines stale symlinks on cleanup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-home-"));
    const executionId = "ot1e_execution-home";
    const home = resolveExecutionHome(root, executionId);
    const executionRoot = path.dirname(home);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-home-outside-"));
    fs.writeFileSync(path.join(outside, "sentinel"), "keep");
    fs.symlinkSync(outside, executionRoot, "dir");

    const prepared = await prepareExecutionHome(root, executionId);
    expect(prepared).toBe(home);
    expect(fs.lstatSync(executionRoot).isDirectory()).toBe(true);
    expect(fs.lstatSync(home).isDirectory()).toBe(true);
    expect(fs.statSync(executionRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "poison");

    await cleanupExecutionHome(root, executionId);
    expect(fs.existsSync(executionRoot)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reclones when the requested base branch differs from the session identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-harness-"));
    const workdir = path.join(root, "session-1");
    fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, ".git", "opentag-workdir.json"),
      JSON.stringify({ repoUrl: "https://github.com/wcordelo/opentag.git", baseBranch: "main" }),
    );
    const clone = vi.fn();
    const result = await ensureWorkdir(
      workdir,
      { url: "https://github.com/wcordelo/opentag.git", branch: "release" },
      "session-1",
      {
        execFile(_file, args) {
          if (args.includes("get-url")) return "https://github.com/wcordelo/opentag.git";
          if (args[0] === "clone") {
            clone(args);
            fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
          }
          return "";
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(clone).toHaveBeenCalledWith([
      "clone",
      "--depth=1",
      "--branch",
      "release",
      "https://github.com/wcordelo/opentag.git",
      expect.stringContaining(".partial-"),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes both a poisoned workdir and partial clone after clone failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-harness-"));
    const workdir = path.join(root, "session-1");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, "poison"), "partial");
    const result = await ensureWorkdir(workdir, { url: "https://github.com/wcordelo/opentag.git" }, "session-1", {
      execFile(_file, args) {
        const destination = args.at(-1);
        if (args[0] === "clone" && destination) {
          fs.mkdirSync(path.join(destination, ".git"), { recursive: true });
          throw new Error("clone failed");
        }
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(workdir)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bounds malformed identity reads and safely replaces a symlinked workdir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-harness-"));
    const outside = path.join(root, "outside");
    const workdir = path.join(root, "session-1");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel"), "keep");
    fs.symlinkSync(outside, workdir, "dir");
    const result = await ensureWorkdir(workdir, { url: "https://github.com/wcordelo/opentag.git" }, "session-1", {
      execFile(_file, args) {
        if (args[0] === "clone") fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
        return "";
      },
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep");
    expect(fs.lstatSync(workdir).isDirectory()).toBe(true);

    fs.writeFileSync(path.join(workdir, ".git", "opentag-workdir.json"), "x".repeat(4097));
    let cloneCount = 0;
    const oversized = await ensureWorkdir(workdir, { url: "https://github.com/wcordelo/opentag.git" }, "session-1", {
      execFile(_file, args) {
        if (args.includes("get-url")) return "https://github.com/wcordelo/opentag.git";
        if (args[0] === "clone") {
          cloneCount += 1;
          fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
        }
        return "";
      },
    });
    expect(oversized.ok).toBe(true);
    expect(cloneCount).toBe(1);

    fs.writeFileSync(path.join(workdir, ".git", "opentag-workdir.json"), "{not-json");
    const malformed = await ensureWorkdir(workdir, { url: "https://github.com/wcordelo/opentag.git" }, "session-1", {
      execFile(_file, args) {
        if (args.includes("get-url")) return "https://github.com/wcordelo/opentag.git";
        if (args[0] === "clone") {
          cloneCount += 1;
          fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
        }
        return "";
      },
    });
    expect(malformed.ok).toBe(true);
    expect(cloneCount).toBe(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deduplicates termination requests and escalates an immortal child once", () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(() => true);
      const terminator = createChildTerminator({ kill }, 10);
      expect(terminator.terminate()).toBe(true);
      expect(terminator.terminate()).toBe(false);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(10);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenLastCalledWith("SIGKILL");
      terminator.terminate();
      expect(kill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates the detached Linux process group with TERM then KILL", () => {
    vi.useFakeTimers();
    try {
      const childKill = vi.fn(() => true);
      const processKill = vi.fn();
      const terminator = createChildTerminator(
        { pid: 4242, kill: childKill },
        10,
        { platform: "linux", kill: processKill },
      );
      expect(terminator.terminate()).toBe(true);
      expect(processKill).toHaveBeenCalledWith(-4242, "SIGTERM");
      expect(childKill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(processKill).toHaveBeenLastCalledWith(-4242, "SIGKILL");
      expect(processKill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sweeps detached descendants after the Claude leader has exited", async () => {
    vi.useFakeTimers();
    try {
      const processKill = vi.fn();
      const terminator = createChildTerminator(
        { pid: 4242, kill: vi.fn(() => true) },
        10,
        { platform: "linux", kill: processKill },
      );
      terminator.markExited();
      expect(terminator.terminate()).toBe(true);
      expect(processKill).toHaveBeenCalledWith(-4242, "SIGTERM");
      let cleaned = false;
      void terminator.waitForCleanup().then(() => (cleaned = true));
      await vi.advanceTimersByTimeAsync(9);
      expect(cleaned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).toHaveBeenLastCalledWith(-4242, "SIGKILL");
      expect(cleaned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signals a possibly reused non-Linux PID after leader exit", async () => {
    const childKill = vi.fn(() => true);
    const terminator = createChildTerminator(
      { pid: 4242, kill: childKill },
      10,
      { platform: "darwin", kill: vi.fn() },
    );
    terminator.markExited();
    expect(terminator.terminate()).toBe(true);
    await terminator.waitForCleanup();
    expect(childKill).not.toHaveBeenCalled();
  });
});

async function withServer(
  options: HarnessServerOptions,
  task: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createHarnessServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  try {
    await task(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("/turn HTTP boundaries", () => {
  it("serves exact /interrupt while a bounded identity read is pending and never clones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-harness-http-"));
    const workdir = path.join(root, validTurn.sessionId);
    fs.mkdirSync(path.join(workdir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, ".git", "opentag-workdir.json"),
      JSON.stringify({ repoUrl: "https://github.com/wcordelo/opentag.git", baseBranch: null }),
    );
    let readStartedResolve!: () => void;
    const readStarted = new Promise<void>((resolve) => { readStartedResolve = resolve; });
    let cloneCalls = 0;
    const filesystem: WorkdirFilesystem = {
      ...defaultWorkdirFilesystem,
      readIdentity(_target, _maxBytes, signal) {
        readStartedResolve();
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("interrupted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    await withServer({
      authToken: "test-secret",
      repoPolicy,
      runTurn: async (body, res, signal) => {
        const result = await ensureWorkdir(
          workdir,
          body.repo!,
          body.sessionId,
          {
            execFile(_file, args) {
              if (args.includes("get-url")) return body.repo!.url;
              if (args[0] === "clone") cloneCalls += 1;
              return "";
            },
          },
          signal,
          filesystem,
        );
        res.write(`${JSON.stringify({
          kind: "done",
          payload: { ok: result.ok && !signal.aborted, summary: signal.aborted ? "interrupted" : "unexpected" },
        })}\n`);
      },
    }, async (baseUrl) => {
      const turnResponse = fetch(`${baseUrl}/turn`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify({
          ...validTurn,
          repo: { url: "https://github.com/wcordelo/opentag.git" },
        }),
      });
      await readStarted;
      const interrupt = await Promise.race([
        fetch(`${baseUrl}/interrupt`, {
          method: "POST",
          headers: { authorization: "Bearer test-secret" },
          body: JSON.stringify(validTurn),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("interrupt blocked")), 500)),
      ]);
      await expect(interrupt.json()).resolves.toEqual({ interrupted: true });
      expect(await (await turnResponse).text()).toContain('"summary":"interrupted"');
      expect(cloneCalls).toBe(0);
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves exact /interrupt during quarantined recursive cleanup and a later turn is safe", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-harness-http-"));
    const workdir = path.join(root, validTurn.sessionId);
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, "poison"), "stale");
    let cleanupStartedResolve!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { cleanupStartedResolve = resolve; });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cloneCalls = 0;
    const filesystem: WorkdirFilesystem = {
      ...defaultWorkdirFilesystem,
      async rm(target, options) {
        cleanupStartedResolve();
        await cleanupReleased;
        await defaultWorkdirFilesystem.rm(target, options);
      },
    };
    await withServer({
      authToken: "test-secret",
      repoPolicy,
      runTurn: async (body, res, signal) => {
        const result = await ensureWorkdir(
          workdir,
          body.repo!,
          body.sessionId,
          {
            execFile(_file, args) {
              if (args[0] === "clone") cloneCalls += 1;
              return "";
            },
          },
          signal,
          filesystem,
        );
        res.write(`${JSON.stringify({
          kind: "done",
          payload: { ok: result.ok && !signal.aborted, summary: signal.aborted ? "interrupted" : "unexpected" },
        })}\n`);
      },
    }, async (baseUrl) => {
      const turnResponse = fetch(`${baseUrl}/turn`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify({
          ...validTurn,
          repo: { url: "https://github.com/wcordelo/opentag.git" },
        }),
      });
      await cleanupStarted;
      let interruptSettled = false;
      const interruptRequest = fetch(`${baseUrl}/interrupt`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify(validTurn),
      }).then((response) => {
        interruptSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Abort was delivered, but acknowledgement waits for the exact cleanup
      // and turn promise to settle.
      expect(interruptSettled).toBe(false);
      releaseCleanup();
      const interrupt = await interruptRequest;
      await expect(interrupt.json()).resolves.toEqual({ interrupted: true });
      expect(await (await turnResponse).text()).toContain('"summary":"interrupted"');
      expect(cloneCalls).toBe(0);
    });

    const later = await ensureWorkdir(
      workdir,
      { url: "https://github.com/wcordelo/opentag.git" },
      validTurn.sessionId,
      {
        execFile(_file, args) {
          if (args[0] === "clone") fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
          return "";
        },
      },
    );
    expect(later.ok).toBe(true);
    expect(fs.readdirSync(root)).toEqual([validTurn.sessionId]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves exact /interrupt while a deferred postcondition command is pending", async () => {
    let commandStartedResolve!: () => void;
    const commandStarted = new Promise<void>((resolve) => { commandStartedResolve = resolve; });
    await withServer({
      authToken: "test-secret",
      repoPolicy,
      runTurn: async (body, res, signal) => {
        const operations = {
          execFile(_file: string, args: string[], options: { signal: AbortSignal }) {
            if (args.includes("--show-current")) {
              commandStartedResolve();
              return new Promise<string>((_resolve, reject) => {
                options.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("interrupted", "AbortError")),
                  { once: true },
                );
              });
            }
            return "unused";
          },
        };
        try {
          await verifyTurnOutcome(
            { ...body, codingTask: true },
            "/work/session-1",
            { head: "base-head", tree: "base-tree" },
            operations,
            signal,
          );
          res.write(`${JSON.stringify({ kind: "done", payload: { ok: true, summary: "escaped" } })}\n`);
        } catch {
          res.write(`${JSON.stringify({ kind: "done", payload: { ok: false, summary: "interrupted" } })}\n`);
        }
      },
    }, async (baseUrl) => {
      const pendingTurn = fetch(`${baseUrl}/turn`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify(validTurn),
      });
      await commandStarted;
      const interrupt = await Promise.race([
        fetch(`${baseUrl}/interrupt`, {
          method: "POST",
          headers: { authorization: "Bearer test-secret" },
          body: JSON.stringify(validTurn),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("interrupt blocked")), 500)),
      ]);
      await expect(interrupt.json()).resolves.toEqual({ interrupted: true });
      const response = await pendingTurn;
      expect(await response.text()).toContain('"ok":false');
    });
  });

  it("does not acknowledge Stop until an in-flight authorized push outcome is known", async () => {
    let pushStartedResolve!: () => void;
    const pushStarted = new Promise<void>((resolve) => { pushStartedResolve = resolve; });
    let releasePush!: () => void;
    const pushReleased = new Promise<void>((resolve) => { releasePush = resolve; });
    let pushSawAbort = false;
    await withServer({
      authToken: "test-secret",
      repoPolicy,
      runTurn: async (_body, res, signal) => {
        // Models a credentialed git/gh subprocess whose remote outcome is
        // temporarily ambiguous even after SIGTERM has been requested.
        pushStartedResolve();
        signal.addEventListener("abort", () => { pushSawAbort = true; }, { once: true });
        await pushReleased;
        res.write(`${JSON.stringify({
          kind: "done",
          payload: { ok: !signal.aborted, summary: signal.aborted ? "push interrupted" : "push landed" },
        })}\n`);
      },
    }, async (baseUrl) => {
      const pendingTurn = fetch(`${baseUrl}/turn`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify({ ...validTurn, remoteGitApproved: true }),
      });
      await pushStarted;
      let interruptSettled = false;
      const interruptRequest = fetch(`${baseUrl}/interrupt`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify(validTurn),
      }).then((response) => {
        interruptSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(pushSawAbort).toBe(true);
      expect(interruptSettled).toBe(false);
      releasePush();
      const interrupt = await interruptRequest;
      await expect(interrupt.json()).resolves.toEqual({ interrupted: true });
      expect(await (await pendingTurn).text()).toContain('"summary":"push interrupted"');
    });
  });

  it("interrupts an exact admitted turn before response headers and cannot kill another turn", async () => {
    let admittedResolve!: () => void;
    const admitted = new Promise<void>((resolve) => { admittedResolve = resolve; });
    await withServer({
      authToken: "test-secret",
      repoPolicy,
      runTurn: async (_body, _res, signal) => {
        admittedResolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    }, async (baseUrl) => {
      const pending = fetch(`${baseUrl}/turn`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify(validTurn),
      });
      await admitted;
      const wrong = await fetch(`${baseUrl}/interrupt`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify({ ...validTurn, sessionId: "session-other" }),
      });
      expect(wrong.status).toBe(503);
      await expect(wrong.json()).resolves.toEqual({ error: "interrupt_quiescence_timeout" });
      const unauthorized = await fetch(`${baseUrl}/interrupt`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: JSON.stringify(validTurn),
      });
      expect(unauthorized.status).toBe(401);
      const stopped = await fetch(`${baseUrl}/interrupt`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify(validTurn),
      });
      await expect(stopped.json()).resolves.toEqual({ interrupted: true });
      const response = await pending;
      expect(await response.text()).not.toContain('"ok":true');
      const repeat = await fetch(`${baseUrl}/interrupt`, {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify(validTurn),
      });
      await expect(repeat.json()).resolves.toEqual({ interrupted: false });
    });
  });
  it("fails closed when server authentication is not configured", async () => {
    await withServer({ authToken: null, repoPolicy }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/turn`, {
        method: "POST",
        body: JSON.stringify(validTurn),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "harness_auth_not_configured" });
    });
  });

  it("rejects missing and invalid auth before parsing or execution", async () => {
    let runs = 0;
    await withServer(
      {
        authToken: "test-secret",
        repoPolicy,
        runTurn: async () => {
          runs += 1;
        },
      },
      async (baseUrl) => {
        const missing = await fetch(`${baseUrl}/turn`, { method: "POST", body: "not-json" });
        expect(missing.status).toBe(401);
        const invalid = await fetch(`${baseUrl}/turn`, {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
          body: JSON.stringify(validTurn),
        });
        expect(invalid.status).toBe(401);
        expect(runs).toBe(0);
      },
    );
  });

  it("rejects unsafe identifiers and disallowed repos before execution", async () => {
    let runs = 0;
    await withServer(
      { authToken: "test-secret", repoPolicy, runTurn: async () => void (runs += 1) },
      async (baseUrl) => {
        for (const body of [
          { ...validTurn, sessionId: "../../escape" },
          { ...validTurn, repo: { url: "https://github.com/other/private" } },
        ]) {
          const response = await fetch(`${baseUrl}/turn`, {
            method: "POST",
            headers: { authorization: "Bearer test-secret" },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(400);
        }
        expect(runs).toBe(0);
      },
    );
  });

  it("returns 413 for a bounded body before execution", async () => {
    let runs = 0;
    await withServer(
      { authToken: "test-secret", maxBodyBytes: 64, repoPolicy, runTurn: async () => void (runs += 1) },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/turn`, {
          method: "POST",
          headers: { authorization: "Bearer test-secret" },
          body: JSON.stringify({ ...validTurn, inputLines: ["x".repeat(100)] }),
        });
        expect(response.status).toBe(413);
        expect(runs).toBe(0);
      },
    );
  });

  it("preserves NDJSON ordering and done-last for a connected turn", async () => {
    await withServer(
      {
        authToken: "test-secret",
        repoPolicy,
        runTurn: async (_body, res) => {
          res.write(`${JSON.stringify({ kind: "output", payload: { text: "hello" } })}\n`);
          res.write(`${JSON.stringify({ kind: "done", payload: { ok: true, summary: "complete" } })}\n`);
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/turn`, {
          method: "POST",
          headers: { authorization: "Bearer test-secret" },
          body: JSON.stringify(validTurn),
        });
        expect(response.status).toBe(200);
        const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
        expect(events.map((event) => event.kind)).toEqual(["output", "done"]);
      },
    );
  });

  it("aborts the running turn when the response disconnects", async () => {
    let abortedResolve!: () => void;
    const aborted = new Promise<void>((resolve) => (abortedResolve = resolve));
    await withServer(
      {
        authToken: "test-secret",
        repoPolicy,
        runTurn: async (_body, res, signal) => {
          res.write(`${JSON.stringify({ kind: "output", payload: { text: "started" } })}\n`);
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              abortedResolve();
              resolve();
            }, { once: true });
          });
        },
      },
      async (baseUrl) => {
        const url = new URL("/turn", baseUrl);
        await new Promise<void>((resolve, reject) => {
          const request = http.request(url, {
            method: "POST",
            headers: {
              authorization: "Bearer test-secret",
              "content-type": "application/json",
            },
          });
          request.on("error", (error) => {
            if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
            else reject(error);
          });
          request.on("response", (response) => {
            response.once("data", () => {
              response.destroy();
              resolve();
            });
          });
          request.end(JSON.stringify(validTurn));
        });
        await aborted;
      },
    );
  });
});
