import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const dockerfile = readFileSync(new URL("../../infra/supermemory/Dockerfile", import.meta.url), "utf8");
const containerSource = readFileSync(new URL("../workers/supermemory/src/container.ts", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../workers/supermemory/src/index.ts", import.meta.url), "utf8");
const entrypointSource = readFileSync(new URL("../../infra/supermemory/entrypoint.sh", import.meta.url), "utf8");

function dockerArg(name) {
  const match = dockerfile.match(new RegExp(`^ARG ${name}=([^\\n]+)$`, "m"));
  if (!match) throw new Error(`Dockerfile is missing ${name}`);
  return match[1].trim();
}

const supermemoryVersion = dockerArg("SUPERMEMORY_VERSION");
const supermemorySha = dockerArg("SUPERMEMORY_X64_SHA256");
const tigrisfsVersion = dockerArg("TIGRISFS_VERSION");
const tigrisfsSha = dockerArg("TIGRISFS_LINUX_AMD64_SHA256");
const args = new Set(process.argv.slice(2));
const binaryArg = process.argv.find((value) => value.startsWith("--binary="))?.slice("--binary=".length);
const shouldDownload = args.has("--download");

if (!binaryArg && !shouldDownload) {
  process.stderr.write(
    "Usage: node scripts/verify-supermemory-artifacts.mjs --binary=/path/to/supermemory-server | --download\n",
  );
  process.exit(2);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifySupermemory(bytes, source) {
  if (digest(bytes) !== supermemorySha) {
    throw new Error(`${source}: SHA-256 does not match ${supermemoryVersion}`);
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 || bytes[4] !== 2) {
    throw new Error(`${source}: expected a 64-bit ELF binary`);
  }
  for (const marker of ["api-key", "SUPERMEMORY_DATA_DIR", "/v3/documents", "/v4/search"]) {
    if (!bytes.includes(Buffer.from(marker))) throw new Error(`${source}: missing runtime marker ${marker}`);
  }
  if (!dockerfile.includes("sha256sum -c -") || !dockerfile.includes("socat") ||
      !dockerfile.includes("fuse3") || !dockerfile.includes("/usr/local/bin/tigrisfs") ||
      !entrypointSource.includes("/usr/local/bin/tigrisfs") ||
      !entrypointSource.includes("AWS_ACCESS_KEY_ID") ||
      !entrypointSource.includes("AWS_SECRET_ACCESS_KEY") ||
      !entrypointSource.includes("R2_ACCOUNT_ID") ||
      !entrypointSource.includes("R2_BUCKET_NAME") ||
      containerSource.includes("mountBucket") || containerSource.includes("unmountBucket") ||
      !containerSource.includes("/run/opentag-supermemory-r2-ready") ||
      !workerSource.includes("ContainerProxy")) {
    throw new Error("Docker image and Worker must use the pinned tigrisfs Container mount contract");
  }
  process.stdout.write(`PASS Supermemory ${supermemoryVersion}: checksum and startup/API markers verified\n`);
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function verifyTigrisfs(bytes, source) {
  if (digest(bytes) !== tigrisfsSha) {
    throw new Error(`${source}: SHA-256 does not match ${tigrisfsVersion}`);
  }
  const listing = spawnSync("tar", ["-tzf", "-"], {
    input: bytes,
    encoding: "utf8",
  });
  if (listing.status !== 0 || !listing.stdout.split(/\r?\n/).some((entry) => entry === "tigrisfs" || entry.endsWith("/tigrisfs"))) {
    throw new Error(`${source}: expected a tigrisfs archive`);
  }
}

let temporaryDirectory;
try {
  if (binaryArg) {
    if (!existsSync(binaryArg)) throw new Error(`binary does not exist: ${binaryArg}`);
    verifySupermemory(readFileSync(binaryArg), binaryArg);
  } else {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "opentag-supermemory-artifacts-"));
    const binary = await download(
      `https://github.com/supermemoryai/supermemory/releases/download/${supermemoryVersion}/supermemory-server-linux-x64`,
    );
    verifySupermemory(binary, "GitHub release");
    const tigrisfs = await download(
      `https://github.com/tigrisdata/tigrisfs/releases/download/${tigrisfsVersion}/tigrisfs_${tigrisfsVersion.slice(1)}_linux_amd64.tar.gz`,
    );
    verifyTigrisfs(tigrisfs, "GitHub release");
    process.stdout.write("PASS tigrisfs R2/FUSE mount: startup contract verified\n");
  }
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
