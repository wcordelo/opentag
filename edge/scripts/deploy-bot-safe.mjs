import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { blockOpentagCloudflareDeploy } from "./block-opentag-cloudflare-deploy.mjs";

blockOpentagCloudflareDeploy();

const generation = process.env.OPENTAG_SUPERMEMORY_INDEX_GENERATION?.trim();
if (!generation || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generation) || generation === "legacy") {
  process.stderr.write("OPENTAG_SUPERMEMORY_INDEX_GENERATION must be a non-legacy immutable generation id\n");
  process.exit(1);
}

const edgeRoot = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync(
  "npx",
  ["wrangler", "deploy", "--config", "wrangler.bot.toml", "--var", `SUPERMEMORY_INDEX_GENERATION:${generation}`],
  { cwd: edgeRoot, stdio: "inherit" },
);
process.exit(result.status ?? 1);
