/**
 * PreviewUrlManager — validates and re-negotiates Sandbox SDK preview URLs.
 * See opentag-2.0-impl-spec.md Task 3.3.
 *
 * Preview URLs do not survive a container restart, so every inter-container
 * call must go through `getValidUrl()` rather than trusting a cached URL
 * forever. Dependencies are injected so this file has no import-time
 * coupling to `DurableObjectStorageAdapter` or the Sandbox SDK.
 */

export class ContainerZombieError extends Error {
  constructor(
    public readonly containerId: string,
    public readonly lastKnownUrl?: string,
  ) {
    super(
      `Container "${containerId}" is a zombie (last known URL: ${
        lastKnownUrl ?? "none"
      })`,
    );
    this.name = "ContainerZombieError";
  }
}

const HEAD_TIMEOUT_MS = 5_000;

export interface PreviewUrlManagerDeps {
  /** Reads the currently stored preview URL for a container, if any. */
  getStoredUrl: (containerId: string) => Promise<string | null>;
  /**
   * Re-negotiates the preview URL (e.g. via `sandbox.tunnels.get()` /
   * `exposePort()`) and persists it. Returns the new URL, or null if
   * re-negotiation itself failed.
   */
  refreshUrl: (containerId: string) => Promise<string | null>;
  /** Marks the container `zombie` in storage and alerts the orchestrator. */
  markZombie: (containerId: string, lastKnownUrl?: string) => Promise<void>;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class PreviewUrlManager {
  constructor(private readonly deps: PreviewUrlManagerDeps) {}

  /**
   * Returns a verified-alive preview URL for `containerId`, or throws
   * `ContainerZombieError` if neither the stored nor a freshly re-negotiated
   * URL responds.
   */
  async getValidUrl(containerId: string): Promise<string> {
    const storedUrl = await this.deps.getStoredUrl(containerId);

    if (storedUrl && (await this.isAlive(storedUrl))) {
      return storedUrl;
    }

    const refreshedUrl = await this.deps.refreshUrl(containerId);
    if (refreshedUrl && (await this.isAlive(refreshedUrl))) {
      return refreshedUrl;
    }

    const lastKnownUrl = refreshedUrl ?? storedUrl ?? undefined;
    await this.deps.markZombie(containerId, lastKnownUrl);
    throw new ContainerZombieError(containerId, lastKnownUrl);
  }

  private async isAlive(url: string): Promise<boolean> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
