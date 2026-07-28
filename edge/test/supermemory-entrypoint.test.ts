import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = resolve(root, "infra/supermemory/entrypoint.sh");
const dockerfile = resolve(root, "infra/supermemory/Dockerfile");
const fixture = resolve(root, "infra/supermemory/test-fixtures/fake-supermemory.sh");
function testEnv() {
  const dataDir = mkdtempSync(resolve(tmpdir(), "opentag-supermemory-entrypoint-"));
  return {
  ...process.env,
  SUPERMEMORY_BINARY: fixture,
  SUPERMEMORY_DATA_DIR: dataDir,
  OPENAI_API_KEY: "sk-fake_provider_secret_123456",
  SUPERMEMORY_API_KEY: "sm_fake_client_secret_654321",
  };
}

describe("Supermemory Railway entrypoint", () => {
  it("passes the exact Docker default argv without repeating the server binary", () => {
    const source = readFileSync(dockerfile, "utf8");
    expect(source).toContain(
      'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/supermemory-entrypoint"]',
    );
    expect(source).toMatch(/^CMD \[\]$/m);
    const runEnv = testEnv();
    try {
      const result = spawnSync("sh", [entrypoint], { env: runEnv, encoding: "utf8" });
      expect(`${result.stdout}${result.stderr}`).toMatch(/(?:^|\n)argv:\n/);
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });

  it("redacts generated/provider/exact secrets while preserving the child exit status", () => {
    const runEnv = testEnv();
    try {
      const result = spawnSync("sh", [entrypoint], { env: runEnv, encoding: "utf8" });
      expect(result.status).toBe(17);
      const logs = `${result.stdout}${result.stderr}`;
      for (const secret of ["sm_fake_generated_key_123456", "sk-fake_provider_secret_123456", "sm_fake_client_secret_654321"]) {
        expect(logs).not.toContain(secret);
      }
      expect(logs).toContain("[REDACTED]");
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });

  it("forwards termination and returns the child status", async () => {
    const runEnv = testEnv();
    try {
      const child = spawn("sh", [entrypoint, "--wait"], { env: runEnv });
      const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
      await new Promise((resolveReady) => setTimeout(resolveReady, 80));
      child.kill("SIGTERM");
      expect(await exited).toBe(42);
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });
});
