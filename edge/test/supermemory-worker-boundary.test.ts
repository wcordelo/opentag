import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {
    env: Record<string, unknown>;
    constructor(_ctx?: unknown, env?: Record<string, unknown>) {
      this.env = env ?? {};
    }
    async onStart() {}
    mountBucket = vi.fn(async () => undefined);
    unmountBucket = vi.fn(async () => undefined);
    exec = vi.fn(async () => ({ success: true }));
  },
  ContainerProxy: class {},
}));

const { default: supermemoryWorker, SupermemoryContainer } = await import("../workers/supermemory/src/index.js");

function env(containerFetch: ReturnType<typeof vi.fn>) {
  return {
    STATE_BUCKET: { get: vi.fn(async () => ({ size: 8, text: async () => "sm_server" })) },
    SUPERMEMORY: { getByName: () => ({ fetch: containerFetch }) },
    SUPERMEMORY_SERVICE_AUTH_TOKEN: "service-token",
  } as never;
}

describe("Supermemory private Worker boundary", () => {
  it("does not wake the singleton for a disallowed route", async () => {
    const containerFetch = vi.fn(async () => Response.json({ status: "ok" }));
    const response = await supermemoryWorker.fetch(new Request("https://supermemory/private", {
      headers: { "x-opentag-service-token": "service-token" },
    }), env(containerFetch));
    expect(response.status).toBe(404);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("allows only the SDK mutation methods on document routes", async () => {
    const containerFetch = vi.fn(async () => Response.json({ status: "ok" }));
    const workerEnv = env(containerFetch);
    const response = await supermemoryWorker.fetch(new Request("https://supermemory/v3/documents", {
      method: "DELETE",
      headers: { "x-opentag-service-token": "service-token" },
    }), workerEnv);
    expect(response.status).toBe(404);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("keeps health GET-only and injects the server key only into the container request", async () => {
    const containerFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/ready") {
        expect(request.headers.get("authorization")).toBeNull();
        return Response.json({ status: "ok" });
      } else {
        expect(request.headers.get("authorization")).toBe("Bearer sm_server");
      }
      expect(request.headers.get("x-opentag-service-token")).toBeNull();
      return Response.json({ results: [] });
    });
    const workerEnv = env(containerFetch);
    const post = await supermemoryWorker.fetch(new Request("https://supermemory/health", {
      method: "POST",
      headers: { "x-opentag-service-token": "service-token" },
    }), workerEnv);
    expect(post.status).toBe(405);

    const get = await supermemoryWorker.fetch(new Request("https://supermemory/health", {
      headers: { "x-opentag-service-token": "service-token" },
    }), workerEnv);
    expect(get.status).toBe(200);

    const healthRequests = containerFetch.mock.calls
      .map(([request]) => request as Request)
      .filter((request) => new URL(request.url).pathname === "/ready" || new URL(request.url).pathname === "/v4/search");
    expect(healthRequests.map((request) => new URL(request.url).pathname)).toEqual(["/ready", "/v4/search"]);

    const forwarded = await supermemoryWorker.fetch(new Request("https://supermemory/v4/search", {
      method: "POST",
      headers: {
        "x-opentag-service-token": "service-token",
        "x-opentag-container-token": "caller-controlled",
      },
      body: "{}",
    }), workerEnv);
    expect(forwarded.status).toBe(200);
    const forwardedRequest = (containerFetch.mock.calls.at(-1) as unknown as [Request])[0];
    expect(forwardedRequest.headers.get("x-opentag-container-token")).toBeNull();
    expect(forwardedRequest.headers.get("content-length")).toBe("2");
    expect(await forwardedRequest.text()).toBe("{}");
  });

  it("fails health closed when the container remains in provisioning", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let containerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        containerStarted = resolve;
      });
      const containerFetch = vi.fn(() => {
        containerStarted();
        return new Promise<Response>(() => {});
      });
      const request = supermemoryWorker.fetch(new Request("https://supermemory/health", {
        headers: { "x-opentag-service-token": "service-token" },
      }), env(containerFetch));
      await started;
      await vi.advanceTimersByTimeAsync(90_001);
      const response = await request;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "degraded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails health closed when the provider search route returns an error", async () => {
    const containerFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/ready") return Response.json({ status: "ok" });
      return Response.json({ error: "provider_failed" }, { status: 500 });
    });
    const response = await supermemoryWorker.fetch(new Request("https://supermemory/health", {
      headers: { "x-opentag-service-token": "service-token" },
    }), env(containerFetch));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "provider_search_failed" });
  });

  it("retries a transient provider disconnect before failing readiness", async () => {
    let searchAttempts = 0;
    const containerFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/ready") return Response.json({ status: "ok" });
      searchAttempts += 1;
      return searchAttempts === 1
        ? new Response("Container suddenly disconnected, try again", { status: 500 })
        : Response.json({ results: [] });
    });
    const response = await supermemoryWorker.fetch(new Request("https://supermemory/health", {
      headers: { "x-opentag-service-token": "service-token" },
    }), env(containerFetch));
    expect(response.status).toBe(200);
    expect(searchAttempts).toBe(2);
  });

  it("retries a transient disconnect for read-only search routes", async () => {
    let searchAttempts = 0;
    const containerFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname !== "/v4/search") return Response.json({ status: "ok" });
      searchAttempts += 1;
      return searchAttempts === 1
        ? new Response("Container suddenly disconnected, try again", { status: 500 })
        : Response.json({ results: [], timing: 1, total: 0 });
    });
    const response = await supermemoryWorker.fetch(new Request("https://supermemory/v4/search", {
      method: "POST",
      headers: {
        "x-opentag-service-token": "service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ q: "fixture", limit: 1 }),
    }), env(containerFetch));
    expect(response.status).toBe(200);
    expect(searchAttempts).toBe(2);
  });

  it("routes Sandbox fetches to the application port", async () => {
    const container = new SupermemoryContainer({} as never, {} as never);
    const containerFetch = vi.fn(async () => Response.json({ ok: true }));
    container.containerFetch = containerFetch;
    expect(container.pingEndpoint).toBe("localhost/ready");
    await container.fetch(new Request("https://supermemory/v3/openapi"));
    expect(containerFetch).toHaveBeenCalledWith(expect.any(Request), 6767);
  });

  it("delegates storage readiness to the Container entrypoint and port gate", async () => {
    const container = new SupermemoryContainer({} as never, {} as never);
    await container.onStart();
    const mountBucket = (container as unknown as { mountBucket: ReturnType<typeof vi.fn> }).mountBucket;
    expect(mountBucket).not.toHaveBeenCalled();
    const exec = (container as unknown as { exec: ReturnType<typeof vi.fn> }).exec;
    expect(exec).not.toHaveBeenCalled();
  });
});
