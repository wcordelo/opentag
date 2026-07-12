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
    executeResult?: { accepted: boolean; duplicate: boolean };
    createResult?: { sessionId: string; restarted: boolean };
  } = {},
) {
  const appended: AppendedEvent[] = [];
  const createCalls: unknown[] = [];
  const executeCalls: unknown[] = [];
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
      appended.push(args);
      return { id: appended.length };
    },
    replay: async () => [],
    getState: async () => ({ interrupted: false }),
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
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "harness_unavailable" });
  });

  it("returns harness_unavailable when SESSION_EVENTS is missing even if HARNESS_URL is set", async () => {
    const env = { HARNESS_URL: "https://harness.example.com" } as unknown as Env;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "harness_unavailable" });
  });

  it("duplicate execute() short-circuits without ever calling fetch", async () => {
    const { namespace, appended } = makeFakeSessionEvents({
      executeResult: { accepted: false, duplicate: true },
    });
    const env = {
      HARNESS_URL: "https://harness.example.com",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "duplicate_execution" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it("appends events in order, accumulates text, and calls onText for deltas (split mid-line)", async () => {
    const line1 = JSON.stringify({ kind: "output", payload: { text: "Hello " } });
    const line2 = JSON.stringify({ kind: "output", payload: { text: "world" } });
    const line3 = JSON.stringify({
      kind: "done",
      payload: { ok: true, summary: "all good" },
    });
    const fullText = `${line1}\n${line2}\n${line3}\n`;
    // Split partway through line2 (not on a newline boundary) to prove the
    // client buffers a partial line across two `read()`s.
    const midLine2 = fullText.indexOf(line2) + 5;
    const stream = streamFromText(fullText, [20, midLine2]);

    const { namespace, appended, createCalls, executeCalls } =
      makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    const fetchCalls = mockFetchOnce(stream);

    const deltas: string[] = [];
    const result = await runHarnessTurn(env, {
      threadKey: "slack:C1:1.0",
      conversationKey: "C1::1.0",
      prompt: "hello",
      model: "claude-sonnet-5",
      onText: (d) => deltas.push(d),
    });

    expect(result).toEqual({ ok: true, text: "Hello world" });
    expect(deltas).toEqual(["Hello ", "world"]);

    expect(createCalls).toEqual([
      { threadKey: "slack:C1:1.0", harnessType: "claudecode", model: "claude-sonnet-5" },
    ]);
    expect(executeCalls).toHaveLength(1);

    expect(appended.map((e) => e.kind)).toEqual(["output", "output", "done"]);
    expect(appended[appended.length - 1]).toMatchObject({
      kind: "done",
      payload: { ok: true, summary: "all good" },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://harness.example.com/turn");
    const body = JSON.parse(String(fetchCalls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.threadKey).toBe("slack:C1:1.0");
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.inputLines).toEqual(["hello"]);
  });

  it("a stream that ends without a terminal done synthesizes error + done, and returns ok:false", async () => {
    const line1 = JSON.stringify({ kind: "output", payload: { text: "partial" } });
    const fullText = `${line1}\n`; // no done line — container died mid-stream
    const stream = streamFromText(fullText, [3]);

    const { namespace, appended } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    mockFetchOnce(stream);

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C2:2.0",
      conversationKey: "C2::2.0",
      prompt: "hello",
    });

    expect(result.ok).toBe(false);
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
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C3:3.0",
      conversationKey: "C3::3.0",
      prompt: "hello",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
    expect(appended.map((e) => e.kind)).toEqual(["error", "done"]);
  });

  it("a 409 response returns execution_in_flight without synthesizing extra events", async () => {
    const { namespace, appended } = makeFakeSessionEvents();
    const env = {
      HARNESS_URL: "https://harness.example.com",
      SESSION_EVENTS: namespace,
    } as unknown as Env;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "execution_in_flight" }), { status: 409 }),
    ) as unknown as typeof fetch;

    const result = await runHarnessTurn(env, {
      threadKey: "slack:C4:4.0",
      conversationKey: "C4::4.0",
      prompt: "hello",
    });

    expect(result).toEqual({ ok: false, text: "", error: "execution_in_flight" });
    expect(appended).toHaveLength(0);
  });
});
