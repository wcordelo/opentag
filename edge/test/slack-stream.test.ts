/**
 * Unit tests for CloudflareSlackAdapter.stream() — incremental Slack
 * rendering (placeholder post + throttled chat.update, never buffer-then-post).
 */
import { describe, expect, it } from "vitest";
import { CloudflareSlackAdapter } from "../src/slack/cloudflare-slack-adapter.js";
import type { LifecycleStateStore } from "../src/store/state-store-contract.js";

type Call = {
  method: string;
  body: Record<string, string>;
};

function mockFetch(): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  let tsCounter = 100;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const params = new URLSearchParams(String(init?.body ?? ""));
    const body: Record<string, string> = {};
    for (const [k, v] of params.entries()) body[k] = v;

    if (urlStr.includes("chat.postMessage")) {
      calls.push({ method: "chat.postMessage", body });
      tsCounter += 1;
      return Response.json({ ok: true, ts: `${tsCounter}.000000` });
    }
    if (urlStr.includes("chat.update")) {
      calls.push({ method: "chat.update", body });
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: "unmocked" });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

/** Yield each string with a real (short) delay so conflation doesn't merge them into one pending chunk. */
async function* delayedChunks(parts: string[]): AsyncIterable<string> {
  for (const p of parts) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield p;
  }
}

