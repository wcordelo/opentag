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
  it("returns false when GITHUB_REPOSITORY is example-org/downstream-deploy", () => {
    expect(isOpentagUpstreamRepo({
      ...process.env,
      GITHUB_REPOSITORY: "example-org/downstream-deploy",
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

function buildWranglerArgv(argv: string[]): string[] {
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { buildWranglerArgv } from './scripts/wrangler-deploy-args.mjs'; process.stdout.write(JSON.stringify(buildWranglerArgv(JSON.parse(process.argv[1]))));",
      JSON.stringify(argv),
    ],
    {
      cwd: edgeRoot,
      encoding: "utf8",
    },
  );
  return JSON.parse(stdout) as string[];
}

describe("buildWranglerArgv", () => {
  it("prepends deploy when only config flags are passed", () => {
    expect(buildWranglerArgv(["--config", "wrangler.toml"])).toEqual([
      "deploy",
      "--config",
      "wrangler.toml",
    ]);
  });

  it("leaves an explicit deploy subcommand unchanged", () => {
    expect(buildWranglerArgv(["deploy", "--config", "wrangler.bot.toml"])).toEqual([
      "deploy",
      "--config",
      "wrangler.bot.toml",
    ]);
  });

  it("prepends deploy for an empty argv list", () => {
    expect(buildWranglerArgv([])).toEqual(["deploy"]);
  });
});
