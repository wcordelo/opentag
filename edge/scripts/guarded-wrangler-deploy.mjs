import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { blockOpentagCloudflareDeploy } from "./block-opentag-cloudflare-deploy.mjs";
import { buildWranglerArgv } from "./wrangler-deploy-args.mjs";

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  blockOpentagCloudflareDeploy();

  const result = spawnSync("npx", ["wrangler", ...buildWranglerArgv(process.argv.slice(2))], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
