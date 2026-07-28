import { describe, expect, it, vi } from "vitest";
import type { TrackedKnowledgeSource } from "../src/config/knowledge-config.js";
import { createKnowledgeJob } from "../src/memory/knowledge-contract.js";
import {
  handleKnowledgeQueue,
  knowledgeCandidateFromSlackCallback,
  scheduleKnowledgeFromSlackEvent,
  type KnowledgeQueueEnv,
} from "../src/memory/knowledge-jobs.js";
import {
  retryKnowledgeBatchWithoutParsing,
  routeKnowledgeQueueName,
} from "../src/memory/knowledge-queue-routing.js";

function source(overrides: Partial<TrackedKnowledgeSource> = {}): TrackedKnowledgeSource {
  return {
    schemaVersion: 1,
    teamId: "T1",
    projectId: "P1",
    channelId: "C1",
    enabled: true,
    everEnabled: true,
    readerPolicyRef: "bundle:readers",
    retentionDays: null,
    configVersion: 3,
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function descriptor(configVersion = 3) {
  return createKnowledgeJob({
    teamId: "T1",
    projectId: "P1",
    channelId: "C1",
    threadTs: "171234.000100",
    configVersion,
    requestedAt: "2026-07-19T01:00:00.000Z",
    reason: "event",
  });
}

function queueMessage(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      id: "msg-1",
      timestamp: new Date(),
      attempts: 1,
      body,
      ack,
      retry,
    } as unknown as Message<unknown>,
    ack,
    retry,
  };
}

function batch(message: Message<unknown>): MessageBatch<unknown> {
  return {
    messages: [message],
    queue: "knowledge-test",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

function fakeEnv(args: {
  sources?: TrackedKnowledgeSource[];
  exactSource?: TrackedKnowledgeSource;
  knowledgeFetch?: (request: Request) => Promise<Response>;
}) {
  const descriptors: unknown[] = [];
  const outcomes: unknown[] = [];
  const stale: unknown[] = [];
  const workspaceFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/listTrackedKnowledgeSources") return Response.json(args.sources ?? []);
    if (path === "/getTrackedKnowledgeSource") {
      return Response.json(args.exactSource ?? source({ enabled: false, configVersion: 0 }));
    }
    if (path === "/beginKnowledgeIngestionEffect") {
      return Response.json({
        decision: "lease",
        effectToken: "effect-token-fixture",
        expiresAt: Date.now() + 80_000,
        source: args.exactSource ?? source(),
      });
    }
    if (path === "/validateKnowledgeIngestionEffect") {
      return Response.json({ valid: true, source: args.exactSource ?? source() });
    }
    if (path === "/releaseKnowledgeIngestionEffect") {
      return Response.json({ released: true });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  const knowledgeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (args.knowledgeFetch) return args.knowledgeFetch(request);
    const path = new URL(request.url).pathname;
    const body = await request.json();
    if (path === "/descriptor") descriptors.push(body);
    if (path === "/outcome") outcomes.push(body);
    if (path === "/stale") stale.push(body);
    if (path === "/lease") {
      return Response.json({ decision: "lease", leaseToken: "lease-1", leaseExpiresAt: Date.now() + 70_000 });
    }
    return Response.json({ ok: true });
  });
  const env = {
    WORKSPACE_CONFIG: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: workspaceFetch }),
    },
    KNOWLEDGE: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: knowledgeFetch }),
    },
  } as unknown as KnowledgeQueueEnv;
  return { env, descriptors, outcomes, stale, workspaceFetch, knowledgeFetch };
}

