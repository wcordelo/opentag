import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const edgeRoot = resolve(import.meta.dirname, "..");
const script = resolve(edgeRoot, "scripts/deploy-knowledge-service.mjs");

describe("knowledge service deployment guard", () => {
  it.each(["supermemory", "graphify"]) (
    "accepts %s deployment dry-run with the configured account",
    (service) => {
      const result = spawnSync("node", [script, service, "--dry-run"], {
        cwd: edgeRoot,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`wrangler deploy --config workers/${service}/wrangler.toml`);
    },
  );

  it("retains the placeholder-account guard in the deployment script", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("replace-with-account-id");
    expect(source).toContain("approved 32-character R2 account ID");
  });

  it("refuses a real deploy from mixed staged and working-tree inputs", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('status === "??" || (status[0] !== " " && status[1] !== " ")');
    expect(source).toContain("deployment inputs have staged and unstaged or untracked changes");
  });

  it("rejects an unknown service before reading deployment configuration", () => {
    const result = spawnSync("node", [script, "unknown", "--dry-run"], {
      cwd: edgeRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("supermemory|graphify");
  });
});
