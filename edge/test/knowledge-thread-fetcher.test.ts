import { describe, expect, it, vi } from "vitest";
import {
  MAX_KNOWLEDGE_RETRY_AFTER_MS,
  KnowledgeThreadFetchError,
  createSlackKnowledgePageReader,
  fetchKnowledgeThread,
  type KnowledgeThreadPageReader,
  type SlackThreadMessage,
} from "../src/slack/knowledge-thread-fetcher.js";
import { KNOWLEDGE_EXECUTION_BUDGETS } from "../src/memory/knowledge-contract.js";
import { SUPERMEMORY_POLL } from "../src/memory/supermemory-adapter.js";
import { SUPERMEMORY_REQUEST_TIMEOUT_MS } from "../src/memory/supermemory-client.js";

function messages(start: number, count: number): SlackThreadMessage[] {
  return Array.from({ length: count }, (_, offset) => ({
    ts: `${start + offset}.000001`,
    client_msg_id: `client-${start + offset}`,
    user: "U1",
    text: `message ${start + offset}`,
  }));
}

describe("knowledge Slack thread pagination", () => {
  it("fetches a >100-message thread across every permitted cursor and deduplicates overlap", async () => {
    const calls: Array<string | undefined> = [];
    const readPage: KnowledgeThreadPageReader = async ({ cursor }) => {
      calls.push(cursor);
      if (!cursor) {
        return {
          ok: true,
          messages: messages(1, 100),
          has_more: true,
          response_metadata: { next_cursor: "cursor-2" },
        };
      }
      return {
        ok: true,
        messages: [messages(1, 1)[0]!, ...messages(101, 51)],
        has_more: false,
        response_metadata: { next_cursor: "" },
      };
    };
    const result = await fetchKnowledgeThread({ channel: "C1", threadTs: "1.0", readPage });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.messages).toHaveLength(151);
    expect(result.pages).toBe(2);
    expect(calls).toEqual([undefined, "cursor-2"]);
  });

  it.each([
    ["cursor_missing", async () => ({ ok: true, messages: [], has_more: true })],
    ["cursor_loop", async ({ cursor }: { cursor?: string }) => ({
      ok: true,
      messages: [],
      has_more: true,
      response_metadata: { next_cursor: cursor ?? "same" },
    })],
    ["slack_error", async () => ({ ok: false, error: "not_allowed", messages: [] })],
    ["retry_exhausted", async () => { throw new KnowledgeThreadFetchError("retry_exhausted"); }],
    ["transport_error", async () => { throw new Error("ambiguous transport failure"); }],
  ] as const)("returns incomplete for %s", async (reason, readPage) => {
    const result = await fetchKnowledgeThread({
      channel: "C1",
      threadTs: "1.0",
      readPage: readPage as KnowledgeThreadPageReader,
    });
    expect(result).toMatchObject({ status: "incomplete", reason });
  });

  it("returns incomplete rather than a truncated complete write for every cap", async () => {
    const pageCap = await fetchKnowledgeThread({
      channel: "C1",
      threadTs: "1.0",
      limits: { maxPages: 1 },
      readPage: async () => ({
        ok: true,
        messages: messages(1, 1),
        has_more: true,
        response_metadata: { next_cursor: "more" },
      }),
    });
    expect(pageCap).toMatchObject({ status: "incomplete", reason: "page_cap" });

    const messageCap = await fetchKnowledgeThread({
      channel: "C1",
      threadTs: "1.0",
      limits: { maxMessages: 2 },
      readPage: async () => ({ ok: true, messages: messages(1, 3), has_more: false }),
    });
    expect(messageCap).toMatchObject({ status: "incomplete", reason: "message_cap" });

    const byteCap = await fetchKnowledgeThread({
      channel: "C1",
      threadTs: "1.0",
      limits: { maxBytes: 20 },
      readPage: async () => ({ ok: true, messages: messages(1, 1), has_more: false }),
    });
    expect(byteCap).toMatchObject({ status: "incomplete", reason: "byte_cap" });
  });

  it("uses form-urlencoded Slack requests and bounds Retry-After attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "2" },
      }))
      .mockResolvedValueOnce(Response.json({ ok: true, messages: [], has_more: false }));
    const reader = createSlackKnowledgePageReader({
      botToken: "xoxb-fixture",
      maxRateLimitRetries: 1,
      sleep,
      fetch: fetchMock,
    });
    expect(await reader({ channel: "C1", threadTs: "1.0", cursor: "next", limit: 100 }))
      .toMatchObject({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(String(init.body)).toBe("channel=C1&ts=1.0&limit=100&cursor=next");

    const exhausted = createSlackKnowledgePageReader({
      botToken: "xoxb-fixture",
      maxRateLimitRetries: 0,
      fetch: async () => new Response("rate limited", { status: 429 }),
    });
    await expect(exhausted({ channel: "C1", threadTs: "1.0", limit: 100 }))
      .rejects.toMatchObject({ reason: "retry_exhausted" });
  });

  it("caps an extreme Retry-After before retrying a page", async () => {
    const sleep = vi.fn(async () => undefined);
    const reader = createSlackKnowledgePageReader({
      botToken: "xoxb-fixture",
      maxRateLimitRetries: 1,
      sleep,
      fetch: vi.fn()
        .mockResolvedValueOnce(new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "999999" },
        }))
        .mockResolvedValueOnce(Response.json({ ok: true, messages: [], has_more: false })),
    });
    await reader({ channel: "C1", threadTs: "1.0", limit: 100 });
    expect(sleep).toHaveBeenCalledWith(MAX_KNOWLEDGE_RETRY_AFTER_MS);
  });

  it("aborts a page that settles only when the overall thread deadline fires", async () => {
    const readPage: KnowledgeThreadPageReader = async ({ signal }) =>
      new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new KnowledgeThreadFetchError("timeout")),
          { once: true },
        );
      });
    await expect(fetchKnowledgeThread({
      channel: "C1",
      threadTs: "1.0",
      readPage,
      overallTimeoutMs: 10,
    })).resolves.toMatchObject({ status: "incomplete", reason: "timeout" });
  });

  it("aborts a hung Slack transport per attempt", async () => {
    const reader = createSlackKnowledgePageReader({
      botToken: "xoxb-fixture",
      perAttemptTimeoutMs: 10,
      fetch: async (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    await expect(reader({ channel: "C1", threadTs: "1.0", limit: 100 }))
      .rejects.toMatchObject({ reason: "timeout" });
  });

  it("stops 429 pagination retries when the total budget would be exhausted", async () => {
    let now = 0;
    const fetchMock = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "10" },
    }));
    const reader = createSlackKnowledgePageReader({
      botToken: "xoxb-fixture",
      maxRateLimitRetries: 2,
      fetch: fetchMock,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    await expect(reader({
      channel: "C1",
      threadTs: "1.0",
      limit: 100,
      deadlineAt: 15_000,
    })).rejects.toMatchObject({ reason: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the durable leases beyond the maximum fetch, Local, and poll path", () => {
    const maximumEffectPath =
      KNOWLEDGE_EXECUTION_BUDGETS.slackThreadFetchMs +
      SUPERMEMORY_REQUEST_TIMEOUT_MS +
      SUPERMEMORY_POLL.deadlineMs +
      KNOWLEDGE_EXECUTION_BUDGETS.localPollOverrunMs +
      KNOWLEDGE_EXECUTION_BUDGETS.controlPlaneMarginMs;
    expect(KNOWLEDGE_EXECUTION_BUDGETS.ledgerLeaseMs).toBeGreaterThan(maximumEffectPath);
    expect(KNOWLEDGE_EXECUTION_BUDGETS.configEffectLeaseMs)
      .toBeGreaterThan(KNOWLEDGE_EXECUTION_BUDGETS.ledgerLeaseMs);
  });
});
