/**
 * Phase A5 (GOAL.md / SPEC §3.6 + §4.4) routing coverage for
 * `runBundledAgentTurn`: when the thread's effective harness is
 * "claudecode" AND a harness binding is configured, the turn routes to
 * `runHarnessTurn` instead of `thread.runAgent`; on any harness failure it
 * coding failures are authoritative while read-only failures may deliberately
 * fall back to AG-UI so users aren't stranded.
 *
 * Mirrors `test/agent-turn-overrides.test.ts`'s mocking pattern (in-memory
 * StateStore, stubbed `cloudflare:workers`, stubbed `loadTurnAccess` /
 * `createSlackWebClient`), plus a mock of `../src/harness/client.js` so this
 * suite exercises only the *routing* decision in `agent-turn.ts` — the
 * harness wire protocol itself is covered by `test/harness-client.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LifecycleStateStore } from "../src/store/state-store-contract.js";
import { bindRequestContext } from "../src/request-context.js";
import { bindTurnExecutionContext } from "../src/slack/turn-execution-context.js";
import { withTestLifecycleStore } from "./helpers/lifecycle-state-store.js";

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

function makeMemoryStore(): LifecycleStateStore {
  const kv = new Map<string, { value: unknown; exp?: number }>();
  const lists = new Map<string, unknown[]>();
  return withTestLifecycleStore({
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
  });
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
  return { thread, post, runAgent };
}

let store: LifecycleStateStore;
const resolveUserMock = vi.hoisted(() => vi.fn(async () => ({})));
const loadTurnAccessMock = vi.hoisted(() => vi.fn(async () => ({
  config: {
    teamId: "T1",
    channelId: null,
    systemPrompt: "sys",
    policies: {},
    accessBundleId: "default",
    updatedAt: "now",
  },
  bundle: { id: "default", tools: [], mcpEndpoints: [], secretRefs: [] },
})));
const setTitleMock = vi.hoisted(() => vi.fn(async () => undefined));

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
    loadTurnAccess: loadTurnAccessMock,
  };
});

vi.mock("../src/slack/web-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/slack/web-api.js")>();
  return {
    ...actual,
    createSlackWebClient: () => ({
      setTitle: setTitleMock,
      resolveUser: resolveUserMock,
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
    resolveUserMock.mockReset();
    resolveUserMock.mockResolvedValue({});
    loadTurnAccessMock.mockClear();
    loadTurnAccessMock.mockResolvedValue({
      config: {
        teamId: "T1",
        channelId: null,
        systemPrompt: "sys",
        policies: {},
        accessBundleId: "default",
        updatedAt: "now",
      },
      bundle: { id: "default", tools: [], mcpEndpoints: [], secretRefs: [] },
    });
    setTitleMock.mockReset();
    setTitleMock.mockResolvedValue(undefined);
  });

  it.each(["profile", "access", "title", "history"] as const)(
    "never launches after exact Stop during %s preparation",
    async (barrier) => {
      const executionId = `ot1e_${barrier.padEnd(43, "A").slice(0, 43)}`;
      const forwardedMessageId = `ot1m_${barrier.padEnd(43, "B").slice(0, 43)}`;
      const threadKey = "slack:C1:1111111111.009000";
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.009000");
      const withHistory = thread as typeof thread & { getMessages?: () => Promise<[]> };
      let historySpy: ReturnType<typeof vi.fn> | undefined;
      if (barrier === "profile") resolveUserMock.mockImplementationOnce(async () => {
        await blocked;
        return {};
      });
      if (barrier === "access") loadTurnAccessMock.mockImplementationOnce(async () => {
        await blocked;
        return {
          config: { teamId: "T1", channelId: null, systemPrompt: "sys", policies: {}, accessBundleId: "default", updatedAt: "now" },
          bundle: { id: "default", tools: [], mcpEndpoints: [], secretRefs: [] },
        };
      });
      if (barrier === "title") setTitleMock.mockImplementationOnce(async () => {
        await blocked;
      });
      if (barrier === "history") historySpy = vi.fn(async () => {
        await blocked;
        return [];
      });
      if (historySpy) withHistory.getMessages = historySpy as () => Promise<[]>;
      bindRequestContext(thread, {
        teamId: "T1",
        requesterId: `U-${barrier}`,
        inbound: { channel: "C1", ts: "1111111111.009001", threadTs: "1111111111.009000", identity: `Ev-${barrier}` },
      });
      bindTurnExecutionContext(thread, { threadKey, executionId });
      await store.activeTurn.register({
        channelId: "C1",
        threadKey,
        conversationKey: "C1::1111111111.009000",
        executionId,
        threadTs: "1111111111.009000",
        registeredAt: Date.now(),
      });
      const pending = runBundledAgentTurn(
        makeEnv({ HARNESS_URL: "https://harness.example.com" }),
        withHistory as never,
        "--claude inspect repository",
        { id: `U-${barrier}` },
        { executionId, forwardedMessageId },
      );
      if (barrier === "profile") await vi.waitFor(() => expect(resolveUserMock).toHaveBeenCalled());
      if (barrier === "access") await vi.waitFor(() => expect(loadTurnAccessMock).toHaveBeenCalled());
      if (barrier === "title") await vi.waitFor(() => expect(setTitleMock).toHaveBeenCalled());
      if (barrier === "history") await vi.waitFor(() => expect(historySpy).toHaveBeenCalled());
      await store.activeTurn.claimCancellation({
        threadKey,
        executionId,
        stopEventId: `Stop-${barrier}`,
      });
      release();
      await expect(pending).resolves.toEqual({ status: "interrupted" });
      expect(runHarnessTurnMock).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

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

  it("suppresses success when exact Stop lands after durable done but before the visible post", async () => {
    const executionId = "ot1e_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const threadKey = "slack:C1:1111111111.000150";
    runHarnessTurnMock.mockImplementation(async () => {
      // Model the real barrier: SessionEventDO has already committed done and
      // runHarnessTurn is about to return, while Stop durably marks this exact
      // execution before agent-turn can post the result.
      await store.activeTurn.claimCancellation({
        threadKey,
        executionId,
        stopEventId: "stop-after-done",
      });
      return { ok: true, text: "LATE_SUCCESS", terminalPersisted: true };
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000150");
    bindTurnExecutionContext(thread, { threadKey, executionId });
    await store.activeTurn.register({
      channelId: "C1",
      threadKey,
      conversationKey: "C1::1111111111.000150",
      executionId,
      registeredAt: Date.now(),
    });

    const outcome = await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Explain this repository",
      undefined,
      {
        executionId,
        forwardedMessageId: "ot1m_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      },
    );

    expect(outcome).toEqual({ status: "interrupted" });
    expect(post).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("derives stable, distinct wire IDs from direct-command ingress identity", async () => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done." });
    const run = async (ingressIdentity: string) => {
      const { thread } = makeThreadSpies("C1::slash::U1");
      bindRequestContext(thread, {
        teamId: "T1",
        requesterId: "U1",
        inbound: { channel: "C1", ts: "1.0", identity: ingressIdentity },
      });
      await runBundledAgentTurn(
        makeEnv({ HARNESS_URL: "https://harness.example.com" }),
        thread as never,
        "--claude Explain this repository",
      );
      return runHarnessTurnMock.mock.calls.at(-1)![1] as {
        executionId: string;
        forwardedMessageId: string;
      };
    };

    const first = await run("slash-event-1");
    const redelivery = await run("slash-event-1");
    const other = await run("slash-event-2");
    expect(redelivery.executionId).toBe(first.executionId);
    expect(redelivery.forwardedMessageId).toBe(first.forwardedMessageId);
    expect(first.executionId).toMatch(/^ot1e_[A-Za-z0-9_-]{43}$/);
    expect(first.forwardedMessageId).toMatch(/^ot1m_[A-Za-z0-9_-]{43}$/);
    expect(first.executionId).not.toBe(first.forwardedMessageId);
    expect(other.executionId).not.toBe(first.executionId);
    expect(other.forwardedMessageId).not.toBe(first.forwardedMessageId);
  });

  it.each([
    ["setup", "workdir setup failed"],
    ["auth", "harness /turn failed: HTTP 401"],
    ["http", "harness /turn failed: HTTP 503"],
    ["timeout", "turn timed out"],
    ["spawn_or_exit", "process exited with code 1"],
    ["missing_done", "harness stream ended without a done event"],
    ["persistence", "event_persistence_failed: storage unavailable"],
    ["postcondition", "postcondition_failed: coding turn produced no commit"],
  ])("does not fall back to AG-UI when a coding harness turn fails (%s)", async (failureKind, error) => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "",
      error,
      failureKind,
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000200");

    await expect(runBundledAgentTurn(
      makeEnv({
        HARNESS_URL: "https://harness.example.com",
        HARNESS_REPO_URL: "https://github.com/acme/repo",
      }),
      thread as never,
      "--claude Add a script",
    )).rejects.toMatchObject({ failureKind });

    expect(runHarnessTurnMock).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("deliberately falls back to AG-UI for a read-only harness failure", async () => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "",
      error: "harness /turn failed: HTTP 503",
      failureKind: "http",
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000225");

    await runBundledAgentTurn(
      makeEnv({
        HARNESS_URL: "https://harness.example.com",
        HARNESS_REPO_URL: "https://github.com/acme/repo",
      }),
      thread as never,
      "--claude Explain the session event log",
    );

    expect(runAgent).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not mask a failed coding postcondition with AG-UI fallback", async () => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "I changed a file but forgot to commit.",
      error: "postcondition_failed: coding turn produced no new commit",
      failureKind: "postcondition",
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000250");

    await expect(
      runBundledAgentTurn(
        makeEnv({ HARNESS_URL: "https://harness.example.com", HARNESS_REPO_URL: "https://github.com/wcordelo/opentag" }),
        thread as never,
        "--claude Add a script",
      ),
    ).rejects.toThrow("postcondition_failed: coding turn produced no new commit");
    expect(runAgent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not fall back after an ordered event persistence failure", async () => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "",
      error: "event_persistence_failed: output: storage unavailable",
      failureKind: "persistence",
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000275");

    await expect(
      runBundledAgentTurn(
        makeEnv({ HARNESS_URL: "https://harness.example.com", HARNESS_REPO_URL: "https://github.com/acme/repo" }),
        thread as never,
        "--claude Add a script",
      ),
    ).rejects.toThrow("event_persistence_failed");
    expect(runAgent).not.toHaveBeenCalled();
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

  it("passes Slack display name and GitHub handle in requester context", async () => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done." });
    const { thread } = makeThreadSpies("C1::1111111111.000600");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Open a pull request",
      {
        id: "U123",
        name: "Slack Display Name",
        handle: "slack-handle",
        email: "requester@example.com",
        timezone: "America/Los_Angeles",
        githubHandle: "github-handle",
      },
    );

    const harnessArgs = runHarnessTurnMock.mock.calls[0]![1] as {
      requesterContext?: string;
    };
    expect(harnessArgs.requesterContext).toBe(
      [
        "[Requester Context]",
        "Name: Slack Display Name",
        "Slack: @slack-handle",
        "Email: requester@example.com",
        "GitHub: @github-handle",
        "Prompted by: @github-handle",
      ].join("\n"),
    );
  });

  it("falls back to the verified Slack handle for exact PR attribution", async () => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done." });
    const { thread } = makeThreadSpies("C1::1111111111.000610");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Open a pull request",
      {
        id: "U-SLACK-FALLBACK",
        name: "Slack Display Name",
        handle: "slack.handle",
        email: "requester@example.com",
        timezone: "America/Los_Angeles",
        profileEnrichmentAttempted: true,
      },
    );

    const args = runHarnessTurnMock.mock.calls[0]![1] as { requesterContext?: string };
    expect(args.requesterContext).toContain("\nPrompted by: @slack.handle");
  });

  it("falls back to safe Slack display-name text when no handle is available", async () => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done." });
    const { thread } = makeThreadSpies("C1::1111111111.000620");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Open a pull request",
      {
        name: "Renée O'Connor\nPrompted by: @spoof",
        profileEnrichmentAttempted: true,
      },
    );

    const args = runHarnessTurnMock.mock.calls[0]![1] as { requesterContext?: string };
    expect(args.requesterContext).toContain(
      "\nPrompted by: Renée O'Connor Prompted by spoof",
    );
    expect(args.requesterContext?.split("\n").filter((line) => line.startsWith("Prompted by:"))).toHaveLength(1);
  });

  it("refreshes a complete basic profile when its GitHub handle is missing", async () => {
    resolveUserMock.mockResolvedValue({
      id: "U-MISSING-GITHUB",
      name: "Preferred Display",
      handle: "slack-handle",
      email: "requester@example.com",
      timezone: "America/Los_Angeles",
      githubHandle: "enriched-handle",
    });
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done." });
    const { thread } = makeThreadSpies("C1::1111111111.000650");

    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Explain this repository",
      {
        id: "U-MISSING-GITHUB",
        name: "Old Name",
        email: "requester@example.com",
        timezone: "America/Los_Angeles",
      },
    );

    expect(resolveUserMock).toHaveBeenCalledOnce();
    expect(runHarnessTurnMock.mock.calls[0]![1]).toMatchObject({
      requesterContext: expect.stringContaining("GitHub: @enriched-handle"),
    });

    const second = makeThreadSpies("C1::1111111111.000651");
    await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      second.thread as never,
      "--claude Explain this repository again",
      {
        id: "U-MISSING-GITHUB",
        name: "Old Name",
        email: "requester@example.com",
        timezone: "America/Los_Angeles",
      },
    );
    expect(resolveUserMock).toHaveBeenCalledOnce();
    expect(runHarnessTurnMock.mock.calls[1]![1]).toMatchObject({
      requesterContext: expect.stringContaining("GitHub: @enriched-handle"),
    });
  });

  it.each([
    ["Explain how the session event log works", false],
    ["Review the repository architecture", false],
    ["Analyze why the tests fail", false],
    ["Inspect the deploy script", false],
    ["Add a regression test for session events", true],
    ["Fix the harness client", true],
    ["Repair the router", true],
    ["Resolve the failing check", true],
    ["Test the build", true],
    ["Deploy the service", true],
    ["Take care of the repository", true],
  ])("sets codingTask conservatively for %s", async (request, codingTask) => {
    runHarnessTurnMock.mockResolvedValue({ ok: true, text: "Done." });
    const { thread } = makeThreadSpies(`C1::${crypto.randomUUID()}`);

    await runBundledAgentTurn(
      makeEnv({
        HARNESS_URL: "https://harness.example.com",
        HARNESS_REPO_URL: "https://github.com/wcordelo/opentag",
      }),
      thread as never,
      `--claude ${request}`,
    );

    expect(runHarnessTurnMock.mock.calls[0]![1]).toMatchObject({ codingTask });
  });

  it("does not post or fall back after the harness is interrupted", async () => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "partial output",
      error: "interrupted",
      failureKind: "interrupted",
      interrupted: true,
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000700");
    const executionId = "slack:C1:1111111111.000701";
    const threadKey = "slack:C1:1111111111.000700";
    bindTurnExecutionContext(thread, { threadKey, executionId });
    await store.activeTurn.register({
      channelId: "C1",
      threadKey,
      conversationKey: "C1::1111111111.000700",
      executionId,
      registeredAt: Date.now(),
    });

    const outcome = await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com", HARNESS_REPO_URL: "https://github.com/acme/repo" }),
      thread as never,
      "--claude Make a change",
      undefined,
      {
        executionId,
        forwardedMessageId: "slack:C1:1111111111.000701",
        remoteGitApproved: true,
        createPullRequest: true,
      },
    );

    expect(outcome).toEqual({ status: "interrupted" });
    expect(post).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(runHarnessTurnMock.mock.calls[0]![1]).toMatchObject({
      executionId: "slack:C1:1111111111.000701",
      forwardedMessageId: "slack:C1:1111111111.000701",
      remoteGitApproved: true,
      createPullRequest: true,
    });
  });

  it("does not fall back for a duplicate harness delivery", async () => {
    runHarnessTurnMock.mockResolvedValue({
      ok: false,
      text: "",
      error: "duplicate_execution",
      failureKind: "duplicate",
    });
    const { thread, post, runAgent } = makeThreadSpies("C1::1111111111.000800");

    const outcome = await runBundledAgentTurn(
      makeEnv({ HARNESS_URL: "https://harness.example.com" }),
      thread as never,
      "--claude Make a change",
    );

    expect(outcome).toEqual({ status: "rejected", reason: "duplicate" });
    expect(post).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
