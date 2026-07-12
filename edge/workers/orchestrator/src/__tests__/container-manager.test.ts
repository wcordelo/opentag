/**
 * Unit tests for ContainerManager. The Sandbox SDK and storage adapter are
 * both mocked — no real container or Durable Object is involved.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ContainerManager,
  ContainerStartTimeoutError,
  type AgentContainerRecord,
  type AgentContainerStatus,
  type ContainerStorage,
  type SandboxLike,
} from "../ContainerManager";

function makeStorage(): ContainerStorage & {
  records: Map<string, AgentContainerRecord>;
} {
  const records = new Map<string, AgentContainerRecord>();
  return {
    records,
    async createAgentContainer(record) {
      records.set(record.containerId, { ...record });
    },
    async updateAgentContainerStatus(
      containerId: string,
      status: AgentContainerStatus,
      fields?: { previewUrl?: string },
    ) {
      const existing = records.get(containerId);
      if (!existing) {
        throw new Error(`no such container: ${containerId}`);
      }
      existing.status = status;
      if (fields?.previewUrl !== undefined) existing.previewUrl = fields.previewUrl;
    },
    async getAgentContainer(containerId: string) {
      return records.get(containerId) ?? null;
    },
  };
}

function makeSandbox(overrides: Partial<SandboxLike> = {}): SandboxLike {
  return {
    setEnvVars: vi.fn(async () => {}),
    exposePort: vi.fn(async () => ({ url: "https://preview.example.com" })),
    destroy: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ContainerManager.start", () => {
  it("fires onColdStartAck before the sandbox is ever touched", async () => {
    const order: string[] = [];
    const storage = makeStorage();
    const sandbox = makeSandbox();
    const getSandbox = vi.fn((_sessionId: string): SandboxLike => {
      order.push("getSandbox");
      return sandbox;
    });
    const onColdStartAck = vi.fn(async (_sessionId: string, _flavor: string) => {
      order.push("ack");
    });

    const manager = new ContainerManager(storage, getSandbox, {
      hostname: "sandbox.test",
      onColdStartAck,
    });

    await manager.start("session-1", "impl");

    expect(order).toEqual(["ack", "getSandbox"]);
    expect(onColdStartAck).toHaveBeenCalledWith("session-1", "impl");
  });

  it("records metadata through the full start lifecycle", async () => {
    const storage = makeStorage();
    const sandbox = makeSandbox();
    const getSandbox = vi.fn((): SandboxLike => sandbox);

    const manager = new ContainerManager(storage, getSandbox, {
      hostname: "sandbox.test",
      egressProxyUrl: "https://egress.test",
    });

    const handle = await manager.start("session-2", "pm");

    expect(handle.previewUrl).toBe("https://preview.example.com");
    expect(sandbox.exposePort).toHaveBeenCalledWith(8080, {
      hostname: "sandbox.test",
    });

    const envArg = (sandbox.setEnvVars as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, string>;
    expect(envArg.AGENT_FLAVOR).toBe("pm");
    expect(envArg.EGRESS_PROXY_URL).toBe("https://egress.test");
    expect(envArg.HTTP_PROXY).toBe("https://egress.test");
    expect(envArg.HTTPS_PROXY).toBe("https://egress.test");
    const token = envArg.AGENT_TOKEN;
    expect(token).toEqual(expect.any(String));
    expect(token!.length).toBeGreaterThan(0);
    // Containers hold no API keys (DECISIONS.md §2).
    expect(envArg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envArg.OPENAI_API_KEY).toBeUndefined();

    const record = await storage.getAgentContainer(handle.containerId);
    expect(record?.status).toBe("running");
    expect(record?.previewUrl).toBe("https://preview.example.com");
    expect(record?.sessionId).toBe("session-2");
    expect(record?.flavor).toBe("pm");
    expect(record?.startedAt).toBeTruthy();
  });

  it("creates the container record with status=starting before provisioning", async () => {
    const storage = makeStorage();
    const statusesSeenByGetSandbox: (AgentContainerStatus | undefined)[] = [];
    const sandbox = makeSandbox();
    const getSandbox = vi.fn((sessionId: string): SandboxLike => {
      const existing = [...storage.records.values()].find(
        (r) => r.sessionId === sessionId,
      );
      statusesSeenByGetSandbox.push(existing?.status);
      return sandbox;
    });

    const manager = new ContainerManager(storage, getSandbox);
    await manager.start("session-3", "verify");

    expect(statusesSeenByGetSandbox).toEqual(["starting"]);
  });

  it("throws ContainerStartTimeoutError when the sandbox never comes up", async () => {
    const storage = makeStorage();
    const hangingSandbox = makeSandbox({
      setEnvVars: () => new Promise<void>(() => {}),
    });
    const getSandbox = vi.fn((): SandboxLike => hangingSandbox);

    const manager = new ContainerManager(storage, getSandbox, {
      startTimeoutMs: 20,
    });

    await expect(manager.start("session-4", "verify")).rejects.toBeInstanceOf(
      ContainerStartTimeoutError,
    );
  });

  it("marks the record as timeout status after a timed-out start", async () => {
    const storage = makeStorage();
    const hangingSandbox = makeSandbox({
      setEnvVars: () => new Promise<void>(() => {}),
    });
    const getSandbox = vi.fn((): SandboxLike => hangingSandbox);

    const manager = new ContainerManager(storage, getSandbox, {
      startTimeoutMs: 20,
    });

    await expect(manager.start("session-5", "pm")).rejects.toThrow();

    const records = [...storage.records.values()];
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("timeout");
  });
});

describe("ContainerManager.kill", () => {
  it("calls destroy() and marks the container terminated", async () => {
    const storage = makeStorage();
    const sandbox = makeSandbox();
    const getSandbox = vi.fn((): SandboxLike => sandbox);
    const manager = new ContainerManager(storage, getSandbox);

    const handle = await manager.start("session-6", "impl");
    await manager.kill(handle.containerId);

    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    const record = await storage.getAgentContainer(handle.containerId);
    expect(record?.status).toBe("terminated");
  });

  it("falls back to kill() when destroy() is unavailable", async () => {
    const storage = makeStorage();
    const killFn = vi.fn(async () => {});
    const sandbox = makeSandbox({ destroy: undefined, kill: killFn });
    const manager = new ContainerManager(storage, () => sandbox);

    const handle = await manager.start("session-7", "impl");
    await manager.kill(handle.containerId);

    expect(killFn).toHaveBeenCalledTimes(1);
  });

  it("throws for an unknown container id", async () => {
    const storage = makeStorage();
    const manager = new ContainerManager(storage, () => makeSandbox());
    await expect(manager.kill("does-not-exist")).rejects.toThrow();
  });
});

describe("ContainerManager.getPreviewUrl", () => {
  it("returns the stored preview URL", async () => {
    const storage = makeStorage();
    const sandbox = makeSandbox();
    const manager = new ContainerManager(storage, () => sandbox);

    const handle = await manager.start("session-8", "pm");
    await expect(manager.getPreviewUrl(handle.containerId)).resolves.toBe(
      handle.previewUrl,
    );
  });

  it("throws for a container with no recorded preview URL", async () => {
    const storage = makeStorage();
    const manager = new ContainerManager(storage, () => makeSandbox());
    await expect(manager.getPreviewUrl("missing")).rejects.toThrow();
  });
});
