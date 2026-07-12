/**
 * Unit tests for PreviewUrlManager. `fetch` is injected via `fetchImpl` so
 * no real network call is made.
 */
import { describe, expect, it, vi } from "vitest";
import { ContainerZombieError, PreviewUrlManager } from "../PreviewUrlManager";

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

function failResponse(): Response {
  return new Response(null, { status: 502 });
}

describe("PreviewUrlManager.getValidUrl", () => {
  it("returns the stored URL when it responds healthy", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        okResponse(),
    );
    const getStoredUrl = vi.fn(async () => "https://healthy.example.com");
    const refreshUrl = vi.fn(async () => "https://should-not-be-used.com");
    const markZombie = vi.fn(async () => {});

    const manager = new PreviewUrlManager({
      getStoredUrl,
      refreshUrl,
      markZombie,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const url = await manager.getValidUrl("container-1");

    expect(url).toBe("https://healthy.example.com");
    expect(refreshUrl).not.toHaveBeenCalled();
    expect(markZombie).not.toHaveBeenCalled();
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://healthy.example.com");
    expect(call[1]?.method).toBe("HEAD");
  });

  it("re-negotiates and returns the refreshed URL when the stored one is dead", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      return target === "https://dead.example.com" ? failResponse() : okResponse();
    });
    const getStoredUrl = vi.fn(async () => "https://dead.example.com");
    const refreshUrl = vi.fn(async () => "https://refreshed.example.com");
    const markZombie = vi.fn(async () => {});

    const manager = new PreviewUrlManager({
      getStoredUrl,
      refreshUrl,
      markZombie,
      fetchImpl,
    });

    const url = await manager.getValidUrl("container-2");

    expect(url).toBe("https://refreshed.example.com");
    expect(refreshUrl).toHaveBeenCalledWith("container-2");
    expect(markZombie).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks the container zombie and throws when refresh also fails", async () => {
    const fetchImpl = vi.fn(async () => failResponse());
    const getStoredUrl = vi.fn(async () => "https://dead.example.com");
    const refreshUrl = vi.fn(async () => "https://also-dead.example.com");
    const markZombie = vi.fn(async () => {});

    const manager = new PreviewUrlManager({
      getStoredUrl,
      refreshUrl,
      markZombie,
      fetchImpl,
    });

    await expect(manager.getValidUrl("container-3")).rejects.toBeInstanceOf(
      ContainerZombieError,
    );
    expect(markZombie).toHaveBeenCalledWith(
      "container-3",
      "https://also-dead.example.com",
    );
  });

  it("still marks zombie (using the stale stored URL) when refresh itself returns null", async () => {
    const fetchImpl = vi.fn(async () => failResponse());
    const getStoredUrl = vi.fn(async () => "https://dead.example.com");
    const refreshUrl = vi.fn(async () => null);
    const markZombie = vi.fn(async () => {});

    const manager = new PreviewUrlManager({
      getStoredUrl,
      refreshUrl,
      markZombie,
      fetchImpl,
    });

    const err = await manager
      .getValidUrl("container-4")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContainerZombieError);
    expect((err as ContainerZombieError).containerId).toBe("container-4");
    expect((err as ContainerZombieError).lastKnownUrl).toBe(
      "https://dead.example.com",
    );
    expect(markZombie).toHaveBeenCalledWith(
      "container-4",
      "https://dead.example.com",
    );
  });

  it("treats a thrown fetch (e.g. abort timeout) the same as a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("aborted");
    });
    const getStoredUrl = vi.fn(async () => null);
    const refreshUrl = vi.fn(async () => "https://refreshed.example.com");
    const markZombie = vi.fn(async () => {});

    const manager = new PreviewUrlManager({
      getStoredUrl,
      refreshUrl,
      markZombie,
      fetchImpl,
    });

    await expect(manager.getValidUrl("container-5")).rejects.toBeInstanceOf(
      ContainerZombieError,
    );
    expect(refreshUrl).toHaveBeenCalledWith("container-5");
  });
});
