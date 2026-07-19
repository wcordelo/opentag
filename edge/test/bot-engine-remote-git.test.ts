import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderable } from "@copilotkit/channels-ui";
import type { LifecycleStateStore, StateStore } from "../src/store/state-store-contract.js";
import { persistHitlChoice } from "../src/hitl/durable-choice.js";
import { withTestLifecycleStore } from "./helpers/lifecycle-state-store.js";

let mentionHandler: ((args: { thread: unknown; message: unknown }) => Promise<void>) | undefined;

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

vi.mock("@copilotkit/channels", () => ({
  createBot: vi.fn(() => ({
    onMention(handler: typeof mentionHandler) {
      mentionHandler = handler;
    },
    async start() {},
  })),
}));

vi.mock("@ag-ui/client", () => ({ HttpAgent: class {} }));

function makeStore(): LifecycleStateStore & {
  obligation: {
    set: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
} {
  const values = new Map<string, unknown>();
  return withTestLifecycleStore({
    kv: {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async set<T>(key: string, value: T) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    },
    hitl: {
      async prepareChoice(args) {
        if (values.has(args.cancelledKey)) {
          return { status: "cancelled", record: values.get(args.choiceKey) };
        }
        values.delete(args.choiceKey);
        return { status: "ready" };
      },
      async consumeChoice(args) {
        if (!values.has(args.choiceKey)) return { status: "pending" };
        const record = values.get(args.choiceKey);
        if (!values.has(args.cancelledKey)) values.delete(args.choiceKey);
        return {
          status: values.has(args.cancelledKey) ? "cancelled" : "choice",
          record,
        };
      },
      async persistChoiceUnlessCancelled(args) {
        if (values.has(args.cancelledKey)) return "cancelled";
        values.set(args.choiceKey, args.record);
        return "persisted";
      },
      async cancelChoice(args) {
        values.set(args.choiceKey, args.denial);
        values.set(args.cancelledKey, true);
      },
    },
    list: {
      async append() { return 0; },
      async range() { return []; },
      async trim() {},
      async delete() {},
    },
    lock: {
      async acquire() { return { token: "t" }; },
      async release() {},
    },
    dedup: { async seen() { return false; } },
    queue: {
      async enqueue() { return 0; },
      async dequeue() { return undefined; },
      async depth() { return 0; },
    },
    obligation: {
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
    },
  } as StateStore & {
    obligation: {
      set: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
  });
}

let store = makeStore();

vi.mock("../src/create-bot-store.js", () => ({
  createBotStoreAdapter: () => store,
}));

const setStatus = vi.fn(async () => undefined);
const reactMock = vi.hoisted(() => vi.fn(async () => true));
const adapterOptionsMock = vi.hoisted(() => vi.fn());
vi.mock("../src/slack/cloudflare-slack-adapter.js", () => ({
  markThreadNextRenderFinal: vi.fn((thread: { __testFinal?: boolean }) => {
    thread.__testFinal = true;
  }),
  CloudflareSlackAdapter: class {
    constructor(options: unknown) {
      adapterOptionsMock(options);
    }
    setStatus = setStatus;
    bindThreadExecutionFence() {}
    async react(
      _conversationKey: string,
      _emoji: string,
      _target: unknown,
      fence?: { threadKey: string; executionId: string },
      final = false,
    ) {
      const result = await reactMock();
      if (result && final && fence) {
        const claim = await store.activeTurn.beginRender(fence);
        if (claim.status === "claimed") {
          await store.activeTurn.confirmRender({
            ...fence,
            token: claim.token,
            final: true,
            output: true,
          });
        }
      }
      return result;
    }
  },
}));

const memoryWriteMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/memory/knowledge-do.js", () => ({
  memoryWrite: (...args: unknown[]) =>
    (memoryWriteMock as (...values: unknown[]) => Promise<undefined>)(...args),
}));
const startTaskMock = vi.hoisted(() => vi.fn(async () => ({
  status: "accepted",
  taskId: "research-1",
})));
vi.mock("../src/tasks/runtime.js", () => ({
  startTask: (...args: unknown[]) =>
    (startTaskMock as (...values: unknown[]) => Promise<{ status: string; taskId: string }>)(...args),
}));