describe("knowledge descriptor scheduling", () => {
  it("enqueues nothing for an unconfigured channel and never infers a project from Slack", async () => {
    const fixture = fakeEnv({ sources: [] });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: { type: "message", channel: "C1", ts: "171234.000100" },
    });
    expect(result).toEqual({ scheduled: 0 });
    expect(fixture.descriptors).toEqual([]);
    expect(fixture.workspaceFetch).toHaveBeenCalledOnce();
  });

  it("creates one server-derived descriptor for the sole exact enabled project row", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { ts: "171234.000100", thread_ts: "171000.000001" },
      },
    }, () => new Date("2026-07-19T02:00:00.000Z"));
    expect(result).toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({ projectId: "P1", threadTs: "171000.000001", configVersion: 3 }),
    ]);
  });

  it("gives only a proven root deletion source-tombstone authority", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000100",
        event_ts: "171235.000200",
        previous_message: { ts: "171234.000100" },
      },
    });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({
        threadTs: "171234.000100",
        messageTs: "171234.000100",
        reason: "delete",
      }),
    ]);
  });

  it.each([
    ["thread reply", undefined],
    ["broadcast reply", "thread_broadcast"],
  ])("turns a deleted %s into an exact parent refetch descriptor", async (
    _label,
    previousSubtype,
  ) => {
    const fixture = fakeEnv({ sources: [source()] });
    await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000199",
        event_ts: "171235.000200",
        previous_message: {
          ts: "171234.000199",
          thread_ts: "171000.000001",
          ...(previousSubtype ? { subtype: previousSubtype } : {}),
        } as never,
      },
    });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({
        threadTs: "171000.000001",
        messageTs: "171234.000199",
        reason: "reply_delete",
      }),
    ]);
  });

  it("never derives a root tombstone from malformed previous_message identity", async () => {
    expect(knowledgeCandidateFromSlackCallback({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000100",
      },
    })).toBeUndefined();
    expect(knowledgeCandidateFromSlackCallback({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000100",
        previous_message: { ts: "171234.999999" },
      },
    })).toBeUndefined();
    expect(knowledgeCandidateFromSlackCallback({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000199",
        previous_message: {
          ts: "171234.999999",
          thread_ts: "171000.000001",
        },
      },
    })).toMatchObject({
      threadTs: "171000.000001",
      messageTs: "171234.000199",
      reason: "reply_delete",
    });
  });

  it("fails closed if storage ever returns multiple enabled projects for one channel", async () => {
    const fixture = fakeEnv({ sources: [source(), source({ projectId: "P2" })] });
    await expect(scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: { type: "message", channel: "C1", ts: "171234.000100" },
    })).rejects.toThrow("tracked_source_project_conflict");
    expect(fixture.descriptors).toEqual([]);
  });
});

describe("opentag-bot knowledge Queue consumer", () => {
  it("routes only exact role-bound primary and DLQ names", () => {
    const config = {
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge-dlq",
    };
    expect(routeKnowledgeQueueName("opentag-knowledge", config)).toBe("primary");
    expect(routeKnowledgeQueueName("opentag-knowledge-dlq", config)).toBe("dlq");
    expect(() => routeKnowledgeQueueName("other-queue", config))
      .toThrow("knowledge_queue_name_unknown");
  });

  it("rejects missing, identical, and swapped Queue role names", () => {
    expect(() => routeKnowledgeQueueName("opentag-knowledge", {
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge-dlq",
    })).toThrow("knowledge_queue_names_missing_distinct_or_swapped");
    expect(() => routeKnowledgeQueueName("opentag-knowledge", {
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge",
    })).toThrow("knowledge_queue_names_missing_distinct_or_swapped");
    expect(() => routeKnowledgeQueueName("opentag-knowledge", {
      KNOWLEDGE_QUEUE_NAME: "opentag-knowledge-dlq",
      KNOWLEDGE_DLQ_NAME: "opentag-knowledge",
    })).toThrow("knowledge_queue_names_missing_distinct_or_swapped");
  });

  it("retries routing failures without parsing message bodies", () => {
    const retry = vi.fn();
    const message = {
      id: "unknown-queue-message",
      get body(): never {
        throw new Error("body must not be parsed");
      },
      retry,
    };
    retryKnowledgeBatchWithoutParsing({
      queue: "unknown",
      messages: [message],
    } as never);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("acks configuration-version drift as an explicit no-op without dispatch", async () => {
    const fixture = fakeEnv({ exactSource: source({ configVersion: 4 }) });
    const queued = queueMessage(descriptor(3));
    const dispatch = vi.fn();
    await handleKnowledgeQueue(batch(queued.message), fixture.env, dispatch);
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.stale).toHaveLength(1);
  });

  it("runs network-capable work only through the injected Queue dispatch seam", async () => {
    const fixture = fakeEnv({ exactSource: source() });
    const queued = queueMessage(descriptor());
    const dispatch = vi.fn(async () => ({
      status: "normalized" as const,
      desiredRevision: "sha256:abc",
    }));
    await handleKnowledgeQueue(batch(queued.message), fixture.env, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(fixture.outcomes).toEqual([
      expect.objectContaining({
        sourceKey: "slack:T1:C1:171234.000100",
        leaseToken: "lease-1",
        outcome: { status: "normalized", desiredRevision: "sha256:abc" },
      }),
    ]);
  });

  it("keeps the message retryable while the B3 dispatch is deliberately unavailable", async () => {
    const fixture = fakeEnv({ exactSource: source() });
    const queued = queueMessage(descriptor());
    await handleKnowledgeQueue(batch(queued.message), fixture.env);
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(fixture.outcomes).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({ errorCode: "b3_dispatch_not_registered" }),
      }),
    ]);
  });
});
