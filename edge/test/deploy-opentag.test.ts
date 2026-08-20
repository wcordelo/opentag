import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const edgeRoot = resolve(import.meta.dirname, "..");
const script = resolve(edgeRoot, "scripts/deploy-opentag.mjs");

describe("one-click deployment ordering", () => {
  it("requires an immutable knowledge generation on the default path", () => {
    const result = spawnSync("node", [script, "--dry-run"], {
      cwd: edgeRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("OPENTAG_SUPERMEMORY_INDEX_GENERATION");
  });

  it("supports an explicit dependency-assumed dry-run", () => {
    const result = spawnSync("node", [script, "--dry-run", "--skip-knowledge"], {
      cwd: edgeRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /wrangler deploy --config .*workers\/sandbox\/\.wrangler-harness-\d+\.toml/,
    );
    expect(result.stdout).toContain("wrangler deploy --config wrangler.bot.toml");
    expect(result.stdout).not.toContain("workers/supermemory/wrangler.toml");
    expect(result.stdout).not.toContain("workers/graphify/wrangler.toml");
  });

  it("forwards the immutable index generation on a bot-only rollout", () => {
    const result = spawnSync("node", [script, "--dry-run", "--skip-knowledge"], {
      cwd: edgeRoot,
      encoding: "utf8",
      env: { ...process.env, OPENTAG_SUPERMEMORY_INDEX_GENERATION: "cloudflare-r2-v1" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--var SUPERMEMORY_INDEX_GENERATION:cloudflare-r2-v1");
  });

  it("contains a clean-harness provenance gate before deployment", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("harness deployment inputs are dirty");
    expect(source).toContain("if (!dryRun && !noDeploy) assertHarnessProvenanceDeployable");
  });

  it("provisions the Supermemory R2 pair through the one-click secret path", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain(
      '{ config: supermemoryConfig, name: "R2_ACCESS_KEY_ID", env: "OPENTAG_SECRET_SUPERMEMORY_R2_ACCESS_KEY_ID" }',
    );
    expect(source).toContain(
      '{ config: supermemoryConfig, name: "R2_SECRET_ACCESS_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_R2_SECRET_ACCESS_KEY" }',
    );
  });

  it("detects the installed Docker Desktop binary for Wrangler", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("WRANGLER_DOCKER_BIN");
    expect(source).toContain("/Applications/Docker.app/Contents/Resources/bin/docker");
  });

  it("allows the documented Claude OAuth credential to replace an Anthropic API key", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain(
      '{ config: harnessConfig, name: "CLAUDE_CODE_OAUTH_TOKEN", env: "OPENTAG_SECRET_CLAUDE_CODE_OAUTH_TOKEN" }',
    );
    expect(source).toContain(
      '{ config: harnessConfig, name: "GITHUB_TOKEN", env: "OPENTAG_SECRET_GITHUB_TOKEN" }',
    );
    expect(source).toContain("const optionalHarnessSecretSpecs");
    expect(source).not.toContain(
      '{ config: harnessConfig, name: "ANTHROPIC_API_KEY", env: "OPENTAG_SECRET_ANTHROPIC_API_KEY" },\n  { config: harnessConfig, name: "GITHUB_TOKEN"',
    );
  });
});
