/**
 * Block Cloudflare deploy scripts in the public upstream opentag repo.
 *
 * Repo detection:
 * - When GITHUB_REPOSITORY is set, only `wcordelo/opentag` is treated as upstream
 *   (block). Any other value is downstream/CI-fork context (do not block; git is
 *   not consulted).
 * - When GITHUB_REPOSITORY is unset, fall back to `git remote.origin.url` matching
 *   wcordelo/opentag.
 * - When git remote lookup fails, fail closed (treat as upstream).
 */
import { execSync } from "node:child_process";
import process from "node:process";

export const OPENTAG_CLOUDFLARE_DEPLOY_MESSAGE =
  "Cloudflare deploys are disabled in wcordelo/opentag; deploy from the private downstream deployment repo (berendo-labs/cosmos). See docs/operations.md";

const UPSTREAM_GITHUB_REPOSITORY = "wcordelo/opentag";

/** True when this checkout is the public upstream opentag repo. */
export function isOpentagUpstreamRepo() {
  const githubRepository = process.env.GITHUB_REPOSITORY?.trim();
  if (githubRepository) {
    return githubRepository === UPSTREAM_GITHUB_REPOSITORY;
  }
  try {
    const url = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /wcordelo\/opentag/i.test(url);
  } catch {
    return true;
  }
}

/** Exit non-zero before any Cloudflare deploy from the upstream opentag repo. */
export function blockOpentagCloudflareDeploy() {
  if (!isOpentagUpstreamRepo()) return;
  process.stderr.write(`${OPENTAG_CLOUDFLARE_DEPLOY_MESSAGE}\n`);
  process.exit(1);
}
