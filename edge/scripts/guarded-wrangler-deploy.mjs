import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { blockOpentagCloudflareDeploy } from "./block-opentag-cloudflare-deploy.mjs";

blockOpentagCloudflareDeploy();

const edgeRoot = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync("npx", ["wrangler", ...process.argv.slice(2)], {
  cwd: edgeRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
