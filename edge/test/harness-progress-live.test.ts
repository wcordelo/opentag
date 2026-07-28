import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createHarnessProgressLiveRenderer,
  harnessProgressClientMessageId,
} from "../src/slack/harness-progress-live.js";
import { withTestLifecycleStore } from "./helpers/lifecycle-state-store.js";
import type { LifecycleStateStore } from "../src/store/state-store-contract.js";

function makeStore(): LifecycleStateStore {
  return withTestLifecycleStore({
    kv: {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
    },
    list: {
      async append() {
        return 0;
      },
      async range() {
        return [];
      },
      async trim() {},
      async delete() {},
    },
    lock: {
      async acquire() {
        return { token: "t" };
      },
      async release() {},
    },
    dedup: {
      async seen() {
        return false;
      },
    },
    queue: {
      async enqueue() {
        return 0;
      },
      async dequeue() {
        return undefined;
      },
      async depth() {
        return 0;
      },
    },
  });
}

describe("harness progress live renderer", () => {
  it("posts one stable progress message and keeps progress out of finalAnswerPrefix", async () => {
    const store = makeStore();
    const threadKey = "slack:C1:1.0";
    const executionId = "exec-live-1";
    await store.activeTurn.register({
      channelId: "C1",
      threadKey,
      conversationKey: "C1::1.0",
      executionId,
      threadTs: "1.0",
      registeredAt: Date.now(),
    });
    const postMessage = vi.fn(async () => ({ ts: "progress-ts" }));
    const updateMessage = vi.fn(async () => undefined);
    let clock = 1_000;
    const live = createHarnessProgressLiveRenderer({
      store,
      client: { postMessage, updateMessage } as never,
      channelId: "C1",
      threadTs: "1.0",
      threadKey,
      executionId,
      now: () => clock,
    });

    await live.handleEvent({
      kind: "context",
      payload: {
        harnessType: "claudecode",
        model: "claude-opus-5",
        modelEvidence: "container_argument",
      },
    });
    await live.handleEvent({
      kind: "progress",
      payload: {
        progressId: "tool-1",
        sequence: 1,
        category: "tool",
        state: "started",
        title: "Read",
        summary: "a.ts",
      },
    });
    // First post is context-only (progress coalesced under rate limit).
    expect(postMessage).toHaveBeenCalledTimes(1);
    const firstPost = (postMessage.mock.calls as unknown as Array<[
      { client_msg_id?: string; text?: string },
    ]>)[0]?.[0];
    expect(firstPost).toMatchObject({
      client_msg_id: harnessProgressClientMessageId(executionId),
      text: expect.stringContaining("container argument"),
    });
    expect(live.finalAnswerPrefix()).toContain("container argument");
    expect(live.finalAnswerPrefix()).not.toContain("Coding progress");

    clock = 2_000;
    await live.handleEvent({
      kind: "progress",
      payload: {
        progressId: "tool-1",
        sequence: 2,
        category: "tool",
        state: "completed",
        title: "Tool",
      },
    });
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const progressUpdate = (updateMessage.mock.calls as unknown as Array<[
      { text?: string },
    ]>)[0]?.[0];
    expect(progressUpdate?.text).toContain("Coding progress");
    expect(progressUpdate?.text).toContain("Read");

    await live.markTerminal({ ok: true });
    expect(updateMessage).toHaveBeenCalledTimes(2);
    const terminalUpdate = (updateMessage.mock.calls as unknown as Array<[
      { text?: string },
    ]>)[1]?.[0];
    expect(terminalUpdate?.text).toContain("Complete");
  });

  it("ignores equal-or-lower modelEvidence for live context", async () => {
    const store = makeStore();
    const threadKey = "slack:C1:2.0";
    const executionId = "exec-live-2";
    await store.activeTurn.register({
      channelId: "C1",
      threadKey,
      conversationKey: "C1::2.0",
      executionId,
      threadTs: "2.0",
      registeredAt: Date.now(),
    });
    const live = createHarnessProgressLiveRenderer({
      store,
      client: {
        postMessage: vi.fn(async () => ({ ts: "progress-ts" })),
        updateMessage: vi.fn(async () => undefined),
      } as never,
      channelId: "C1",
      threadTs: "2.0",
      threadKey,
      executionId,
    });

    await live.handleEvent({
      kind: "context",
      payload: {
        harnessType: "claudecode",
        model: "strong-model",
        modelEvidence: "provider_reported",
      },
    });
    await live.handleEvent({
      kind: "context",
      payload: {
        harnessType: "claudecode",
        model: "same-rank-other-model",
        modelEvidence: "provider_reported",
      },
    });
    await live.handleEvent({
      kind: "context",
      payload: {
        harnessType: "claudecode",
        model: "weaker-model",
        modelEvidence: "unknown",
      },
    });
    expect(live.finalAnswerPrefix()).toContain("strong-model");
    expect(live.finalAnswerPrefix()).toContain("provider confirmed");
    expect(live.finalAnswerPrefix()).not.toContain("same-rank-other-model");
    expect(live.finalAnswerPrefix()).not.toContain("weaker-model");
  });
});

describe("overlay digest verification", () => {
  it("rejects mismatched overlay digests in turn-contract", async () => {
    const { validateTurnRequest } = await import("../workers/sandbox/turn-contract.js");
    const text = "Admin overlay text";
    const digest = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    const base = {
      sessionId: "session1",
      executionId: `ot1e_${"A".repeat(43)}`,
      threadKey: "slack:C1:1.0",
      inputLines: ["hi"],
      contractVersion: 2 as const,
      systemPromptOverlay: {
        version: 1 as const,
        revision: 1,
        digest: "sha256:" + "0".repeat(64),
        text,
        source: "workspace_admin" as const,
      },
    };
    expect(
      await validateTurnRequest(base, {
        allowedHosts: new Set(["github.com"]),
        allowedOrgs: new Set(["acme"]),
      }),
    ).toEqual({ ok: false, error: "invalid_system_prompt_overlay" });
    expect(
      await validateTurnRequest(
        {
          ...base,
          systemPromptOverlay: { ...base.systemPromptOverlay, digest },
        },
        {
          allowedHosts: new Set(["github.com"]),
          allowedOrgs: new Set(["acme"]),
        },
      ),
    ).toMatchObject({ ok: true });
  });
});
