/**
 * Unit tests for `runHarnessTurn` (GOAL.md Phase A5, SPEC.md §3.6/§4.4).
 *
 * `env.SESSION_EVENTS` is faked the same way `test/render-obligation.test.ts`
 * fakes it: an `idFromName`/`get` namespace whose stub records every
 * `appendEvent` call so we can assert ordering. `env.HARNESS_URL` + a mocked
 * `globalThis.fetch` stand in for the container — the NDJSON body is fed back
 * as a `ReadableStream<Uint8Array>` split at arbitrary byte offsets (including
 * mid-line) to prove the client buffers correctly rather than assuming each
 * `read()` yields exactly one line.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Env } from "../src/env.js";

const { runHarnessTurn } = await import("../src/harness/client.js");

type AppendedEvent = { executionId: string; kind: string; payload: unknown };

function makeFakeSessionEvents(
  opts: {
    executeResult?: { accepted: boolean; duplicate: boolean; cancelled?: boolean };
    createResult?: { sessionId: string; restarted: boolean };
    failDoneAppend?: boolean;
    failAppendOnce?: "output" | "error" | "done";
    getState?: () => {
      interrupted: boolean;
      interruptedExecutionId?: string;
      executing?: { executionId: string; startedAt: number };
    };
  } = {},
) {
  const appended: AppendedEvent[] = [];
  const createCalls: unknown[] = [];
  const executeCalls: unknown[] = [];
  let failedOnce = false;
  const stub = {
    create: async (args: unknown) => {
      createCalls.push(args);
      return opts.createResult ?? { sessionId: "sess-1", restarted: false };
    },
    execute: async (args: unknown) => {
      executeCalls.push(args);
      return opts.executeResult ?? { accepted: true, duplicate: false };
    },
    appendEvent: async (args: AppendedEvent) => {
      if (opts.failAppendOnce === args.kind && !failedOnce) {
        failedOnce = true;
        throw new Error("transient storage failure");
      }
      if (opts.failDoneAppend && args.kind === "done") {
        throw new Error("storage unavailable");
      }
      appended.push(args);
      return { id: appended.length };
    },
    replay: async () => [],
    getState: async () => opts.getState?.() ?? ({ interrupted: false }),
  };
  return {
    appended,
    createCalls,
    executeCalls,
    namespace: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (_id: { name: string }) => stub,
    },
  };
}

/**
 * Builds a `ReadableStream<Uint8Array>` from `text`, chunked at the given
 * byte offsets. At least one offset is expected to fall inside a line (not
 * on a `\n` boundary) so the test exercises the client's line-buffering.
 */
