import { describe, it, expect } from "vitest";
import { parseThreadKey } from "../delivery/slack.js";

describe("Slack delivery", () => {
  it("parses thread key", () => {
    const parsed = parseThreadKey("slack:C123ABC:1234567890.123456");
    expect(parsed).toEqual({
      channel: "C123ABC",
      threadTs: "1234567890.123456",
    });
  });

  it("omits thread_ts when key uses channel as thread (channel-top)", async () => {
    const posts: unknown[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const { postToSlackThread } = await import("../delivery/slack.js");
      await postToSlackThread("slack:C123:C123", "hello", "xoxb-test");
      expect(posts[0]).toMatchObject({ channel: "C123", text: "hello" });
      expect((posts[0] as { thread_ts?: string }).thread_ts).toBeUndefined();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("omits invalid slash-scope thread_ts", async () => {
    const posts: unknown[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const { postToSlackThread } = await import("../delivery/slack.js");
      await postToSlackThread("slack:C123:slash::U999", "hello", "xoxb-test");
      expect((posts[0] as { thread_ts?: string }).thread_ts).toBeUndefined();
    } finally {
      globalThis.fetch = orig;
    }
  });
});
