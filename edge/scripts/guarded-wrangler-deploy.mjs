import { spawnSync } from "node:child_process";
import process from "node:process";
import { blockOpentagCloudflareDeploy } from "./block-opentag-cloudflare-deploy.mjs";

blockOpentagCloudflareDeploy();

const result = spawnSync("npx", ["wrangler", "deploy", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(result.status ?? 1);
