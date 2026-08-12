import { describe, expect, it, vi } from "vitest";
import { createSlackKnowledgeObserver } from "../src/slack/knowledge-observer.js";

describe("Slack knowledge observer", () => {
  it("durably owns outbound observations before returning", async () => {
    const prepare = vi.fn(async () => ({
      accepted: true,
      status: "pending" as const,
    }));
    const observer = createSlackKnowledgeObserver({
      DEFERRED_INGRESS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ prepare }),
      },
    } as never);

    await observer!("T1", {
      operation: "posted",
      channel: "C1",
      ts: "1710000000.200000",
      threadTs: "1710000000.100000",
      text: "durable answer",
    });

    expect(prepare).toHaveBeenCalledWith({
      id: "knowledge-observation:T1:posted:C1:1710000000.200000",
      kind: "knowledge_observation",
      teamId: "T1",
      payload: expect.objectContaining({
        teamId: "T1",
        observation: expect.objectContaining({
          operation: "posted",
          channel: "C1",
          ts: "1710000000.200000",
        }),
      }),
    });
  });

  it("does not hide an exhausted durable observation", async () => {
    const observer = createSlackKnowledgeObserver({
      DEFERRED_INGRESS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          prepare: async () => ({ accepted: false, status: "exhausted" as const }),
        }),
      },
    } as never);

    await expect(observer!("T1", {
      operation: "updated",
      channel: "C1",
      ts: "1710000000.300000",
      text: "recovered answer",
    })).rejects.toThrow("knowledge_observation_ingress_exhausted");
  });

  it("gives each changed update body its own idempotent durable identity", async () => {
    const prepare = vi.fn(async () => ({
      accepted: true,
      status: "pending" as const,
    }));
    const observer = createSlackKnowledgeObserver({
      DEFERRED_INGRESS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ prepare }),
      },
    } as never);

    const base = {
      operation: "updated" as const,
      channel: "C1",
      ts: "1710000000.300000",
      text: "first revision",
    };
    await observer!("T1", base);
    await observer!("T1", { ...base, text: "second revision" });
    await observer!("T1", { ...base, text: "second revision" });

    const calls = prepare.mock.calls as unknown as Array<[
      { id: string; payload?: unknown },
    ]>;
    const ids = calls.map(([job]) => job.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(calls[1]![0]).toMatchObject({
      payload: {
        observation: { observationId: expect.any(String) },
      },
    });
  });
});
