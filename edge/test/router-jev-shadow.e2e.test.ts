import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IngressSink } from "@copilotkit/channels";
import { CloudflareSlackAdapter } from "../src/slack/cloudflare-slack-adapter.js";
import {
  createResponseRouteJevMeasurement,
  scheduleRouterJevShadow,
} from "../src/router/response-route-jev-measurement.js";
import { callRouterJevJudgment } from "../src/router/jev-route-shadow.js";
import { detectMemoryOptOut } from "../src/router/jev-route-questions.js";
import { isRouterJevShadowEnabled } from "../src/router/jev-route-config.js";

function makeSink(): IngressSink & { turns: unknown[] } {
  const turns: unknown[] = [];
  return {
    turns,
    onTurn: async (turn) => { turns.push(turn); },
    onCommand: async () => undefined,
    onInteraction: async () => undefined,
    onThreadStarted: async () => undefined,
    onReaction: async () => undefined,
    onModalSubmit: async () => undefined,
    onModalClose: async () => undefined,
  };
}

function stubUsersFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const value = String(url);
    if (value.includes("users.info")) {
      return Response.json({ ok: true, user: { id: "U1", real_name: "Ada", name: "ada" } });
    }
    if (value.includes("auth.test")) {
      return Response.json({ ok: true, user_id: "UBOT" });
    }
    return Response.json({ ok: false });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe("router Jev shadow ingress E2E", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    restoreFetch = stubUsersFetch();
  });

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it("keeps respond/observe routing unchanged while recording Jev shadow rows", async () => {
    const shadowRows: Array<ReturnType<typeof createResponseRouteJevMeasurement>> = [];
    const pendingShadow: Promise<void>[] = [];
    const typesafeCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("api.typesafe.ai")) {
        typesafeCalls.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({
          model: "jev-test",
          answers: {
            route: {
              type: "choice",
              choice: "observe",
              probabilities: { respond: 0.2, observe: 0.8 },
              confidence: 0.6,
            },
            needsHuman: { type: "noul", noul: 0.1 },
            memoryNeeded: { type: "noul", noul: 0.9 },
          },
        });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
      routerJevShadow: (input) => {
        pendingShadow.push(callRouterJevJudgment({
          apiKey: "test-key",
          model: "jev-latest",
          timeoutMs: 1500,
          message: input.message,
          source: input.source,
          channelType: input.channelType,
          botMentioned: input.botMentioned,
          hasFiles: input.hasFiles,
          threadContext: input.threadContext,
          fetchImpl: globalThis.fetch,
        }).then((jev) => {
          shadowRows.push(createResponseRouteJevMeasurement({
            workspaceId: "T1",
            eventId: input.eventId,
            threadKey: input.threadKey,
            executionId: input.executionId,
            currentRoute: input.currentRoute,
            jev,
          }));
        }));
      },
    });
    const sink = makeSink();
    await adapter.start(sink);

    const respond = await adapter.handleEventsBody({
      team_id: "T1",
      event_id: "EvRespond",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "what is the deploy status?",
        ts: "2.0",
        thread_ts: "1.0",
      },
    });
    const observe = await adapter.handleEventsBody({
      team_id: "T1",
      event_id: "EvObserve",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "yo",
        ts: "3.0",
        thread_ts: "1.0",
      },
    });

    await Promise.all(pendingShadow);
    expect(respond).toEqual({ handled: true });
    expect(observe).toEqual({ handled: true });
    expect(sink.turns).toHaveLength(1);
    expect(typesafeCalls).toHaveLength(2);
    expect(shadowRows).toHaveLength(2);
    const byEvent = new Map(shadowRows.map((row) => [row.eventId, row]));
    expect(byEvent.get("EvRespond")).toMatchObject({
      currentRoute: { decision: "respond" },
      jev: { model: "jev-test", route: { choice: "observe" } },
      combinedRoute: { decision: "respond", rule: "4a" },
    });
    expect(byEvent.get("EvObserve")).toMatchObject({
      currentRoute: { decision: "observe", reason: "observe_conversation" },
      jev: { model: "jev-test" },
      combinedRoute: { decision: "observe", rule: "4a" },
    });
  });

  it("applies rule 4a: router respond + high memoryNeeded upgrades Jev observe to combined respond", async () => {
    const judgment = await callRouterJevJudgment({
      apiKey: "test-key",
      model: "jev-latest",
      timeoutMs: 1500,
      message: "what is the deploy status?",
      source: "thread_reply",
      fetchImpl: async () => Response.json({
        model: "jev-test",
        answers: {
          route: { type: "choice", choice: "observe", probabilities: { respond: 0.2, observe: 0.8 } },
          needsHuman: { type: "noul", noul: 0.1 },
          memoryNeeded: { type: "noul", noul: 0.96 },
        },
      }),
    });
    const record = createResponseRouteJevMeasurement({
      workspaceId: "T1",
      eventId: "EvComboFlip",
      threadKey: "slack:T1:C1:1.0",
      executionId: "route-jev:EvComboFlip",
      currentRoute: {
        decision: "respond",
        reason: "question",
        classification: {
          tier: 1,
          confidence: 1,
          classifierPath: "heuristic",
          matchedRule: "t1.11",
          primarySignal: "question_form",
          surfaceFeatures: {
            hasCodeBlock: false,
            hasAttachment: false,
            wordCount: 4,
            matchedTier1Pattern: true,
            matchedTier2Pattern: false,
            tier3Flag: false,
          },
          normalizedMessage: "what is the deploy status",
        },
      },
      jev: judgment,
    });
    expect(record.combinedRoute).toEqual({ decision: "respond", rule: "4a" });
  });

  it("applies rule 4a: router respond + low memoryNeeded keeps combined observe when Jev observes", async () => {
    const judgment = await callRouterJevJudgment({
      apiKey: "test-key",
      model: "jev-latest",
      timeoutMs: 1500,
      message: "yo",
      source: "thread_reply",
      fetchImpl: async () => Response.json({
        model: "jev-test",
        answers: {
          route: { type: "choice", choice: "observe", probabilities: { respond: 0.1, observe: 0.9 } },
          needsHuman: { type: "noul", noul: 0.05 },
          memoryNeeded: { type: "noul", noul: 0.1 },
        },
      }),
    });
    const record = createResponseRouteJevMeasurement({
      workspaceId: "T1",
      eventId: "EvComboStay",
      threadKey: "slack:T1:C1:1.0",
      executionId: "route-jev:EvComboStay",
      currentRoute: {
        decision: "respond",
        reason: "question",
        classification: {
          tier: 1,
          confidence: 1,
          classifierPath: "heuristic",
          matchedRule: "t1.11",
          primarySignal: "question_form",
          surfaceFeatures: {
            hasCodeBlock: false,
            hasAttachment: false,
            wordCount: 1,
            matchedTier1Pattern: true,
            matchedTier2Pattern: false,
            tier3Flag: false,
          },
          normalizedMessage: "yo",
        },
      },
      jev: judgment,
    });
    expect(record.combinedRoute).toEqual({ decision: "observe", rule: "4a" });
  });

  it("records fetch failures without changing routing", async () => {
    const shadowRows: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("api.typesafe.ai")) {
        throw new Error("network_down");
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
      routerJevShadow: (input) => {
        void callRouterJevJudgment({
          apiKey: "test-key",
          model: "jev-latest",
          timeoutMs: 1500,
          message: input.message,
          source: input.source,
          fetchImpl: globalThis.fetch,
        }).then((jev) => {
          shadowRows.push(jev);
        });
      },
    });
    await adapter.start(makeSink());
    const result = await adapter.handleEventsBody({
      team_id: "T1",
      event_id: "EvFail",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "please check deploy",
        ts: "4.0",
        thread_ts: "1.0",
      },
    });
    await vi.waitFor(() => shadowRows.length === 1);
    expect(result).toEqual({ handled: true });
    expect(shadowRows[0]).toMatchObject({ error: "network_down" });
  });

  it("registers shadow Jev work with waitUntil on observe paths without blocking the ack", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    let resolveTypesafe: (() => void) | undefined;
    const typesafeGate = new Promise<void>((resolve) => { resolveTypesafe = resolve; });
    let typesafeStarted = false;
    let typesafeFinished = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("api.typesafe.ai")) {
        typesafeStarted = true;
        await typesafeGate;
        typesafeFinished = true;
        return Response.json({
          model: "jev-test",
          answers: {
            route: { type: "choice", choice: "observe", probabilities: { respond: 0.1, observe: 0.9 } },
            needsHuman: { type: "noul", noul: 0.05 },
            memoryNeeded: { type: "noul", noul: 0.1 },
          },
        });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const adapter = new CloudflareSlackAdapter({
      unsafeAllowUnfencedTestOnly: true,
      botToken: "xoxb-test",
      botUserId: "UBOT",
      routerJevShadow: (input) => {
        scheduleRouterJevShadow(
          {
            ROUTER_JEV_SHADOW: "on",
            TYPESAFE_API_KEY: "test-key",
            ROUTER_JEV_MODEL: "jev-latest",
            ROUTER_JEV_TIMEOUT_MS: "1500",
          },
          input,
          globalThis.fetch,
        );
      },
    });
    await adapter.start(makeSink());
    const result = await adapter.handleEventsBody({
      team_id: "T1",
      event_id: "EvWaitUntil",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "yo",
        ts: "5.0",
        thread_ts: "1.0",
      },
    }, {
      waitUntil: (promise) => { waitUntilTasks.push(promise); },
    });

    expect(result).toEqual({ handled: true });
    expect(waitUntilTasks).toHaveLength(1);
    expect(typesafeStarted).toBe(true);
    expect(typesafeFinished).toBe(false);
    resolveTypesafe?.();
    await waitUntilTasks[0];
    expect(typesafeFinished).toBe(true);
  });

  it("does not call Jev when ROUTER_JEV_SHADOW is off", async () => {
    const typesafeCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("api.typesafe.ai")) {
        typesafeCalls.push(String(url));
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    expect(isRouterJevShadowEnabled({ ROUTER_JEV_SHADOW: "off" })).toBe(false);
    scheduleRouterJevShadow(
      { ROUTER_JEV_SHADOW: "off", TYPESAFE_API_KEY: "secret" },
      {
        eventId: "EvOff",
        threadKey: "slack:T1:C1:1.0",
        executionId: "route-jev:EvOff",
        message: "yo",
        source: "thread_reply",
        currentRoute: {
          decision: "observe",
          reason: "observe_conversation",
          classification: {
            tier: 2,
            confidence: 0,
            classifierPath: "classifier_failed",
            matchedRule: "unresolved",
            primarySignal: "conversational",
            surfaceFeatures: {
              hasCodeBlock: false,
              hasAttachment: false,
              wordCount: 1,
              matchedTier1Pattern: false,
              matchedTier2Pattern: false,
              tier3Flag: false,
            },
            normalizedMessage: "yo",
          },
        },
      },
      globalThis.fetch,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(typesafeCalls).toHaveLength(0);
  });

  it("forces memoryNeeded false when the user opts out of memory", async () => {
    expect(detectMemoryOptOut("answer without using memory")).toBe(true);
    expect(detectMemoryOptOut("explain HTTP status codes, don't look anything up")).toBe(true);
    const judgment = await callRouterJevJudgment({
      apiKey: "test-key",
      model: "jev-latest",
      timeoutMs: 1500,
      message: "what did we ship last week? answer without using memory",
      source: "app_mention",
      fetchImpl: async () => Response.json({
        model: "jev-test",
        answers: {
          route: { type: "choice", choice: "respond", probabilities: { respond: 0.9, observe: 0.1 } },
          needsHuman: { type: "noul", noul: 0.05 },
          memoryNeeded: { type: "noul", noul: 0.95 },
        },
      }),
    });
    expect(judgment.memoryNeeded).toEqual({ noul: 0, overriddenByOptOut: true });
  });
});
