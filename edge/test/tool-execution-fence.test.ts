import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderable } from "@copilotkit/channels-ui";
import type { BotTool } from "@copilotkit/channels";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

type HitlRecord = { value: unknown; at: number };
const state = vi.hoisted(() => ({
  status: "pending" as string,
  choiceIds: new Set<string>(),
  receipts: new Map<string, HitlRecord>(),
  cancelled: new Set<string>(),
  stopOnAwait: false,
  stopOnPost: false,
  effectToken: undefined as string | undefined,
  effectName: undefined as string | undefined,
  stopEventId: undefined as string | undefined,
  effectResource: undefined as unknown,
  effectSequence: 0,
  confirmEffectBarrier: undefined as Promise<void> | undefined,
  effectConfirmationEntered: undefined as (() => void) | undefined,
  exact: { threadKey: "slack:C1:1.0", executionId: "exec-tools" },
}));

const store = {
  activeTurn: {
    async get() {
      return {
        record: { ...state.exact },
        status: state.status,
        effectToken: state.effectToken,
        effectName: state.effectName,
        effectResource: state.effectResource,
        stopEventId: state.stopEventId,
        updatedAt: Date.now(),
      };
    },
    async beginEffect(args: { effectName: string }) {
      if (state.status !== "pending") return { status: "cancelled" as const };
      if (state.effectToken) return { status: "in_flight" as const };
      state.effectToken = `effect-${++state.effectSequence}`;
      state.effectName = args.effectName;
      return { status: "claimed" as const, token: state.effectToken };
    },
    async confirmEffect(args: { token: string; resource?: unknown }) {
      if (state.effectToken !== args.token) return false;
      state.effectConfirmationEntered?.();
      await state.confirmEffectBarrier;
      state.effectResource = args.resource;
      state.effectToken = undefined;
      state.effectName = undefined;
      if (state.stopEventId) state.status = "cancelled";
      return true;
    },
    async failEffect(args: { token: string }) {
      if (state.effectToken !== args.token) return false;
      state.effectToken = undefined;
      state.effectName = undefined;
      return true;
    },
    async claimCancellation() {
      if (state.effectToken) {
        state.stopEventId = "stop-1";
        return "in_flight" as const;
      }
      if (state.status !== "pending") return "retry" as const;
      state.status = "cancelled";
      return "claimed" as const;
    },
    async registerChoice(args: { choiceId: string }) {
      if (state.status !== "pending") return "cancelled" as const;
      state.choiceIds.add(args.choiceId);
      return "registered" as const;
    },
    async unregisterChoice(args: { choiceId: string }) {
      return state.choiceIds.delete(args.choiceId);
    },
  },
  hitl: {
    async prepareChoice(args: { choiceKey: string; cancelledKey: string }) {
      const choiceId = args.choiceKey.slice("hitl-id:".length);
      if (state.cancelled.has(choiceId)) {
        return { status: "cancelled" as const, record: state.receipts.get(choiceId)! };
      }
      state.receipts.delete(choiceId);
      return { status: "ready" as const };
    },
    async consumeChoice(args: { choiceKey: string }) {
      const choiceId = args.choiceKey.slice("hitl-id:".length);
      const record = state.receipts.get(choiceId);
      if (!record) return { status: "pending" as const };
      if (!state.cancelled.has(choiceId)) state.receipts.delete(choiceId);
      return {
        status: state.cancelled.has(choiceId) ? "cancelled" as const : "choice" as const,
        record,
      };
    },
  },
  kv: {
    async get() { return undefined; },
    async set() {},
    async delete() {},
  },
};

vi.mock("../src/store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/index.js")>();
  return { ...actual, createDurableObjectStore: () => store };
});

const { ALL_EDGE_TOOLS, bindToolEnv } = await import("../src/tools/index.js");
const { bindTurnExecutionContext, resetTurnExecutionContext } = await import(
  "../src/slack/turn-execution-context.js"
);
const { bindRequestContext, resetRequestContext } = await import(
  "../src/request-context.js"
);

function tool(name: string): BotTool {
  const found = ALL_EDGE_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found as BotTool;
}

