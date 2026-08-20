import { describe, expect, it, vi } from "vitest";
import type { SupermemoryClient } from "../src/memory/supermemory-client.js";
import {
  SupermemoryAdapter,
  SupermemoryAdapterError,
  createKnowledgeSupermemoryDispatch,
} from "../src/memory/supermemory-adapter.js";
import { createKnowledgeJob } from "../src/memory/knowledge-contract.js";
import type { KnowledgeQueueEnv } from "../src/memory/knowledge-jobs.js";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    workspaceId: "T1",
    projectId: "P1",
    channelId: "C1",
    threadTs: "1.0",
    sourceKey: "slack:T1:C1:1_0",
    contentRevision: "sha256:one",
    rootTs: "1.0",
    observedAt: "2026-07-19T00:00:00.000Z",
    indexedAt: "2026-07-19T00:00:01.000Z",
    aclPolicyRef: "bundle:readers",
    status: "active" as const,
    ...overrides,
  };
}

function client(overrides: Partial<SupermemoryClient> = {}): SupermemoryClient {
  return {
    add: vi.fn(async () => ({ id: "doc-1", status: "queued" })),
    documents: {
      get: vi.fn(async () => ({ id: "doc-1", customId: "slack:T1:C1:1_0", status: "done" })),
      update: vi.fn(async () => ({ id: "doc-1", status: "queued" })),
      delete: vi.fn(async () => undefined),
    },
    search: { memories: vi.fn(async () => ({ results: [], timing: 1, total: 0 })) },
    ...overrides,
  } as unknown as SupermemoryClient;
}