vi.mock("../src/tools/index.js", () => ({
  ALL_EDGE_TOOLS: [],
  ALL_EDGE_TOOL_NAMES: ["memory_write", "start_task", "research_progress"],
  bindToolEnv: vi.fn(),
}));
vi.mock("../src/commands/index.js", () => ({
  edgeCommands: [],
  bindCommandEnv: vi.fn(),
}));
vi.mock("../src/config/access-bundle.js", () => ({
  resolveAllowedTools: (names: string[]) => names,
}));
vi.mock("../src/config/workspace-config-do.js", () => ({
  loadTurnAccess: async () => ({
    config: { policies: {} },
    bundle: { tools: [] },
  }),
}));
vi.mock("../src/request-context.js", () => ({
  copyRequestContext: () => ({
    teamId: "T1",
    actor: { kind: "slack_user", userId: "U123" },
    requesterId: "U123",
    inbound: { channel: "C1", ts: "111.333", threadTs: "111.222" },
    preAdmittedTurn: {
      record: {
        channelId: "C1",
        threadKey: "slack:C1:111.222",
        conversationKey: "C1::111.222",
        executionId: "slack:C1:111.333",
        threadTs: "111.222",
        registeredAt: 1,
      },
    },
  }),
  requireRequestContext: () => ({
    teamId: "T1",
    actor: { kind: "slack_user", userId: "U123" },
    requesterId: "U123",
    inbound: { channel: "C1", ts: "111.333", threadTs: "111.222" },
    preAdmittedTurn: {
      record: {
        channelId: "C1",
        threadKey: "slack:C1:111.222",
        conversationKey: "C1::111.222",
        executionId: "slack:C1:111.333",
        threadTs: "111.222",
        registeredAt: 1,
      },
    },
  }),
  slackTurnIdentity: (context: { inbound: { ts: string } }, channel: string) => ({
    executionId: `slack:${channel}:${context.inbound.ts}`,
    forwardedMessageId: `slack:${channel}:${context.inbound.ts}`,
  }),
}));
vi.mock("../src/slack/inbound-target.js", () => ({
  getInboundMessage: () => ({
    channel: "C1",
    ts: "111.333",
    threadTs: "111.222",
  }),
  bindInboundToThread: vi.fn(),
}));

const runBundledAgentTurn = vi.fn(
  async (..._args: unknown[]): Promise<
    | { status: "completed" | "interrupted" }
    | { status: "completed"; terminalPersisted: true }
    | { status: "rejected"; reason: "duplicate" | "concurrent" }
    | undefined
  > =>
    undefined,
);
vi.mock("../src/agent-turn.js", () => ({ runBundledAgentTurn }));

const { getOrCreateBot, resetBotSingleton } = await import("../src/bot-engine.js");
const { handleStopCommand } = await import("../src/slack/stop-routing.js");
const { postTurnRejectedFeedback } = await import("../src/slack/turn-lifecycle.js");

function findChoiceId(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const record = node as { props?: { value?: unknown; children?: unknown } };
  const value = record.props?.value;
  if (value && typeof value === "object") {
    const choiceId = (value as { choiceId?: unknown }).choiceId;
    if (typeof choiceId === "string") return choiceId;
  }
  const children = record.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findChoiceId(child);
      if (found) return found;
    }
  } else {
    return findChoiceId(children);
  }
  return undefined;
}

function allCardText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return Array.isArray(children)
    ? children.map(allCardText).join("\n")
    : allCardText(children);
}

