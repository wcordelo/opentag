import { describe, expect, it } from "vitest";
import { DEFAULT_BUNDLE } from "../src/config/access-bundle.js";
import {
  bindPermissionSnapshot,
  copyPermissionSnapshot,
  requirePermissionSnapshot,
  resetPermissionSnapshots,
} from "../src/permissions/context.js";
import { buildPermissionSnapshot } from "../src/permissions/snapshot.js";

const config = {
  teamId: "T1",
  channelId: "C1",
  systemPrompt: "sys",
  policies: { allowMemoryWrite: false, allowTasks: false },
  accessBundleId: "restricted",
  updatedAt: "now",
};

describe("permission snapshots", () => {
  it("is deterministic, bounded, and removes URL credentials/query/fragment", () => {
    const args = {
      teamId: "T1",
      channelId: "C1",
      actor: { kind: "slack_user" as const, userId: "U1" },
      config,
      bundle: {
        ...DEFAULT_BUNDLE,
        id: "restricted",
        mcpEndpoints: [
          "https://user:pass@example.com/tools?token=secret#fragment",
          "http://insecure.example/path",
        ],
        secretRefs: ["Z_SECRET", "A_SECRET", "A_SECRET"],
      },
      allToolNames: ["memory_write", "show_status", "start_task"],
      allowedTools: ["show_status"],
      runtime: {
        harnessConnected: true,
        harnessSource: "deployment" as const,
        modelSource: "deployment" as const,
      },
      generatedAt: "2026-01-01T00:00:00.000Z",
    };
    const first = buildPermissionSnapshot(args);
    expect(buildPermissionSnapshot(args)).toEqual(first);
    expect(first.channelAccess).toMatchObject({
      allowedTools: ["show_status"],
      deniedTools: ["memory_write", "start_task"],
      secretRefs: ["A_SECRET", "Z_SECRET"],
      mcpEndpoints: [
        { origin: "[invalid]", path: "" },
        { origin: "https://example.com", path: "/tools" },
      ],
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("fragment");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.channelAccess.allowedTools)).toBe(true);
  });

  it("applies the automation safe ceiling and hides integration metadata", () => {
    const snapshot = buildPermissionSnapshot({
      teamId: "T1",
      channelId: "C1",
      actor: { kind: "slack_automation", botId: "B1" },
      config,
      bundle: DEFAULT_BUNDLE,
      allToolNames: [
        "show_status",
        "show_permissions",
        "memory_write",
        "start_task",
        "new_future_write_tool",
      ],
      allowedTools: [
        "show_status",
        "show_permissions",
        "memory_write",
        "start_task",
        "new_future_write_tool",
      ],
      runtime: { harnessConnected: false },
    });
    expect(snapshot.channelAccess.allowedTools).toEqual([
      "show_permissions",
      "show_status",
    ]);
    expect(snapshot.channelAccess.deniedTools).toEqual([
      "memory_write",
      "new_future_write_tool",
      "start_task",
    ]);
    expect(snapshot.channelAccess.metadataVisibility).toBe("restricted");
    expect(snapshot.channelAccess.mcpEndpoints).toEqual([]);
    expect(snapshot.channelAccess.secretRefs).toEqual([]);
  });

  it("keeps concurrent invocation bindings isolated", async () => {
    resetPermissionSnapshots();
    const a = {};
    const b = {};
    const threadA = {};
    const threadB = {};
    const make = (channelId: string) =>
      buildPermissionSnapshot({
        teamId: "T",
        channelId,
        actor: { kind: "slack_user", userId: "U" },
        config: { ...config, channelId },
        bundle: DEFAULT_BUNDLE,
        allToolNames: ["show_status"],
        allowedTools: ["show_status"],
        runtime: { harnessConnected: false },
      });
    bindPermissionSnapshot(a, make("C-A"));
    bindPermissionSnapshot(b, make("C-B"));
    copyPermissionSnapshot(a, threadA);
    copyPermissionSnapshot(b, threadB);
    await Promise.resolve();
    expect(requirePermissionSnapshot(threadA).scope.channelId).toBe("C-A");
    expect(requirePermissionSnapshot(threadB).scope.channelId).toBe("C-B");
  });
});
