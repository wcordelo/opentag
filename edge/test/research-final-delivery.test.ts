import { describe, expect, it, vi } from "vitest";
import {
  deliverResearchSlackObligation,
  researchSlackRateScheduler,
} from "../workers/orchestrator/src/OrchestratorDO.js";
import { postToSlackThread } from "../../lib/research/delivery/slack.js";
import {
  createSlackWebClient,
  sharedSlackRateScheduler,
} from "../src/slack/web-api.js";

describe("OrchestratorDO final research delivery", () => {
  it("passes final task identity to the production Slack card delivery", async () => {
    const deliver = vi.fn(async () => ({ status: "delivered" as const, duplicate: false }));
    await expect(deliverResearchSlackObligation({
      id: "obligation-7",
      threadKey: "slack:C1:1.0",
      payload: { type: "final", text: "synthesis", taskId: "research-42" },
    }, "xoxb", deliver)).resolves.toEqual({ status: "delivered", duplicate: false });
    expect(deliver).toHaveBeenCalledWith(
      "slack:C1:1.0",
      "synthesis",
      "obligation-7",
      "xoxb",
      { type: "final", text: "synthesis", taskId: "research-42" },
      { scheduler: undefined },
    );
  });

  it("reserves every 429 attempt, honors Retry-After, and replays the identical form", async () => {
    const bodies: string[] = [];
    const reserve = vi.fn(async () => ({ delayMs: 0 }));
    const scheduler = researchSlackRateScheduler({
      idFromName: (name: string) => ({ name }),
      get: () => ({ reserve }),
    } as never, "production");
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "Retry-After": "2" } },
          )
        : Response.json({ ok: true, ts: "1.1" });
    }));

    await expect(postToSlackThread(
      "slack:C-rate:1.0",
      "research result",
      "obligation-rate",
      "xoxb",
      undefined,
      { scheduler, sleep },
    )).resolves.toEqual({ status: "delivered", duplicate: false });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(1, { minIntervalMs: 1_000 });
    expect(reserve).toHaveBeenNthCalledWith(2, { minIntervalMs: 1_000 });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(bodies[1]).toBe(bodies[0]);
    vi.unstubAllGlobals();
  });

  it("keeps an exhausted research 429 ambiguous so the obligation remains drainable", async () => {
    const reserve = vi.fn(async () => ({ delayMs: 0 }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "0" } },
      )));
    await expect(postToSlackThread(
      "slack:C-rate:1.0",
      "research result",
      "obligation-rate",
      "xoxb",
      undefined,
      {
        scheduler: researchSlackRateScheduler({
          idFromName: (name: string) => ({ name }),
          get: () => ({ reserve }),
        } as never, "production"),
        sleep: async () => undefined,
      },
    )).resolves.toEqual({
      status: "ambiguous",
      error: "page_1_of_1:ratelimited",
    });
    expect(reserve).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("shares sequential per-channel reservations between bot and research scripts", async () => {
    const reservations: string[] = [];
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        reserve: async () => {
          reservations.push(id.name);
          return { delayMs: 0 };
        },
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ts: "1.1" })));
    await createSlackWebClient("xoxb", {
      scheduler: sharedSlackRateScheduler("production", namespace as never),
    }).postMessage({ channel: "C-shared", text: "bot" });
    await postToSlackThread(
      "slack:C-shared:1.0",
      "research",
      "research-obligation",
      "xoxb",
      undefined,
      {
        scheduler: researchSlackRateScheduler(
          namespace as never,
          "production",
        ),
      },
    );
    expect(reservations).toEqual(["C-shared", "C-shared"]);
    vi.unstubAllGlobals();
  });
});
