import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const edgeRoot = resolve(import.meta.dirname, "..");
const script = resolve(edgeRoot, "scripts/check-knowledge-rollout.mjs");

describe("knowledge rollout preflight", () => {
  it("reports structural readiness without mutating Cloudflare resources", () => {
    const result = spawnSync("node", [script], {
      cwd: edgeRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[PASS] Supermemory is single-writer");
    expect(result.stdout).toContain("[PASS] Graphify source pin is exact");
    expect(result.stdout).toContain("[PASS] Knowledge Workers scope R2 credentials to Containers");
    expect(result.stdout).toContain("run with --live");
  });

  it("defines live provider instance checks instead of treating deployment as readiness", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('"containers", "instances"');
    expect(source).toContain('"containers", "info"');
    expect(source).toContain("health?.instances");
    expect(source).toContain("Supermemory query instance is registered");
    expect(source).toContain("Graphify query instance is registered");
    expect(source).toContain("Supermemory health probe exposes provider readiness");
    expect(source).toContain("requireHealthyInstances");
    expect(source).toContain("healthy >= 1 && failed === 0");
    expect(source).not.toContain("active >= 1 && healthy >= 1 && failed === 0");
  });
});