function makeThread(confirmed: boolean) {
  const awaitChoice = vi.fn(async <T>(ui: Renderable): Promise<T> => {
    const choiceId = findChoiceId(ui);
    if (!choiceId) throw new Error("approval card did not include choiceId");
    const value = { confirmed, choiceId };
    // Production Slack interactivity persists before invoking the local sink.
    await persistHitlChoice(store, "C1::111.222", value);
    return value as T;
  });
  const thread: {
    conversationKey: string;
    awaitChoice: typeof awaitChoice;
    post: ReturnType<typeof vi.fn>;
    __testFinal?: boolean;
  } = {
    conversationKey: "C1::111.222",
    awaitChoice,
    post: vi.fn(async (_ui?: unknown) => {
      if (!thread.__testFinal) return;
      const active = await store.activeTurn.latest("C1");
      if (active) {
        await store.activeTurn.lifecycleComplete({
          threadKey: active.record.threadKey,
          executionId: active.record.executionId,
        });
      }
    }),
  };
  return thread;
}

async function emitMention(
  text: string,
  confirmed = true,
  envOverrides: Record<string, unknown> = {},
) {
  const thread = makeThread(confirmed);
  await store.activeTurn.register({
    channelId: "C1",
    threadKey: "slack:C1:111.222",
    conversationKey: "C1::111.222",
    executionId: "slack:C1:111.333",
    threadTs: "111.222",
    registeredAt: 1,
  });
  await getOrCreateBot({
    SLACK_BOT_TOKEN: "xoxb-test",
    AGENT_URL: "https://agent.example.com",
    HARNESS_URL: "https://harness.example.com",
    HARNESS_REPO_URL: "https://github.com/acme/widget.git",
    BOT_STATE: {} as never,
    WORKSPACE_CONFIG: {} as never,
    ...envOverrides,
  } as never);
  if (!mentionHandler) throw new Error("mention handler was not registered");
  await mentionHandler({
    thread,
    message: {
      text,
      user: { id: "U123", handle: "requester" },
    },
  });
  return thread;
}

