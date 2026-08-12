import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { buildHarnessProvenance } from "./harness-provenance.mjs";

const root = new URL("..", import.meta.url).pathname;
const repositoryRoot = new URL("../..", import.meta.url).pathname;
const botConfig = "wrangler.bot.toml";
const harnessConfig = "workers/sandbox/wrangler.toml";
const supermemoryConfig = "workers/supermemory/wrangler.toml";
const graphifyConfig = "workers/graphify/wrangler.toml";
const defaultDockerBin = "/Applications/Docker.app/Contents/Resources/bin/docker";

function wranglerEnv() {
  const env = { ...process.env };
  if (!env.WRANGLER_DOCKER_BIN && existsSync(defaultDockerBin)) {
    env.WRANGLER_DOCKER_BIN = defaultDockerBin;
  }
  return env;
}

const secretSpecs = [
  { config: botConfig, name: "SLACK_BOT_TOKEN", env: "OPENTAG_SECRET_SLACK_BOT_TOKEN" },
  { config: botConfig, name: "SLACK_SIGNING_SECRET", env: "OPENTAG_SECRET_SLACK_SIGNING_SECRET" },
  { config: botConfig, name: "AGENT_URL", env: "OPENTAG_SECRET_AGENT_URL" },
  { config: botConfig, name: "ADMIN_SECRET", env: "OPENTAG_SECRET_ADMIN_SECRET" },
  { config: botConfig, name: "INTERNAL_SECRET", env: "OPENTAG_SECRET_INTERNAL_SECRET" },
  { config: botConfig, name: "HARNESS_AUTH_TOKEN", env: "OPENTAG_SECRET_HARNESS_AUTH_TOKEN" },
  { config: botConfig, name: "KNOWLEDGE_ACTOR_TOKEN_SECRET", env: "OPENTAG_SECRET_KNOWLEDGE_ACTOR_TOKEN_SECRET" },
  { config: botConfig, name: "SUPERMEMORY_SERVICE_AUTH_TOKEN", env: "OPENTAG_SECRET_SUPERMEMORY_SERVICE_AUTH_TOKEN" },
  { config: botConfig, name: "GRAPHIFY_SERVICE_AUTH_TOKEN", env: "OPENTAG_SECRET_GRAPHIFY_SERVICE_AUTH_TOKEN" },
  { config: harnessConfig, name: "HARNESS_AUTH_TOKEN", env: "OPENTAG_SECRET_HARNESS_AUTH_TOKEN" },
  { config: harnessConfig, name: "OPENAI_API_KEY", env: "OPENTAG_SECRET_OPENAI_API_KEY" },
];

const knowledgeSecretSpecs = [
  { config: supermemoryConfig, name: "SUPERMEMORY_SERVICE_AUTH_TOKEN", env: "OPENTAG_SECRET_SUPERMEMORY_SERVICE_AUTH_TOKEN" },
  { config: supermemoryConfig, name: "R2_ACCESS_KEY_ID", env: "OPENTAG_SECRET_SUPERMEMORY_R2_ACCESS_KEY_ID" },
  { config: supermemoryConfig, name: "R2_SECRET_ACCESS_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_R2_SECRET_ACCESS_KEY" },
  { config: graphifyConfig, name: "GRAPHIFY_SERVICE_AUTH_TOKEN", env: "OPENTAG_SECRET_GRAPHIFY_SERVICE_AUTH_TOKEN" },
  { config: graphifyConfig, name: "GRAPHIFY_ADMIN_TOKEN", env: "OPENTAG_SECRET_GRAPHIFY_ADMIN_TOKEN" },
  { config: graphifyConfig, name: "GRAPHIFY_CONTAINER_AUTH_TOKEN", env: "OPENTAG_SECRET_GRAPHIFY_CONTAINER_AUTH_TOKEN" },
  { config: graphifyConfig, name: "GITHUB_TOKEN", env: "OPENTAG_SECRET_GRAPHIFY_GITHUB_TOKEN" },
];