function choiceThread() {
  const post = vi.fn(async () => {
    if (state.stopOnPost) {
      state.status = "cancelled";
      throw new Error("active_turn_render_suppressed");
    }
    return { id: "posted" };
  });
  const react = vi.fn(async () => ({ ok: true }));
  const thread = {
    conversationKey: "C1::1.0",
    post,
    react,
    getMessages: vi.fn(async () => []),
    awaitChoice: vi.fn(async <T>(_ui: Renderable): Promise<T> => {
      const choiceId = [...state.choiceIds].at(-1)!;
      if (state.stopOnAwait) {
        state.status = "cancelled";
        state.cancelled.add(choiceId);
        state.receipts.set(choiceId, {
          value: { confirmed: false, choiceId },
          at: Date.now(),
        });
      } else {
        state.receipts.set(choiceId, {
          value: { confirmed: true, choiceId },
          at: Date.now(),
        });
      }
      // Exact production choices must ignore this isolate-local affirmative.
      return { confirmed: true, action: "ack", choiceId } as T;
    }),
  };
  bindTurnExecutionContext(thread, state.exact);
  bindRequestContext(thread, {
    teamId: "T1",
    requesterId: "U1",
    inbound: { channel: "C1", ts: "1.1", threadTs: "1.0" },
  });
  return { thread, post, react };
}

