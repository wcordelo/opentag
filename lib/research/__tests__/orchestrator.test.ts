import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryStorageAdapter } from "../adapters/storage-memory.js";
import { DirectLlmAdapter } from "../adapters/llm.js";
import { Orchestrator } from "../orchestrator.js";

describe("Orchestrator", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
  });

  it("creates a task and returns continuing status", async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue({
        content: '{"verdict":"pass","issues":[]}',
        model: "test",
      }),
    };

    const orchestrator = new Orchestrator({ storage, llm: llm as unknown as DirectLlmAdapter });

    const result = await orchestrator.handleMention({
      threadKey: "slack:C123:1234.5678",
      objective: "What is TypeScript?",
      eventId: "evt_1",
    });

    expect(result.status).toBe("continuing");
    expect(result.taskId).toBeTruthy();

    const task = await storage.getTask(result.taskId);
    expect(task?.status).toBe("running");
    expect(task?.objective).toBe("What is TypeScript?");
  });

  it("deduplicates slack events", async () => {
    const llm = { complete: vi.fn() };
    const orchestrator = new Orchestrator({ storage, llm: llm as never });

    await orchestrator.handleMention({
      threadKey: "slack:C123:1234.5678",
      objective: "topic",
      eventId: "evt_dup",
    });

    const second = await orchestrator.handleMention({
      threadKey: "slack:C123:1234.5678",
      objective: "topic",
      eventId: "evt_dup",
    });

    expect(second.status).toBe("continuing");
  });
});