const knowledgeProviderSecretSpecs = [
  { config: supermemoryConfig, name: "OPENAI_API_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_OPENAI_API_KEY" },
  { config: supermemoryConfig, name: "ANTHROPIC_API_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_ANTHROPIC_API_KEY" },
  { config: supermemoryConfig, name: "GEMINI_API_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_GEMINI_API_KEY" },
  { config: supermemoryConfig, name: "GROQ_API_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_GROQ_API_KEY" },
  { config: supermemoryConfig, name: "WORKERS_AI_API_KEY", env: "OPENTAG_SECRET_SUPERMEMORY_WORKERS_AI_API_KEY" },
];

const optionalHarnessSecretSpecs = [
  { config: harnessConfig, name: "ANTHROPIC_API_KEY", env: "OPENTAG_SECRET_ANTHROPIC_API_KEY" },
  { config: harnessConfig, name: "CLAUDE_CODE_OAUTH_TOKEN", env: "OPENTAG_SECRET_CLAUDE_CODE_OAUTH_TOKEN" },
  { config: harnessConfig, name: "GITHUB_TOKEN", env: "OPENTAG_SECRET_GITHUB_TOKEN" },
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noDeploy = args.has("--no-deploy");
const preserveExistingSecrets = args.has("--preserve-existing-secrets");
const deployKnowledge = !args.has("--skip-knowledge");
const requireSecrets = args.has("--require-secrets") ||
  (deployKnowledge && !dryRun && !noDeploy && !preserveExistingSecrets);
const supermemoryIndexGeneration = process.env.OPENTAG_SUPERMEMORY_INDEX_GENERATION?.trim();

function assertKnowledgeConfigReady() {
  const knowledgeSources = new Map();
  for (const config of [supermemoryConfig, graphifyConfig]) {
    const source = readFileSync(new URL(`../${config}`, import.meta.url), "utf8");
    knowledgeSources.set(config, source);
  }
  if (knowledgeSources.get(graphifyConfig)?.includes('GRAPHIFY_REPOSITORY_CATALOG = "{}"')) {
    throw new Error(
      "workers/graphify/wrangler.toml still has an empty GRAPHIFY_REPOSITORY_CATALOG; configure tracked repo sources before deployment",
    );
  }
  if (!supermemoryIndexGeneration ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supermemoryIndexGeneration) ||
      supermemoryIndexGeneration === "legacy") {
    throw new Error(
      "OPENTAG_SUPERMEMORY_INDEX_GENERATION must be a non-legacy immutable generation id when deploying knowledge services",
    );
  }
}
function runWrangler(wranglerArgs, input) {
  if (dryRun) {
    process.stdout.write(`wrangler ${wranglerArgs.join(" ")}\n`);
    return;
  }
  const result = spawnSync("npx", ["wrangler", ...wranglerArgs], {
    cwd: root,
    env: wranglerEnv(),
    input,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function existingSecretNames(config) {
  const result = spawnSync("npx", ["wrangler", "secret", "list", "--config", config], {
    cwd: root,
    env: wranglerEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`unable to list existing secrets for ${config}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`wrangler secret list returned invalid JSON for ${config}`);
  }
  return new Set(Array.isArray(parsed) ? parsed.map((entry) => entry?.name).filter((name) => typeof name === "string") : []);
}

const existingSecretsByConfig = new Map();
function cachedExistingSecretNames(config) {
  if (!existingSecretsByConfig.has(config)) {
    existingSecretsByConfig.set(config, existingSecretNames(config));
  }
  return existingSecretsByConfig.get(config);
}

function assertExistingSecrets(specs) {
  const namesByConfig = new Map();
  for (const spec of specs) {
    if (!namesByConfig.has(spec.config)) namesByConfig.set(spec.config, cachedExistingSecretNames(spec.config));
    if (!namesByConfig.get(spec.config).has(spec.name)) {
      throw new Error(`missing existing Cloudflare secret ${spec.name} in ${spec.config}; supply ${spec.env} or configure it first`);
    }
  }
}

function assertKnowledgeProviderConfigured() {
  const configured = knowledgeProviderSecretSpecs.some((spec) =>
    Boolean(process.env[spec.env]) || cachedExistingSecretNames(spec.config).has(spec.name));
  if (!configured) {
    throw new Error(
      "missing Supermemory model provider secret; supply one of OPENTAG_SECRET_SUPERMEMORY_OPENAI_API_KEY, OPENTAG_SECRET_SUPERMEMORY_ANTHROPIC_API_KEY, OPENTAG_SECRET_SUPERMEMORY_GEMINI_API_KEY, OPENTAG_SECRET_SUPERMEMORY_GROQ_API_KEY, or OPENTAG_SECRET_SUPERMEMORY_WORKERS_AI_API_KEY",
    );
  }
}

function assertHarnessProvenanceDeployable(provenance) {
  if (provenance.workingTreeDirty) {
    throw new Error(
      "harness deployment inputs are dirty; reconcile the tracked harness files before deploying",
    );
  }
}

function renderHarnessConfig(provenance) {
  const source = readFileSync(new URL(`../${harnessConfig}`, import.meta.url), "utf8");
  const marker = 'image_build_context = "../../.."';
  const values = {
    OPENTAG_HARNESS_SOURCE_REVISION: provenance.sourceRevision,
    OPENTAG_HARNESS_SOURCE_DIGEST: provenance.sourceDigest,
    OPENTAG_HARNESS_SOURCE_TREE: provenance.sourceTree,
    OPENTAG_HARNESS_SOURCE_STATE: provenance.workingTreeDirty ? "dirty" : "clean",
  };
  const imageVars = Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ");
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) throw new Error("harness image build context marker is not unique");
  return source.replace(marker, `${marker}\nimage_vars = { ${imageVars} }`);
}

let generatedHarnessConfig;
function cleanupGeneratedHarnessConfig() {
  if (!generatedHarnessConfig) return;
  try {
    unlinkSync(generatedHarnessConfig);
  } catch {
    return;
  }
  generatedHarnessConfig = undefined;
}
process.on("exit", cleanupGeneratedHarnessConfig);

if (deployKnowledge && !noDeploy) assertKnowledgeConfigReady();
const harnessProvenance = buildHarnessProvenance(repositoryRoot);
if (!dryRun && !noDeploy) assertHarnessProvenanceDeployable(harnessProvenance);

const requiredSecretSpecs = [...secretSpecs, ...(deployKnowledge ? knowledgeSecretSpecs : [])];
const optionalSecretSpecs = [
  ...optionalHarnessSecretSpecs,
  ...(deployKnowledge ? knowledgeProviderSecretSpecs : []),
];
const allSecretSpecs = [...requiredSecretSpecs, ...optionalSecretSpecs];
if (preserveExistingSecrets && !dryRun && !noDeploy) assertExistingSecrets(requiredSecretSpecs);
if (deployKnowledge && !dryRun && !noDeploy) assertKnowledgeProviderConfigured();

for (const spec of allSecretSpecs) {
  const value = process.env[spec.env];
  if (!value) {
    if (preserveExistingSecrets) continue;
    if (requireSecrets && requiredSecretSpecs.includes(spec)) throw new Error(`missing ${spec.env}`);
    continue;
  }
  runWrangler(["secret", "put", spec.name, "--config", spec.config], `${value}\n`);
}

if (noDeploy) process.exit(0);
generatedHarnessConfig = new URL(
  `../workers/sandbox/.wrangler-harness-${process.pid}.toml`,
  import.meta.url,
).pathname;
writeFileSync(generatedHarnessConfig, renderHarnessConfig(harnessProvenance));
if (deployKnowledge) {
  runWrangler(["deploy", "--config", supermemoryConfig]);
  runWrangler(["deploy", "--config", graphifyConfig]);
}
runWrangler(["deploy", "--config", generatedHarnessConfig]);
runWrangler([
  "deploy",
  "--config",
  botConfig,
  ...(supermemoryIndexGeneration
    ? ["--var", `SUPERMEMORY_INDEX_GENERATION:${supermemoryIndexGeneration}`]
    : []),
]);
