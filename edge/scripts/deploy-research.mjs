import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blockOpentagCloudflareDeploy } from "./block-opentag-cloudflare-deploy.mjs";

const edgeRoot = fileURLToPath(new URL("..", import.meta.url));

blockOpentagCloudflareDeploy();

const build = spawnSync("npm", ["run", "build:wasm"], {
  cwd: edgeRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const deploy = spawnSync(
  "node",
  ["scripts/guarded-wrangler-deploy.mjs", "--config", "wrangler.research.toml"],
  { cwd: edgeRoot, stdio: "inherit" },
);
process.exit(deploy.status ?? 1);
