import { describe, expect, it } from "vitest";
import { createSupermemoryClientFromEnv } from "../src/memory/supermemory-client.js";

describe("Supermemory private service binding transport", () => {
  it("removes the SDK bearer and sends the OpenTag facade token", async () => {
    const observed: { url?: string; authorization?: string | null; serviceToken?: string | null } = {};
    const binding = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        observed.url = request.url;
        observed.authorization = request.headers.get("authorization");
        observed.serviceToken = request.headers.get("x-opentag-service-token");
        return Response.json({ results: [], timing: 1, total: 0 });
      },
    };
    const client = createSupermemoryClientFromEnv({
      SUPERMEMORY: binding,
      SUPERMEMORY_SERVICE_AUTH_TOKEN: "facade-secret",
    });
    expect(client).toBeDefined();
    await client!.search.memories({ q: "fixture", containerTag: "workspace:T1", limit: 1 });
    expect(observed.url).toBe("https://supermemory.internal/v4/search");
    expect(observed.authorization).toBeNull();
    expect(observed.serviceToken).toBe("facade-secret");
  });

  it("retries a transient disconnect only for read-only service routes", async () => {
    let attempts = 0;
    const binding = {
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("Container suddenly disconnected, try again", { status: 500 })
          : Response.json({ results: [], timing: 1, total: 0 });
      },
    };
    const client = createSupermemoryClientFromEnv({
      SUPERMEMORY: binding,
      SUPERMEMORY_SERVICE_AUTH_TOKEN: "facade-secret",
    });
    await client!.search.memories({ q: "fixture", containerTag: "workspace:T1", limit: 1 });
    expect(attempts).toBe(2);
  });

  it("keeps the legacy URL/key fallback available for migration tests", () => {
    expect(createSupermemoryClientFromEnv({
      SUPERMEMORY_URL: "https://legacy.example",
      SUPERMEMORY_API_KEY: "sm_fixture",
      SUPERMEMORY_MIGRATION_MODE: "true",
    })).toBeDefined();
  });

  it("does not use the legacy URL/key path without explicit migration mode", () => {
    expect(createSupermemoryClientFromEnv({
      SUPERMEMORY_URL: "https://legacy.example",
      SUPERMEMORY_API_KEY: "sm_fixture",
    })).toBeUndefined();
  });

  it("does not silently use a service binding without its facade token", () => {
    expect(createSupermemoryClientFromEnv({
      SUPERMEMORY: { fetch: async () => Response.json({}) },
    })).toBeUndefined();
  });
});
