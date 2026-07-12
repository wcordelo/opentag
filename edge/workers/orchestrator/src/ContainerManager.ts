/**
 * ContainerManager — Sandbox SDK container lifecycle for agent flavors
 * (pm/impl/verify). See DECISIONS.md §2 (application-level egress proxy;
 * containers hold no API keys) and opentag-2.0-impl-spec.md Task 3.2.
 *
 * Storage and the Sandbox factory are both injected (duck-typed) so this
 * class has zero import-time dependency on `lib/research/adapters/storage-do`
 * or `@cloudflare/sandbox` — callers wire the real implementations, tests
 * inject mocks.
 */

export type AgentFlavor = "pm" | "impl" | "verify";

export interface ContainerHandle {
  containerId: string;
  previewUrl: string;
}

/**
 * Minimal surface of `@cloudflare/sandbox`'s `Sandbox` DO stub that
 * ContainerManager depends on. The real stub has many more RPC methods —
 * this interface only names what's used here.
 */
export interface SandboxLike {
  setEnvVars(env: Record<string, string>): Promise<void>;
  exposePort(
    port: number,
    opts: { hostname: string },
  ): Promise<{ url: string }>;
  /** Either method may exist depending on Sandbox SDK version; both optional. */
  destroy?(): Promise<void>;
  kill?(): Promise<void>;
}

