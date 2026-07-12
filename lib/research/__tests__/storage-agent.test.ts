import { describe, it, expect } from "vitest";
import { MemoryStorageAdapter } from "../adapters/storage-memory.js";
import type {
  AgentContainerRecord,
  AgentHandoffRecord,
  AgentExecutionLogEntry,
  GithubArtifactRecord,
} from "../types.js";

describe("MemoryStorageAdapter — agent pipeline", () => {
  it("creates, gets, and updates an agent container", async () => {
    const storage = new MemoryStorageAdapter();
    const record: AgentContainerRecord = {
      containerId: "c1",
      sessionId: "s1",
      flavor: "pm",
      status: "starting",
    };

    await storage.createAgentContainer(record);

    const fetched = await storage.getAgentContainer("c1");
    expect(fetched).toEqual(record);

    await storage.updateAgentContainerStatus("c1", "running", {
      previewUrl: "https://preview.example.com",
      startedAt: "2026-01-01T00:00:00Z",
    });

    const updated = await storage.getAgentContainer("c1");
    expect(updated).toEqual({
      ...record,
      status: "running",
      previewUrl: "https://preview.example.com",
      startedAt: "2026-01-01T00:00:00Z",
    });

    await storage.updateAgentContainerStatus("c1", "terminated", {
      killedAt: "2026-01-01T01:00:00Z",
    });

    const terminated = await storage.getAgentContainer("c1");
    expect(terminated?.status).toBe("terminated");
    expect(terminated?.killedAt).toBe("2026-01-01T01:00:00Z");
    // previously-set fields survive a partial update
    expect(terminated?.previewUrl).toBe("https://preview.example.com");
  });

  it("returns null for an unknown container", async () => {
    const storage = new MemoryStorageAdapter();
    expect(await storage.getAgentContainer("missing")).toBeNull();
  });

  it("appends and retrieves handoffs by session, from either side", async () => {
    const storage = new MemoryStorageAdapter();
    const handoff1: AgentHandoffRecord = {
      id: "h1",
      fromSessionId: "pm-session",
      toSessionId: "impl-session",
      round: 1,
      compressedTokens: 500,
      validated: true,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const handoff2: AgentHandoffRecord = {
      id: "h2",
      fromSessionId: "impl-session",
      toSessionId: "verify-session",
      round: 2,
      validated: false,
      createdAt: "2026-01-01T00:05:00Z",
    };

    await storage.appendHandoff(handoff1);
    await storage.appendHandoff(handoff2);

    const forPm = await storage.getHandoffs("pm-session");
    expect(forPm).toEqual([handoff1]);

    const forImpl = await storage.getHandoffs("impl-session");
    expect(forImpl).toEqual([handoff1, handoff2]);

    const forVerify = await storage.getHandoffs("verify-session");
    expect(forVerify).toEqual([handoff2]);

    const forUnknown = await storage.getHandoffs("nope");
    expect(forUnknown).toEqual([]);
  });

  it("appends and retrieves execution logs scoped to a session, respecting limit", async () => {
    const storage = new MemoryStorageAdapter();
    const entries: AgentExecutionLogEntry[] = Array.from({ length: 3 }, (_, i) => ({
      id: `log-${i}`,
      sessionId: "s1",
      containerId: "c1",
      step: `step-${i}`,
      toolName: "run_tests",
      request: { i },
      response: { ok: true },
      durationMs: 10 * i,
      createdAt: `2026-01-01T00:0${i}:00Z`,
    }));

    for (const entry of entries) {
      await storage.appendExecutionLog(entry);
    }
    await storage.appendExecutionLog({
      id: "other-session-log",
      sessionId: "s2",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const logs = await storage.getExecutionLogs("s1");
    expect(logs).toEqual(entries);

    const limited = await storage.getExecutionLogs("s1", 2);
    expect(limited).toEqual(entries.slice(0, 2));

    const other = await storage.getExecutionLogs("s2");
    expect(other).toHaveLength(1);
    expect(other[0]?.id).toBe("other-session-log");
  });

  it("appends a github artifact without throwing", async () => {
    const storage = new MemoryStorageAdapter();
    const artifact: GithubArtifactRecord = {
      id: "gh1",
      sessionId: "s1",
      prUrl: "https://github.com/org/repo/pull/1",
      commitSha: "abc123",
      branchName: "feature/x",
      createdAt: "2026-01-01T00:00:00Z",
    };

    await expect(storage.appendGithubArtifact(artifact)).resolves.toBeUndefined();
  });
});