describe("SupermemoryAdapter", () => {
  it("derives the exact tag/customId and rejects metadata identity mismatches", async () => {
    const add = vi.fn(async () => ({ id: "doc-1", status: "queued" }));
    const adapter = new SupermemoryAdapter(client({ add: add as unknown as SupermemoryClient["add"] }));
    expect(await adapter.addSlackDocument({ teamId: "T1", content: "fixture", metadata: metadata() }))
      .toEqual({ localDocumentId: "doc-1", status: "queued" });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      containerTag: "workspace:T1",
      customId: "slack:T1:C1:1_0",
    }));
    await expect(adapter.addSlackDocument({
      teamId: "T1", content: "fixture", metadata: metadata({ sourceKey: "slack:T1:C2:1_0" }),
    })).rejects.toThrow("invalid schema version or sourceKey");
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("times out non-terminal indexing and resumes the same Local document ID without add", async () => {
    let now = 0;
    const get = vi.fn(async (id: string) => ({ id, customId: "slack:T1:C1:1_0", status: "indexing" as const }));
    const add = vi.fn();
    const adapter = new SupermemoryAdapter(client({
      add: add as unknown as SupermemoryClient["add"],
      documents: { get } as unknown as SupermemoryClient["documents"],
    }), { now: () => now, sleep: async (ms) => { now += ms; } });
    const result = await adapter.pollDocument({
      localDocumentId: "doc-known",
      sourceKey: "slack:T1:C1:1_0",
      pollDeadlineAt: 300,
    });
    expect(result).toMatchObject({
      status: "processing_unconfirmed",
      localDocumentId: "doc-known",
      workflowStatus: "indexing",
    });
    expect(get).toHaveBeenCalledWith("doc-known");
    expect(add).not.toHaveBeenCalled();
  });

  it("renews an expired poll window without issuing another add", async () => {
    let now = 1_000;
    const get = vi.fn(async (id: string) => ({ id, customId: "slack:T1:C1:1_0", status: "indexing" as const }));
    const add = vi.fn();
    const adapter = new SupermemoryAdapter(client({
      add: add as unknown as SupermemoryClient["add"],
      documents: { get } as unknown as SupermemoryClient["documents"],
    }), { now: () => now, sleep: async (ms) => { now += ms; } });
    const result = await adapter.pollDocument({
      localDocumentId: "doc-known",
      sourceKey: "slack:T1:C1:1_0",
      pollDeadlineAt: 500,
    });
    expect(result).toMatchObject({
      status: "processing_unconfirmed",
      pollDeadlineAt: expect.any(Number),
    });
    if (result.status !== "processing_unconfirmed") throw new Error("expected processing result");
    expect(result.pollDeadlineAt).toBeGreaterThan(1_000);
    expect(get).toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("classifies unsupported statuses and bounds search at the adapter boundary", async () => {
    const adapter = new SupermemoryAdapter(client({
      documents: { get: vi.fn(async () => ({ id: "doc-1", customId: "slack:T1:C1:1_0", status: "processing" })) } as unknown as SupermemoryClient["documents"],
    }));
    await expect(adapter.pollDocument({ localDocumentId: "doc-1", sourceKey: "slack:T1:C1:1_0" }))
      .rejects.toEqual(expect.objectContaining({ code: "local_malformed_response", retryable: false }));
    await expect(adapter.searchSlack({
      teamId: "T1", projectId: "P1", channelId: "C1", aclPolicyRef: "bundle:readers",
      query: "x".repeat(1_001), limit: 1,
    })).rejects.toBeInstanceOf(SupermemoryAdapterError);
  });

  it("updates via documents.update and deletes via documents.delete", async () => {
    const update = vi.fn(async () => ({ id: "doc-1", status: "queued" as const }));
    const del = vi.fn(async () => undefined);
    const adapter = new SupermemoryAdapter(client({
      documents: {
        get: vi.fn(),
        update,
        delete: del,
      } as unknown as SupermemoryClient["documents"],
    }));
    expect(await adapter.updateSlackDocument({
      teamId: "T1",
      localDocumentId: "doc-1",
      content: "revised",
      metadata: metadata({ contentRevision: "sha256:two" }),
    })).toEqual({ localDocumentId: "doc-1", status: "queued" });
    expect(update).toHaveBeenCalledWith("doc-1", expect.objectContaining({
      content: "revised",
      customId: "slack:T1:C1:1_0",
      containerTag: "workspace:T1",
    }));
    expect(await adapter.deleteSlackDocument({
      localDocumentId: "doc-1",
      sourceKey: "slack:T1:C1:1_0",
    })).toEqual({ deleted: true });
    expect(del).toHaveBeenCalledWith("doc-1");
  });

  it("accepts a terminal update receipt without classifying it as malformed", async () => {
    const adapter = new SupermemoryAdapter(client({
      documents: {
        get: vi.fn(),
        update: vi.fn(async () => ({ id: "doc-1", status: "done" as const })),
        delete: vi.fn(async () => undefined),
      } as unknown as SupermemoryClient["documents"],
    }));
    await expect(adapter.updateSlackDocument({
      teamId: "T1",
      localDocumentId: "doc-1",
      content: "revised",
      metadata: metadata({ contentRevision: "sha256:two" }),
    })).resolves.toEqual({ localDocumentId: "doc-1", status: "done" });
  });

  it("probes an ambiguous add by exact workspace/source identity", async () => {
    const list = vi.fn(async () => ({
      memories: [{
        id: "doc-probed",
        customId: "slack:T1:C1:1_0",
        metadata: metadata(),
        status: "indexing",
      }],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    }));
    const adapter = new SupermemoryAdapter(client({
      documents: { list } as unknown as SupermemoryClient["documents"],
    }));
    await expect(adapter.findSlackDocument({
      teamId: "T1",
      sourceKey: "slack:T1:C1:1_0",
    })).resolves.toEqual({
      status: "found",
      localDocumentId: "doc-probed",
      workflowStatus: "indexing",
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      containerTags: ["workspace:T1"],
      filters: { AND: [
        { key: "workspaceId", value: "T1" },
        { key: "sourceKey", value: "slack:T1:C1:1_0" },
      ] },
      includeContent: false,
      limit: 10,
      page: 1,
    }));
  });

  it("refuses a provider identity collision instead of treating it as an add miss", async () => {
    const adapter = new SupermemoryAdapter(client({
      documents: {
        list: vi.fn(async () => ({
          memories: [{
            id: "doc-collision",
            customId: "slack:T1:C1:1_0",
            metadata: { workspaceId: "T1", sourceKey: "slack:T1:C2:1_0" },
            status: "done",
          }],
          pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
        })),
      } as unknown as SupermemoryClient["documents"],
    }));
    await expect(adapter.findSlackDocument({
      teamId: "T1",
      sourceKey: "slack:T1:C1:1_0",
    })).rejects.toEqual(expect.objectContaining({
      code: "local_ambiguous_identity",
      retryable: false,
    }));
  });

  it.each([
    ["missing id", { status: "queued" }],
    ["undocumented status", { id: "doc-1", status: "processing" }],
  ])("classifies a malformed Local add response (%s) as permanent", async (_label, response) => {
    const adapter = new SupermemoryAdapter(client({
      add: vi.fn(async () => response) as unknown as SupermemoryClient["add"],
    }));
    await expect(adapter.addSlackDocument({
      teamId: "T1",
      content: "fixture",
      metadata: metadata(),
    })).rejects.toEqual(expect.objectContaining({
      code: "local_malformed_response",
      retryable: false,
    }));
  });

  it("uses hybrid exact-scope filters and emits only compliant revisioned citations", async () => {
    const memories = vi.fn(async () => ({
      timing: 1,
      total: 3,
      results: [
        { id: "r1", similarity: 0.9, chunk: "  useful   excerpt ", metadata: { ...metadata(), slackPermalink: "https://example.com/not-slack" } },
        { id: "r2", similarity: 0.8, memory: "wrong channel", metadata: { ...metadata(), channelId: "C2" } },
        { id: "r3", similarity: 0.7, memory: "not active", metadata: { ...metadata(), status: "deleted" } },
      ],
    }));
    const adapter = new SupermemoryAdapter(client({ search: { memories } as unknown as SupermemoryClient["search"] }), {
      now: () => Date.parse("2026-07-19T01:00:00.000Z"),
    });
    const citations = await adapter.searchSlack({
      teamId: "T1", projectId: "P1", channelId: "C1", aclPolicyRef: "bundle:readers", query: "fixture", limit: 3,
    });
    expect(memories).toHaveBeenCalledWith({
      q: "fixture",
      containerTag: "workspace:T1",
      searchMode: "hybrid",
      filters: { AND: [
        { key: "projectId", value: "P1" },
        { key: "channelId", value: "C1" },
        { key: "status", value: "active" },
      ] },
      limit: 3,
    });
    expect(citations).toEqual([expect.objectContaining({
      sourceKey: "slack:T1:C1:1_0",
      sourceType: "slack",
      contentRevision: "sha256:one",
      excerpt: "useful excerpt",
    })]);
    expect(citations[0]).not.toHaveProperty("permalink");
  });

  it("keeps completed provider polling separate from search convergence", async () => {
    const phases: string[] = [];
    const add = vi.fn(async () => {
      phases.push("add");
      return { id: "doc-1", status: "queued" as const };
    });
    const get = vi.fn(async () => {
      phases.push("poll");
      return { id: "doc-1", customId: "slack:T1:C1:1_0", status: "done" as const };
    });
    const memories = vi.fn(async () => {
      phases.push("search");
      return { results: [], timing: 1, total: 0 };
    });
    const adapter = new SupermemoryAdapter(client({
      add: add as unknown as SupermemoryClient["add"],
      documents: { get } as unknown as SupermemoryClient["documents"],
      search: { memories } as unknown as SupermemoryClient["search"],
    }));

    await expect(adapter.addSlackDocument({
      teamId: "T1",
      content: "fixture",
      metadata: metadata(),
    })).resolves.toEqual({ localDocumentId: "doc-1", status: "queued" });
    await expect(adapter.pollDocument({
      localDocumentId: "doc-1",
      sourceKey: "slack:T1:C1:1_0",
    })).resolves.toMatchObject({ status: "done", localDocumentId: "doc-1" });
    await expect(adapter.searchSlackForConvergence({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      aclPolicyRef: "bundle:readers",
      query: "fixture",
      limit: 1,
    })).resolves.toMatchObject({ citations: [], providerResultCount: 0, queryDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(phases).toEqual(["add", "poll", "search"]);
    expect(memories).toHaveBeenCalledTimes(1);
  });
});

describe("Supermemory Queue dispatch configuration fence", () => {
  it("records hard thread size bounds as permanent explicit outcomes", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    });
    const outcomes: unknown[] = [];
    const dispatch = createKnowledgeSupermemoryDispatch({
      fetchThread: async () => ({
        status: "incomplete" as const,
        reason: "message_cap" as const,
        pages: 20,
        messages: 1_000,
        bytes: 1_900_000,
      }),
      createAdapter: () => ({
        addSlackDocument: vi.fn(),
        updateSlackDocument: vi.fn(),
        deleteSlackDocument: vi.fn(),
        pollDocument: vi.fn(),
      }),
    });
    const source = {
      schemaVersion: 1 as const,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const env = {
      SLACK_BOT_TOKEN: "xoxb-fixture",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            outcomes.push(JSON.parse(String(init?.body ?? "{}")));
            return Response.json({ recorded: true });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    await expect(dispatch(job, env, {
      leaseToken: "lease-size",
      effectToken: "effect-size",
      source,
      validateSource: vi.fn(async () => source),
    })).resolves.toEqual({ status: "recorded_permanent" });
    expect(outcomes).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({
          status: "permanent_failure",
          errorClass: "slack_thread_size_bound",
          errorCode: "message_cap",
        }),
      }),
    ]);
  });

  it("tombstones only a root-delete job and does not fetch the thread", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      messageTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "delete",
    });
    const outcomes: unknown[] = [];
    const fetchThread = vi.fn();
    const dispatch = createKnowledgeSupermemoryDispatch({ fetchThread });
    const env = {
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            outcomes.push(JSON.parse(String(init?.body ?? "{}")));
            return Response.json({ recorded: true });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    await expect(dispatch(job, env, {
      leaseToken: "lease-root",
      effectToken: "effect-root",
      source: {
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
      },
      validateSource: vi.fn(async () => ({} as never)),
    })).resolves.toEqual({ status: "recorded_permanent" });
    expect(fetchThread).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({
          status: "tombstoned",
          errorCode: "unsupported_delete_contract",
        }),
      }),
    ]);
  });

  it("deletes the Local document then tombstones when mutation contract is verified", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      messageTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "delete",
    });
    const outcomes: unknown[] = [];
    const deleteSlackDocument = vi.fn(async () => ({ deleted: true as const }));
    const updateSlackDocument = vi.fn();
    const addSlackDocument = vi.fn();
    const pollDocument = vi.fn();
    const fetchThread = vi.fn();
    const dispatch = createKnowledgeSupermemoryDispatch({
      fetchThread,
      createAdapter: () => ({
        addSlackDocument,
        updateSlackDocument,
        deleteSlackDocument,
        pollDocument,
      }),
    });
    const env = {
      SUPERMEMORY_URL: "https://supermemory.example",
      SUPERMEMORY_API_KEY: "sm_fixture",
      SUPERMEMORY_MIGRATION_MODE: "true",
      SUPERMEMORY_MUTATION_CONTRACT: "verified",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/state") {
              return Response.json({ ledger: { localDocumentId: "doc-1" }, outbox: null });
            }
            if (path === "/outcome") {
              outcomes.push(JSON.parse(String(init?.body ?? "{}")));
              return Response.json({ recorded: true });
            }
            return Response.json({ error: "not_found" }, { status: 404 });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    await expect(dispatch(job, env, {
      leaseToken: "lease-root",
      effectToken: "effect-root",
      source: {
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
      },
      validateSource: vi.fn(async () => ({} as never)),
    })).resolves.toEqual({ status: "recorded_permanent" });
    expect(fetchThread).not.toHaveBeenCalled();
    expect(deleteSlackDocument).toHaveBeenCalledWith({
      localDocumentId: "doc-1",
      sourceKey: "slack:T1:C1:1_0",
    });
    expect(addSlackDocument).not.toHaveBeenCalled();
    expect(updateSlackDocument).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({
          status: "tombstoned",
          errorCode: "deleted",
        }),
      }),
    ]);
  });

  it("updates an indexed revision when mutation contract is verified", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    });
    const source = {
      schemaVersion: 1 as const,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const prepareBodies: unknown[] = [];
    const env = {
      SLACK_BOT_TOKEN: "xoxb-fixture",
      SUPERMEMORY_URL: "https://supermemory.example",
      SUPERMEMORY_API_KEY: "sm_fixture",
      SUPERMEMORY_MIGRATION_MODE: "true",
      SUPERMEMORY_MUTATION_CONTRACT: "verified",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/prepareRevision") {
              prepareBodies.push(JSON.parse(String(init?.body ?? "{}")));
              return Response.json({ decision: "update", localDocumentId: "doc-1" });
            }
            if (path === "/message-thread/put") return Response.json({ stored: 1 });
            if (path === "/localAccepted") return Response.json({ recorded: true });
            if (path === "/outcome") return Response.json({ recorded: true });
            return Response.json({ error: "not_found" }, { status: 404 });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    const updateSlackDocument = vi.fn(async () => ({
      localDocumentId: "doc-1",
      status: "queued" as const,
    }));
    const addSlackDocument = vi.fn();
    const deleteSlackDocument = vi.fn();
    const pollDocument = vi.fn(async () => ({
      status: "done" as const,
      localDocumentId: "doc-1",
      polls: 1,
    }));
    const dispatch = createKnowledgeSupermemoryDispatch({
      createAdapter: () => ({
        addSlackDocument,
        updateSlackDocument,
        deleteSlackDocument,
        pollDocument,
      }),
      fetchThread: async () => ({
        status: "complete",
        messages: [{
          ts: "1.0",
          user: "U1",
          text: "revised fixture",
          reactions: [{ name: "eyes", count: 2 }],
        }],
        pages: 1,
        bytes: 32,
      }),
    });
    await expect(dispatch(job, env, {
      leaseToken: "lease-1",
      source,
      effectToken: "effect-1",
      validateSource: vi.fn(async () => source),
    })).resolves.toEqual({ status: "recorded_success" });
    expect(prepareBodies).toEqual([
      expect.objectContaining({ mutationsVerified: true }),
    ]);
    expect(updateSlackDocument).toHaveBeenCalledTimes(1);
    expect(updateSlackDocument).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("engagement reactions:2"),
      metadata: expect.objectContaining({
        reactionCount: 2,
        distillStatus: "skipped",
        burstCount: expect.any(Number),
      }),
    }));
    expect(addSlackDocument).not.toHaveBeenCalled();
    expect(pollDocument).toHaveBeenCalledWith({
      localDocumentId: "doc-1",
      sourceKey: "slack:T1:C1:1_0",
    });
  });

  it("probes before replaying an ambiguous add and only adds after an exact miss", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    });
    const source = {
      schemaVersion: 1 as const,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const findSlackDocument = vi.fn(async () => ({ status: "not_found" as const }));
    const addSlackDocument = vi.fn(async () => ({
      localDocumentId: "doc-new",
      status: "queued" as const,
    }));
    const pollDocument = vi.fn(async () => ({
      status: "done" as const,
      localDocumentId: "doc-new",
      polls: 1,
    }));
    const paths: string[] = [];
    const dispatch = createKnowledgeSupermemoryDispatch({
      createAdapter: () => ({
        addSlackDocument,
        updateSlackDocument: vi.fn(),
        deleteSlackDocument: vi.fn(),
        pollDocument,
        findSlackDocument,
      }),
      fetchThread: async () => ({
        status: "complete" as const,
        messages: [{ ts: "1.0", user: "U1", text: "ambiguous add fixture" }],
        pages: 1,
        bytes: 32,
      }),
    });
    const env = {
      SLACK_BOT_TOKEN: "xoxb-fixture",
      SUPERMEMORY_MUTATION_CONTRACT: "verified",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            if (path === "/message-thread/put") return Response.json({ stored: 1 });
            if (path === "/prepareRevision") {
              return Response.json({ decision: "blocked", reason: "ambiguous_add_contract" });
            }
            if (path === "/resolveAmbiguousAdd") {
              expect(JSON.parse(String(init?.body ?? "{}"))).toMatchObject({ resolution: "not_found" });
              return Response.json({ decision: "add" });
            }
            if (path === "/localAccepted") return Response.json({ recorded: true });
            if (path === "/outcome") return Response.json({ recorded: true });
            return Response.json({ error: "not_found" }, { status: 404 });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    await expect(dispatch(job, env, {
      leaseToken: "lease-ambiguous",
      source,
      effectToken: "effect-ambiguous",
      validateSource: vi.fn(async () => source),
    })).resolves.toEqual({ status: "recorded_success" });
    expect(findSlackDocument).toHaveBeenCalledWith({
      teamId: "T1",
      sourceKey: job.sourceKey,
    });
    expect(addSlackDocument).toHaveBeenCalledTimes(1);
    expect(pollDocument).toHaveBeenCalledWith({
      localDocumentId: "doc-new",
      sourceKey: job.sourceKey,
    });
    expect(paths).toContain("/resolveAmbiguousAdd");
  });

  it("persists a terminal Slack source skip without normalizing or writing an empty corpus", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    });
    const source = {
      schemaVersion: 1 as const,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const outcomes: unknown[] = [];
    const addSlackDocument = vi.fn();
    const updateSlackDocument = vi.fn();
    const deleteSlackDocument = vi.fn();
    const pollDocument = vi.fn();
    const fetchThread = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "not_in_channel" as const,
      pages: 1,
      messages: 0,
      bytes: 0,
    }));
    const dispatch = createKnowledgeSupermemoryDispatch({
      fetchThread,
      createAdapter: () => ({
        addSlackDocument,
        updateSlackDocument,
        deleteSlackDocument,
        pollDocument,
      }),
    });
    const env = {
      SLACK_BOT_TOKEN: "xoxb-fixture",
      SUPERMEMORY_URL: "https://supermemory.example",
      SUPERMEMORY_API_KEY: "sm_fixture",
      SUPERMEMORY_MIGRATION_MODE: "true",
      SUPERMEMORY_MUTATION_CONTRACT: "verified",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/outcome") {
              outcomes.push(JSON.parse(String(init?.body ?? "{}")));
              return Response.json({ recorded: true });
            }
            return Response.json({ error: "not_found" }, { status: 404 });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;

    await expect(dispatch(job, env, {
      leaseToken: "lease-skip",
      source,
      effectToken: "effect-skip",
      validateSource: vi.fn(async () => source),
    })).resolves.toEqual({ status: "recorded_permanent" });
    expect(fetchThread).toHaveBeenCalledWith(job, env);
    expect(outcomes).toEqual([
      expect.objectContaining({
        sourceKey: "slack:T1:C1:1_0",
        leaseToken: "lease-skip",
        outcome: {
          status: "permanent_failure",
          errorClass: "slack_terminal_skip",
          errorCode: "not_in_channel",
        },
      }),
    ]);
    expect(addSlackDocument).not.toHaveBeenCalled();
    expect(updateSlackDocument).not.toHaveBeenCalled();
    expect(pollDocument).not.toHaveBeenCalled();
  });

  it("retries a complete-but-stale Slack thread until the observed message is present", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      observedMessageTs: "1.1",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    });
    const source = {
      schemaVersion: 1 as const,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const outcomes: unknown[] = [];
    const fetchThread = vi.fn(async () => ({
      status: "complete" as const,
      messages: [{ ts: "1.0", user: "U1", text: "root only" }],
      pages: 1,
      bytes: 24,
    }));
    const dispatch = createKnowledgeSupermemoryDispatch({
      fetchThread,
      createAdapter: () => ({
        addSlackDocument: vi.fn(),
        updateSlackDocument: vi.fn(),
        deleteSlackDocument: vi.fn(),
        pollDocument: vi.fn(),
      }),
    });
    const env = {
      SLACK_BOT_TOKEN: "xoxb-fixture",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            outcomes.push(JSON.parse(String(init?.body ?? "{}")));
            return Response.json({ recorded: true });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    await expect(dispatch(job, env, {
      leaseToken: "lease-stale-thread",
      effectToken: "effect-stale-thread",
      source,
      validateSource: vi.fn(async () => source),
    })).resolves.toEqual({ status: "recorded_retry" });
    expect(outcomes).toEqual([
      expect.objectContaining({
        outcome: {
          status: "retryable_failure",
          errorClass: "slack_thread_incomplete",
          errorCode: "observed_message_missing",
          incompleteReason: "observed_message_missing",
        },
      }),
    ]);
  });

  it("refetches a reply deletion and halts an indexed mutation without tombstoning", async () => {
    const job = createKnowledgeJob({
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      messageTs: "1.1",
      configVersion: 3,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "reply_delete",
    });
    const outcomes: unknown[] = [];
    const fetchThread = vi.fn(async () => ({
      status: "complete" as const,
      messages: [{ ts: "1.0", user: "U1", text: "root remains" }],
      pages: 1,
      bytes: 24,
    }));
    const dispatch = createKnowledgeSupermemoryDispatch({
      fetchThread,
      createAdapter: vi.fn(),
    });
    const source = {
      schemaVersion: 1 as const,
      teamId: "T1",
      projectId: "P1",
      channelId: "C1",
      enabled: true,
      everEnabled: true,
      readerPolicyRef: "bundle:readers",
      retentionDays: null,
      configVersion: 3,
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const env = {
      SLACK_BOT_TOKEN: "xoxb-fixture",
      SUPERMEMORY_URL: "https://supermemory.example",
      SUPERMEMORY_API_KEY: "sm_fixture",
      SUPERMEMORY_MIGRATION_MODE: "true",
      KNOWLEDGE: {
        idFromName: vi.fn(),
        get: () => ({
          fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/prepareRevision") {
              return Response.json({
                decision: "blocked",
                reason: "unsupported_update_contract",
              });
            }
            if (path === "/message-thread/put") return Response.json({ stored: 1 });
            if (path === "/outcome") {
              outcomes.push(JSON.parse(String(init?.body ?? "{}")));
              return Response.json({ recorded: true });
            }
            return Response.json({ error: "not_found" }, { status: 404 });
          }),
        }),
      },
    } as unknown as KnowledgeQueueEnv;
    await expect(dispatch(job, env, {
      leaseToken: "lease-reply",
      effectToken: "effect-reply",
      source,
      validateSource: vi.fn(async () => source),
    })).resolves.toEqual({ status: "recorded_permanent" });
    expect(fetchThread).toHaveBeenCalledWith(job, env);
    expect(outcomes).toEqual([
      expect.objectContaining({
        outcome: {
          status: "preserve_indexed",
          errorClass: "unsupported_capability",
          errorCode: "unsupported_update_contract",
        },
      }),
    ]);
    expect(JSON.stringify(outcomes)).not.toContain("tombstoned");
    expect(JSON.stringify(outcomes)).not.toContain("permanent_failure");
  });

  it.each([
    ["after fetch", 1, "disabled", 0, 0],
    ["after add_started", 2, "policy changed", 0, 0],
    ["before localAccepted", 3, "version changed", 1, 0],
    ["before terminal outcome", 5, "disabled", 1, 1],
  ] as const)(
    "fails closed %s when the durable source is %s",
    async (_boundary, failValidationCall, reason, expectedAdds, expectedPolls) => {
      const job = createKnowledgeJob({
        teamId: "T1",
        projectId: "P1",
        channelId: "C1",
        threadTs: "1.0",
        configVersion: 3,
        requestedAt: "2026-07-19T00:00:00.000Z",
        reason: "event",
      });
      const source = {
        schemaVersion: 1 as const,
        teamId: "T1",
        projectId: "P1",
        channelId: "C1",
        enabled: true,
        everEnabled: true,
        readerPolicyRef: "bundle:readers",
        retentionDays: null,
        configVersion: 3,
        updatedAt: "2026-07-19T00:00:00.000Z",
      };
      const paths: string[] = [];
      const env = {
        SLACK_BOT_TOKEN: "xoxb-fixture",
        SUPERMEMORY_URL: "https://supermemory.example",
        SUPERMEMORY_API_KEY: "sm_fixture",
        SUPERMEMORY_MIGRATION_MODE: "true",
        KNOWLEDGE: {
          idFromName: vi.fn(),
          get: () => ({
            fetch: vi.fn(async (input: RequestInfo | URL) => {
              const path = new URL(String(input)).pathname;
              paths.push(path);
              if (path === "/message-thread/put") return Response.json({ stored: 1 });
              if (path === "/prepareRevision") return Response.json({ decision: "add" });
              if (path === "/localAccepted") return Response.json({ recorded: true });
              if (path === "/outcome") return Response.json({ recorded: true });
              return Response.json({ error: "not_found" }, { status: 404 });
            }),
          }),
        },
      } as unknown as KnowledgeQueueEnv;
      const addSlackDocument = vi.fn(async () => ({
        localDocumentId: "doc-1",
        status: "queued" as const,
      }));
      const updateSlackDocument = vi.fn();
      const deleteSlackDocument = vi.fn();
      const pollDocument = vi.fn(async () => ({
        status: "done" as const,
        localDocumentId: "doc-1",
        polls: 1,
      }));
      const dispatch = createKnowledgeSupermemoryDispatch({
        createAdapter: () => ({
          addSlackDocument,
          updateSlackDocument,
          deleteSlackDocument,
          pollDocument,
        }),
        fetchThread: async () => ({
          status: "complete",
          messages: [{ ts: "1.0", user: "U1", text: "fixture" }],
          pages: 1,
          bytes: 32,
        }),
      });
      let validationCalls = 0;
      const validateSource = vi.fn(async () => {
        validationCalls += 1;
        if (validationCalls === failValidationCall) {
          throw new Error(`knowledge_config_effect_invalid:${reason}`);
        }
        return source;
      });
      await expect(dispatch(job, env, {
        leaseToken: "lease-1",
        source,
        effectToken: "effect-1",
        validateSource,
      })).rejects.toThrow("knowledge_config_effect_invalid");
      expect(addSlackDocument).toHaveBeenCalledTimes(expectedAdds);
      expect(pollDocument).toHaveBeenCalledTimes(expectedPolls);
      if (failValidationCall <= 2) expect(paths).not.toContain("/localAccepted");
      if (failValidationCall === 3) expect(paths).not.toContain("/localAccepted");
      if (failValidationCall === 5) expect(paths).not.toContain("/outcome");
    },
  );
});
