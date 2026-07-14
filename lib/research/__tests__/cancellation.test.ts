import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "../adapters/storage-memory.js";
import { Orchestrator } from "../orchestrator.js";
import { Researcher } from "../researcher.js";
import { postToSlackThread } from "../delivery/slack.js";

const webSearchMock = vi.hoisted(() => vi.fn());
vi.mock("../tools/websearch.js", () => ({
  webSearch: webSearchMock,
  pollExternalJob: vi.fn(),
  startDeepResearch: vi.fn(),
}));
vi.mock("../tools/scrape.js", () => ({ scrapeUrl: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seedRunning(storage: MemoryStorageAdapter, taskId: string, fiberIndex: number) {
  const now = new Date().toISOString();
  await storage.createTask({
    taskId,
    threadKey: "slack:C1:1.0",
    status: "running",
    objective: "race cancellation",
    createdAt: now,
  });
  await storage.createSession(taskId, {
    status: "running",
    objective: "race cancellation",
    fiberIndex,
    llmCalls: 0,
    toolCalls: 0,
    alarmCount: 0,
  }, now);
}

describe("exact research cancellation", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    webSearchMock.mockReset();
  });

  it("is idempotent and suppresses queued/future outbox, deliveries, and alarms", async () => {
    const orchestrator = new Orchestrator({
      storage,
      llm: { complete: vi.fn() } as never,
    });
    const started = await orchestrator.handleMention({
      threadKey: "slack:C1:1.0",
      objective: "cancel me",
      eventId: "evt-cancel",
    });

    await expect(orchestrator.cancelTask(started.taskId, "slack:C1:1.0"))
      .resolves.toMatchObject({ status: "cancelled", taskId: started.taskId });
    await expect(orchestrator.cancelTask(started.taskId, "slack:C1:1.0"))
      .resolves.toMatchObject({ status: "already_cancelled", taskId: started.taskId });

    expect((await storage.getTask(started.taskId))?.status).toBe("cancelled");
    expect((await storage.getSession(started.taskId))?.data.status).toBe("cancelled");
    expect(await storage.getPendingDeliveries()).toEqual([]);
    expect(await storage.getDueAlarms(Number.MAX_SAFE_INTEGER)).toEqual([]);

    // Even an already-produced result replaying after cancellation cannot
    // become a Slack delivery obligation.
    await storage.appendOutbox({
      id: "late-result",
      sessionId: started.taskId,
      targetActor: "orchestrator",
      payload: {
        type: "complete",
        taskId: started.taskId,
        threadKey: "slack:C1:1.0",
        summary: "must stay silent",
      },
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    await orchestrator.processOutbox(started.taskId);
    expect(await storage.getPendingDeliveries()).toEqual([]);
  });

  it("drops a search result that resolves after cancellation", async () => {
    const gate = deferred<Array<{ url: string; title: string; snippet: string }>>();
    webSearchMock.mockReturnValueOnce(gate.promise);
    await seedRunning(storage, "task-search", 0);
    const researcher = new Researcher({
      storage,
      llm: { complete: vi.fn() } as never,
    });

    const running = researcher.runFiberStep("task-search");
    await vi.waitFor(() => expect(webSearchMock).toHaveBeenCalledOnce());
    await storage.cancelResearchTask("task-search", "slack:C1:1.0");
    gate.resolve([{ url: "https://example.test", title: "late", snippet: "late fact" }]);

    await expect(running).resolves.toMatchObject({ done: true });
    expect(await storage.getFacts("task-search")).toEqual([]);
    expect(await storage.getPendingOutbox("task-search")).toEqual([]);
    expect(await storage.getDueAlarms(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("suppresses pending delivery but remains non-quiescent until an in-flight effect resolves", async () => {
    await seedRunning(storage, "task-delivery", 0);
    await storage.appendDeliveryObligation({
      id: "delivery-in-flight",
      threadKey: "slack:C1:1.0",
      payload: { type: "final", text: "may have landed", taskId: "task-delivery" },
      status: "pending",
    });
    await storage.appendDeliveryObligation({
      id: "delivery-pending",
      threadKey: "slack:C1:1.0",
      payload: { type: "interim", text: "must not start", taskId: "task-delivery" },
      status: "pending",
    });

    expect((await storage.claimDelivery("delivery-in-flight"))?.status).toBe("in_flight");
    await expect(storage.cancelResearchTask("task-delivery", "slack:C1:1.0"))
      .resolves.toMatchObject({ status: "cancelled", quiescent: false });
    expect(await storage.claimDelivery("delivery-pending")).toBeNull();
    // Recovery is allowed only for the exact already-started effect.
    expect((await storage.claimDelivery("delivery-in-flight"))?.status).toBe("in_flight");

    await storage.markDeliveryDelivered("delivery-in-flight");
    await expect(storage.cancelResearchTask("task-delivery", "slack:C1:1.0"))
      .resolves.toMatchObject({ status: "already_cancelled", quiescent: true });
    expect(await storage.getDeliveriesToDrain()).toEqual([]);
  });

  it("reports non-quiescence while a deferred Slack fetch can still land", async () => {
    await seedRunning(storage, "task-deferred-delivery", 0);
    await storage.appendDeliveryObligation({
      id: "delivery-deferred",
      threadKey: "slack:C1:1.0",
      payload: { type: "final", text: "result", taskId: "task-deferred-delivery" },
      status: "pending",
    });
    const claimed = await storage.claimDelivery("delivery-deferred");
    expect(claimed?.status).toBe("in_flight");

    const response = deferred<Response>();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(() => response.promise);
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const posting = postToSlackThread(
        claimed!.threadKey,
        claimed!.payload.text,
        claimed!.id,
        "xoxb-test",
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await expect(storage.cancelResearchTask(
        "task-deferred-delivery",
        "slack:C1:1.0",
      )).resolves.toMatchObject({ quiescent: false });

      response.resolve(Response.json({ ok: true }));
      const outcome = await posting;
      expect(outcome.status).toBe("delivered");
      await storage.markDeliveryDelivered(claimed!.id);
      await expect(storage.cancelResearchTask(
        "task-deferred-delivery",
        "slack:C1:1.0",
      )).resolves.toMatchObject({ quiescent: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers an ambiguous cancelled delivery with the same Slack id after restart", async () => {
    await seedRunning(storage, "task-ambiguous-delivery", 0);
    await storage.appendDeliveryObligation({
      id: "delivery-ambiguous",
      threadKey: "slack:C1:1.0",
      payload: { type: "final", text: "result", taskId: "task-ambiguous-delivery" },
      status: "pending",
    });
    const claimed = await storage.claimDelivery("delivery-ambiguous");
    const originalFetch = globalThis.fetch;
    const clientMessageIds: string[] = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      clientMessageIds.push(
        new URLSearchParams(String(init?.body ?? "")).get("client_msg_id")!,
      );
      throw new Error("ambiguous transport");
    }) as typeof fetch;
    try {
      const first = await postToSlackThread(
        claimed!.threadKey, claimed!.payload.text, claimed!.id, "xoxb-test",
      );
      expect(first.status).toBe("ambiguous");
      await expect(storage.cancelResearchTask(
        "task-ambiguous-delivery",
        "slack:C1:1.0",
      )).resolves.toMatchObject({ quiescent: false });

      // Simulate a new alarm/instance enumerating durable state. A cancelled
      // pending effect would be absent; this exact in-flight one is recoverable.
      const recovered = await storage.getDeliveriesToDrain();
      expect(recovered.map((item) => item.id)).toEqual(["delivery-ambiguous"]);
      const replay = await storage.claimDelivery("delivery-ambiguous");
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        clientMessageIds.push(
          new URLSearchParams(String(init?.body ?? "")).get("client_msg_id")!,
        );
        return Response.json({ ok: false, error: "duplicate_message" });
      }) as typeof fetch;
      const second = await postToSlackThread(
        replay!.threadKey, replay!.payload.text, replay!.id, "xoxb-test",
      );
      expect(second).toEqual({ status: "delivered", duplicate: true });
      expect(clientMessageIds[1]).toBe(clientMessageIds[0]);
      await storage.markDeliveryDelivered(replay!.id);
      await expect(storage.cancelResearchTask(
        "task-ambiguous-delivery",
        "slack:C1:1.0",
      )).resolves.toMatchObject({ quiescent: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loses the synthesis CAS and suppresses its late final result", async () => {
    const gate = deferred<{ content: string; model: string }>();
    const complete = vi.fn(() => gate.promise);
    await seedRunning(storage, "task-synthesis", 1);
    const researcher = new Researcher({ storage, llm: { complete } as never });

    const running = researcher.runFiberStep("task-synthesis");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await storage.cancelResearchTask("task-synthesis", "slack:C1:1.0");
    gate.resolve({ content: "late final", model: "test" });

    await expect(running).resolves.toMatchObject({ done: true });
    expect((await storage.getTask("task-synthesis"))?.status).toBe("cancelled");
    expect((await storage.getSession("task-synthesis"))?.data.status).toBe("cancelled");
    expect(await storage.getPendingOutbox("task-synthesis")).toEqual([]);
  });
});
