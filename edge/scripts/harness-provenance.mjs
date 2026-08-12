import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "../..");

export const HARNESS_SOURCE_FILES = Object.freeze([
  "containers/harness/Dockerfile",
  "containers/harness/SYSTEM_PROMPT.md",
  "containers/harness/package.json",
  "containers/harness/package-lock.json",
  "edge/workers/sandbox/harness-server.ts",
  "edge/workers/sandbox/tool-host.ts",
  "edge/workers/sandbox/turn-contract.ts",
  "edge/workers/sandbox/image-normalization.ts",
  "edge/workers/sandbox/output-redaction.ts",
  "edge/workers/sandbox/src/nanocodex-responses.ts",
  "edge/src/harness/capability-profile.ts",
  "edge/src/permissions/contract.ts",
  "edge/src/platform/contract.ts",
  "edge/src/store/active-turn-types.ts",
]);

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function buildHarnessProvenance(root = defaultRoot) {
  const digest = createHash("sha256");
  for (const relativePath of HARNESS_SOURCE_FILES) {
    const contents = readFileSync(path.join(root, relativePath));
    digest.update(`${relativePath}\0${contents.byteLength}\0`);
    digest.update(contents);
    digest.update("\0");
  }
  const dirtyFiles = git(root, ["status", "--porcelain", "--", ...HARNESS_SOURCE_FILES]);
  return {
    schemaVersion: 1,
    sourceRevision: git(root, ["rev-parse", "HEAD"]),
    sourceTree: git(root, ["rev-parse", "HEAD^{tree}"]),
    sourceDigest: `sha256:${digest.digest("hex")}`,
    workingTreeDirty: dirtyFiles.length > 0,
    files: [...HARNESS_SOURCE_FILES],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(buildHarnessProvenance(), null, 2)}\n`);
}
