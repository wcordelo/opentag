import { describe, it, expect } from "vitest";
import { parseThreadKey, postToSlackThread } from "../delivery/slack.js";

describe("Slack delivery", () => {
  it("parses thread key", () => {
    const parsed = parseThreadKey("slack:C123ABC:1234567890.123456");
    expect(parsed).toEqual({
      channel: "C123ABC",
      threadTs: "1234567890.123456",
    });
  });

  it("omits thread_ts when key uses channel as thread (channel-top)", async () => {
    const posts: URLSearchParams[] = [];
    const headers: Headers[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(new URLSearchParams(String(init?.body ?? "")));
      headers.push(new Headers(init?.headers));
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await expect(postToSlackThread(
        "slack:C123:C123",
        "hello",
        "delivery-top",
        "xoxb-test",
      )).resolves.toEqual({ status: "delivered", duplicate: false });
      expect(posts[0]!.get("channel")).toBe("C123");
      expect(posts[0]!.get("text")).toBe("hello");
      expect(posts[0]!.get("thread_ts")).toBeNull();
      expect(posts[0]!.get("client_msg_id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(headers[0]!.get("content-type")).toBe(
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("omits invalid slash-scope thread_ts", async () => {
    const posts: URLSearchParams[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await postToSlackThread(
        "slack:C123:slash::U999",
        "hello",
        "delivery-slash",
        "xoxb-test",
      );
      expect(posts[0]!.get("thread_ts")).toBeNull();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("uses the same idempotency key on replay and accepts Slack duplicates", async () => {
    const clientIds: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      clientIds.push(new URLSearchParams(String(init?.body ?? "")).get("client_msg_id")!);
      return Response.json({ ok: false, error: "duplicate_client_msg_id" });
    }) as typeof fetch;
    try {
      const first = await postToSlackThread(
        "slack:C123:123.456",
        "hello",
        "obligation-stable",
        "xoxb-test",
      );
      const replay = await postToSlackThread(
        "slack:C123:123.456",
        "hello",
        "obligation-stable",
        "xoxb-test",
      );
      expect(first).toEqual({ status: "delivered", duplicate: true });
      expect(replay).toEqual({ status: "delivered", duplicate: true });
      expect(clientIds[0]).toBe(clientIds[1]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("posts final research results with Retry, Dig deeper, and Export actions", async () => {
    let form: URLSearchParams | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      form = new URLSearchParams(String(init?.body ?? ""));
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await postToSlackThread(
        "slack:C1:1.0",
        "final synthesis",
        "delivery-final",
        "token",
        { type: "final", text: "final synthesis", taskId: "research-42" },
      );
      const blocks = JSON.parse(form!.get("blocks")!) as Array<{
        type: string;
        elements?: Array<{ action_id: string; value: string }>;
      }>;
      expect(blocks[0]).toMatchObject({ type: "section" });
      const actions = blocks.find((block) => block.type === "actions")!.elements!;
      expect(actions.map((action) => action.action_id)).toEqual([
        "quick_retry", "quick_dig_deeper", "quick_export",
      ]);
      expect(actions.map((action) => JSON.parse(action.value))).toEqual([
        { type: "research", taskId: "research-42" },
        { type: "research", taskId: "research-42" },
        { type: "research", taskId: "research-42" },
      ]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("losslessly pages a 200k final result with stable per-page identities", async () => {
    const text = "0123456789".repeat(20_000);
    const firstPosts: URLSearchParams[] = [];
    const replayPosts: URLSearchParams[] = [];
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = (async (_url, init) => {
        firstPosts.push(new URLSearchParams(String(init?.body ?? "")));
        return Response.json({ ok: true });
      }) as typeof fetch;
      await expect(postToSlackThread(
        "slack:C1:1.0",
        text,
        "delivery-large-final",
        "token",
        { type: "final", text, taskId: "research-large" },
      )).resolves.toEqual({ status: "delivered", duplicate: false });

      expect(firstPosts.length).toBeGreaterThan(1);
      expect(firstPosts.map((form) => form.get("text") ?? "").join("")).toBe(text);
      const firstIds = firstPosts.map((form) => form.get("client_msg_id"));
      expect(new Set(firstIds).size).toBe(firstPosts.length);
      for (const [index, form] of firstPosts.entries()) {
        expect((form.get("text") ?? "").length).toBeLessThanOrEqual(35_000);
        const blocks = JSON.parse(form.get("blocks") ?? "[]") as Array<{
          type: string;
          text?: { text?: string };
          elements?: Array<{ action_id?: string }>;
        }>;
        expect(blocks.length).toBeLessThanOrEqual(50);
        for (const block of blocks) {
          if (block.type === "section") {
            expect(block.text?.text?.length ?? 0).toBeLessThanOrEqual(3_000);
          }
        }
        const actionIds = blocks
          .flatMap((block) => block.elements ?? [])
          .map((element) => element.action_id);
        if (index === firstPosts.length - 1) {
          expect(actionIds).toEqual(["quick_retry", "quick_dig_deeper", "quick_export"]);
        } else {
          expect(actionIds).toEqual([]);
        }
      }

      globalThis.fetch = (async (_url, init) => {
        replayPosts.push(new URLSearchParams(String(init?.body ?? "")));
        return Response.json({ ok: false, error: "duplicate_client_msg_id" });
      }) as typeof fetch;
      await expect(postToSlackThread(
        "slack:C1:1.0",
        text,
        "delivery-large-final",
        "token",
        { type: "final", text, taskId: "research-large" },
      )).resolves.toEqual({ status: "delivered", duplicate: true });
      expect(replayPosts.map((form) => form.get("client_msg_id"))).toEqual(firstIds);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("distinguishes definitive Slack rejection from ambiguous transport/parse outcomes", async () => {
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json({ ok: false, error: "channel_not_found" })) as typeof fetch;
      await expect(postToSlackThread("slack:C1:1.0", "x", "reject", "token"))
        .resolves.toEqual({ status: "definitive_failure", error: "page_1_of_1:channel_not_found" });

      globalThis.fetch = (async () => { throw new Error("socket reset"); }) as typeof fetch;
      await expect(postToSlackThread("slack:C1:1.0", "x", "transport", "token"))
        .resolves.toEqual({ status: "ambiguous", error: "page_1_of_1:socket reset" });

      globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as typeof fetch;
      await expect(postToSlackThread("slack:C1:1.0", "x", "parse", "token"))
        .resolves.toMatchObject({ status: "ambiguous" });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