export class ContainerStartTimeoutError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Container for session "${sessionId}" did not start within ${timeoutMs}ms`,
    );
    this.name = "ContainerStartTimeoutError";
  }
}

export type AgentContainerStatus =
  | "starting"
  | "running"
  | "terminated"
  | "timeout"
  | "zombie";

export interface AgentContainerRecord {
  containerId: string;
  sessionId: string;
  flavor: AgentFlavor;
  status: AgentContainerStatus;
  previewUrl?: string;
  startedAt?: string;
  killedAt?: string;
}

/**
 * Duck-typed storage dependency. Mirrors the `agent_containers` methods
 * `opentag-2.0-impl-spec.md` Task 7.3 adds to `DurableObjectStorageAdapter`
 * (`createAgentContainer` / `getAgentContainer` / `updateAgentContainerStatus`),
 * named as a local interface so this file doesn't need to import that
 * adapter (or exist before Task 7.3 lands).
 */
export interface ContainerStorage {
  createAgentContainer(record: AgentContainerRecord): Promise<void>;
  updateAgentContainerStatus(
    containerId: string,
    status: AgentContainerStatus,
    fields?: { previewUrl?: string; startedAt?: string; killedAt?: string },
  ): Promise<void>;
  getAgentContainer(containerId: string): Promise<AgentContainerRecord | null>;
}

export interface ContainerManagerOptions {
  /** Hostname used to construct the Sandbox SDK's preview URL. */
  hostname?: string;
  /** Overall cold-start budget before `start()` throws. Default 240_000ms (4min). */
  startTimeoutMs?: number;
  /**
   * Fired immediately when `start()` is called, before the sandbox is ever
   * touched — lets callers post an interim "🔄 Agent starting up…" Slack
   * message without waiting on the 2-3min container cold start.
   */
  onColdStartAck?: (sessionId: string, flavor: AgentFlavor) => Promise<void>;
  /** Egress proxy base URL injected into the container's env (DECISIONS.md §2). */
  egressProxyUrl?: string;
  /** KV cache for active AGENT_TOKEN values (DECISIONS.md §2). */
  agentStateKv?: KVNamespace;
  /** Workspace team id — required when agentStateKv is set. */
  teamId?: string;
}

const DEFAULT_START_TIMEOUT_MS = 240_000;
const DEFAULT_HOSTNAME = "sandbox.opentag.dev";
const AGENT_PORT = 8080;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class ContainerManager {
  constructor(
    private readonly storage: ContainerStorage,
    private readonly getSandbox: (sessionId: string) => SandboxLike,
    private readonly options: ContainerManagerOptions = {},
  ) {}

  /**
   * Starts a container for `sessionId`. Order (per impl-spec Task 3.2):
   * 1. Cold-start ack (before awaiting the sandbox at all).
   * 2. Create the `agent_containers` row, status=starting.
   * 3. getSandbox() + setEnvVars (AGENT_FLAVOR, EGRESS_PROXY_URL, AGENT_TOKEN,
   *    HTTP_PROXY/HTTPS_PROXY) — no API keys, per DECISIONS.md §2.
   * 4. exposePort(8080) — update the row to running with the preview URL.
   */
  async start(
    sessionId: string,
    flavor: AgentFlavor,
  ): Promise<ContainerHandle> {
    if (this.options.onColdStartAck) {
      await this.options.onColdStartAck(sessionId, flavor);
    }

    const containerId = crypto.randomUUID();
    await this.storage.createAgentContainer({
      containerId,
      sessionId,
      flavor,
      status: "starting",
      startedAt: new Date().toISOString(),
    });

    const hostname = this.options.hostname ?? DEFAULT_HOSTNAME;
    const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const egressProxyUrl = this.options.egressProxyUrl ?? "";

    try {
      const previewUrl = await withTimeout(
        this.provision(sessionId, flavor, hostname, egressProxyUrl, containerId),
        startTimeoutMs,
        () => new ContainerStartTimeoutError(sessionId, startTimeoutMs),
      );

      await this.storage.updateAgentContainerStatus(containerId, "running", {
        previewUrl,
      });
      return { containerId, previewUrl };
    } catch (err) {
      if (err instanceof ContainerStartTimeoutError) {
        await this.storage
          .updateAgentContainerStatus(containerId, "timeout")
          .catch(() => {
            // Best-effort — surfacing the timeout error matters more than
            // the status write succeeding.
          });
      }
      throw err;
    }
  }

  private async provision(
    sessionId: string,
    flavor: AgentFlavor,
    hostname: string,
    egressProxyUrl: string,
    containerId: string,
  ): Promise<string> {
    const sandbox = this.getSandbox(sessionId);
    const agentToken = crypto.randomUUID();

    await sandbox.setEnvVars({
      AGENT_FLAVOR: flavor,
      EGRESS_PROXY_URL: egressProxyUrl,
      AGENT_TOKEN: agentToken,
      HTTP_PROXY: egressProxyUrl,
      HTTPS_PROXY: egressProxyUrl,
    });

    if (this.options.agentStateKv && this.options.teamId) {
      await this.options.agentStateKv.put(
        `agent_token:${agentToken}`,
        JSON.stringify({
          teamId: this.options.teamId,
          containerId,
          sessionId,
        }),
        { expirationTtl: 86_400 },
      );
      await this.options.agentStateKv.put(`container_token:${containerId}`, agentToken, {
        expirationTtl: 86_400,
      });
    }

    const { url } = await sandbox.exposePort(AGENT_PORT, { hostname });
    return url;
  }

  /** Terminates a container and marks it `terminated` in storage. */
  async kill(containerId: string): Promise<void> {
    const record = await this.storage.getAgentContainer(containerId);
    if (!record) {
      throw new Error(`Unknown container "${containerId}"`);
    }

    const sandbox = this.getSandbox(record.sessionId);
    if (sandbox.destroy) {
      await sandbox.destroy();
    } else if (sandbox.kill) {
      await sandbox.kill();
    }

    await this.storage.updateAgentContainerStatus(containerId, "terminated");

    if (this.options.agentStateKv) {
      const token = await this.options.agentStateKv.get(`container_token:${containerId}`);
      if (token) {
        await this.options.agentStateKv.delete(`agent_token:${token}`);
        await this.options.agentStateKv.delete(`container_token:${containerId}`);
      }
    }
  }

  /** Returns the stored preview URL for a container, or throws if unknown. */
  async getPreviewUrl(containerId: string): Promise<string> {
    const record = await this.storage.getAgentContainer(containerId);
    if (!record?.previewUrl) {
      throw new Error(`No preview URL recorded for container "${containerId}"`);
    }
    return record.previewUrl;
  }
}
