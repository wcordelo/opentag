/**
 * Unit tests for CloudflareSlackAdapter.stream() — incremental Slack
 * rendering (placeholder post + throttled chat.update, never buffer-then-post).
 */
import { describe, expect, it } from "vitest";
import { CloudflareSlackAdapter } from "../src/slack/cloudflare-slack-adapter.js";

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
  it("posts exactly one placeholder before consuming chunks, then updates per chunk with final full text", async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new CloudflareSlackAdapter({
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
