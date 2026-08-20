import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const edgeRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(edgeRoot, "..");
const supermemoryConfigPath = resolve(edgeRoot, "workers/supermemory/wrangler.toml");
const graphifyConfigPath = resolve(edgeRoot, "workers/graphify/wrangler.toml");
const graphifyDockerfilePath = resolve(edgeRoot, "workers/graphify/Dockerfile");
const supermemoryDockerfilePath = resolve(repoRoot, "infra/supermemory/Dockerfile");
const supermemoryEntrypointPath = resolve(repoRoot, "infra/supermemory/entrypoint.sh");
const supermemoryPortGatePath = resolve(repoRoot, "infra/supermemory/port-gate.sh");
const supermemoryVerifierPath = resolve(edgeRoot, "scripts/verify-supermemory-artifacts.mjs");
const supermemoryContainerPath = resolve(edgeRoot, "workers/supermemory/src/container.ts");
const supermemoryContainerEnvPath = resolve(edgeRoot, "workers/supermemory/src/container-env.ts");
const graphifyContainerPath = resolve(edgeRoot, "workers/graphify/src/container.ts");
const graphifyIndexPath = resolve(edgeRoot, "workers/graphify/src/index.ts");
const supermemoryIndexPath = resolve(edgeRoot, "workers/supermemory/src/index.ts");
const graphifyContainerEnvPath = resolve(edgeRoot, "workers/graphify/src/container-env.ts");
const graphifyQueryEntrypointPath = resolve(edgeRoot, "workers/graphify/start-query.sh");
const graphifyBuilderPath = resolve(edgeRoot, "workers/graphify/graphify-builder.py");
const supermemoryClientPath = resolve(edgeRoot, "src/memory/supermemory-client.ts");
const knowledgeLedgerPath = resolve(edgeRoot, "src/memory/knowledge-ledger.ts");
const knowledgeLedgerMigrationPath = resolve(edgeRoot, "src/memory/knowledge-ledger-migration.ts");
const supermemoryAdapterPath = resolve(edgeRoot, "src/memory/supermemory-adapter.ts");
const knowledgeJobsPath = resolve(edgeRoot, "src/memory/knowledge-jobs.ts");
const knowledgeReconcilePath = resolve(edgeRoot, "src/memory/knowledge-reconcile.ts");
const migrationRunbookPath = resolve(repoRoot, "docs/supermemory-cloudflare-migration.md");
const botConfigPath = resolve(edgeRoot, "wrangler.bot.toml");
const knowledgeDeployGuardPath = resolve(edgeRoot, "scripts/deploy-knowledge-service.mjs");
const expectedGraphifyCommit = "00efd6e7969837ae4a9f11d8d504dcd3b20b09df";
const expectedSupermemoryBucket = "opentag-supermemory-state";
const expectedGraphBucket = "opentag-code-graphs";

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const requireActiveInstances = args.has("--require-active-instances");
const requireHealthyInstances = args.has("--require-healthy-instances");
const sourceArg = process.argv.find((value) => value.startsWith("--source-dir="));
const sourceDir = sourceArg?.slice("--source-dir=".length) || process.env.GRAPHIFY_SOURCE_DIR;
const checks = [];

function check(name, ok, detail, { pending = false } = {}) {
  checks.push({ name, ok, detail, pending });
}

function literal(source, name) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*["']([^"']*)["']`, "m"));
  return match?.[1];
}

function escapedLiteral(source, name) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*"((?:\\\\.|[^"])*)"`, "m"));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return undefined;
  }
}