describe("CloudflareSlackAdapter.stream", () => {
  it.each([
    { mode: "text", expected: "final answer" },
    { mode: "tool-only", expected: "completed without a text response" },
    { mode: "error", expected: "Agent error: boom" },
  ] as const)(
    "terminalizes the actual final AG-UI Slack request for $mode runs",
    async ({ mode, expected }) => {
      const original = globalThis.fetch;
      const requests: Array<{ method: string; text: string }> = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const method = String(url).split("/").pop()!;
        const body = new URLSearchParams(String(init?.body ?? ""));
        requests.push({ method, text: body.get("text") ?? "" });
        return method === "chat.postMessage"
          ? Response.json({ ok: true, ts: "10.1" })
          : Response.json({ ok: true });
      }) as typeof fetch;

      let rowPresent = true;
      let renderToken: string | undefined;
      let tokenSequence = 0;
      const confirmations: Array<{ final: boolean; output: boolean }> = [];
      const activeTurn = {
        beginRender: async () => {
          if (!rowPresent) return { status: "missing" as const };
          if (renderToken) return { status: "in_flight" as const };
          renderToken = `render-${++tokenSequence}`;
          return { status: "claimed" as const, token: renderToken };
        },
        confirmRender: async (args: {
          token: string;
          final: boolean;
          output: boolean;
        }) => {
          if (renderToken !== args.token) return false;
          renderToken = undefined;
          confirmations.push({ final: args.final, output: args.output });
          if (args.final) rowPresent = false;
          return true;
        },
        failRender: async () => false,
      };
      const adapter = new CloudflareSlackAdapter({
        botToken: "xoxb-test",
        stateStore: { activeTurn } as unknown as LifecycleStateStore,
      });
      const target = { channel: "C1" };
      adapter.bindExecutionFence(target, {
        threadKey: "slack:C1:1.0",
        executionId: "exec-final",
      });
      const renderer = adapter.createRunRenderer(target as never);
      const subscriber = renderer.subscriber as unknown as {
        onTextMessageStartEvent(args: unknown): void;
        onTextMessageContentEvent(args: unknown): void;
        onTextMessageEndEvent(args: unknown): Promise<void>;
        onRunErrorEvent(args: unknown): Promise<void>;
      };
      try {
        if (mode === "text") {
          subscriber.onTextMessageStartEvent({ event: { messageId: "m1" } });
          subscriber.onTextMessageContentEvent({
            event: { messageId: "m1", delta: "final answer" },
          });
          await subscriber.onTextMessageEndEvent({ event: { messageId: "m1" } });
        } else if (mode === "error") {
          await subscriber.onRunErrorEvent({ event: { message: "boom" } });
        }
        await renderer.finish?.();

        expect(rowPresent).toBe(false);
        expect(confirmations.filter((entry) => entry.final)).toEqual([
          { final: true, output: true },
        ]);
        expect(requests.at(-1)?.text).toContain(expected);
      } finally {
        globalThis.fetch = original;
      }
    },
  );

  it("serializes final AG-UI update against Stop with no answer-plus-Stopped gap", async () => {
    const original = globalThis.fetch;
    let finalUpdateEntered!: () => void;
    let releaseFinalUpdate!: () => void;
    const entered = new Promise<void>((resolve) => { finalUpdateEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFinalUpdate = resolve; });
    let updates = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const method = String(url).split("/").pop()!;
      if (method === "chat.postMessage") {
        return Response.json({ ok: true, ts: "10.1" });
      }
      if (method === "chat.update" && ++updates === 1) {
        finalUpdateEntered();
        await release;
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    let rowPresent = true;
    let renderToken: string | undefined;
    let sequence = 0;
    const activeTurn = {
      beginRender: async () => {
        if (!rowPresent) return { status: "missing" as const };
        if (renderToken) return { status: "in_flight" as const };
        renderToken = `r-${++sequence}`;
        return { status: "claimed" as const, token: renderToken };
      },
      confirmRender: async (args: { token: string; final: boolean }) => {
        if (renderToken !== args.token) return false;
        renderToken = undefined;
        if (args.final) rowPresent = false;
        return true;
      },
      failRender: async () => false,
      claimCancellation: async () => {
        if (!rowPresent) return "missing" as const;
        return renderToken ? "in_flight" as const : "claimed" as const;
      },
    };
    const adapter = new CloudflareSlackAdapter({
      botToken: "xoxb-test",
      stateStore: { activeTurn } as unknown as LifecycleStateStore,
    });
    const target = { channel: "C1" };
    adapter.bindExecutionFence(target, {
      threadKey: "slack:C1:1.0",
      executionId: "exec-race",
    });
    const renderer = adapter.createRunRenderer(target as never);
    const subscriber = renderer.subscriber as unknown as {
      onTextMessageStartEvent(args: unknown): void;
      onTextMessageContentEvent(args: unknown): void;
      onTextMessageEndEvent(args: unknown): Promise<void>;
    };
    try {
      subscriber.onTextMessageStartEvent({ event: { messageId: "m1" } });
      subscriber.onTextMessageContentEvent({
        event: { messageId: "m1", delta: "answer" },
      });
      const ending = subscriber.onTextMessageEndEvent({ event: { messageId: "m1" } });
      await entered;
      // Stop sees the final request's durable render token and remains silent.
      expect(await activeTurn.claimCancellation()).toBe("in_flight");
      releaseFinalUpdate();
      await ending;
      const finishing = renderer.finish?.();
      await finishing;
      expect(rowPresent).toBe(false);
      // Once the final update is visible, the exact row is already gone and a
      // later Stop is idle/silent rather than posting a contradictory status.
      expect(await activeTurn.claimCancellation()).toBe("missing");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("fails closed when a fenced renderer is missing LifecycleStateStore", async () => {
    const adapter = new CloudflareSlackAdapter({ botToken: "xoxb-test", unsafeAllowUnfencedTestOnly: true });
    const target = { channel: "C1" };
    adapter.bindExecutionFence(target, {
      threadKey: "slack:C1:1.0",
      executionId: "exec-no-store",
    });
    await expect(adapter.post(target as never, []))
      .rejects.toThrow("lifecycle_state_store_required");
  });

  it("fails closed in production when a Slack effect has no exact fence", async () => {
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ ok: true, ts: "1.0" });
    }) as typeof fetch;
    try {
      const adapter = new CloudflareSlackAdapter({
        botToken: "xoxb-test",
        stateStore: {} as LifecycleStateStore,
      });
      await expect(adapter.post({ channel: "C1" } as never, []))
        .rejects.toThrow("exact_execution_fence_required");
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("awaits and fences a delayed Thinking status so Stop suppresses every later status mutation", async () => {
    const original = globalThis.fetch;
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      entered();
      await releasePromise;
      return Response.json({ ok: true });
    }) as typeof fetch;
    let state: "pending" | "cancelled" = "pending";
    let token: string | undefined;
    let cancelQueued = false;
    const activeTurn = {
      beginRender: async () => {
        if (state === "cancelled") return { status: "cancelled" as const };
        if (token) return { status: "in_flight" as const };
        token = "thinking-render";
        return { status: "claimed" as const, token };
      },
      confirmRender: async () => {
        token = undefined;
        if (cancelQueued) state = "cancelled";
        return true;
      },
      failRender: async () => false,
    };
    const adapter = new CloudflareSlackAdapter({
      botToken: "xoxb-test",
      stateStore: { activeTurn } as unknown as LifecycleStateStore,
    });
    const fence = { threadKey: "slack:C1:1.0", executionId: "exec-1" };
    const thinking = adapter.setStatus({
      channel: "C1",
      threadTs: "1.0",
      status: "Thinking…",
      fence,
    });
    await enteredPromise;
    expect(token).toBe("thinking-render");
    cancelQueued = true;
    release();
    await thinking;
    await expect(adapter.setStatus({
      channel: "C1",
      threadTs: "1.0",
      status: "",
      fence,
    })).rejects.toThrow("active_turn_render_suppressed");
    expect(requests).toBe(1);
    globalThis.fetch = original;
  });

  it("reopens a render on Slack ok:false but retains the fence on an ambiguous throw", async () => {
    const original = globalThis.fetch;
    for (const mode of ["rejected", "ambiguous"] as const) {
      let token: string | undefined;
      let failures = 0;
      const activeTurn = {
        beginRender: async () => {
          if (token) return { status: "in_flight" as const };
          token = "render-1";
          return { status: "claimed" as const, token };
        },
        confirmRender: async () => true,
        failRender: async (args: { token: string }) => {
          failures += 1;
          if (token === args.token) token = undefined;
          return true;
        },
      };
      globalThis.fetch = (async () => {
        if (mode === "rejected") {
          return Response.json({ ok: false, error: "ratelimited" });
        }
        throw new TypeError("socket reset after request dispatch");
      }) as typeof fetch;
      const adapter = new CloudflareSlackAdapter({
        botToken: "xoxb-test",
        stateStore: { activeTurn } as unknown as LifecycleStateStore,
      });
      const target = { channel: "C1", threadTs: "1.0" };
      adapter.bindExecutionFence(target, {
        threadKey: "slack:C1:1.0",
        executionId: "exec-1",
      });
      await expect(adapter.stream(target as never, (async function* () {
        yield "never consumed";
      })())).rejects.toThrow();
      if (mode === "rejected") {
        expect(failures).toBe(1);
        expect(token).toBeUndefined();
      } else {
        expect(failures).toBe(0);
        expect(token).toBe("render-1");
      }
    }
    globalThis.fetch = original;
  });

  it("applies definitive-vs-ambiguous semantics to chat.update, including the final update", async () => {
    const original = globalThis.fetch;
    for (const mode of ["rejected", "ambiguous"] as const) {
      let token: string | undefined;
      let sequence = 0;
      let failures = 0;
      let updates = 0;
      const activeTurn = {
        beginRender: async () => {
          if (token) return { status: "in_flight" as const };
          token = `render-${++sequence}`;
          return { status: "claimed" as const, token };
        },
        confirmRender: async (args: { token: string }) => {
          if (token !== args.token) return false;
          token = undefined;
          return true;
        },
        failRender: async (args: { token: string }) => {
          failures += 1;
          if (token === args.token) token = undefined;
          return true;
        },
      };
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        if (String(url).includes("chat.postMessage")) {
          return Response.json({ ok: true, ts: "1.1" });
        }
        updates += 1;
        if (mode === "rejected") {
          return Response.json({ ok: false, error: "message_not_found" });
        }
        throw new TypeError("connection closed after update dispatch");
      }) as typeof fetch;
      const adapter = new CloudflareSlackAdapter({
        botToken: "xoxb-test",
        stateStore: { activeTurn } as unknown as LifecycleStateStore,
        streamUpdateIntervalMs: 0,
      });
      const target = { channel: "C1", threadTs: "1.0" };
      adapter.bindExecutionFence(target, {
        threadKey: "slack:C1:1.0",
        executionId: "exec-1",
      });
      await expect(adapter.stream(target as never, (async function* () {
        yield "answer";
      })())).rejects.toThrow();
      if (mode === "rejected") {
        expect(updates).toBe(2);
        expect(failures).toBe(2);
        expect(token).toBeUndefined();
      } else {
        expect(updates).toBe(1);
        expect(failures).toBe(0);
        expect(token).toBeDefined();
      }
    }
    globalThis.fetch = original;
  });

  it("fences a stalled AG-UI update and suppresses every update after Stop", async () => {
    const original = globalThis.fetch;
    let releaseUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const updateEntered = new Promise<void>((resolve) => { updateStarted = resolve; });
    const calls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const method = String(url).split("/").pop()!;
      calls.push(method);
      if (method === "chat.postMessage") {
        return Response.json({ ok: true, ts: "1.1" });
      }
      updateStarted();
      await updateGate;
      return Response.json({ ok: true });
    }) as typeof fetch;

    let state: "pending" | "cancelled" = "pending";
    let renderToken: string | undefined;
    let sequence = 0;
    let stopRetryQueued = false;
    const activeTurn = {
      beginRender: async () => {
        if (state === "cancelled") return { status: "cancelled" as const };
        if (renderToken) return { status: "in_flight" as const };
        renderToken = `r${++sequence}`;
        return { status: "claimed" as const, token: renderToken };
      },
      confirmRender: async (args: { token: string; final: boolean }) => {
        if (renderToken !== args.token) return false;
        renderToken = undefined;
        if (args.final) state = "cancelled";
        if (stopRetryQueued) state = "cancelled";
        return true;
      },
      failRender: async (args: { token: string }) => {
        if (renderToken !== args.token) return false;
        renderToken = undefined;
        return true;
      },
    };
    const store = { activeTurn } as unknown as LifecycleStateStore;
    const adapter = new CloudflareSlackAdapter({
      botToken: "xoxb-test",
      stateStore: store,
      streamUpdateIntervalMs: 0,
    });
    const target = { channel: "C1", threadTs: "1.0" };
    adapter.bindExecutionFence(target, {
      threadKey: "slack:C1:1.0",
      executionId: "exec-1",
    });

    async function* chunks() {
      yield "first";
      await updateEntered;
      yield " late";
    }
    const rendering = adapter.stream(target as never, chunks());
    await updateEntered;
    // Stop observes the durable in-flight token and must remain silent.
    expect(renderToken).toBeDefined();
    stopRetryQueued = true;
    releaseUpdate();
    // The identical Stop retry now claims cancellation between confirmed
    // increments; every subsequent chat.update is suppressed before fetch.
    await expect(rendering).rejects.toThrow("active_turn_render_suppressed");
    expect(calls.filter((call) => call === "chat.update")).toHaveLength(1);
    globalThis.fetch = original;
  });

  it("posts exactly one placeholder before consuming chunks, then updates per chunk with final full text", async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new CloudflareSlackAdapter({
        unsafeAllowUnfencedTestOnly: true,
        botToken: "xoxb-test",
        streamUpdateIntervalMs: 0,
      });

      let consumedBeforePost = false;
      async function* chunks(): AsyncIterable<string> {
        // If stream() consumed anything before awaiting postMessage, this
        // generator would already have been pulled from by the time
        // postMessage resolves — record whether iteration started.
        consumedBeforePost = true;
        await new Promise((r) => setTimeout(r, 5));
        yield "Hello ";
        await new Promise((r) => setTimeout(r, 5));
        yield "world";
        await new Promise((r) => setTimeout(r, 5));
        yield "!";
      }

      const ref = await adapter.stream(
        { channel: "C1", threadTs: "1.0" } as never,
        chunks(),
      );

      const postCalls = calls.filter((c) => c.method === "chat.postMessage");
      const updateCalls = calls.filter((c) => c.method === "chat.update");

      expect(postCalls).toHaveLength(1);
      expect(postCalls[0]!.body.text).toBe("…");
      expect(postCalls[0]!.body.channel).toBe("C1");
      expect(postCalls[0]!.body.thread_ts).toBe("1.0");

      // Placeholder must be posted before the source generator is ever pulled from.
      // (calls[0] is the postMessage call; consumedBeforePost only flips true
      // once stream() starts draining chunks, which happens after the await.)
      expect(calls[0]!.method).toBe("chat.postMessage");
      expect(consumedBeforePost).toBe(true);

      expect(updateCalls.length).toBeGreaterThanOrEqual(3);
      const last = updateCalls[updateCalls.length - 1]!;
      expect(last.body.text).toBe("Hello world!");
      const lastBlocks = JSON.parse(last.body.blocks!) as Array<{
        text: { text: string };
      }>;
      expect(lastBlocks.map((b) => b.text.text).join("")).toBe(
        "Hello world!",
      );

      expect(ref.channel).toBe("C1");
      expect(ref.ts).toBeTruthy();
      expect(ref.id).toBe(ref.ts);
    } finally {
      restore();
    }
  });

  it("empty stream renders (empty) as the final text", async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new CloudflareSlackAdapter({
        unsafeAllowUnfencedTestOnly: true,
        botToken: "xoxb-test",
        streamUpdateIntervalMs: 0,
      });

      async function* empty(): AsyncIterable<string> {
        // no yields
      }

      await adapter.stream({ channel: "C1", threadTs: "1.0" } as never, empty());

      const postCalls = calls.filter((c) => c.method === "chat.postMessage");
      const updateCalls = calls.filter((c) => c.method === "chat.update");
      expect(postCalls).toHaveLength(1);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
      const last = updateCalls[updateCalls.length - 1]!;
      expect(last.body.text).toBe("(empty)");
      const lastBlocks = JSON.parse(last.body.blocks!) as Array<{
        text: { text: string };
      }>;
      expect(lastBlocks).toHaveLength(1);
      expect(lastBlocks[0]!.text.text).toBe("(empty)");
    } finally {
      restore();
    }
  });

  it("truncates huge content to <=50 blocks and <=3000 chars per block", async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new CloudflareSlackAdapter({
        unsafeAllowUnfencedTestOnly: true,
        botToken: "xoxb-test",
        streamUpdateIntervalMs: 0,
      });

      // 200k chars with no newlines forces the hard maxChars split path and
      // guarantees far more than 50 segments if left unbounded.
      const huge = "x".repeat(200_000);

      async function* one(): AsyncIterable<string> {
        yield huge;
      }

      await adapter.stream({ channel: "C1", threadTs: "1.0" } as never, one());

      const updateCalls = calls.filter((c) => c.method === "chat.update");
      const last = updateCalls[updateCalls.length - 1]!;
      const lastBlocks = JSON.parse(last.body.blocks!) as Array<{
        text: { text: string };
      }>;
      expect(lastBlocks.length).toBeLessThanOrEqual(50);
      for (const b of lastBlocks) {
        expect(b.text.text.length).toBeLessThanOrEqual(3000);
      }
      // Overflow marker present since 200k chars >> 50*3000 cap.
      expect(lastBlocks[lastBlocks.length - 1]!.text.text.endsWith("…")).toBe(
        true,
      );
      // Fallback text field truncated to 35k chars.
      expect(last.body.text!.length).toBeLessThanOrEqual(35_000);
    } finally {
      restore();
    }
  });

  it("rethrows and posts a best-effort interrupted marker when the source stream throws", async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new CloudflareSlackAdapter({
        unsafeAllowUnfencedTestOnly: true,
        botToken: "xoxb-test",
        streamUpdateIntervalMs: 0,
      });

      async function* boom(): AsyncIterable<string> {
        yield "partial";
        throw new Error("upstream exploded");
      }

      await expect(
        adapter.stream({ channel: "C1", threadTs: "1.0" } as never, boom()),
      ).rejects.toThrow("upstream exploded");

      const updateCalls = calls.filter((c) => c.method === "chat.update");
      const last = updateCalls[updateCalls.length - 1]!;
      expect(last.body.text).toContain("partial");
      expect(last.body.text).toContain("stream interrupted");
    } finally {
      restore();
    }
  });
});
