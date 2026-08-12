import { describe, expect, it, vi } from "vitest";
import type { TrackedKnowledgeSource } from "../src/config/knowledge-config.js";
import { createKnowledgeJob } from "../src/memory/knowledge-contract.js";
import {
  handleKnowledgeQueue,
  knowledgeCandidateFromSlackCallback,
  parseKnowledgeJob,
  slackKnowledgeAclInvalidationFromSlackCallback,
  scheduleKnowledgeFromSlackEvent,
  scheduleKnowledgeFromSlackMessage,
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
  botUserId?: string;
  slackFetchImpl?: typeof fetch;
  exactSource?: TrackedKnowledgeSource;
  deletedThreadTs?: string;
  resolvedMessageThreadTs?: string;
  lifecycleResult?: { affectedChannels: string[] };
  knowledgeFetch?: (request: Request) => Promise<Response>;
}) {
  const descriptors: unknown[] = [];
  const outcomes: unknown[] = [];
  const stale: unknown[] = [];
  const aclInvalidations: unknown[] = [];
  const workspaceFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/resolveSlackKnowledgeSource") {
      if ((args.sources?.filter((item) => item.enabled).length ?? 0) > 1) {
        return Response.json({ error: "tracked_source_project_conflict" }, { status: 409 });
      }
      return Response.json({ source: args.sources?.[0] ?? null });
    }
    if (path === "/applySlackLifecycle") {
      return Response.json(args.lifecycleResult ?? { affectedChannels: [] });
    }
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
    const body = await request.json() as {
      sourceKey?: string;
      threadTs?: string;
      messageTs?: string;
    };
    if (path === "/message-thread/resolve") {
      const resolvedThreadTs = args.resolvedMessageThreadTs ?? args.deletedThreadTs;
      return Response.json(resolvedThreadTs
        ? { found: true, threadTs: resolvedThreadTs }
        : { found: false });
    }
    if (path === "/descriptor") {
      descriptors.push(body);
      return Response.json({
        accepted: true,
        reason: "new",
        descriptorKey: `${body.sourceKey ?? "source"}:${body.threadTs ?? "thread"}`,
      });
    }
    if (path === "/acl/invalidate") {
      aclInvalidations.push(body);
      return Response.json({ invalidated: true, duplicate: false, revision: 1 });
    }
    if (path === "/outcome") outcomes.push(body);
    if (path === "/stale") stale.push(body);
    if (path === "/lease") {
      return Response.json({ decision: "lease", leaseToken: "lease-1", leaseExpiresAt: Date.now() + 70_000 });
    }
    return Response.json({ ok: true });
  });
  const env = {
    ...(args.botUserId ? { SLACK_BOT_USER_ID: args.botUserId } : {}),
    ...(args.slackFetchImpl ? { SLACK_BOT_TOKEN: "xoxb-test", slackFetchImpl: args.slackFetchImpl } : {}),
    WORKSPACE_CONFIG: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: workspaceFetch }),
    },
    KNOWLEDGE: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: knowledgeFetch }),
    },
  } as unknown as KnowledgeQueueEnv;
  return { env, descriptors, outcomes, stale, aclInvalidations, workspaceFetch, knowledgeFetch };
}