describe("exact execution tool guards", () => {
  beforeEach(() => {
    state.status = "pending";
    state.choiceIds.clear();
    state.receipts.clear();
    state.cancelled.clear();
    state.stopOnAwait = false;
    state.stopOnPost = false;
    state.effectToken = undefined;
    state.effectName = undefined;
    state.stopEventId = undefined;
    state.effectResource = undefined;
    state.effectSequence = 0;
    state.confirmEffectBarrier = undefined;
    state.effectConfirmationEntered = undefined;
    resetTurnExecutionContext();
    resetRequestContext();
    bindToolEnv({ BOT_STATE: {} } as never);
  });

  it("does not return approval when Stop suppresses the post-click acknowledgement", async () => {
    const { thread } = choiceThread();
    state.stopOnPost = true;
    await expect(tool("confirm_write").handler(
      { action: "Create Linear issue", title: "T" },
      { thread, platform: "slack" } as never,
    )).rejects.toThrow("active_turn_tool_suppressed");
  });

  it("Stop during confirm_write denies the stale affirmative and suppresses the next tool", async () => {
    const { thread, post } = choiceThread();
    state.stopOnAwait = true;
    await expect(tool("confirm_write").handler(
      { action: "Create Linear issue", title: "T" },
      { thread, platform: "slack" } as never,
    )).resolves.toMatch(/DECLINED/);
    expect(post).not.toHaveBeenCalled();
    await expect(tool("issue_card").handler(
      { identifier: "X-1", title: "must not land" },
      { thread, platform: "slack" } as never,
    )).rejects.toThrow("active_turn_tool_suppressed");
  });

  it("Stop during show_incident prevents its stale action acknowledgement", async () => {
    const { thread, post } = choiceThread();
    state.stopOnAwait = true;
    await expect(tool("show_incident").handler(
      { id: "INC-1", title: "Database", severity: "SEV1", status: "open" },
      { thread, platform: "slack", user: { id: "U1" } } as never,
    )).rejects.toThrow("active_turn_tool_suppressed");
    expect(post).not.toHaveBeenCalled();
  });

  it("react_message uses the fenced Thread.react capability with an exact MessageRef", async () => {
    const { thread, react } = choiceThread();
    await expect(tool("react_message").handler(
      { emoji: "eyes", messageTs: "123.456" },
      { thread, platform: "slack" } as never,
    )).resolves.toMatchObject({ ok: true, ts: "123.456" });
    expect(react).toHaveBeenCalledWith({ id: "123.456" }, "eyes");
  });

  it("does not allow Stop acknowledgement while start_task is crossing its mutation fence", async () => {
    const { thread } = choiceThread();
    let releaseConfirmation!: () => void;
    let confirmationEntered!: () => void;
    state.confirmEffectBarrier = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      confirmationEntered = resolve;
    });
    state.effectConfirmationEntered = confirmationEntered;
    const fetch = vi.fn(async () => Response.json({
      taskId: "task-1",
      status: "forwarded",
    }));
    bindToolEnv({
      BOT_STATE: {},
      RESEARCH_TASKS: { fetch },
    } as never);

    const pending = tool("start_task").handler(
      { objective: "race the mutation" },
      { thread, platform: "slack" } as never,
    );
    await entered;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.effectName).toBe("start_task");
    await expect(store.activeTurn.claimCancellation()).resolves.toBe("in_flight");

    releaseConfirmation();
    await expect(pending).rejects.toThrow("active_turn_tool_suppressed");
    expect(state.effectResource).toMatchObject({
      kind: "research_task",
      teamId: "T1",
      taskId: "task-1",
      threadKey: "slack:C1:1.0",
    });
    await expect(store.activeTurn.claimCancellation()).resolves.toBe("retry");
    await expect(tool("start_task").handler(
      { objective: "must not start" },
      { thread, platform: "slack" } as never,
    )).rejects.toThrow("active_turn_tool_suppressed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not allow Stop acknowledgement while memory_write is crossing its mutation fence", async () => {
    const { thread } = choiceThread();
    let releaseConfirmation!: () => void;
    let confirmationEntered!: () => void;
    state.confirmEffectBarrier = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      confirmationEntered = resolve;
    });
    state.effectConfirmationEntered = confirmationEntered;
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    bindToolEnv({
      BOT_STATE: {},
      KNOWLEDGE: {
        idFromName: () => ({ id: "knowledge" }),
        get: () => ({ fetch }),
      },
    } as never);

    const pending = tool("memory_write").handler(
      { title: "Decision", body: "Keep the fence durable" },
      { thread, platform: "slack" } as never,
    );
    await entered;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.effectName).toBe("memory_write");
    await expect(store.activeTurn.claimCancellation()).resolves.toBe("in_flight");

    releaseConfirmation();
    await expect(pending).rejects.toThrow("active_turn_tool_suppressed");
    await expect(store.activeTurn.claimCancellation()).resolves.toBe("retry");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the effect token when a task-start transport outcome is ambiguous", async () => {
    const { thread } = choiceThread();
    const fetch = vi.fn(async () => {
      throw new TypeError("connection reset after dispatch");
    });
    bindToolEnv({
      BOT_STATE: {},
      RESEARCH_TASKS: { fetch },
    } as never);

    await expect(tool("start_task").handler(
      { objective: "ambiguous task" },
      { thread, platform: "slack" } as never,
    )).rejects.toThrow("connection reset");
    expect(state.effectToken).toBeDefined();
    await expect(store.activeTurn.claimCancellation()).resolves.toBe("in_flight");
  });

  it("cancels the exact returned task before confirming an already-recorded Stop", async () => {
    const { thread } = choiceThread();
    const fetch = vi.fn(async (url: RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith("/research")) {
        state.stopEventId = "stop-during-launch";
        return Response.json({ taskId: "task-raced", status: "continuing" });
      }
      expect(String(url)).toBe("https://research/internal/tasks/task-raced/cancel");
      expect(JSON.parse(String(init?.body))).toEqual({
        teamId: "T1",
        threadKey: "slack:C1:1.0",
      });
      return Response.json({ cancelled: true, quiescent: true, taskId: "task-raced" });
    });
    bindToolEnv({ BOT_STATE: {}, RESEARCH_TASKS: { fetch } } as never);

    await expect(tool("start_task").handler(
      { objective: "stop this exact task" },
      { thread, platform: "slack" } as never,
    )).rejects.toThrow("active_turn_tool_suppressed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.effectToken).toBeUndefined();
  });

  it("keeps Stop silent when exact task cancellation transport fails", async () => {
    const { thread } = choiceThread();
    const fetch = vi.fn(async (url: RequestInfo) => {
      if (String(url).endsWith("/research")) {
        state.stopEventId = "stop-during-launch";
        return Response.json({ taskId: "task-raced", status: "continuing" });
      }
      throw new TypeError("cancel transport reset");
    });
    bindToolEnv({ BOT_STATE: {}, RESEARCH_TASKS: { fetch } } as never);

    await expect(tool("start_task").handler(
      { objective: "ambiguous cancel" },
      { thread, platform: "slack" } as never,
    )).rejects.toThrow("cancel transport reset");
    expect(state.effectToken).toBeDefined();
    await expect(store.activeTurn.claimCancellation()).resolves.toBe("in_flight");
  });
});
