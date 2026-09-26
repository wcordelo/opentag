import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const edgeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const originalGithubRepository = process.env.GITHUB_REPOSITORY;

function isOpentagUpstreamRepo(env: NodeJS.ProcessEnv = process.env): boolean {
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { isOpentagUpstreamRepo } from './scripts/block-opentag-cloudflare-deploy.mjs'; process.stdout.write(String(isOpentagUpstreamRepo()));",
    ],
    {
      cwd: edgeRoot,
      env,
      encoding: "utf8",
    },
  );
  return stdout.trim() === "true";
}

afterEach(() => {
  if (originalGithubRepository === undefined) {
    delete process.env.GITHUB_REPOSITORY;
  } else {
    process.env.GITHUB_REPOSITORY = originalGithubRepository;
  }
});

describe("isOpentagUpstreamRepo", () => {
  it("returns false when GITHUB_REPOSITORY is berendo-labs/cosmos", () => {
    expect(isOpentagUpstreamRepo({
      ...process.env,
      GITHUB_REPOSITORY: "berendo-labs/cosmos",
    })).toBe(false);
  });

  it("returns true when GITHUB_REPOSITORY is wcordelo/opentag", () => {
    expect(isOpentagUpstreamRepo({
      ...process.env,
      GITHUB_REPOSITORY: "wcordelo/opentag",
    })).toBe(true);
  });

  it("returns true when GITHUB_REPOSITORY is unset and origin is opentag", () => {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    expect(isOpentagUpstreamRepo(env)).toBe(true);
  });
});