describe("knowledge descriptor scheduling", () => {
  it("uses the same exact source for bot posts and final content updates", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    let observedAt = 0;
    const now = () => new Date(Date.parse("2026-08-02T07:00:00.000Z") + observedAt++);

    await expect(scheduleKnowledgeFromSlackMessage(fixture.env, {
      teamId: "T1",
      channelId: "C1",
      ts: "171234.000200",
      threadTs: "171234.000100",
      operation: "posted",
    }, now)).resolves.toEqual({ scheduled: 1 });
    await expect(scheduleKnowledgeFromSlackMessage(fixture.env, {
      teamId: "T1",
      channelId: "C1",
      ts: "171234.000200",
      threadTs: "171234.000100",
      operation: "updated",
    }, now)).resolves.toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({
        teamId: "T1",
        channelId: "C1",
        threadTs: "171234.000100",
        observedMessageTs: "171234.000200",
      }),
      expect.objectContaining({
        teamId: "T1",
        channelId: "C1",
        threadTs: "171234.000100",
        observedMessageTs: "171234.000200",
      }),
    ]);
  });

  it("preserves and validates the observed timestamp at queue boundaries", () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "171234.000100",
      observedMessageTs: "171234.000200",
      configVersion: 3,
      requestedAt: "2026-08-02T07:00:00.000Z",
      reason: "event",
    });
    expect(parseKnowledgeJob(job)).toMatchObject({ observedMessageTs: "171234.000200" });
    expect(() => parseKnowledgeJob({ ...job, observedMessageTs: 171234.0002 })).toThrow(
      "observedMessageTs is required",
    );
  });

  it("orders an immediate outbound final update after its post", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const now = () => new Date("2026-08-02T07:00:00.000Z");

    await scheduleKnowledgeFromSlackMessage(fixture.env, {
      teamId: "T1",
      channelId: "C1",
      ts: "171234.000200",
      threadTs: "171234.000100",
      operation: "posted",
    }, now);
    await scheduleKnowledgeFromSlackMessage(fixture.env, {
      teamId: "T1",
      channelId: "C1",
      ts: "171234.000200",
      threadTs: "171234.000100",
      operation: "updated",
    }, now);

    const requestedAt = fixture.descriptors.map((descriptor) =>
      (descriptor as { requestedAt: string }).requestedAt,
    );
    expect(requestedAt).toEqual([
      "2026-08-02T07:00:00.000Z",
      "2026-08-02T07:00:00.001Z",
    ]);
  });

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

  it("does not acknowledge an outbound observation without an enabled source", async () => {
    const fixture = fakeEnv({ sources: [] });
    await expect(scheduleKnowledgeFromSlackMessage(fixture.env, {
      teamId: "T1",
      channelId: "C1",
      ts: "171234.000100",
      threadTs: "171234.000001",
      operation: "posted",
    })).rejects.toThrow("knowledge_observation_source_not_enabled");
    expect(fixture.descriptors).toEqual([]);
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
      expect.objectContaining({
        projectId: "P1",
        threadTs: "171000.000001",
        observedMessageTs: "171234.000100",
        configVersion: 3,
      }),
    ]);
  });

  it("indexes bot-authored message events without admitting a response turn", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      event_id: "bot-message-1",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "bot_message",
        bot_id: "B1",
        channel: "C1",
        ts: "171234.000150",
        thread_ts: "171000.000001",
      },
    });
    expect(result).toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({
        threadTs: "171000.000001",
        observedMessageTs: "171234.000150",
        reason: "event",
      }),
    ]);
  });

  it("refreshes a reaction event's affected thread without admitting a turn", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      event_id: "reaction-1",
      team_id: "T1",
      event: {
        type: "reaction_added",
        channel: "C1",
        event_ts: "171234.000200",
        item: { type: "message", channel: "C1", ts: "171234.000100", thread_ts: "171000.000001" },
      },
    });
    expect(result).toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({ threadTs: "171000.000001" }),
    ]);
  });

  it("does not turn the bot's transient eyes reaction into a knowledge refresh", async () => {
    const fixture = fakeEnv({ sources: [source()], botUserId: "U_BOT" });
    for (const type of ["reaction_added", "reaction_removed"] as const) {
      const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
        type: "event_callback",
        event_id: `bot-eyes-${type}`,
        team_id: "T1",
        event: {
          type,
          reaction: "eyes",
          user: "U_BOT",
          channel: "C1",
          event_ts: "171234.000300",
          item: { type: "message", channel: "C1", ts: "171234.000100", thread_ts: "171000.000001" },
        },
      });
      expect(result).toEqual({ scheduled: 0 });
    }
    expect(fixture.descriptors).toEqual([]);
  });

  it("keeps user eyes reactions as knowledge refresh signals", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      event_id: "user-eyes",
      team_id: "T1",
      event: {
        type: "reaction_added",
        reaction: "eyes",
        user: "U_HUMAN",
        channel: "C1",
        event_ts: "171234.000400",
        item: { type: "message", channel: "C1", ts: "171234.000100", thread_ts: "171000.000001" },
      },
    });
    expect(result).toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({ threadTs: "171000.000001" }),
    ]);
  });

  it("resolves a documented reaction payload to the actual parent thread", async () => {
    const slackFetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("conversations.history");
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("latest")).toBe("171234.000199");
      expect(body.get("inclusive")).toBe("true");
      return Response.json({
        ok: true,
        messages: [{ ts: "171234.000199", thread_ts: "171000.000001" }],
      });
    });
    const fixture = fakeEnv({ sources: [source()], slackFetchImpl });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      event_id: "reaction-real-shape",
      team_id: "T1",
      event: {
        type: "reaction_added",
        reaction: "thumbsup",
        user: "U_HUMAN",
        channel: "C1",
        event_ts: "171234.000300",
        item: { type: "message", channel: "C1", ts: "171234.000199" },
      },
    });
    expect(result).toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({ threadTs: "171000.000001" }),
    ]);
  });

  it("uses the durable message map for a reply reaction", async () => {
    const slackFetchImpl = vi.fn();
    const fixture = fakeEnv({
      sources: [source()],
      resolvedMessageThreadTs: "171000.000001",
      slackFetchImpl,
    });
    await expect(scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "reaction_added",
        reaction: "thumbsup",
        user: "U_HUMAN",
        channel: "C1",
        item: { type: "message", channel: "C1", ts: "171234.000199" },
      },
    })).resolves.toEqual({ scheduled: 1 });
    expect(slackFetchImpl).not.toHaveBeenCalled();
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({ threadTs: "171000.000001" }),
    ]);
  });

  it("uses the nested parent from a message_replied delivery", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      event_id: "message-replied-real-shape",
      team_id: "T1",
      event: {
        type: "message",
        channel: "C1",
        ts: "171234.000300",
        event_ts: "171234.000300",
        message: {
          ts: "171234.000199",
          thread_ts: "171000.000001",
        },
      },
    });
    expect(result).toEqual({ scheduled: 1 });
    expect(fixture.descriptors).toEqual([
      expect.objectContaining({ threadTs: "171000.000001" }),
    ]);
  });

  it("durably invalidates the channel ACL on membership events", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const callback = {
      type: "event_callback" as const,
      event_id: "member-1",
      team_id: "T1",
      event: {
        type: "member_left_channel",
        channel: "C1",
        user: "U2",
        event_ts: "171234.000300",
      },
    };
    expect(slackKnowledgeAclInvalidationFromSlackCallback(callback)).toMatchObject({
      teamId: "T1",
      channelId: "C1",
      eventId: "member-1",
      eventType: "member_left_channel",
      userId: "U2",
    });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, callback);
    expect(result).toEqual({ scheduled: 0, aclInvalidated: 1 });
    expect(fixture.aclInvalidations).toEqual([expect.objectContaining({ eventId: "member-1" })]);
  });

  it("durably invalidates the channel ACL when a member joins without admitting a turn", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    const callback = {
      type: "event_callback" as const,
      event_id: "member-joined-1",
      team_id: "T1",
      event: {
        type: "member_joined_channel",
        channel: "C1",
        user: "U3",
        event_ts: "171234.000350",
      },
    };
    expect(slackKnowledgeAclInvalidationFromSlackCallback(callback)).toMatchObject({
      teamId: "T1",
      channelId: "C1",
      eventId: "member-joined-1",
      eventType: "member_joined_channel",
      userId: "U3",
    });
    await expect(scheduleKnowledgeFromSlackEvent(fixture.env, callback)).resolves.toEqual({
      scheduled: 0,
      aclInvalidated: 1,
    });
    expect(fixture.descriptors).toEqual([]);
    expect(fixture.aclInvalidations).toEqual([
      expect.objectContaining({
        eventId: "member-joined-1",
        eventType: "member_joined_channel",
      }),
    ]);
  });

  it("applies workspace lifecycle revocation before touching indexed ACL state", async () => {
    const fixture = fakeEnv({
      sources: [source()],
      lifecycleResult: { affectedChannels: ["C1"] },
    });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      event_id: "uninstall-1",
      team_id: "T1",
      event: { type: "app_uninstalled" },
    });
    expect(result).toEqual({ scheduled: 0, aclInvalidated: 1 });
    expect(fixture.workspaceFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.stringContaining("app_uninstalled") }),
    );
    expect(fixture.aclInvalidations).toEqual([
      expect.objectContaining({
        eventId: "lifecycle:uninstall-1:C1",
        eventType: "installation_revoked",
      }),
    ]);
    expect(fixture.descriptors).toEqual([]);
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

  it("resolves a documented root deletion from the durable message map", async () => {
    const fixture = fakeEnv({
      sources: [source()],
      deletedThreadTs: "171234.000100",
    });
    await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000100",
        ts: "171235.000200",
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

  it("resolves a documented reply deletion from the durable message map", async () => {
    const fixture = fakeEnv({
      sources: [source()],
      deletedThreadTs: "171000.000001",
    });
    await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000199",
        ts: "171235.000200",
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

  it("does not guess a deleted message's root when no durable map exists", async () => {
    const fixture = fakeEnv({ sources: [source()] });
    await expect(scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "171234.000199",
      },
    })).rejects.toThrow("knowledge_deleted_message_thread_unresolved");
    expect(fixture.descriptors).toEqual([]);
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
    })).toMatchObject({
      threadTs: "171234.000100",
      messageTs: "171234.000100",
      reason: "delete",
      resolveDeletedMessageThread: true,
    });
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
    })).toMatchObject({
      threadTs: "171234.000100",
      messageTs: "171234.000100",
      reason: "delete",
      resolveDeletedMessageThread: true,
    });
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

  it("does not count duplicate or out-of-order descriptor rejections as scheduled", async () => {
    const fixture = fakeEnv({
      sources: [source()],
      knowledgeFetch: async (request) => {
        const body = await request.json();
        return Response.json({
          accepted: false,
          reason: "duplicate",
          descriptorKey: "slack:T1:C1:171234_000100",
          echo: body,
        });
      },
    });
    const result = await scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: { type: "message", channel: "C1", ts: "171234.000100" },
    });
    expect(result).toEqual({ scheduled: 0 });
  });

  it("fails closed when the descriptor response is malformed", async () => {
    const fixture = fakeEnv({
      sources: [source()],
      knowledgeFetch: async () => Response.json({ ok: true }),
    });
    await expect(scheduleKnowledgeFromSlackEvent(fixture.env, {
      type: "event_callback",
      team_id: "T1",
      event: { type: "message", channel: "C1", ts: "171234.000100" },
    })).rejects.toThrow("knowledge_descriptor_result_malformed");
  });
});

