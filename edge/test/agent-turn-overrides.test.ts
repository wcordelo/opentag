/**
 * Phase A3 (GOAL.md / SPEC §2.2) integration coverage for runBundledAgentTurn:
 *  - flags-only message → sticky save confirmation, no agent run
 *  - cleanedText (never raw flagged text) reaches thread memory / setTitle / runAgent
 *  - AgentContentPart[] prompts are stripped per-part
 *
 * The Durable Object store and Slack Web API client are mocked with an
 * in-memory implementation so this runs without workerd. Other exports of
 * both modules are passed through via `importOriginal` so the rest of the
 * agent-turn.ts dependency graph (tools/index.ts etc.) keeps working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StateStore } from "../src/store/state-store-contract.js";
import { bindRequestContext } from "../src/request-context.js";
import { bindTurnExecutionContext } from "../src/slack/turn-execution-context.js";
import { withTestLifecycleStore } from "./helpers/lifecycle-state-store.js";

// agent-turn.ts transitively imports tools/index.ts → memory/knowledge-do.ts
// (and, via the mocked modules' `importOriginal`, workspace-config-do.ts /
// conversation-state-do.ts too), all of which import `cloudflare:workers`
// for the real `DurableObject` base class. Node's vitest environment has no
// such module — stub it, mirroring test/render-obligation.test.ts.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

function makeMemoryStore(): StateStore {
  const kv = new Map<string, { value: unknown; exp?: number }>();
  const lists = new Map<string, unknown[]>();
  return {
    kv: {
      async get<T>(key: string) {
        const e = kv.get(key);
        if (!e) return undefined;
        if (e.exp != null && Date.now() > e.exp) {
          kv.delete(key);
          return undefined;
        }
        return e.value as T;
      },
      async set<T>(key: string, value: T, ttlMs?: number) {
        kv.set(key, { value, exp: ttlMs != null ? Date.now() + ttlMs : undefined });
      },
      async delete(key: string) {
        kv.delete(key);
      },
    },
    list: {
      async append<T>(key: string, value: T, opts?: { maxLen?: number }) {
        const arr = (lists.get(key) as T[] | undefined) ?? [];
        arr.push(value);
        if (opts?.maxLen && arr.length > opts.maxLen) {
          arr.splice(0, arr.length - opts.maxLen);
        }
        lists.set(key, arr);
        return arr.length;
      },
      async range<T>(key: string, start = 0, stop = -1) {
        const arr = ((lists.get(key) as T[] | undefined) ?? []).slice();
        const end = stop < 0 ? arr.length + stop + 1 : stop + 1;
        return arr.slice(start, end);
      },
      async trim(key: string, maxLen: number) {
        const arr = lists.get(key) ?? [];
        if (arr.length > maxLen) lists.set(key, arr.slice(arr.length - maxLen));
      },
      async delete(key: string) {
        lists.delete(key);
      },
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
  };
}

type RunAgentOpts = {
  prompt: unknown;
  context?: Array<{ description: string; value: string }>;
  tools?: unknown;
};

function makeThreadSpies(conversationKey: string) {
  const post = vi.fn(async (_ui: string) => undefined);
  const runAgent = vi.fn(async (_opts: RunAgentOpts) => undefined);
  const thread = { conversationKey, post, runAgent };
  bindRequestContext(thread, { teamId: "T1", requesterId: "U1" });
  bindTurnExecutionContext(thread, {
    threadKey: `slack:${conversationKey.replace("::", ":")}`,
    executionId: `test-title-${conversationKey}`,
  });
  return { thread, post, runAgent };
}

let store: StateStore;
const setTitleSpy = vi.fn(
  async (_args: { channel_id: string; thread_ts: string; title: string }) =>
    undefined,
);

vi.mock("../src/store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/index.js")>();
  return {
    ...actual,
    createDurableObjectStore: () => store,
  };
});

vi.mock("../src/config/workspace-config-do.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/config/workspace-config-do.js")>();
  return {
    ...actual,
    loadTurnAccess: async () => ({
      config: {
        teamId: "T1",
        channelId: null,
        systemPrompt: "sys",
        policies: {},
        accessBundleId: "default",
        updatedAt: "now",
      },
      bundle: { id: "default", tools: [], mcpEndpoints: [], secretRefs: [] },
    }),
  };
});

vi.mock("../src/slack/web-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/slack/web-api.js")>();
  return {
    ...actual,
    createSlackWebClient: () => ({
      setTitle: setTitleSpy,
      resolveUser: async () => ({}),
    }),
  };
});

const { runBundledAgentTurn } = await import("../src/agent-turn.js");

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    BOT_STATE: {} as never,
    WORKSPACE_CONFIG: {} as never,
    SLACK_BOT_TOKEN: "xoxb-test",
    ...overrides,
  } as unknown as Parameters<typeof runBundledAgentTurn>[0];
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

describe("runBundledAgentTurn — Phase A3 overrides wiring", () => {
  beforeEach(() => {
    store = withTestLifecycleStore(makeMemoryStore());
    setTitleSpy.mockClear();
  });

  it("flags-only message posts a sticky confirmation and never runs the agent", async () => {
    const { thread, post, runAgent } = makeThreadSpies(
      "C1::1234567890.000100",
    );

    await runBundledAgentTurn(makeEnv(), thread as never, "--opus");

    expect(runAgent).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const [confirmation] = post.mock.calls[0]!;
    expect(String(confirmation)).toContain("claude-opus-4-8");
    expect(String(confirmation)).not.toContain("--opus");

    // Sticky state is still persisted even though the agent never ran.
    const sticky = await store.kv.get<{ model?: string }>(
      "thread:overrides:C1::1234567890.000100",
    );
    expect(sticky?.model).toBe("claude-opus-4-8");
  });

  it("strips flags before they reach thread memory, setTitle, and runAgent (string prompt)", async () => {
    const conversationKey = "C1::1234567890.000200";
    const { thread, runAgent } = makeThreadSpies(conversationKey);

    await runBundledAgentTurn(makeEnv(), thread as never, "--opus Tell me a joke");

    expect(runAgent).toHaveBeenCalledTimes(1);

    // setTitle received cleaned text only.
    expect(setTitleSpy).toHaveBeenCalledTimes(1);
    const titleArgs = setTitleSpy.mock.calls[0]![0];
    expect(titleArgs.title).toBe("Tell me a joke");
    expect(titleArgs.title).not.toContain("--opus");

    // Durable thread memory stored cleaned text only.
    const memory = await store.list.range<{ text: string }>(
      `threadmem:${conversationKey}`,
    );
    expect(memory.length).toBeGreaterThan(0);
    for (const line of memory) {
      expect(line.text).not.toContain("--opus");
    }

    // The prompt handed to runAgent never contains the raw flag text.
    const runAgentArgs = runAgent.mock.calls[0]![0];
    expect(serialize(runAgentArgs.prompt)).not.toContain("--opus");
    expect(serialize(runAgentArgs.prompt)).toContain("Tell me a joke");

    // A "model preference" context entry records the requested override.
    const modelContext = runAgentArgs.context?.find(
      (c) => c.description === "model preference",
    );
    expect(modelContext).toBeTruthy();
    expect(modelContext!.value).toContain("claude-opus-4-8");
    expect(modelContext!.value).toContain("claudecode");
    expect(modelContext!.value).not.toContain("--opus");
  });

  it("strips flags per text part for AgentContentPart[] prompts (a flag never spans parts)", async () => {
    const conversationKey = "C1::1234567890.000300";
    const { thread, runAgent } = makeThreadSpies(conversationKey);

    const prompt = [
      { type: "text" as const, text: "--sonnet" },
      { type: "text" as const, text: "What's up?" },
    ];

    await runBundledAgentTurn(makeEnv(), thread as never, prompt);

    expect(runAgent).toHaveBeenCalledTimes(1);
    const runAgentArgs = runAgent.mock.calls[0]![0];
    expect(serialize(runAgentArgs.prompt)).not.toContain("--sonnet");
    expect(serialize(runAgentArgs.prompt)).toContain("What's up?");

    const modelContext = runAgentArgs.context?.find(
      (c) => c.description === "model preference",
    );
    expect(modelContext).toBeTruthy();
    expect(modelContext!.value).toContain("claude-sonnet-5");
  });

  it("flags-only AgentContentPart[] prompt (no non-text parts) also short-circuits", async () => {
    const conversationKey = "C1::1234567890.000400";
    const { thread, post, runAgent } = makeThreadSpies(conversationKey);

    const prompt = [{ type: "text" as const, text: "--haiku" }];

    await runBundledAgentTurn(makeEnv(), thread as never, prompt);

    expect(runAgent).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0]![0])).toContain(
      "claude-haiku-4-5-20251001",
    );
  });

  it("a non-text part (e.g. an image) keeps the turn running even if all text was flags", async () => {
    const conversationKey = "C1::1234567890.000500";
    const { thread, post, runAgent } = makeThreadSpies(conversationKey);

    const prompt = [
      { type: "text" as const, text: "--haiku" },
      {
        type: "image" as const,
        source: { type: "data" as const, value: "abc", mimeType: "image/png" },
      },
    ];

    await runBundledAgentTurn(makeEnv(), thread as never, prompt);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
