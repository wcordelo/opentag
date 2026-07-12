/**
 * OrchestratorCore idempotency — duplicate Slack event_id must not create a
 * second task (M6 acceptance). Uses MemoryStorageAdapter; no live Slack.
 */
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../../../../../lib/research/orchestrator.js";
import { MemoryStorageAdapter } from "../../../../../lib/research/adapters/storage-memory.js";
import type { LlmAdapter } from "../../../../../lib/research/adapters/llm.js";

const fakeLlm: LlmAdapter = {
  async complete() {
    return { content: "{}", model: "test" };
  },
};

describe("Orchestrator Slack event idempotency", () => {
  it("returns existing task for duplicate event_id without creating another", async () => {
    const storage = new MemoryStorageAdapter();
    const orch = new Orchestrator({ storage, llm: fakeLlm });

    const req = {
      threadKey: "slack:C1:100.1",
      objective: "test topic",
      eventId: "Ev_DUP",
      eventTs: "100.1",
      channelId: "C1",
    };

    const first = await orch.handleMention(req);
    expect(first.taskId).toBeTruthy();
    expect(first.status).toBe("continuing");

    const second = await orch.handleMention(req);
    expect(second.taskId).toBe(first.taskId);

    const tasks = await storage.getTasksByThread(req.threadKey);
    expect(tasks).toHaveLength(1);
  });
});
