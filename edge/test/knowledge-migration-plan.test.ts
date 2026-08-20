import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const edgeRoot = resolve(import.meta.dirname, "..");
const script = resolve(edgeRoot, "scripts/knowledge-migration-plan.mjs");

describe("knowledge migration dry-run", () => {
  it("prints the ordered freeze and parity gates without mutating external state", () => {
    const result = spawnSync("node", [script], { cwd: edgeRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npx wrangler queues pause-delivery opentag-knowledge");
    expect(result.stdout).toContain("SUPERMEMORY_CONSUMER_MODE=paused");
    expect(result.stdout).toContain("SUPERMEMORY_INDEX_GENERATION");
    expect(result.stdout).toContain("npx wrangler queues resume-delivery opentag-knowledge");
    expect(result.stdout).toContain("Static implementation preflight:");
    expect(result.stdout).not.toContain("wrangler deploy");
  });

  it("rejects live or mutating options", () => {
    const result = spawnSync("node", [script, "--live"], { cwd: edgeRoot, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("refuses deployment, cutover, shutdown, deletion, and secret mutations");
  });
});
