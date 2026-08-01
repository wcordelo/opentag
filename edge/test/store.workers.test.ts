import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createDurableObjectStore } from "../src/store/index.js";
import { tenantStub } from "../src/tenancy.js";
import { runStateStoreConformance } from "./conformance.js";

/**
 * TRUE end-to-end: the full @copilotkit/bot StateStore conformance suite run
 * against the real Durable Object in workerd — RPC (getByName) → DO →
 * ctx.storage.sql → transactionSync. Each `make()` targets a fresh DO instance
 * (unique partition) so tests are isolated, mirroring the reference store's
 * fresh-per-test semantics.
 */

runStateStoreConformance("durable-object-sqlite (workerd)", () => {
  const instance = `test-${crypto.randomUUID()}`;
  return createDurableObjectStore(env.BOT_STATE, { partition: () => instance });
});

// A couple of DO-specific integration checks the pure-engine suite can't cover.
describe("Durable Object integration", () => {
  it("persists and clears additive channel runtime defaults without changing other config", async () => {
    const teamId = `runtime-${crypto.randomUUID()}`;
    const channelId = "C-runtime";
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    expect((await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        policies: { allowMemoryWrite: true, allowTasks: false },
        accessBundleId: "default",
        updatedAt: new Date().toISOString(),
      }),
    })).status).toBe(200);
    expect((await stub.fetch("https://do/putChannelContext", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        channelContext: "keep this prompt",
        updatedAt: new Date().toISOString(),
      }),
    })).status).toBe(200);
    const withoutDefaults = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    }).then((response) => response.json()) as {
      systemPrompt: string;
      policies: { allowMemoryWrite: boolean; allowTasks: boolean };
      runtimeDefaults?: unknown;
    };
    expect(withoutDefaults.runtimeDefaults).toBeUndefined();
    expect(withoutDefaults.systemPrompt).toBe("keep this prompt");
    expect(withoutDefaults.policies).toEqual({
      allowMemoryWrite: true,
      allowTasks: false,
    });

    expect((await stub.fetch("https://do/putChannelContext", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        channelContext: "keep this prompt",
        runtimeDefaults: {
          harnessType: "claudecode",
          model: "claude-sonnet-5",
        },
      }),
    })).status).toBe(200);
    const configured = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    }).then((response) => response.json()) as {
      systemPrompt: string;
      policies: { allowMemoryWrite: boolean; allowTasks: boolean };
      runtimeDefaults?: unknown;
    };
    expect(configured).toMatchObject({
      systemPrompt: "keep this prompt",
      policies: { allowMemoryWrite: true, allowTasks: false },
      runtimeDefaults: {
        harnessType: "claudecode",
        model: "claude-sonnet-5",
      },
    });

    expect((await stub.fetch("https://do/putChannelContext", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        channelContext: "keep this prompt",
        runtimeDefaults: null,
      }),
    })).status).toBe(200);
    const cleared = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    }).then((response) => response.json()) as {
      runtimeDefaults?: unknown;
    };
    expect(cleared.runtimeDefaults).toBeUndefined();
  });

  it("preserves channel context when only runtimeDefaults are updated", async () => {
    const teamId = `runtime-only-${crypto.randomUUID()}`;
    const channelId = "C-runtime-only";
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    expect((await stub.fetch("https://do/putChannelContext", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        channelContext: "keep this prompt",
        runtimeDefaults: { harnessType: "claudecode", model: "claude-sonnet-5" },
      }),
    })).status).toBe(200);
    expect((await stub.fetch("https://do/putChannelContext", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        runtimeDefaults: null,
      }),
    })).status).toBe(200);
    const cleared = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    }).then((response) => response.json()) as {
      systemPrompt: string;
      runtimeDefaults?: unknown;
    };
    expect(cleared.systemPrompt).toBe("keep this prompt");
    expect(cleared.runtimeDefaults).toBeUndefined();
  });

  it("allows policy-only admin updates without overlay expectedRevision CAS", async () => {
    const teamId = `admin-partial-${crypto.randomUUID()}`;
    const channelId = "C-admin-partial";
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    const first = await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        systemPromptOverlay: {
          version: 1,
          text: "overlay",
          source: "workspace_admin",
        },
        policies: { allowMemoryWrite: true, allowTasks: true },
        accessBundleId: "custom-bundle",
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { revision: number };
    expect(firstBody.revision).toBe(1);

    // Stale expectedRevision must not block a non-overlay admin mutation.
    const policyOnly = await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        policies: { allowMemoryWrite: false, allowTasks: false },
        expectedRevision: 0,
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(policyOnly.status).toBe(200);
    const afterPolicy = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    }).then((response) => response.json()) as {
      policies: { allowMemoryWrite: boolean; allowTasks: boolean };
      accessBundleId: string;
      systemPromptOverlay?: { revision: number; text: string };
    };
    expect(afterPolicy.policies).toEqual({
      allowMemoryWrite: false,
      allowTasks: false,
    });
    expect(afterPolicy.accessBundleId).toBe("custom-bundle");
    expect(afterPolicy.systemPromptOverlay).toMatchObject({
      revision: 1,
    });

    // Overlay write with stale revision still conflicts.
    const staleOverlay = await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        systemPromptOverlay: {
          version: 1,
          text: "new overlay",
          source: "workspace_admin",
        },
        expectedRevision: 0,
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(staleOverlay.status).toBe(409);

    // Admin runtime clear must wipe defaults when runtimeDefaults: null is sent.
    expect((await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        runtimeDefaults: {
          harnessType: "claudecode",
          model: "claude-sonnet-5",
        },
        updatedAt: new Date().toISOString(),
      }),
    })).status).toBe(200);
    expect((await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        runtimeDefaults: null,
        updatedAt: new Date().toISOString(),
      }),
    })).status).toBe(200);
    const clearedRuntime = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId }),
    }).then((response) => response.json()) as {
      runtimeDefaults?: unknown;
      accessBundleId: string;
    };
    expect(clearedRuntime.runtimeDefaults).toBeUndefined();
    expect(clearedRuntime.accessBundleId).toBe("custom-bundle");
  });

  it("rejects overlay objects without text and non-monotonic revisions", async () => {
    const teamId = `overlay-guard-${crypto.randomUUID()}`;
    const channelId = "C-overlay-guard";
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    expect((await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        systemPromptOverlay: {
          version: 1,
          text: "trusted overlay",
          source: "workspace_admin",
        },
        updatedAt: new Date().toISOString(),
      }),
    })).status).toBe(200);

    const missingText = await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        systemPromptOverlay: {
          version: 1,
          source: "workspace_admin",
          revision: 2,
        },
        expectedRevision: 1,
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(missingText.status).toBe(400);
    expect(await missingText.text()).toContain("overlay_text_required");

    const downgrade = await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        systemPromptOverlay: {
          version: 1,
          text: "downgraded",
          source: "workspace_admin",
          revision: 1,
        },
        expectedRevision: 1,
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(downgrade.status).toBe(400);
    expect(await downgrade.text()).toContain("overlay_revision_not_monotonic");

    const after = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId, includeOverlayText: true }),
    }).then((response) => response.json()) as {
      systemPromptOverlay?: { revision: number; text: string };
    };
    expect(after.systemPromptOverlay).toMatchObject({
      revision: 1,
      text: "trusted overlay",
    });

    // Mixed channel context + overlay apply in one admin write.
    expect((await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        channelContext: "channel prompt from admin path",
        systemPromptOverlay: {
          version: 1,
          text: "next overlay",
          source: "workspace_admin",
        },
        expectedRevision: 1,
        updatedAt: new Date().toISOString(),
      }),
    })).status).toBe(200);
    const mixed = await stub.fetch("https://do/getConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId, includeOverlayText: true }),
    }).then((response) => response.json()) as {
      systemPrompt: string;
      systemPromptOverlay?: { revision: number; text: string };
    };
    expect(mixed.systemPrompt).toBe("channel prompt from admin path");
    expect(mixed.systemPromptOverlay).toMatchObject({
      revision: 2,
      text: "next overlay",
    });
  });

  it("rejects policy and overlay writes on legacy putConfig", async () => {
    const teamId = `legacy-${crypto.randomUUID()}`;
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    expect((await stub.fetch("https://do/putConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: "C1",
        systemPrompt: "channel only",
        policies: { allowMemoryWrite: false, allowTasks: false },
      }),
    })).status).toBe(400);
    expect((await stub.fetch("https://do/putConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: "C1",
        systemPrompt: "channel only",
        systemPromptOverlay: { version: 1, text: "nope", digest: "x", revision: 0, source: "workspace_admin" },
      }),
    })).status).toBe(400);
    expect((await stub.fetch("https://do/putConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId: "C1",
        systemPrompt: "channel only",
      }),
    })).status).toBe(200);
  });

  it("isolates state across partitioned instances", async () => {
    const a = createDurableObjectStore(env.BOT_STATE, { partition: () => "inst-a" });
    const b = createDurableObjectStore(env.BOT_STATE, { partition: () => "inst-b" });
    await a.kv.set("shared", { who: "a" });
    await b.kv.set("shared", { who: "b" });
    expect(await a.kv.get("shared")).toEqual({ who: "a" });
    expect(await b.kv.get("shared")).toEqual({ who: "b" });
  });

  it("persists across separate stub resolutions (same instance)", async () => {
    const name = `persist-${crypto.randomUUID()}`;
    const first = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    await first.kv.set("k", { n: 42 }, 60_000);
    // A fresh store/stub to the same instance must observe the committed write.
    const second = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    expect(await second.kv.get("k")).toEqual({ n: 42 });
  });

  it("routes active rows, channel-latest, obligations, cancellation, and cleanup through one lifecycle DO under incompatible partitioners", async () => {
    const a = createDurableObjectStore(env.BOT_STATE, {
      partition: (key) => `shard-a:${key}`,
    });
    const b = createDurableObjectStore(env.BOT_STATE, {
      partition: (key) => `shard-b:${key.split("").reverse().join("")}`,
    });
    const suffix = crypto.randomUUID();
    const record = {
      channelId: `C-${suffix}`,
      threadKey: `slack:C-${suffix}:1.0`,
      conversationKey: `C-${suffix}::1.0`,
      executionId: `exec-${suffix}`,
      threadTs: "1.0",
      registeredAt: Date.now(),
    };
    await a.obligation.set({
      threadKey: record.threadKey,
      executionId: record.executionId,
      afterEventId: 0,
      channel: record.channelId,
      threadTs: record.threadTs,
      timeoutMs: 60_000,
    });
    await expect(a.activeTurn.register(record)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await expect(b.activeTurn.latest(record.channelId)).resolves.toMatchObject({
      record: { executionId: record.executionId },
    });
    await expect(b.obligation.get(record.threadKey)).resolves.toMatchObject({
      executionId: record.executionId,
    });
    await expect(b.activeTurn.claimCancellation({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: "EvPartition",
    })).resolves.toBe("claimed");
    await expect(a.activeTurn.markCancelControlled({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: "EvPartition",
    })).resolves.toBe(true);
    await expect(b.activeTurn.beginCancelAck({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: "EvPartition",
    })).resolves.toBe(true);
    await expect(a.activeTurn.confirmCancellationAndClear({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: "EvPartition",
    })).resolves.toBe(true);
    await expect(b.activeTurn.get(record.threadKey)).resolves.toBeUndefined();
    await expect(a.obligation.get(record.threadKey)).resolves.toBeUndefined();

    // Atomic terminal cleanup makes the same thread immediately admissible.
    await expect(b.activeTurn.register({
      ...record,
      executionId: `exec-next-${suffix}`,
      registeredAt: Date.now() + 1,
    })).resolves.toEqual({ accepted: true, duplicate: false });
  });

  it("persists HITL action:* snapshots across stub resolutions", async () => {
    const name = `hitl-${crypto.randomUUID()}`;
    const actionId = `act_${crypto.randomUUID()}`;
    const first = createDurableObjectStore(env.BOT_STATE, {
      partition: () => name,
    });
    await first.kv.set(
      `action:${actionId}`,
      {
        actionId,
        conversationKey: "C1::1.0",
        status: "pending",
        summary: "approve write?",
      },
      86_400_000,
    );
    const second = createDurableObjectStore(env.BOT_STATE, {
      partition: () => name,
    });
    const snap = await second.kv.get<{ actionId: string; status: string }>(
      `action:${actionId}`,
    );
    expect(snap?.actionId).toBe(actionId);
    expect(snap?.status).toBe("pending");
  });

  it("registers dynamic exact choices and keeps Stop authoritative across isolates", async () => {
    const suffix = crypto.randomUUID();
    const record = {
      channelId: `C-hitl-${suffix}`,
      threadKey: `slack:C-hitl-${suffix}:1.0`,
      conversationKey: `C-hitl-${suffix}::1.0`,
      executionId: `exec-hitl-${suffix}`,
      threadTs: "1.0",
      registeredAt: Date.now(),
    };
    const choiceIds = [`confirm-${suffix}`, `incident-${suffix}`];
    const first = createDurableObjectStore(env.BOT_STATE, {
      partition: (key) => `first:${key}`,
    });
    const restarted = createDurableObjectStore(env.BOT_STATE, {
      partition: (key) => `restarted:${key}`,
    });
    await expect(first.activeTurn.register(record)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    for (const choiceId of choiceIds) {
      await expect(first.activeTurn.registerChoice({
        threadKey: record.threadKey,
        executionId: record.executionId,
        choiceId,
      })).resolves.toBe("registered");
    }
    await expect(restarted.activeTurn.claimCancellation({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: `Ev-${suffix}`,
    })).resolves.toBe("claimed");
    await expect(first.activeTurn.registerChoice({
      threadKey: record.threadKey,
      executionId: record.executionId,
      choiceId: `late-${suffix}`,
    })).resolves.toBe("cancelled");
    await expect(restarted.activeTurn.cancelRegisteredChoices({
      threadKey: record.threadKey,
      executionId: record.executionId,
    })).resolves.toEqual(choiceIds);

    for (const choiceId of choiceIds) {
      const choiceKey = `hitl-id:${choiceId}`;
      const cancelledKey = `hitl-cancelled:${choiceId}`;
      await expect(first.hitl.persistChoiceUnlessCancelled({
        choiceKey,
        cancelledKey,
        record: { value: { confirmed: true, choiceId }, at: Date.now() },
        ttlMs: 60_000,
      })).resolves.toBe("cancelled");
      await expect(restarted.hitl.consumeChoice({ choiceKey, cancelledKey }))
        .resolves.toMatchObject({
          status: "cancelled",
          record: { value: { confirmed: false, choiceId } },
        });
    }

    await restarted.activeTurn.markCancelControlled({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: `Ev-${suffix}`,
    });
    await restarted.activeTurn.beginCancelAck({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: `Ev-${suffix}`,
    });
    await restarted.activeTurn.confirmCancellationAndClear({
      threadKey: record.threadKey,
      executionId: record.executionId,
      stopEventId: `Ev-${suffix}`,
    });
  });

  it("atomically makes exact HITL cancellation authoritative across races and stub resolutions", async () => {
    const name = `hitl-race-${crypto.randomUUID()}`;
    const choiceKey = `hitl-id:${crypto.randomUUID()}`;
    const cancelledKey = choiceKey.replace("hitl-id:", "hitl-cancelled:");
    const first = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    const approval = { value: { confirmed: true, choiceId: "race" }, at: 1 };
    const denial = { value: { confirmed: false, choiceId: "race" }, at: 2 };

    const [persistResult] = await Promise.all([
      first.hitl.persistChoiceUnlessCancelled({
        choiceKey,
        cancelledKey,
        record: approval,
        ttlMs: 60_000,
      }),
      first.hitl.cancelChoice({
        choiceKey,
        cancelledKey,
        denial,
        ttlMs: 60_000,
      }),
    ]);
    expect(["persisted", "cancelled"]).toContain(persistResult);

    const restarted = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    await expect(restarted.hitl.consumeChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "cancelled", record: denial });
    await expect(restarted.hitl.persistChoiceUnlessCancelled({
      choiceKey,
      cancelledKey,
      record: approval,
      ttlMs: 60_000,
    })).resolves.toBe("cancelled");
    await expect(restarted.hitl.consumeChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "cancelled", record: denial });
  });

  it("prepares an exact HITL wait without erasing a Stop denial", async () => {
    const name = `hitl-prepare-${crypto.randomUUID()}`;
    const choiceId = crypto.randomUUID();
    const choiceKey = `hitl-id:${choiceId}`;
    const cancelledKey = `hitl-cancelled:${choiceId}`;
    const store = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    const stale = { value: { confirmed: true, choiceId }, at: 1 };
    const denial = { value: { confirmed: false, choiceId }, at: 2 };

    await store.hitl.persistChoiceUnlessCancelled({
      choiceKey,
      cancelledKey,
      record: stale,
      ttlMs: 60_000,
    });
    await expect(store.hitl.prepareChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "ready" });
    await expect(store.hitl.consumeChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "pending" });

    // Awaiting this RPC is the first serialization barrier: Stop has fully
    // linearized before a fresh stub attempts setup.
    await store.hitl.cancelChoice({ choiceKey, cancelledKey, denial, ttlMs: 60_000 });
    const restarted = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    await expect(restarted.hitl.prepareChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "cancelled", record: denial });
    await expect(restarted.hitl.consumeChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "cancelled", record: denial });
    // Denials remain durable/idempotent across repeated polls and restarts.
    await expect(restarted.hitl.consumeChoice({ choiceKey, cancelledKey }))
      .resolves.toEqual({ status: "cancelled", record: denial });
  });

  it("linearizes exact HITL consume on both sides of the Stop barrier", async () => {
    const name = `hitl-consume-${crypto.randomUUID()}`;
    const store = createDurableObjectStore(env.BOT_STATE, { partition: () => name });

    const stoppedId = crypto.randomUUID();
    const stoppedChoiceKey = `hitl-id:${stoppedId}`;
    const stoppedCancelledKey = `hitl-cancelled:${stoppedId}`;
    const stoppedApproval = { value: { confirmed: true, choiceId: stoppedId }, at: 1 };
    const stoppedDenial = { value: { confirmed: false, choiceId: stoppedId }, at: 2 };
    await store.hitl.prepareChoice({
      choiceKey: stoppedChoiceKey,
      cancelledKey: stoppedCancelledKey,
    });
    await store.hitl.persistChoiceUnlessCancelled({
      choiceKey: stoppedChoiceKey,
      cancelledKey: stoppedCancelledKey,
      record: stoppedApproval,
      ttlMs: 60_000,
    });
    // Stop is the serialization barrier between the affirmative write and
    // consume, so consume must select the replacement denial.
    await store.hitl.cancelChoice({
      choiceKey: stoppedChoiceKey,
      cancelledKey: stoppedCancelledKey,
      denial: stoppedDenial,
      ttlMs: 60_000,
    });
    await expect(store.hitl.consumeChoice({
      choiceKey: stoppedChoiceKey,
      cancelledKey: stoppedCancelledKey,
    })).resolves.toEqual({ status: "cancelled", record: stoppedDenial });

    const grantedId = crypto.randomUUID();
    const grantedChoiceKey = `hitl-id:${grantedId}`;
    const grantedCancelledKey = `hitl-cancelled:${grantedId}`;
    const grantedApproval = { value: { confirmed: true, choiceId: grantedId }, at: 3 };
    const laterDenial = { value: { confirmed: false, choiceId: grantedId }, at: 4 };
    await store.hitl.prepareChoice({
      choiceKey: grantedChoiceKey,
      cancelledKey: grantedCancelledKey,
    });
    await store.hitl.persistChoiceUnlessCancelled({
      choiceKey: grantedChoiceKey,
      cancelledKey: grantedCancelledKey,
      record: grantedApproval,
      ttlMs: 60_000,
    });
    // Here consume itself is the barrier and is allowed to grant because it
    // fully linearizes before the later Stop.
    await expect(store.hitl.consumeChoice({
      choiceKey: grantedChoiceKey,
      cancelledKey: grantedCancelledKey,
    })).resolves.toEqual({ status: "choice", record: grantedApproval });
    await store.hitl.cancelChoice({
      choiceKey: grantedChoiceKey,
      cancelledKey: grantedCancelledKey,
      denial: laterDenial,
      ttlMs: 60_000,
    });
    const restarted = createDurableObjectStore(env.BOT_STATE, { partition: () => name });
    await expect(restarted.hitl.consumeChoice({
      choiceKey: grantedChoiceKey,
      cancelledKey: grantedCancelledKey,
    })).resolves.toEqual({ status: "cancelled", record: laterDenial });
  });
});
