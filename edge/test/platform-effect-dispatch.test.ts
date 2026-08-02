import { describe, expect, it, vi } from "vitest";
import {
  dispatchPlatformEffectWakeup,
  enqueuePlatformEffectWakeup,
  handlePlatformEffectQueue,
  platformEffectWakeup,
  validatePlatformEffectWakeup,
} from "../src/platform/effect-dispatch.js";

const tenantObject = "tenant:123e4567-e89b-12d3-a456-426614174000";

function receipt(status: "pending" | "failed", overrides: Record<string, unknown> = {}) {
  return {
    intentId: "effect:provisioning:install-1",
    idempotencyKey: "provisioning:install-1",
    scope: "tenant",
    tenantId: "123e4567-e89b-12d3-a456-426614174000",
    kind: "provisioning",
    targetRef: "provision:install-1",
    status,
    attempts: 0,
    retryable: status === "failed",
    availableAt: "2026-08-01T20:00:00.000Z",
    requestedAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
    ...overrides,
  };
}

function bindings(options: {
  pending?: unknown[];
  failed?: unknown[];
  leased?: unknown[];
  effecterStatus?: number;
  authToken?: string;
} = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers?: Record<string, string> }> = [];
  const stateStub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const path = new URL(input.toString()).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/effect/list") {
        const status = body.status;
        const effects = status === "pending"
          ? (options.pending ?? [])
          : status === "failed"
            ? (options.failed ?? [])
            : (options.leased ?? []);
        return Response.json({ effects });
      }
      return Response.json({ error: "unexpected_path" }, { status: 404 });
    },
  };
  const effecter = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      calls.push({
        path: "/run",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        headers,
      });
      return Response.json(
        { status: "completed" },
        { status: options.effecterStatus ?? 200 },
      );
    },
  };
  return {
    calls,
    PLATFORM_STATE: {
      idFromName: (name: string) => name,
      get: () => stateStub,
    } as never,
    PLATFORM_EFFECTER: effecter as never,
    EFFECTOR_AUTH_TOKEN: options.authToken ?? "effector-test-token",
  };
}

