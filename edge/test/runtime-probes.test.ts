import { describe, expect, it, vi } from "vitest";
import { probeRuntimeDependencies } from "../src/runtime-probes.js";
import type { Env } from "../src/env.js";

function binding(seen: string[]) {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(`${request.url}:${request.headers.get("x-opentag-service-token") ?? request.headers.get("x-opentag-graphify-token") ?? "none"}`);
      if (request.url.includes("supermemory")) return Response.json({ status: "ok" });
      if (request.url.includes("graphify")) return Response.json({ status: "ok" });
      if (request.url.includes("credential-broker")) {
        return Response.json({ ok: true, providerResolutionEnabled: true });
      }
      if (request.url.includes("platform-effecter")) {
        return Response.json({ ok: true, providerEffectsEnabled: true });
      }
      if (request.url.includes("harness")) return Response.json({ ok: true });
      return new Response("ok");
    },
  } as unknown as Env["AGENT_RUNTIME"];
}

describe("runtime dependency probes", () => {
  it("uses non-mutating authenticated health requests for service bindings", async () => {
    const seen: string[] = [];
    const result = await probeRuntimeDependencies({
      AGENT_RUNTIME: binding(seen),
      AGENT_URL: "https://agent.example.test/api/run",
      SUPERMEMORY: binding(seen),
      SUPERMEMORY_SERVICE_AUTH_TOKEN: "memory-secret",
      GRAPHIFY: binding(seen),
      GRAPHIFY_SERVICE_AUTH_TOKEN: "graph-secret",
      HARNESS: binding(seen),
      CONNECTOR_CREDENTIALS: binding(seen),
      PLATFORM_EFFECTER: binding(seen),
    }, "full");

    expect(result).toEqual({
      agentReachable: true,
      knowledgeSearchReachable: true,
      codeGraphReachable: true,
      harnessReachable: true,
      credentialBrokerReachable: true,
      platformEffecterReachable: true,
    });
    expect(seen).toContain("https://agent/health:none");
    expect(seen).toContain("https://supermemory/health:memory-secret");
    expect(seen).toContain("https://graphify/health:graph-secret");
  });

  it("fails closed when a configured health probe does not answer", async () => {
    const result = await probeRuntimeDependencies({
      AGENT_RUNTIME: {
        fetch: async () => { throw new Error("unavailable"); },
      } as unknown as Env["AGENT_RUNTIME"],
    }, "core");
    expect(result).toEqual({ agentReachable: false });
  });

  it("aborts a timed-out health request", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    try {
      const pending = probeRuntimeDependencies({
        AGENT_RUNTIME: {
          fetch: async (input: RequestInfo | URL) => {
            requestSignal = new Request(input).signal;
            return new Promise<Response>(() => {});
          },
        } as unknown as Env["AGENT_RUNTIME"],
      }, "core");
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toEqual({ agentReachable: false });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows container-backed health probes to finish after startup latency", async () => {
    vi.useFakeTimers();
    try {
      const pending = probeRuntimeDependencies({
        AGENT_RUNTIME: binding([]),
        SUPERMEMORY: {
          fetch: async () => new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json({ status: "ok" })), 2_000);
          }),
        } as unknown as Env["SUPERMEMORY"],
        SUPERMEMORY_SERVICE_AUTH_TOKEN: "memory-secret",
      }, "knowledge");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({
        agentReachable: true,
        knowledgeSearchReachable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
