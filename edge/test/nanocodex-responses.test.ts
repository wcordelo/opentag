import { describe, expect, it, vi } from "vitest";
import {
  NanocodexResponsesClient,
  NanocodexResponsesSession,
  parseNanocodexResponsesSse,
  type NanocodexProviderState,
} from "../workers/sandbox/src/nanocodex-responses.js";

function streamResponse(id: string, text: string): Response {
  return new Response([
    `data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      },
    })}`,
    "",
  ].join("\n"), { headers: { "content-type": "text/event-stream" } });
}

function requestBody(call: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = call.mock.calls[index]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("native Nanocodex Responses adapter", () => {
  it("parses typed streaming lifecycle events", () => {
    const events = parseNanocodexResponsesSse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}',
      'data: [DONE]',
    ].join("\n\n"));
    expect(events).toEqual([{ type: "response.output_text.delta", delta: "hi" }]);
  });

  it("uses full history first, then previous_response_id for healthy continuation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(streamResponse("resp-1", "first"))
      .mockResolvedValueOnce(streamResponse("resp-2", "second"));
    const session = new NanocodexResponsesSession(
      new NanocodexResponsesClient({ fetcher }),
      { model: "gpt-5.6-sol", instructions: "system" },
    );

    await expect(session.run({ input: "hello" })).resolves.toMatchObject({ responseId: "resp-1", text: "first" });
    await expect(session.run({ input: "next" })).resolves.toMatchObject({ responseId: "resp-2", text: "second", replayed: false });

    expect(requestBody(fetcher, 0)).toMatchObject({ model: "gpt-5.6-sol", store: true, stream: true });
    expect(requestBody(fetcher, 0).input).toEqual([{ role: "user", content: "hello" }]);
    expect(requestBody(fetcher, 1)).toMatchObject({ previous_response_id: "resp-1" });
    expect(requestBody(fetcher, 1).input).toEqual([{ role: "user", content: "next" }]);
  });

  it("replays full typed history once when a checkpoint is unavailable", async () => {
    const initial: NanocodexProviderState = {
      version: 1,
      previousResponseId: "lost-response",
      checkpoint: "healthy",
      history: [
        { role: "user", content: "old question" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
      ],
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "previous_response_not_found" } }, { status: 404 }))
      .mockResolvedValueOnce(streamResponse("resp-replayed", "replayed"));
    const session = new NanocodexResponsesSession(
      new NanocodexResponsesClient({ fetcher }),
      { model: "gpt-5.6-sol" },
      initial,
    );

    await expect(session.run({ input: "new question" })).resolves.toMatchObject({ responseId: "resp-replayed", replayed: true });
    expect(requestBody(fetcher, 0)).toMatchObject({ previous_response_id: "lost-response" });
    expect(requestBody(fetcher, 0).input).toEqual([{ role: "user", content: "new question" }]);
    expect(requestBody(fetcher, 1)).not.toHaveProperty("previous_response_id");
    expect(requestBody(fetcher, 1).input).toEqual([
      ...initial.history,
      { role: "user", content: "new question" },
    ]);
    expect(session.snapshot().checkpoint).toBe("healthy");
  });

  it("does not commit history without a terminal completed event", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const session = new NanocodexResponsesSession(
      new NanocodexResponsesClient({ fetcher }),
      { model: "gpt-5.6-sol" },
    );
    await expect(session.run({ input: "hello" })).rejects.toThrow("responses_missing_completed");
    expect(session.snapshot().history).toEqual([]);
  });

  it("does not replay a healthy checkpoint for an ordinary provider failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response([
      'data: {"type":"response.failed","error":{"code":"context_length_exceeded"}}',
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } }));
    const session = new NanocodexResponsesSession(
      new NanocodexResponsesClient({ fetcher }),
      { model: "gpt-5.6-sol" },
      {
        version: 1,
        previousResponseId: "healthy-response",
        checkpoint: "healthy",
        history: [{ role: "user", content: "old question" }],
      },
    );

    await expect(session.run({ input: "new question" })).rejects.toThrow("context_length_exceeded");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not emit partial checkpoint output before a replay succeeds", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response([
        'data: {"type":"response.output_text.delta","delta":"partial"}',
        "",
        'data: {"type":"error","code":"previous_response_not_found"}',
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(streamResponse("resp-replayed", "complete"));
    const output: string[] = [];
    const session = new NanocodexResponsesSession(
      new NanocodexResponsesClient({ fetcher }),
      { model: "gpt-5.6-sol" },
      {
        version: 1,
        previousResponseId: "lost-response",
        checkpoint: "healthy",
        history: [{ role: "user", content: "old question" }],
      },
    );

    await expect(session.run({
      input: "new question",
      onEvent: (event) => {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") output.push(event.delta);
      },
    })).resolves.toMatchObject({ replayed: true });
    expect(output).toEqual(["complete"]);
  });

  it("rejects a provider state snapshot that exceeds the durable bound", () => {
    const session = new NanocodexResponsesSession(
      new NanocodexResponsesClient(),
      { model: "gpt-5.6-sol" },
    );
    const oversized = {
      version: 1 as const,
      checkpoint: "replay_required" as const,
      history: [{ role: "user" as const, content: "x".repeat(2 * 1024 * 1024) }],
    };
    expect(() => new NanocodexResponsesSession(
      new NanocodexResponsesClient(),
      { model: "gpt-5.6-sol" },
      oversized,
    )).toThrow("invalid_provider_state");
  });
});