describe("production Slack remote-git ingress", () => {
  beforeEach(() => {
    store = makeStore();
    mentionHandler = undefined;
    runBundledAgentTurn.mockClear();
    setStatus.mockClear();
    reactMock.mockClear();
    reactMock.mockResolvedValue(true);
    adapterOptionsMock.mockClear();
    memoryWriteMock.mockReset();
    memoryWriteMock.mockResolvedValue(undefined);
    startTaskMock.mockReset();
    startTaskMock.mockResolvedValue({ status: "accepted", taskId: "research-1" });
    resetBotSingleton();
    runBundledAgentTurn.mockResolvedValue(undefined);
  });

  it("pins the configured Slack bot identity on the adapter", async () => {
    await getOrCreateBot({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_BOT_USER_ID: "UOPENTAG",
      AGENT_URL: "https://agent.example.com",
      BOT_STATE: {} as never,
      WORKSPACE_CONFIG: {} as never,
    } as never);

    expect(adapterOptionsMock).toHaveBeenCalledOnce();
    expect(adapterOptionsMock.mock.calls[0]![0]).toMatchObject({
      botUserId: "UOPENTAG",
    });
  });

  it("explains that a concurrent turn may be waiting on approval", async () => {
    const originalFetch = globalThis.fetch;
    let postedText = "";
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedText = new URLSearchParams(String(init?.body ?? "")).get("text") ?? "";
      return Response.json({ ok: true, ts: "222.333" });
    });
    try {
      await postTurnRejectedFeedback(
        { SLACK_BOT_TOKEN: "xoxb-test" } as never,
        store as never,
        {
          reason: "concurrent",
          channelId: "C1",
          threadTs: "111.222",
          threadKey: "slack:C1:111.222",
        },
      );
      expect(postedText).toContain("active turn");
      expect(postedText).toContain("waiting on an approval card");
      expect(postedText).toContain("send *Stop*");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("terminalizes trivial reaction and post shortcuts without launching an agent", async () => {
    const reacted = await emitMention("thanks!");
    expect(reactMock).toHaveBeenCalledOnce();
    expect(reacted.post).not.toHaveBeenCalled();
    expect(await store.activeTurn.latest("C1")).toBeUndefined();
    expect(runBundledAgentTurn).not.toHaveBeenCalled();

    store = makeStore();
    resetBotSingleton();
    mentionHandler = undefined;
    reactMock.mockResolvedValueOnce(false);
    const posted = await emitMention("ok great thank you");
    expect(posted.post).toHaveBeenCalledOnce();
    expect(await store.activeTurn.latest("C1")).toBeUndefined();
    expect(runBundledAgentTurn).not.toHaveBeenCalled();
  });

  it("fences mention memory/research mutations and atomically finalizes their replies", async () => {
    const remembered = await emitMention("remember: production uses Durable Objects");
    expect(memoryWriteMock).toHaveBeenCalledOnce();
    expect(remembered.post).toHaveBeenCalledWith("💾 Saved to channel knowledge.");
    expect(await store.activeTurn.latest("C1")).toBeUndefined();

    store = makeStore();
    resetBotSingleton();
    mentionHandler = undefined;
    const researched = await emitMention("research: durable cancellation semantics");
    expect(startTaskMock).toHaveBeenCalledOnce();
    expect(researched.post).toHaveBeenCalledWith(expect.stringContaining("Research accepted"));
    expect(await store.activeTurn.latest("C1")).toBeUndefined();
    expect(runBundledAgentTurn).not.toHaveBeenCalled();
  });

  it("suppresses a shortcut reply when Stop lands during its claimed mutation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    memoryWriteMock.mockImplementationOnce(async () => {
      await blocked;
      return undefined;
    });
    const thread = makeThread(true);
    await store.activeTurn.register({
      channelId: "C1",
      threadKey: "slack:C1:111.222",
      conversationKey: "C1::111.222",
      executionId: "slack:C1:111.333",
      threadTs: "111.222",
      registeredAt: 1,
    });
    await getOrCreateBot({
      SLACK_BOT_TOKEN: "xoxb-test",
      AGENT_URL: "https://agent.example.com",
      BOT_STATE: {} as never,
      WORKSPACE_CONFIG: {} as never,
      KNOWLEDGE: {} as never,
    } as never);
    const pending = mentionHandler!({
      thread,
      message: { text: "remember: stop-safe", user: { id: "U123" } },
    });
    await vi.waitFor(() => expect(memoryWriteMock).toHaveBeenCalledOnce());
    expect(await store.activeTurn.claimCancellation({
      threadKey: "slack:C1:111.222",
      executionId: "slack:C1:111.333",
      stopEventId: "EvShortcutStop",
    })).toBe("effect_in_flight");
    release();
    await pending;
    expect(thread.post).not.toHaveBeenCalled();
    expect(await store.activeTurn.latest("C1")).toMatchObject({
      status: "cancelled",
      stopEventId: "EvShortcutStop",
    });
    expect(runBundledAgentTurn).not.toHaveBeenCalled();
  });

  it("passes affirmative approval and stable Slack identities to the bundled turn", async () => {
    const thread = await emitMention("--claude make a script to normalize files");

    expect(thread.awaitChoice).toHaveBeenCalledTimes(1);
    const cardText = allCardText(thread.awaitChoice.mock.calls[0]![0]);
    expect(cardText).toContain("github.com/acme/widget.git");
    expect(cardText).toContain("dedicated temporary branch");
    expect(cardText).toContain("open a GitHub pull request");
    expect(cardText).toContain("@requester");
    expect(cardText).toContain("Approve push + PR");
    expect(cardText).toContain("Cancel");
    expect(cardText).toContain("This turn pauses here");
    expect(cardText).toContain("Follow-up messages in this thread are rejected");
    expect(thread.post).toHaveBeenCalledWith(
      "✅ GitHub push + PR approved. Starting the coding turn…",
    );
    expect(runBundledAgentTurn).toHaveBeenCalledTimes(1);
    expect(runBundledAgentTurn.mock.calls[0]![4]).toEqual({
      executionId: "slack:C1:111.333",
      forwardedMessageId: "slack:C1:111.333",
      remoteGitApproved: true,
      createPullRequest: true,
    });
  });

  it("passes false flags after cancel", async () => {
    const thread = await emitMention("--claude fix the worker test", false);
    expect(thread.awaitChoice).toHaveBeenCalledTimes(1);
    expect(runBundledAgentTurn.mock.calls[0]![4]).toMatchObject({
      remoteGitApproved: false,
      createPullRequest: false,
    });
    expect(thread.post).toHaveBeenCalledWith(
      "ℹ️ Remote Git writes remain disabled. Continuing the coding turn locally…",
    );
  });

  it.each([
    ["--claude explain the router", false],
    ["--claude review the API implementation", false],
    ["--claude inspect the deploy script", false],
    ["--claude edit what repository?", false],
    ["--claude repair the router", true],
    ["--claude test the build", true],
    ["--claude take care of the repository", true],
  ])("uses shared coding intent for approval UI: %s", async (text, codingTask) => {
    const thread = await emitMention(text);
    expect(thread.awaitChoice).toHaveBeenCalledTimes(codingTask ? 1 : 0);
  });

  it("Stop during durable approval makes a later approval incapable of starting the harness", async () => {
    let approve!: (value: unknown) => void;
    const approval = new Promise<unknown>((resolve) => { approve = resolve; });
    const thread = {
      conversationKey: "C1::111.222",
      awaitChoice: vi.fn(async (ui: Renderable) => {
        const choiceId = findChoiceId(ui);
        if (!choiceId) throw new Error("approval card did not include choiceId");
        const value = await approval as { confirmed: boolean };
        return { ...value, choiceId };
      }),
      post: vi.fn(async (_ui?: unknown) => undefined),
    };
    let cancelled = false;
    const execute = vi.fn(async () =>
      cancelled
        ? { accepted: false, duplicate: false, cancelled: true }
        : { accepted: true, duplicate: false },
    );
    const interrupt = vi.fn(async () => ({ interrupted: false }));
    const interruptExpected = vi.fn(async () => {
      cancelled = true;
      return { interrupted: false, cancelled: true as const };
    });
    const env = {
      SLACK_BOT_TOKEN: "xoxb-test",
      AGENT_URL: "https://agent.example.com",
      HARNESS_URL: "https://harness.example.com",
      HARNESS_REPO_URL: "https://github.com/acme/widget.git",
      BOT_STATE: {} as never,
      WORKSPACE_CONFIG: {} as never,
      SESSION_EVENTS: {
        idFromName: (name: string) => name,
        get: () => ({ replay: async () => [], execute, interrupt, interruptExpected }),
      },
    } as never;
    const originalFetch = globalThis.fetch;
    const slackCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = url instanceof Request ? url.url : String(url);
      slackCalls.push(requestUrl);
      if (new URL(requestUrl).pathname === "/opentag/control/interrupt") {
        const body = url instanceof Request
          ? await url.clone().json() as { executionId?: string }
          : JSON.parse(String(init?.body ?? "{}")) as { executionId?: string };
        return Response.json({
          accepted: true,
          quiescent: true,
          executionId: body.executionId,
        });
      }
      return Response.json({ ok: true, ts: "222.333" });
    });
    try {
      await store.activeTurn.register({
        channelId: "C1",
        threadKey: "slack:C1:111.222",
        conversationKey: "C1::111.222",
        executionId: "slack:C1:111.333",
        threadTs: "111.222",
        registeredAt: 1,
      });
      await getOrCreateBot(env);
      const pending = mentionHandler!({
        thread,
        message: {
          text: "--claude fix the worker test",
          user: { id: "U123", handle: "requester" },
        },
      });
      await vi.waitFor(() => expect(thread.awaitChoice).toHaveBeenCalledOnce());

      await handleStopCommand(
        env,
        {
          type: "message",
          channel: "C1",
          user: "U123",
          text: "stop",
          ts: "111.444",
          thread_ts: "111.222",
        },
        "EvStopApproval",
      );
      runBundledAgentTurn.mockImplementationOnce(async () => {
        const claim = await execute();
        return claim.cancelled
          ? { status: "interrupted" as const }
          : { status: "completed" as const };
      });
      approve({ confirmed: true });
      await pending;

      expect(interruptExpected).toHaveBeenCalledWith("slack:C1:111.333");
      expect(interrupt).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(runBundledAgentTurn).not.toHaveBeenCalled();
      expect(slackCalls.filter((url) => url.includes("chat.postMessage"))).toHaveLength(1);
      expect(thread.post).not.toHaveBeenCalled();
      expect(store.obligation.clear).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not gate a read-only harness question", async () => {
    const thread = await emitMention("--claude explain how this script works");
    expect(thread.awaitChoice).not.toHaveBeenCalled();
    expect(runBundledAgentTurn.mock.calls[0]![4]).toMatchObject({
      remoteGitApproved: false,
      createPullRequest: false,
    });
  });

  it("records an interrupted turn without a completion metric or final error post", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    runBundledAgentTurn.mockResolvedValueOnce({ status: "interrupted" });

    const thread = await emitMention("--claude explain the worker");

    expect(logs.some((line) => line.includes('"metric":"turn_interrupted"'))).toBe(true);
    expect(logs.some((line) => line.includes('"metric":"turn_completed"'))).toBe(false);
    expect(thread.post).not.toHaveBeenCalled();
    // A newly admitted exact redelivery can observe an existing SessionEvent
    // cancellation tombstone only after the earlier visibly-confirmed Stop
    // cleared its original active row. Do not leave that redelivery blocking
    // the next unrelated execution.
    expect(store.obligation.clear).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });

  it("does not mark a duplicate harness outcome completed", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    runBundledAgentTurn.mockResolvedValueOnce({ status: "rejected", reason: "duplicate" });

    const thread = await emitMention("--claude explain the worker");

    expect(logs.some((line) => line.includes('"metric":"turn_duplicate"'))).toBe(true);
    expect(logs.some((line) => line.includes('"metric":"turn_completed"'))).toBe(false);
    // Duplicate = Slack redelivery of a message the user sent once — the
    // original invocation answers it; acknowledging the redelivery is noise.
    expect(thread.post).not.toHaveBeenCalled();
    expect(store.obligation.clear).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("does not attempt a second done after the harness persisted its terminal", async () => {
    const appendEvent = vi.fn(async () => undefined);
    runBundledAgentTurn.mockResolvedValue({
      status: "completed",
      terminalPersisted: true,
    });
    await emitMention("--claude explain the worker", true, {
      SESSION_EVENTS: {
        idFromName: (name: string) => name,
        get: () => ({
          replay: async () => [],
          execute: async () => ({ accepted: true, duplicate: false }),
          appendEvent,
        }),
      },
    });
    expect(appendEvent).not.toHaveBeenCalled();
    // This mock returns after the final renderer would already have committed;
    // it intentionally does not fake a second lifecycle-clear RPC.
    expect(store.obligation.clear).not.toHaveBeenCalled();
  });

  it("records a failed turn and delivers exactly one visible error", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runBundledAgentTurn.mockRejectedValueOnce(new Error("workdir setup failed"));

    const thread = await emitMention("--claude fix the worker test");

    expect(logs.some((line) => line.includes('"metric":"turn_failed"'))).toBe(true);
    expect(logs.some((line) => line.includes('"metric":"turn_completed"'))).toBe(false);
    expect(thread.post).toHaveBeenCalledTimes(2);
    expect(thread.post).toHaveBeenNthCalledWith(
      1,
      "✅ GitHub push + PR approved. Starting the coding turn…",
    );
    expect(String(thread.post.mock.calls[1]![0])).toContain("workdir setup failed");
    expect(store.obligation.clear).toHaveBeenCalledOnce();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