function streamFromText(
  text: string,
  splitAt: number[],
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of splitAt) {
    chunks.push(bytes.slice(start, cut));
    start = cut;
  }
  chunks.push(bytes.slice(start));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchOnce(stream: ReadableStream<Uint8Array>, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(stream, {
      status,
      headers: { "content-type": "application/x-ndjson" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("runHarnessTurn", () => {
  it("returns harness_unavailable when neither HARNESS nor HARNESS_URL is configured", async () => {
    const { namespace } = makeFakeSessionEvents();
    const env = { SESSION_EVENTS: namespace } as unknown as Env;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      executionId: "slack:C1:1.1",
      forwardedMessageId: "slack:C1:1.1",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "harness_unavailable", failureKind: "unavailable" });
  });

  it("returns harness_unavailable when SESSION_EVENTS is missing even if HARNESS_URL is set", async () => {
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
    } as unknown as Env;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      executionId: "slack:C1:1.2",
      forwardedMessageId: "slack:C1:1.2",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "harness_unavailable", failureKind: "unavailable" });
  });

  it("returns harness_unavailable without HARNESS_AUTH_TOKEN", async () => {
    const { namespace } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      executionId: "slack:C1:1.auth",
      forwardedMessageId: "slack:C1:1.auth",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "harness_unavailable", failureKind: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("duplicate execute() short-circuits without ever calling fetch", async () => {
    const { namespace, appended } = makeFakeSessionEvents({
      executeResult: { accepted: false, duplicate: true },
    });
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      executionId: "slack:C1:1.3",
      forwardedMessageId: "slack:C1:1.3",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "duplicate_execution", failureKind: "duplicate" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it("does no harness work when execute observes a pre-start cancellation", async () => {
    const { namespace, appended } = makeFakeSessionEvents({
      executeResult: { accepted: false, duplicate: false, cancelled: true },
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runHarnessTurn({
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env, {
      threadKey: "slack:C1:cancelled",
      conversationKey: "C1::cancelled",
      executionId: "exec-cancelled",
      forwardedMessageId: "message-cancelled",
      prompt: "fix it",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "interrupted" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("checks the durable stop barrier immediately after claim before fetch", async () => {
    const { namespace } = makeFakeSessionEvents({
      getState: () => ({
        interrupted: true,
        interruptedExecutionId: "exec-just-claimed",
      }),
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runHarnessTurn({
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env, {
      threadKey: "slack:C1:claimed",
      conversationKey: "C1::claimed",
      executionId: "exec-just-claimed",
      forwardedMessageId: "message-just-claimed",
      prompt: "implement it",
    });

    expect(result).toMatchObject({ ok: false, failureKind: "interrupted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("appends events in order, accumulates text, and calls onText for deltas (split mid-line)", async () => {
    const line1 = JSON.stringify({ kind: "output", payload: { text: "Hello " } });
    const line2 = JSON.stringify({ kind: "output", payload: { text: "world" } });
    const line3 = JSON.stringify({
      kind: "done",
      payload: { ok: true, summary: "all good" },
    });
    const late = JSON.stringify({ kind: "output", payload: { text: " LATE" } });
    const fullText = `${line1}\n${line2}\n${line3}\n${late}\n`;
    // Split partway through line2 (not on a newline boundary) to prove the
    // client buffers a partial line across two `read()`s.
    const midLine2 = fullText.indexOf(line2) + 5;
    const stream = streamFromText(fullText, [20, midLine2]);

    const { namespace, appended, createCalls, executeCalls } =
      makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    const fetchCalls = mockFetchOnce(stream);

    const deltas: string[] = [];
    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      executionId: "slack:C1:1.4",
      forwardedMessageId: "slack:C1:1.4",
      prompt: "hello",
      model: "claude-sonnet-5",
      onText: (d) => deltas.push(d),
    });

    expect(result).toEqual({
      ok: true,
      text: "Hello world",
      terminalPersisted: true,
    });
    expect(deltas).toEqual(["Hello ", "world"]);

    expect(createCalls).toEqual([
      { threadKey: "slack:C1:1.0", harnessType: "claudecode", model: "claude-sonnet-5" },
    ]);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toMatchObject({
      executionId: "slack:C1:1.4",
      forwardedMessageId: "slack:C1:1.4",
    });

    expect(appended.map((e) => e.kind)).toEqual(["output", "output", "done"]);
    expect(appended[appended.length - 1]).toMatchObject({
      kind: "done",
      payload: { ok: true, summary: "all good" },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://harness.example.com/turn");
    expect(new Headers(fetchCalls[0]!.init!.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    const body = JSON.parse(String(fetchCalls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.threadKey).toBe("slack:C1:1.0");
    expect(body.executionId).toBe("slack:C1:1.4");
    expect(body.forwardedMessageId).toBe("slack:C1:1.4");
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.inputLines).toEqual(["hello"]);
    expect(body.remoteGitApproved).toBe(false);
  });

  it("a stream that ends without a terminal done synthesizes error + done, and returns ok:false", async () => {
    const line1 = JSON.stringify({ kind: "output", payload: { text: "partial" } });
    const fullText = `${line1}\n`; // no done line — container died mid-stream
    const stream = streamFromText(fullText, [3]);

    const { namespace, appended } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    mockFetchOnce(stream);

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C2:2.0",
      conversationKey: "C2::2.0",
      executionId: "slack:C2:2.1",
      forwardedMessageId: "slack:C2:2.1",
      prompt: "hello",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected harness failure");
    expect(result.text).toBe("partial");
    expect(result.error).toMatch(/ended without a done event/);

    expect(appended.map((e) => e.kind)).toEqual(["output", "error", "done"]);
    const doneEvent = appended[appended.length - 1]!;
    expect(doneEvent.payload).toMatchObject({ ok: false });
  });

  it("a fetch failure synthesizes error + done and returns ok:false", async () => {
    const { namespace, appended } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C3:3.0",
      conversationKey: "C3::3.0",
      executionId: "slack:C3:3.1",
      forwardedMessageId: "slack:C3:3.1",
      prompt: "hello",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected harness failure");
    expect(result.error).toContain("network down");
    expect(appended.map((e) => e.kind)).toEqual(["error", "done"]);
  });

  it("a 409 response returns execution_in_flight without synthesizing extra events", async () => {
    const { namespace, appended } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "execution_in_flight" }), { status: 409 }),
    ) as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C4:4.0",
      conversationKey: "C4::4.0",
      executionId: "slack:C4:4.1",
      forwardedMessageId: "slack:C4:4.1",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "execution_in_flight", failureKind: "concurrent" });
    expect(appended).toHaveLength(0);
  });

  it("classifies an auth response and durably records a failed terminal", async () => {
    const { namespace, appended } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "bad-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C4:4.2",
      conversationKey: "C4::4.2",
      executionId: "slack:C4:4.3",
      forwardedMessageId: "slack:C4:4.3",
      prompt: "fix the worker",
      codingTask: true,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "auth" });
    expect(appended.map((event) => event.kind)).toEqual(["error", "done"]);
    expect(appended.at(-1)?.payload).toMatchObject({ ok: false });
  });

  it.each([
    ["git clone failed: authentication required", "workdir setup failed", "setup"],
    ["claude turn timed out after 900000ms", "turn timed out", "timeout"],
    ["claude exited with code 1", "process exited with code 1", "spawn_or_exit"],
    ["postcondition_failed: coding turn produced no commit", "postcondition_failed", "postcondition"],
  ])("classifies terminal harness failure: %s", async (errorMessage, summary, failureKind) => {
    const stream = streamFromText(
      [
        JSON.stringify({ kind: "error", payload: { message: errorMessage } }),
        JSON.stringify({ kind: "done", payload: { ok: false, summary } }),
      ].join("\n") + "\n",
      [7],
    );
    const { namespace } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    mockFetchOnce(stream);

    const result = await runHarnessTurn(env, {
      threadKey: `slack:C7:${failureKind}`,
      conversationKey: `C7::${failureKind}`,
      executionId: `exec-${failureKind}`,
      forwardedMessageId: `msg-${failureKind}`,
      prompt: "fix the worker",
      codingTask: true,
    });

    expect(result).toMatchObject({ ok: false, failureKind, error: errorMessage });
  });

  it("does not report success when the durable done append fails", async () => {
    const stream = streamFromText(
      `${JSON.stringify({ kind: "done", payload: { ok: true } })}\n`,
      [4],
    );
    const { namespace } = makeFakeSessionEvents({ failDoneAppend: true });
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    mockFetchOnce(stream);

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C5:5.0",
      conversationKey: "C5::5.0",
      executionId: "slack:C5:5.1",
      forwardedMessageId: "slack:C5:5.1",
      prompt: "hello",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected harness failure");
    expect(result.error).toContain("terminal_persistence_failed");
  });

  it("aborts and does not expose output when its ordered append fails transiently", async () => {
    const stream = streamFromText(
      [
        JSON.stringify({ kind: "output", payload: { text: "uncommitted" } }),
        JSON.stringify({ kind: "done", payload: { ok: true } }),
      ].join("\n") + "\n",
      [6],
    );
    const { namespace, appended } = makeFakeSessionEvents({
      failAppendOnce: "output",
    });
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    const fetchCalls = mockFetchOnce(stream);
    const onText = vi.fn();

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C5:5.2",
      conversationKey: "C5::5.2",
      executionId: "slack:C5:5.3",
      forwardedMessageId: "slack:C5:5.3",
      prompt: "hello",
      onText,
    });

    expect(result).toMatchObject({ ok: false, text: "" });
    if (result.ok) throw new Error("expected harness failure");
    expect(result.error).toContain(
      "event_persistence_failed: output: transient storage failure",
    );
    expect(onText).not.toHaveBeenCalled();
    expect(appended.map((event) => event.kind)).toEqual(["error", "done"]);
    expect(
      (fetchCalls[0]!.init!.signal as AbortSignal | undefined)?.aborted,
    ).toBe(true);
  });

  it("polls interruption, aborts the live response, and returns no success", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    let polls = 0;
    const { namespace, appended } = makeFakeSessionEvents({
      getState: () => {
        polls += 1;
        return polls >= 1
          ? { interrupted: true }
          : { interrupted: false, executing: { executionId: "slack:C6:6.1", startedAt: 1 } };
      },
    });
    const env = {
      HARNESS_URL: "https://harness.example.com",
      HARNESS_AUTH_TOKEN: "test-token",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    mockFetchOnce(stream);

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C6:6.0",
      conversationKey: "C6::6.0",
      executionId: "slack:C6:6.1",
      forwardedMessageId: "slack:C6:6.1",
      prompt: "hello",
    });

    expect(result).toMatchObject({ ok: false, interrupted: true, error: "interrupted" });
    expect(appended).toHaveLength(0);
  });
});
