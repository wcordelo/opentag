/**
 * Phase A5 (GOAL.md / SPEC §3.6 + §4.4) routing coverage for
 * `runBundledAgentTurn`: when the thread's effective harness is
 * "claudecode" AND a harness binding is configured, the turn routes to
 * `runHarnessTurn` instead of `thread.runAgent`; on any harness failure it
 * falls back to the normal AG-UI path so users aren't stranded.
 *
 * Mirrors `test/agent-turn-overrides.test.ts`'s mocking pattern (in-memory
 * StateStore, stubbed `cloudflare:workers`, stubbed `loadTurnAccess` /
 * `createSlackWebClient`), plus a mock of `../src/harness/client.js` so this
 * suite exercises only the *routing* decision in `agent-turn.ts` — the
 * harness wire protocol itself is covered by `test/harness-client.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StateStore } from "../src/store/state-store-contract.js";

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
  return { thread, post, runAgent };
}

let store: StateStore;

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
      setTitle: async () => undefined,
      resolveUser: async () => ({}),
    }),
  };
});

const runHarnessTurnMock = vi.fn();
vi.mock("../src/harness/client.js", () => ({
  runHarnessTurn: (...args: unknown[]) => runHarnessTurnMock(...args),
}));

const { runBundledAgentTurn } = await import("../src/agent-turn.js");

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    BOT_STATE: {} as never,
    WORKSPACE_CONFIG: {} as never,
    SLACK_BOT_TOKEN: "xoxb-test",
    ...overrides,
  } as unknown as Parameters<typeof runBundledAgentTurn>[0];
}

describe("runBundledAgentTurn — Phase A5 harness routing", () => {
  beforeEach(() => {
    store = makeMemoryStore();
    runHarnessTurnMock.mockReset();
  });

  it("routes to the harness and posts its text when harnessType=claudecode and HARNESS_URL is configured", async () => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done via Claude Code." });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000100");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Add a script",
    );

    expect(runHarnessTurnMock).toHaveBeenCalledTimes(1);
    const harnessArgs = runHarnessTurnMock.mock.calls[0]![1] as {
      threadKey: string;
      conversationKey: string;
      prompt: string;
    };
    expect(harnessArgs.threadKey).toBe("slack:C1:1111111111.000100");
    expect(harnessArgs.conversationKey).toBe("C1::1111111111.000100");
    expect(harnessArgs.prompt).toContain("Add a script");
    expect(harnessArgs.prompt).not.toContain("--claude");

    expect(runAgent).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe("Done via Claude Code.");
  });

  it("falls back to thread.runAgent when the harness turn fails", async () => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "",
      error: "harness_unavailable",
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000200");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Add a script",
    );

    expect(runHarnessTurnMock).toHaveBeenCalledTimes(1);
    // Fallback: the normal AG-UI path runs instead of a harness-side post.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("never calls the harness when no HARNESS/HARNESS_URL binding is configured, even with --claude", async () => {
    const { thread, runAgent } = makeThreadSpies("C1::1111111111.000300");

    await runBundledAgentTurn(makeEnv(), thread as never, "--claude Add a script");

    expect(runHarnessTurnMock).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("never calls the harness for a plain message with no harness flag, even if HARNESS_URL is configured", async () => {
    const { thread, runAgent } = makeThreadSpies("C1::1111111111.000400");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "just chatting",
    );

    expect(runHarnessTurnMock).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("posts a placeholder line instead of silence when the harness reports ok:true with empty text", async () => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "   " });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000500");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Add a script",
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0]![0])).not.toBe("");
  });
});
