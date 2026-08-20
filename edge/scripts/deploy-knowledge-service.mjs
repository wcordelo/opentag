import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const edgeRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(edgeRoot, "..");
const service = process.argv[2];
const supported = new Set(["supermemory", "graphify"]);
const passthrough = process.argv.slice(3);
const dryRun = passthrough.includes("--dry-run");

const deploymentInputPaths = {
  supermemory: [
    "infra/supermemory/Dockerfile",
    "infra/supermemory/entrypoint.sh",
    "infra/supermemory/port-gate.sh",
    "edge/workers/supermemory/src/container-env.ts",
    "edge/workers/supermemory/src/container.ts",
    "edge/workers/supermemory/src/env.ts",
    "edge/workers/supermemory/src/index.ts",
    "edge/workers/supermemory/wrangler.toml",
  ],
  graphify: [
    "edge/workers/graphify/Dockerfile",
    "edge/workers/graphify/start-query.sh",
    "edge/workers/graphify/src/container-env.ts",
    "edge/workers/graphify/src/container.ts",
    "edge/workers/graphify/src/env.ts",
    "edge/workers/graphify/src/index.ts",
    "edge/workers/graphify/src/registry-do.ts",
    "edge/workers/graphify/wrangler.toml",
  ],
};

if (!supported.has(service)) {
  process.stderr.write("usage: deploy-knowledge-service.mjs <supermemory|graphify> [wrangler deploy options]\n");
  process.exit(2);
}

function literal(source, name) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*"((?:\\\\.|[^"])*)"`, "m"));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return undefined;
  }
}

function catalogIsValid(source) {
  const raw = literal(source, "GRAPHIFY_REPOSITORY_CATALOG");
  if (!raw) return false;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const allowedOrgs = new Set(
    (literal(source, "GRAPHIFY_ALLOWED_REPO_ORGS") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const entries = Object.entries(parsed);
  return entries.length > 0 && entries.every(([repoId, value]) => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(repoId) || !value || typeof value !== "object" || Array.isArray(value)) return false;
    const sourceEntry = value;
    const match = typeof sourceEntry.cloneUrl === "string"
      ? /^https:\/\/github\.com\/([^/]+)\/[A-Za-z0-9_.-]{1,100}\.git$/.exec(sourceEntry.cloneUrl)
      : undefined;
    return Boolean(
      match &&
      allowedOrgs.has(match[1].toLowerCase()) &&
      typeof sourceEntry.defaultBranch === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(sourceEntry.defaultBranch) &&
      !sourceEntry.defaultBranch.includes("..") &&
      !sourceEntry.defaultBranch.includes("//") &&
      !sourceEntry.defaultBranch.includes("@{") &&
      !sourceEntry.defaultBranch.endsWith("/"),
    );
  });
}

function accountConfigIsValid(source) {
  // R2_ACCOUNT_ID, when present, must be an approved 32-character R2 account ID.
  if (source.includes('R2_ACCOUNT_ID = "replace-with-account-id"')) return false;
  const accountId = literal(source, "R2_ACCOUNT_ID");
  return accountId === undefined || /^[a-f0-9]{32}$/i.test(accountId);
}

function assertDeploymentInputsAreStable() {
  const result = spawnSync("git", [
    "status",
    "--porcelain=v1",
    "--",
    ...deploymentInputPaths[service],
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write("unable to inspect deployment input ownership\n");
    process.exit(1);
  }
  const unstable = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const status = line.slice(0, 2);
      return status === "??" || (status[0] !== " " && status[1] !== " ");
    });
  if (unstable.length > 0) {
    process.stderr.write(
      `${service} deployment inputs have staged and unstaged or untracked changes; reconcile the checkout before deploying:\n${unstable.join("\n")}\n`,
    );
    process.exit(1);
  }
}

const configPath = `workers/${service}/wrangler.toml`;
const config = readFileSync(resolve(edgeRoot, configPath), "utf8");
if (!accountConfigIsValid(config)) {
  process.stderr.write(`${configPath} must contain a real Cloudflare account ID when R2_ACCOUNT_ID is configured\n`);
  process.exit(1);
}
if (service === "graphify" && !catalogIsValid(config)) {
  process.stderr.write(`${configPath} must contain a valid non-empty tracked repository catalog\n`);
  process.exit(1);
}
if (!dryRun && process.env.OPENTAG_KNOWLEDGE_DEPLOY_APPROVED !== "true") {
  process.stderr.write("set OPENTAG_KNOWLEDGE_DEPLOY_APPROVED=true after explicit staging/deployment approval\n");
  process.exit(1);
}
if (!dryRun) assertDeploymentInputsAreStable();

const args = ["wrangler", "deploy", "--config", configPath, ...passthrough];
if (dryRun) {
  process.stdout.write(`npx ${args.join(" ")}\n`);
  process.exit(0);
}
const result = spawnSync("npx", args, {
  cwd: edgeRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