function trackedCatalog(source) {
  const raw = escapedLiteral(source, "GRAPHIFY_REPOSITORY_CATALOG");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readOnly(commandArgs) {
  const result = spawnSync("npx", ["wrangler", ...commandArgs], {
    cwd: edgeRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function liveCommand(name, commandArgs, predicate) {
  const result = readOnly(commandArgs);
  const detail = result.output.trim().split("\n").slice(-3).join(" | ") || `exit ${result.status}`;
  check(name, result.status === 0 && predicate(result.output), detail);
}

function liveNamedResource(name, commandArgs, resourceName) {
  const result = readOnly(commandArgs);
  const escaped = resourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = result.output
    .split(/\n\s*\n/)
    .find((candidate) => new RegExp(`^name:\\s*${escaped}\\s*$`, "m").test(candidate));
  const detail = block?.replace(/\s+/g, " ").trim() ||
    result.output.trim().split("\n").slice(-3).join(" | ") || `exit ${result.status}`;
  check(name, result.status === 0 && Boolean(block), detail);
}

function liveSecretNames(name, configPath, requiredNames) {
  const result = readOnly(["secret", "list", "--config", configPath]);
  let names = [];
  try {
    const parsed = JSON.parse(result.output);
    names = Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.name === "string").map((item) => item.name)
      : [];
  } catch {
    names = [];
  }
  const missing = requiredNames.filter((required) => !names.includes(required));
  check(
    name,
    result.status === 0 && missing.length === 0,
    missing.length > 0 ? `missing secret names: ${missing.join(", ")}` : `configured names: ${requiredNames.join(", ")}`,
  );
}

function containerIdFromList(output, name) {
  const row = output.split(/\r?\n/).find((line) => {
    const columns = line.split("│").map((column) => column.trim());
    return columns[2] === name;
  });
  const id = row?.split("│").map((column) => column.trim())[1];
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

function liveContainerState(name, applicationName, instanceName) {
  const list = readOnly(["containers", "list"]);
  const applicationId = containerIdFromList(list.output, applicationName);
  if (!applicationId) {
    check(name, false, `application ${applicationName} was not found`);
    return;
  }
  const instances = readOnly(["containers", "instances", applicationId]);
  const instanceLine = instances.output.split(/\r?\n/).find((line) => {
    const columns = line.split("│").map((column) => column.trim().toLowerCase());
    return columns[2] === instanceName.toLowerCase();
  });
  const state = instanceLine?.split("│").map((column) => column.trim().toLowerCase())[3];
  if (requireHealthyInstances) {
    const info = readOnly(["containers", "info", applicationId]);
    let healthInstances;
    try {
      const parsed = JSON.parse(info.output);
      healthInstances = parsed?.health?.instances;
    } catch {
      healthInstances = undefined;
    }
    const active = Number(healthInstances?.active ?? NaN);
    const healthy = Number(healthInstances?.healthy ?? NaN);
    const failed = Number(healthInstances?.failed ?? NaN);
    const detail = `instance_state=${state ?? "missing"}; active=${Number.isFinite(active) ? active : "unknown"}; healthy=${Number.isFinite(healthy) ? healthy : "unknown"}; failed=${Number.isFinite(failed) ? failed : "unknown"}`;
    check(
      name,
      instances.status === 0 && Boolean(instanceLine) && info.status === 0 &&
        healthy >= 1 && failed === 0,
      detail,
    );
    return;
  }
  const detail = instances.output.trim().split("\n").slice(-4).join(" | ") || `exit ${instances.status}`;
  check(
    name,
    instances.status === 0 && Boolean(instanceLine) &&
      (!requireActiveInstances || state === "running"),
    `${state ?? "missing"}: ${detail}`,
  );
}

const supermemory = readFileSync(supermemoryConfigPath, "utf8");
const graphify = readFileSync(graphifyConfigPath, "utf8");
const graphifyDockerfile = readFileSync(graphifyDockerfilePath, "utf8");
const supermemoryDockerfile = readFileSync(supermemoryDockerfilePath, "utf8");
const supermemoryEntrypoint = readFileSync(supermemoryEntrypointPath, "utf8");
const supermemoryPortGate = readFileSync(supermemoryPortGatePath, "utf8");
const supermemoryVerifier = readFileSync(supermemoryVerifierPath, "utf8");
const supermemoryContainer = readFileSync(supermemoryContainerPath, "utf8");
const supermemoryContainerEnv = readFileSync(supermemoryContainerEnvPath, "utf8");
const graphifyContainer = readFileSync(graphifyContainerPath, "utf8");
const graphifyIndex = readFileSync(graphifyIndexPath, "utf8");
const supermemoryIndex = readFileSync(supermemoryIndexPath, "utf8");
const graphifyContainerEnv = readFileSync(graphifyContainerEnvPath, "utf8");
const graphifyQueryEntrypoint = readFileSync(graphifyQueryEntrypointPath, "utf8");
const graphifyBuilder = readFileSync(graphifyBuilderPath, "utf8");
const supermemoryClient = readFileSync(supermemoryClientPath, "utf8");
const knowledgeLedger = readFileSync(knowledgeLedgerPath, "utf8");
const knowledgeLedgerMigration = readFileSync(knowledgeLedgerMigrationPath, "utf8");
const knowledgeLedgerSource = `${knowledgeLedger}\n${knowledgeLedgerMigration}`;
const supermemoryAdapter = readFileSync(supermemoryAdapterPath, "utf8");
const knowledgeJobs = readFileSync(knowledgeJobsPath, "utf8");
const knowledgeReconcile = readFileSync(knowledgeReconcilePath, "utf8");
const migrationRunbook = readFileSync(migrationRunbookPath, "utf8");
const botConfig = readFileSync(botConfigPath, "utf8");
const knowledgeDeployGuard = readFileSync(knowledgeDeployGuardPath, "utf8");
const graphifyCatalog = trackedCatalog(graphify);
const allowedGraphifyOrgs = new Set(
  (literal(graphify, "GRAPHIFY_ALLOWED_REPO_ORGS") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const graphifyCatalogEntries = graphifyCatalog ? Object.entries(graphifyCatalog) : [];
const graphifyDefaultScopeConfigured =
  /^[A-Za-z0-9._-]{1,128}$/.test(literal(graphify, "GRAPHIFY_DEFAULT_TEAM_ID") ?? "") &&
  /^[A-Za-z0-9._-]{1,128}$/.test(literal(graphify, "GRAPHIFY_DEFAULT_PROJECT_ID") ?? "");
const graphifyCatalogConfigured = graphifyCatalogEntries.length > 0 && graphifyCatalogEntries.every(([repoId, value]) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(repoId) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value;
  if (typeof source.cloneUrl !== "string" || typeof source.defaultBranch !== "string") return false;
  const match = /^https:\/\/github\.com\/([^/]+)\/[A-Za-z0-9_.-]{1,100}\.git$/.exec(source.cloneUrl);
  return Boolean(
    match &&
    allowedGraphifyOrgs.has(match[1].toLowerCase()) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(source.defaultBranch) &&
    !source.defaultBranch.includes("..") &&
    !source.defaultBranch.includes("//") &&
    !source.defaultBranch.includes("@{") &&
    !source.defaultBranch.endsWith("/"),
  );
});
const graphifyBuilderEnv = graphifyContainerEnv.slice(
  graphifyContainerEnv.indexOf("export function graphBuilderContainerEnv"),
);

check(
  "Supermemory Worker is private",
  /workers_dev\s*=\s*false/.test(supermemory),
  "workers_dev=false",
);
check(
  "Graphify Worker is private",
  /workers_dev\s*=\s*false/.test(graphify),
  "workers_dev=false",
);
check(
  "Supermemory is single-writer",
  /max_instances\s*=\s*1/.test(supermemory),
  "max_instances=1",
);
check(
  "Supermemory pins the binary and tigrisfs adapter",
  supermemoryDockerfile.includes("ARG SUPERMEMORY_VERSION=server-v0.0.5") &&
    supermemoryDockerfile.includes('test "$SUPERMEMORY_VERSION" = "server-v0.0.5"') &&
    supermemoryDockerfile.includes("ARG TIGRISFS_VERSION=v1.2.1") &&
    supermemoryDockerfile.includes("TIGRISFS_LINUX_AMD64_SHA256=9fd6e7a9f3e7d86571ea55c66459205e94dfa5f6a25887d7e95c0a46f7641ed4") &&
    supermemoryDockerfile.includes("tigrisfs_${TIGRISFS_VERSION#v}_linux_amd64.tar.gz") &&
    supermemoryDockerfile.includes("/usr/local/bin/tigrisfs") &&
    supermemoryVerifier.includes("verifySupermemory") &&
    supermemoryDockerfile.includes("socat") &&
    !supermemoryContainer.includes("mountBucket") &&
    !supermemoryContainer.includes("unmountBucket") &&
    supermemoryEntrypoint.includes("/usr/local/bin/tigrisfs") &&
    supermemoryEntrypoint.includes("--endpoint") &&
    supermemoryIndex.includes("ContainerProxy") &&
    supermemoryIndex.includes("@cloudflare/sandbox"),
  "server-v0.0.5 + pinned tigrisfs R2/FUSE mount",
);
check(
  "Supermemory tigrisfs mount and key bootstrap are fail-closed",
  supermemoryEntrypoint.includes('data_dir="${SUPERMEMORY_DATA_DIR:-/var/lib/supermemory}"') &&
    supermemoryEntrypoint.includes("opentag-supermemory-r2-ready") &&
    supermemoryEntrypoint.includes("supermemory-port-gate") &&
    supermemoryEntrypoint.includes("AWS_ACCESS_KEY_ID") &&
    supermemoryEntrypoint.includes("AWS_SECRET_ACCESS_KEY") &&
    supermemoryEntrypoint.includes("R2_ACCOUNT_ID") &&
    supermemoryEntrypoint.includes("R2_BUCKET_NAME") &&
    supermemoryEntrypoint.includes("mountpoint -q") &&
    supermemoryEntrypoint.includes("runuser -u supermemory") &&
    supermemoryEntrypoint.includes('touch "$r2_ready_file"') &&
    supermemoryContainer.includes("/run/opentag-supermemory-r2-ready") &&
    supermemoryContainer.includes("mountpoint -q") &&
    supermemoryContainer.includes("runuser -u supermemory") &&
    supermemoryContainerEnv.includes('SUPERMEMORY_DATA_DIR: "/var/lib/supermemory"') &&
    supermemoryContainerEnv.includes('AWS_ACCESS_KEY_ID') &&
    supermemoryContainerEnv.includes('AWS_SECRET_ACCESS_KEY') &&
    supermemoryContainerEnv.includes('R2_ACCOUNT_ID') &&
    supermemoryContainerEnv.includes('R2_BUCKET_NAME') &&
    !supermemoryContainerEnv.includes("SUPERMEMORY_SERVICE_AUTH_TOKEN") &&
    !supermemoryContainerEnv.includes("SUPERMEMORY_ALLOW_LOCAL_DISK"),
  "Container-only R2 credentials + tigrisfs readiness fence",
);
check(
  "Supermemory health probe exposes provider readiness",
  supermemoryPortGate.includes("GET\\ /health\\ HTTP/") &&
    supermemoryPortGate.includes("provider_ready_file") &&
    supermemoryPortGate.includes("HTTP/1.1 200 OK"),
  "liveness stays green during R2/provider boot; /ready and proxy traffic require provider-ready sentinel",
);
check(
  "Supermemory preserves the documented provider boundary",
  supermemoryContainerEnv.includes('"OPENAI_BASE_URL"') &&
    supermemoryContainerEnv.includes('"SUPERMEMORY_EMBEDDING_PROVIDER"') &&
    supermemoryDockerfile.includes("SUPERMEMORY_DISABLE_TELEMETRY=1") &&
    supermemoryEntrypoint.includes("ANTHROPIC_API_KEY") &&
    supermemoryEntrypoint.includes("GEMINI_API_KEY"),
  "provider/base URL, embedding controls, and telemetry remain Container-scoped",
);
check(
  "Bot has private service bindings without derived-index credentials",
  botConfig.includes('binding = "SUPERMEMORY"') &&
    botConfig.includes('binding = "GRAPHIFY"') &&
    !/R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|SUPERMEMORY_API_KEY\s*=/.test(botConfig),
  "service bindings only; no R2/Supermemory server key",
);
check(
  "Supermemory legacy fallback is migration-only",
  supermemoryClient.includes('SUPERMEMORY_MIGRATION_MODE?.trim() !== "true"') &&
    supermemoryClient.includes("SUPERMEMORY_INTERNAL_ORIGIN"),
  "service binding preferred; explicit legacy mode required",
);
check(
  "Supermemory ambiguous-add recovery is exact-identity scoped",
  supermemoryIndex.includes('pathname === "/v3/documents/list"') &&
    supermemoryAdapter.includes("findSlackDocument") &&
    supermemoryAdapter.includes("local_ambiguous_identity") &&
    knowledgeLedger.includes("resolveAmbiguousAdd"),
  "private list probe + customId/metadata identity + durable resolution fence",
);
check(
  "Knowledge service deploys are approval-gated",
  knowledgeDeployGuard.includes("OPENTAG_KNOWLEDGE_DEPLOY_APPROVED") &&
    knowledgeDeployGuard.includes("replace-with-account-id") &&
    knowledgeDeployGuard.includes("accountConfigIsValid") &&
    knowledgeDeployGuard.includes("catalogIsValid") &&
    knowledgeDeployGuard.includes("dryRun"),
  "placeholder/account/catalog validation plus explicit non-dry approval",
);
check(
  "Supermemory migration freeze uses Queue pause plus bounded handler fence",
  knowledgeJobs.includes('"SUPERMEMORY_CONSUMER_MODE"') &&
    knowledgeJobs.includes('=== "paused"') &&
    knowledgeJobs.includes("batch.retryAll") &&
    knowledgeJobs.includes("return;") &&
    migrationRunbook.includes("npx wrangler queues pause-delivery opentag-knowledge") &&
    migrationRunbook.includes("npx wrangler queues resume-delivery opentag-knowledge") &&
    migrationRunbook.includes("not a substitute for queue-level pause"),
  "prolonged freeze pauses delivery; handler retry fence is explicitly bounded",
);
check(
  "Supermemory replay fences provider generations",
  knowledgeLedgerSource.includes("derived_index_generation TEXT") &&
    knowledgeLedgerSource.includes("knowledge_ledger_derived_history") &&
    knowledgeLedgerSource.includes("index_generation_mismatch") &&
    supermemoryAdapter.includes("SUPERMEMORY_INDEX_GENERATION") &&
    supermemoryAdapter.includes("knowledge_index_generation_unconfigured"),
  "old provider IDs are never sent to a new isolated state store",
);
check(
  "Supermemory reconciliation replays old generations",
  knowledgeReconcile.includes("targetIndexGeneration") &&
    knowledgeReconcile.includes("derivedIndexGeneration !== options.targetIndexGeneration") &&
    knowledgeReconcile.includes("SUPERMEMORY_INDEX_GENERATION") &&
    knowledgeReconcile.includes("normalizeDerivedIndexGeneration"),
  "same-revision ledger rows are re-enqueued when their derived generation is stale",
);
check(
  "Graphify has query and builder roles",
  (graphify.match(/\[\[containers\]\]/g) ?? []).length === 2,
  "two Container declarations",
);
check(
  "Graphify source pin is exact",
  literal(graphify, "GRAPHIFY_COMMIT") === expectedGraphifyCommit &&
    graphifyDockerfile.includes(`ARG GRAPHIFY_COMMIT=${expectedGraphifyCommit}`),
  expectedGraphifyCommit,
);
check(
  "Graphify builder verifies the exact checkout",
  graphifyDockerfile.includes('test "$(git rev-parse HEAD)" = "$GRAPHIFY_COMMIT"') &&
    graphifyBuilder.includes('"rev-parse"') &&
    graphifyBuilder.includes('environment.pop("GITHUB_TOKEN", None)'),
  "exact commit verification + scrubbed build environment",
);
check(
  "Graphify repository sources are server-catalogued",
  graphify.includes("GRAPHIFY_REPOSITORY_CATALOG") &&
    graphifyIndex.includes("trackedRepositorySource") &&
    graphifyIndex.includes("isCurrentTrackedRepository") &&
    graphifyIndex.includes("!isCurrentTrackedRepository(env, repo)") &&
    graphifyIndex.includes('"cloneUrl" in body') &&
    !graphifyIndex.includes("body.cloneUrl"),
  "registration and serving require the current server-owned catalog source",
);
check(
  "Graphify tracked repository catalog is configured",
  graphifyCatalogConfigured,
  !graphifyCatalogConfigured
    ? "pending: configure the approved tracked repository catalog before deployment"
    : `configured tracked repositories: ${graphifyCatalogEntries.map(([repoId]) => repoId).join(", ")}`,
  { pending: !graphifyCatalogConfigured },
);
check(
  "Graphify catalog bootstrap scope is configured",
  graphifyDefaultScopeConfigured,
  graphifyDefaultScopeConfigured
    ? `${literal(graphify, "GRAPHIFY_DEFAULT_TEAM_ID")}/${literal(graphify, "GRAPHIFY_DEFAULT_PROJECT_ID")}`
    : "pending: configure the approved team/project scope before the first scheduled build",
  { pending: !graphifyDefaultScopeConfigured },
);
check(
  "Graphify artifact publication is immutable and CAS-guarded",
  graphifyIndex.includes('onlyIf: { etagDoesNotMatch: "*" }') &&
    graphifyIndex.includes('"/activate"') &&
    graphifyIndex.includes("expectedRepositoryRevision") &&
    readFileSync(resolve(edgeRoot, "workers/graphify/src/registry-do.ts"), "utf8").includes("stale_repository") &&
    graphifyIndex.includes('"source.tar.gz"') &&
    graphifyIndex.includes('"manifest.json"'),
  "conditional R2 put + registry activation",
);
check(
  "Graphify registry invalidates stale pointers on repository changes",
  graphifyIndex.includes("/v1/repositories") &&
    readFileSync(resolve(edgeRoot, "workers/graphify/src/registry-do.ts"), "utf8").includes("DELETE FROM artifacts WHERE repo_id = ?"),
  "changed repository identity cannot serve the previous active artifact",
);
check(
  "Graphify source snapshots are reproducible",
  graphifyBuilder.includes('gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0)') &&
    graphifyBuilder.includes("info.mtime = 0") &&
    graphifyBuilder.includes("info.uid = 0") &&
    graphifyBuilder.includes("info.gid = 0"),
  "stable tar/gzip metadata for same-commit rebuilds",
);
check(
  "Graphify query is read-only and builder has no R2 credentials",
  graphifyQueryEntrypoint.includes("exec python3 /app/graphify-api.py") &&
    graphifyContainer.includes("enableInternet = false") &&
    (graphifyContainer.match(/interceptHttps = true/g) ?? []).length === 2 &&
    graphifyContainer.includes('allowedHosts = ["*.r2.cloudflarestorage.com"]') &&
    graphifyContainer.includes('allowedHosts = ["github.com", "*.github.com", "*.githubusercontent.com"]') &&
    graphifyIndex.includes("ContainerProxy") &&
    graphifyContainerEnv.includes("The builder never receives R2 credentials") &&
    !graphifyBuilderEnv.includes("R2_BUCKET_NAME") &&
    !graphifyBuilderEnv.includes("AWS_ACCESS_KEY_ID") &&
    !graphifyBuilderEnv.includes("AWS_SECRET_ACCESS_KEY"),
  "read-only FUSE query + restricted egress + builder credential isolation",
);
check(
  "Graphify rebuild schedule is hourly",
  /crons\s*=\s*\["0 \* \* \* \*"\]/.test(graphify),
  "0 * * * *",
);
check(
  "Supermemory and Graphify use separate buckets",
  supermemory.includes('binding = "STATE_BUCKET"') &&
    supermemory.includes(`bucket_name = "${expectedSupermemoryBucket}"`) &&
    graphify.includes('binding = "ARTIFACTS"') &&
    graphify.includes(`bucket_name = "${expectedGraphBucket}"`) &&
    expectedSupermemoryBucket !== expectedGraphBucket,
  `${expectedSupermemoryBucket} != ${expectedGraphBucket}`,
);
check(
  "Graphify query mount is fail-closed",
  graphifyContainer.includes('mountBucket("ARTIFACTS", "/mnt/graphs", { readOnly: true })') &&
    graphifyQueryEntrypoint.includes("exec python3 /app/graphify-api.py") &&
    !graphifyQueryEntrypoint.includes("AWS_ACCESS_KEY_ID") &&
    !graphifyQueryEntrypoint.includes("R2_READ_ACCESS_KEY_ID"),
  "no local-directory fallback; Worker-owned read-only R2 binding mount",
);
check(
  "KnowledgeDO and Queue/DLQ remain authoritative",
  botConfig.includes('name = "KNOWLEDGE"') &&
    botConfig.includes('binding = "KNOWLEDGE_QUEUE"') &&
    botConfig.includes('dead_letter_queue = "opentag-knowledge-dlq"'),
  "KnowledgeDO + authoritative Queue/DLQ bindings",
);

check(
  "Knowledge Workers scope R2 credentials to Containers",
  /R2_ACCOUNT_ID\s*=\s*"[a-f0-9]{32}"/i.test(supermemory) &&
    supermemory.includes('R2_BUCKET_NAME = "opentag-supermemory-state"') &&
    supermemoryContainerEnv.includes("AWS_ACCESS_KEY_ID") &&
    supermemoryContainerEnv.includes("AWS_SECRET_ACCESS_KEY") &&
    !/R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ACCOUNT_ID|R2_BUCKET_NAME/.test(botConfig),
  "Supermemory account/bucket vars and secrets enter only Container envVars",
);

if (sourceDir) {
  const sourcePath = resolve(repoRoot, sourceDir);
  const result = spawnSync("git", ["-C", sourcePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commit = result.stdout?.trim();
  check(
    "Local Graphify checkout matches the pin",
    result.status === 0 && commit === expectedGraphifyCommit,
    result.status === 0 ? `${sourcePath}: ${commit}` : `${sourcePath}: git rev-parse failed`,
  );
} else {
  check(
    "Local Graphify checkout matches the pin",
    true,
    "not checked (pass --source-dir=/absolute/path or set GRAPHIFY_SOURCE_DIR)",
    { pending: true },
  );
}

if (live) {
  liveNamedResource(
    `R2 bucket exists: ${expectedSupermemoryBucket}`,
    ["r2", "bucket", "list"],
    expectedSupermemoryBucket,
  );
  liveNamedResource(
    `R2 bucket exists: ${expectedGraphBucket}`,
    ["r2", "bucket", "list"],
    expectedGraphBucket,
  );
  liveCommand(
    "opentag-supermemory Worker is deployed",
    ["deployments", "list", "--name", "opentag-supermemory"],
    (output) => !/code:\s*10007|not found|does not exist/i.test(output),
  );
  liveCommand(
    "opentag-graphify Worker is deployed",
    ["deployments", "list", "--name", "opentag-graphify"],
    (output) => !/code:\s*10007|not found|does not exist/i.test(output),
  );
  liveSecretNames(
    "Supermemory Container secrets are provisioned",
    supermemoryConfigPath,
    ["SUPERMEMORY_SERVICE_AUTH_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "OPENAI_API_KEY"],
  );
  liveSecretNames(
    "Graphify facade and builder secrets are provisioned",
    graphifyConfigPath,
    ["GRAPHIFY_SERVICE_AUTH_TOKEN", "GRAPHIFY_ADMIN_TOKEN", "GRAPHIFY_CONTAINER_AUTH_TOKEN", "GITHUB_TOKEN"],
  );
  liveContainerState(
    "Supermemory query instance is registered",
    "opentag-supermemory-supermemorycontainer",
    "supermemory",
  );
  liveContainerState(
    "Graphify query instance is registered",
    "opentag-graphify-graphquerycontainer",
    "query",
  );
  if (requireActiveInstances) {
    liveContainerState(
      "Supermemory query instance is running",
      "opentag-supermemory-supermemorycontainer",
      "supermemory",
    );
    liveContainerState(
      "Graphify query instance is running",
      "opentag-graphify-graphquerycontainer",
      "query",
    );
  }
}

for (const result of checks) {
  const label = result.ok ? "PASS" : result.pending ? "PENDING" : "FAIL";
  process.stdout.write(`[${label}] ${result.name}: ${result.detail}\n`);
}

const blockingFailures = checks.filter((result) => !result.ok && (!result.pending || live));
if (blockingFailures.length > 0) {
  process.stderr.write(`Knowledge rollout preflight failed with ${blockingFailures.length} blocking check(s).\n`);
  process.exitCode = 1;
} else if (live) {
  process.stdout.write("Live checks passed; FUSE, parity, and cutover gates still require staged evidence and approval.\n");
} else {
  process.stdout.write("Static checks passed; run with --live after approved staging resources exist.\n");
}
