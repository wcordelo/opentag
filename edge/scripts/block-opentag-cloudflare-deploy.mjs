import { execSync } from "node:child_process";
import process from "node:process";

export const OPENTAG_CLOUDFLARE_DEPLOY_MESSAGE =
  "Cloudflare deploys are disabled in wcordelo/opentag; deploy from the private downstream deployment repo (berendo-labs/cosmos). See docs/operations.md";

/** True when this checkout is the public upstream opentag repo. */
export function isOpentagUpstreamRepo() {
  if (process.env.GITHUB_REPOSITORY === "wcordelo/opentag") return true;
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
