import { spawnSync } from "node:child_process";
import process from "node:process";
<<<<<<< HEAD
import { pathToFileURL } from "node:url";
=======
>>>>>>> origin/cursor/jev-rerank-mode-wrangler-var-5cd2
import { blockOpentagCloudflareDeploy } from "./block-opentag-cloudflare-deploy.mjs";
import { buildWranglerArgv } from "./wrangler-deploy-args.mjs";

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  blockOpentagCloudflareDeploy();

<<<<<<< HEAD
  const result = spawnSync("npx", ["wrangler", ...buildWranglerArgv(process.argv.slice(2))], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
=======
const result = spawnSync("npx", ["wrangler", "deploy", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(result.status ?? 1);
>>>>>>> origin/cursor/jev-rerank-mode-wrangler-var-5cd2
