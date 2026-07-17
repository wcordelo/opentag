import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { DeferredIngressDO } = await import("../src/deferred-ingress-do.js");
const { SlackRateLimitDO } = await import("../src/slack/slack-rate-limit-do.js");

function fakeCtx(options: { failFirstAlarm?: boolean } = {}) {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let alarmCalls = 0;
  return {
    values,
    currentAlarm: () => alarm,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, value); },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarmCalls += 1;
        if (options.failFirstAlarm && alarmCalls === 1) {
          throw new Error("alarm_write_failed");
        }
        alarm = at;
      },
      transaction: async <T>(fn: (txn: unknown) => Promise<T>) => fn({
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => { values.set(key, value); },
      }),
    },
  };
}

describe("durable Slack ingress ownership", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("persists and arms the immutable click before processing, then retries after isolate failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const ctx = fakeCtx();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("retry", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const owner = new DeferredIngressDO(ctx as never, {
      BOT_SELF: { fetch },
      ADMIN_SECRET: "secret",
    } as never);
    const job = {
      id: "quick:C1:10.0:11.1",
      kind: "quick_action" as const,
      payload: { action: "retry" },
      teamId: "T1",
    };

    await expect(owner.prepare(job)).resolves.toEqual({
      accepted: true,
      status: "pending",
    });
    expect(ctx.currentAlarm()).toBe(1_000);
    expect(await owner.getState()).toMatchObject(job);

    await owner.alarm();
    expect(await owner.getState()).toMatchObject({
      status: "pending",
      attempt: 1,
      lastError: "internal_handoff_http_503",
    });
    expect(ctx.currentAlarm()).toBe(2_000);

    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await owner.alarm();
    expect(await owner.getState()).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("authorization"))
      .toBe("Bearer secret");
  });

  it("rejects a different payload reusing a stable job id", async () => {
    const owner = new DeferredIngressDO(fakeCtx() as never, {} as never);
    await owner.prepare({
      id: "late-file-repair:Ev1:10:F1",
      kind: "late_file",
      payload: { file: "F1" },
      teamId: "T1",
    });
    await expect(owner.prepare({
      id: "late-file-repair:Ev1:10:F1",
      kind: "late_file",
      payload: { file: "F2" },
      teamId: "T1",
    })).rejects.toThrow("deferred_ingress_identity_conflict");
  });

  it.each([
    ["late_file", { file: "F1" }],
    ["quick_action", { action: "retry" }],
    ["file_turn", { event_id: "Ev-file", event: { files: [{ id: "F1" }] } }],
  ] as const)(
    "repairs a missing %s alarm on the identical retry and executes once",
    async (kind, payload) => {
      vi.spyOn(Date, "now").mockReturnValue(5_000);
      const ctx = fakeCtx({ failFirstAlarm: true });
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const owner = new DeferredIngressDO(ctx as never, {
        BOT_SELF: { fetch },
      } as never);
      const job = { id: `${kind}:stable`, kind, payload, teamId: "T1" };

      await expect(owner.prepare(job)).rejects.toThrow("alarm_write_failed");
      expect(await owner.getState()).toMatchObject({
        id: job.id,
        status: "pending",
      });
      expect(ctx.currentAlarm()).toBeNull();

      await expect(owner.prepare(job)).resolves.toEqual({
        accepted: false,
        status: "pending",
      });
      expect(ctx.currentAlarm()).toBe(5_000);

      await owner.alarm();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await owner.getState()).toMatchObject({ status: "completed" });
      await owner.alarm();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("cross-isolate Slack rate reservations", () => {
  it("persists non-overlapping channel dispatch slots", async () => {
    const ctx = fakeCtx();
    const owner = new SlackRateLimitDO(ctx as never, {} as never);
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    await expect(owner.reserve({ minIntervalMs: 1_000 })).resolves.toEqual({
      delayMs: 0,
      reservedAt: 10_000,
    });
    await expect(owner.reserve({ minIntervalMs: 1_000 })).resolves.toEqual({
      delayMs: 1_000,
      reservedAt: 11_000,
    });
    expect(ctx.values.get("nextAllowedAt")).toBe(12_000);
  });
});