describe("opentag-bot knowledge Queue consumer", () => {
  it("retries the whole batch during a controlled Supermemory migration freeze", async () => {
    const fixture = fakeEnv({ exactSource: source() });
    fixture.env.SUPERMEMORY_CONSUMER_MODE = "paused";
    const queued = queueMessage(descriptor());
    const retryAll = vi.fn();
    const dispatch = vi.fn();

    await handleKnowledgeQueue({
      ...batch(queued.message),
      retryAll,
    }, fixture.env, dispatch);

    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).not.toHaveBeenCalled();
  });

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

  it("fails closed for a typed non-Slack job without invoking the Slack dispatch", async () => {
    const fixture = fakeEnv({ exactSource: source({ sourceType: "wiki", channelId: "docs" }) });
    const queued = queueMessage(createKnowledgeJob({
      sourceType: "wiki",
      teamId: "T1",
      projectId: "P1",
      channelId: "docs",
      threadTs: "page-1",
      configVersion: 3,
      requestedAt: "2026-07-19T01:00:00.000Z",
      reason: "event",
    }));
    const dispatch = vi.fn();
    await handleKnowledgeQueue(batch(queued.message), fixture.env, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(fixture.outcomes).toEqual([
      expect.objectContaining({
        sourceKey: "wiki:T1:docs:page-1",
        outcome: {
          status: "permanent_failure",
          errorClass: "unsupported_source_type",
          errorCode: "wiki",
        },
      }),
    ]);
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
        sourceKey: "slack:T1:C1:171234_000100",
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

  it("acks terminal recorded_permanent outcomes instead of retrying forever", async () => {
    const fixture = fakeEnv({ exactSource: source() });
    const queued = queueMessage(descriptor());
    const dispatch = vi.fn(async () => ({ status: "recorded_permanent" as const }));
    await handleKnowledgeQueue(batch(queued.message), fixture.env, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("still processes root deletes after the tracked source configVersion advances", async () => {
    const fixture = fakeEnv({
      exactSource: source({ configVersion: 5, enabled: false, everEnabled: true }),
    });
    const deleteJob = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "171234.000100",
      configVersion: 3,
      requestedAt: "2026-07-19T01:00:00.000Z",
      reason: "delete",
      messageTs: "171234.000100",
    });
    const queued = queueMessage(deleteJob);
    const dispatch = vi.fn(async () => ({ status: "recorded_permanent" as const }));
    await handleKnowledgeQueue(batch(queued.message), fixture.env, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(fixture.stale).toHaveLength(0);
  });
});
