import { spawnSync } from "node:child_process";
import process from "node:process";

const root = new URL("..", import.meta.url).pathname;
const botConfig = "wrangler.bot.toml";
const harnessConfig = "workers/sandbox/wrangler.toml";

const secretSpecs = [
  { config: botConfig, name: "SLACK_BOT_TOKEN", env: "OPENTAG_SECRET_SLACK_BOT_TOKEN" },
  { config: botConfig, name: "SLACK_SIGNING_SECRET", env: "OPENTAG_SECRET_SLACK_SIGNING_SECRET" },
  { config: botConfig, name: "AGENT_URL", env: "OPENTAG_SECRET_AGENT_URL" },
  { config: botConfig, name: "ADMIN_SECRET", env: "OPENTAG_SECRET_ADMIN_SECRET" },
  { config: botConfig, name: "INTERNAL_SECRET", env: "OPENTAG_SECRET_INTERNAL_SECRET" },
  { config: botConfig, name: "HARNESS_AUTH_TOKEN", env: "OPENTAG_SECRET_HARNESS_AUTH_TOKEN" },
  { config: botConfig, name: "KNOWLEDGE_ACTOR_TOKEN_SECRET", env: "OPENTAG_SECRET_KNOWLEDGE_ACTOR_TOKEN_SECRET" },
  { config: botConfig, name: "SUPERMEMORY_API_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_API_KEY" },
  { config: harnessConfig, name: "HARNESS_AUTH_TOKEN", env: "OPENTAG_SECRET_HARNESS_AUTH_TOKEN" },
  { config: harnessConfig, name: "OPENAI_API_KEY", env: "OPENTAG_SECRET_OPENAI_API_KEY" },
  { config: harnessConfig, name: "ANTHROPIC_API_KEY", env: "OPENTAG_SECRET_ANTHROPIC_API_KEY" },
  { config: harnessConfig, name: "GITHUB_TOKEN", env: "OPENTAG_SECRET_GITHUB_TOKEN" },
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noDeploy = args.has("--no-deploy");
const requireSecrets = args.has("--require-secrets");
const supermemoryUrl = process.env.OPENTAG_VAR_SUPERMEMORY_URL?.trim();

if (requireSecrets && !supermemoryUrl) throw new Error("missing OPENTAG_VAR_SUPERMEMORY_URL");

function runWrangler(wranglerArgs, input) {
  if (dryRun) {
    process.stdout.write(`wrangler ${wranglerArgs.join(" ")}\n`);
    return;
  }
  const result = spawnSync("npx", ["wrangler", ...wranglerArgs], {
    cwd: root,
    input,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const spec of secretSpecs) {
  const value = process.env[spec.env];
  if (!value) {
    if (requireSecrets) throw new Error(`missing ${spec.env}`);
    continue;
  }
  runWrangler(["secret", "put", spec.name, "--config", spec.config], `${value}\n`);
}

if (noDeploy) process.exit(0);
runWrangler(["deploy", "--config", harnessConfig]);
const botDeployArgs = ["deploy", "--config", botConfig];
if (supermemoryUrl) botDeployArgs.push("--var", `SUPERMEMORY_URL:${supermemoryUrl}`);
runWrangler(botDeployArgs);
