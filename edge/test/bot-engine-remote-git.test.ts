import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderable } from "@copilotkit/channels-ui";
import type { StateStore } from "../src/store/state-store-contract.js";

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

function makeStore(): StateStore & {
  obligation: { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
} {
  const values = new Map<string, unknown>();
  return {
    kv: {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async set<T>(key: string, value: T) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
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
    obligation: { set: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) },
  };
}

let store = makeStore();

vi.mock("../src/create-bot-store.js", () => ({
  createBotStoreAdapter: () => store,
}));

const setStatus = vi.fn(async () => undefined);
vi.mock("../src/slack/cloudflare-slack-adapter.js", () => ({
  CloudflareSlackAdapter: class {
    setStatus = setStatus;
    async react() { return true; }
  },
}));

vi.mock("../src/tools/index.js", () => ({
  ALL_EDGE_TOOLS: [],
  ALL_EDGE_TOOL_NAMES: [],
  bindToolEnv: vi.fn(),
}));
vi.mock("../src/commands/index.js", () => ({
  edgeCommands: [],
  bindCommandEnv: vi.fn(),
}));
vi.mock("../src/config/access-bundle.js", () => ({
  resolveAllowedTools: () => [],
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
    requesterId: "U123",
    inbound: { channel: "C1", ts: "111.333", threadTs: "111.222" },
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
    return { confirmed, choiceId } as T;
  });
  return {
    conversationKey: "C1::111.222",
    awaitChoice,
    post: vi.fn(async (_ui?: unknown) => undefined),
  };
}

async function emitMention(
  text: string,
  confirmed = true,
  envOverrides: Record<string, unknown> = {},
) {
  const thread = makeThread(confirmed);
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
    resetBotSingleton();
    runBundledAgentTurn.mockResolvedValue(undefined);
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
  });

  it.each([
    ["--claude explain the router", false],
    ["--claude review the API implementation", false],
    ["--claude inspect the deploy script", false],
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
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      slackCalls.push(String(url));
      return Response.json({ ok: true, ts: "222.333" });
    });
    try {
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
      expect(runBundledAgentTurn).toHaveBeenCalledOnce();
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
    expect(thread.post).not.toHaveBeenCalled();
    expect(store.obligation.clear).toHaveBeenCalledOnce();
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
    expect(store.obligation.clear).toHaveBeenCalledOnce();
  });

  it("records a failed turn and delivers exactly one visible error", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runBundledAgentTurn.mockRejectedValueOnce(new Error("workdir setup failed"));

    const thread = await emitMention("--claude fix the worker test");

    expect(logs.some((line) => line.includes('"metric":"turn_failed"'))).toBe(true);
    expect(logs.some((line) => line.includes('"metric":"turn_completed"'))).toBe(false);
    expect(thread.post).toHaveBeenCalledOnce();
    expect(String(thread.post.mock.calls[0]![0])).toContain("workdir setup failed");
    expect(store.obligation.clear).toHaveBeenCalledOnce();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