describe("platform effect wakeup contract", () => {
  it("accepts only opaque internal tenant or marketplace object names", () => {
    expect(validatePlatformEffectWakeup(platformEffectWakeup(tenantObject))).toEqual({
      schemaVersion: 1,
      objectName: tenantObject,
    });
    expect(validatePlatformEffectWakeup(platformEffectWakeup("__platform_marketplace__"))).toEqual({
      schemaVersion: 1,
      objectName: "__platform_marketplace__",
    });
    expect(() => validatePlatformEffectWakeup({
      schemaVersion: 1,
      objectName: "tenant:T-external-slack-id",
    })).toThrow("effect_wakeup_object_invalid");
    expect(() => validatePlatformEffectWakeup({
      schemaVersion: 1,
      objectName: tenantObject,
      token: "must-not-enter-queue",
    })).toThrow("effect_wakeup_field_invalid");
  });

  it("lists metadata receipts and sends only a lease request to the effecter", async () => {
    const fixture = bindings({ pending: [receipt("pending")] });
    const result = await dispatchPlatformEffectWakeup(
      platformEffectWakeup(tenantObject),
      fixture,
      Date.parse("2026-08-01T20:00:00.000Z"),
    );
    expect(result).toEqual({ dispatched: 1 });
    expect(fixture.calls).toEqual(expect.arrayContaining([
      { path: "/effect/list", body: expect.objectContaining({ scope: "tenant", tenantId: "123e4567-e89b-12d3-a456-426614174000", status: "pending" }) },
      { path: "/effect/list", body: expect.objectContaining({ scope: "tenant", tenantId: "123e4567-e89b-12d3-a456-426614174000", status: "failed" }) },
      { path: "/effect/list", body: expect.objectContaining({ scope: "tenant", tenantId: "123e4567-e89b-12d3-a456-426614174000", status: "leased" }) },
      { path: "/run", body: expect.objectContaining({ scope: "tenant", tenantId: "123e4567-e89b-12d3-a456-426614174000", intentId: receipt("pending").intentId }), headers: { authorization: "Bearer effector-test-token", "content-type": "application/json" } },
    ]));
    expect(JSON.stringify(fixture.calls)).not.toContain("must-not-enter-queue");
  });

  it("schedules a future retry without claiming it early", async () => {
    const fixture = bindings({
      failed: [receipt("failed", { availableAt: "2026-08-01T20:05:00.000Z" })],
    });
    await expect(dispatchPlatformEffectWakeup(
      platformEffectWakeup(tenantObject),
      fixture,
      Date.parse("2026-08-01T20:00:00.000Z"),
    )).resolves.toEqual({ dispatched: 0, nextDelaySeconds: 300 });
    expect(fixture.calls.filter((call) => call.path === "/run")).toHaveLength(0);
  });

  it("ignores terminal failed receipts instead of retrying poison work", async () => {
    const fixture = bindings({
      failed: [receipt("failed", { retryable: false })],
    });
    await expect(dispatchPlatformEffectWakeup(
      platformEffectWakeup(tenantObject),
      fixture,
      Date.parse("2026-08-01T20:00:00.000Z"),
    )).resolves.toEqual({ dispatched: 0 });
    expect(fixture.calls.filter((call) => call.path === "/run")).toHaveLength(0);
  });

  it("redispatches expired leased receipts for reclaim", async () => {
    const leased = receipt("pending", {
      status: "leased",
      leaseExpiresAt: "2026-08-01T19:00:00.000Z",
    });
    const fixture = bindings({ leased: [leased] });
    const result = await dispatchPlatformEffectWakeup(
      platformEffectWakeup(tenantObject),
      fixture,
      Date.parse("2026-08-01T20:00:00.000Z"),
    );
    expect(result).toEqual({ dispatched: 1 });
    expect(fixture.calls).toEqual(expect.arrayContaining([
      { path: "/run", body: expect.objectContaining({ intentId: leased.intentId }), headers: expect.objectContaining({ authorization: "Bearer effector-test-token" }) },
    ]));
  });

  it("skips leased receipts until the lease expires", async () => {
    const leased = receipt("pending", {
      status: "leased",
      leaseExpiresAt: "2026-08-01T21:00:00.000Z",
    });
    const fixture = bindings({ leased: [leased] });
    await expect(dispatchPlatformEffectWakeup(
      platformEffectWakeup(tenantObject),
      fixture,
      Date.parse("2026-08-01T20:00:00.000Z"),
    )).resolves.toEqual({ dispatched: 0 });
    expect(fixture.calls.filter((call) => call.path === "/run")).toHaveLength(0);
  });
});

describe("platform effect queue consumer", () => {
  it("requeues a transient effecter outage and acks malformed bodies", async () => {
    const retry = vi.fn();
    const ack = vi.fn();
    const queue = {
      send: vi.fn(async () => ({})),
    };
    const fixture = bindings({ effecterStatus: 503, pending: [receipt("pending")] });
    await handlePlatformEffectQueue({
      queue: "opentag-platform-effects",
      messages: [
        { id: "bad", timestamp: new Date(), attempts: 1, body: { schemaVersion: 1, objectName: "secret" }, retry, ack },
        { id: "good", timestamp: new Date(), attempts: 2, body: platformEffectWakeup(tenantObject), retry, ack },
      ],
      metadata: { backlogCount: 0, backlogBytes: 0 },
    } as never, {
      ...fixture,
      PLATFORM_EFFECTS_QUEUE: queue as never,
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("enqueues a bounded wakeup and never accepts a provider payload", async () => {
    const send = vi.fn(async () => ({}));
    await enqueuePlatformEffectWakeup({ send } as never, tenantObject);
    expect(send).toHaveBeenCalledWith(
      { schemaVersion: 1, objectName: tenantObject },
      { contentType: "json" },
    );
  });
});
