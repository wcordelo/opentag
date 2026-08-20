import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = resolve(root, "infra/supermemory/entrypoint.sh");
const portGate = resolve(root, "infra/supermemory/port-gate.sh");
const dockerfile = resolve(root, "infra/supermemory/Dockerfile");
const fixture = resolve(root, "infra/supermemory/test-fixtures/fake-supermemory.sh");
function testEnv(): NodeJS.ProcessEnv & { SUPERMEMORY_DATA_DIR: string } {
  const dataDir = mkdtempSync(resolve(tmpdir(), "opentag-supermemory-entrypoint-"));
  writeFileSync(resolve(dataDir, "api-key"), "sm_fake_bootstrap_key_987654\n", { mode: 0o600 });
  return {
  ...process.env,
  SUPERMEMORY_BINARY: fixture,
  SUPERMEMORY_DATA_DIR: dataDir,
  SUPERMEMORY_ALLOW_LOCAL_DISK: "true",
  OPENAI_API_KEY: "sk-fake_provider_secret_123456",
  ANTHROPIC_API_KEY: "sk-ant-fake_provider_secret_123456",
  SUPERMEMORY_API_KEY: "sm_fake_client_secret_654321",
  };
}

describe("Supermemory Cloudflare Container entrypoint", () => {
  it("passes the exact Docker default argv without repeating the server binary", () => {
    const source = readFileSync(dockerfile, "utf8");
    const entrypointSource = readFileSync(entrypoint, "utf8");
    const portGateSource = readFileSync(portGate, "utf8");
    expect(source).toContain("ARG SUPERMEMORY_VERSION=server-v0.0.5");
    expect(source).toContain('test "$SUPERMEMORY_VERSION" = "server-v0.0.5"');
    expect(source).toContain("TIGRISFS_VERSION=v1.2.1");
    expect(source).toContain("tigrisfs_${TIGRISFS_VERSION#v}_linux_amd64.tar.gz");
    expect(source).toContain("9fd6e7a9f3e7d86571ea55c66459205e94dfa5f6a25887d7e95c0a46f7641ed4");
    expect(source).toContain("PORT=6768");
    expect(source).toContain("EXPOSE 6767 6768");
    expect(source).toContain("socat");
    expect(source).toContain("docker.io/cloudflare/sandbox:0.12.4");
    expect(source).toContain("--gid 999 supermemory");
    expect(source).toContain("--uid 999 --gid supermemory");
    expect(source).toContain('CMD ["/usr/local/bin/supermemory-entrypoint"]');
    expect(source).not.toContain("ENTRYPOINT [");
    expect(entrypointSource).toContain("opentag-supermemory-r2-ready");
    expect(entrypointSource).toContain("supermemory-port-gate");
    expect(entrypointSource).toContain("/usr/local/bin/tigrisfs");
    expect(entrypointSource).toContain('--cache "$r2_cache_dir"');
    expect(entrypointSource).toContain("--fsync-on-close");
    expect(entrypointSource).toContain('model_cache_dir="/var/cache/supermemory/models"');
    expect(entrypointSource).toContain('rm -rf "$model_cache_dir" || exit $?');
    expect(entrypointSource).toContain("AWS_ACCESS_KEY_ID");
    expect(entrypointSource).toContain("R2_ACCOUNT_ID");
    expect(entrypointSource).toContain("rm -f /etc/machine-id /var/lib/dbus/machine-id");
    expect(portGateSource).toContain('request_file="$(mktemp)"');
    expect(portGateSource).toContain('dd bs=1 count="$content_length" >> "$request_file"');
    expect(portGateSource).toContain("Connection: close");
    expect(portGateSource).toContain('TCP:127.0.0.1:${application_port},shut-none');
    expect(portGateSource).toContain('< "$request_file"');
    const runEnv = testEnv();
    try {
      const result = spawnSync("sh", [entrypoint], { env: runEnv, encoding: "utf8" });
      expect(`${result.stdout}${result.stderr}`).toMatch(/(?:^|\n)argv:\n/);
      expect(`${result.stdout}${result.stderr}`).toContain("PORT=6768");
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });

  it("loads the mounted data-dir api-key into the server environment", () => {
    const runEnv = testEnv();
    try {
      const result = spawnSync("sh", [entrypoint], { env: runEnv, encoding: "utf8" });
      expect(result.status).toBe(17);
      expect(readFileSync(resolve(runEnv.SUPERMEMORY_DATA_DIR, "api-key"), "utf8")).toBe("sm_fake_bootstrap_key_987654\n");
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });

  it("keeps local fixture startup behind an explicit opt-in and production behind the mount gate", () => {
    const source = readFileSync(entrypoint, "utf8");
    expect(source).toContain('if [ "${SUPERMEMORY_ALLOW_LOCAL_DISK:-}" = "true" ]; then');
    expect(source).toContain('if [ "${SUPERMEMORY_ALLOW_LOCAL_DISK:-}" != "true" ]; then');
    expect(source).toContain("/usr/local/bin/tigrisfs");
    expect(source).toContain("touch \"$r2_ready_file\"");
    expect(source).toContain('case "$status" in\n      2??)');
    expect(source).not.toContain('case "$status" in\n      1??|2??|3??|4??|5??)');
  });

  it("fails closed before starting the provider when the R2 mount contract is incomplete", () => {
    const runEnv = testEnv();
    delete runEnv.SUPERMEMORY_ALLOW_LOCAL_DISK;
    delete runEnv.AWS_ACCESS_KEY_ID;
    delete runEnv.AWS_SECRET_ACCESS_KEY;
    delete runEnv.R2_ACCOUNT_ID;
    delete runEnv.R2_BUCKET_NAME;
    try {
      const result = spawnSync("sh", [entrypoint], { env: runEnv, encoding: "utf8" });
      const logs = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(78);
      expect(logs).toContain("supermemory R2 credentials are required");
      expect(logs).not.toContain("argv:");
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });

  it("keeps bootstrap health separate from application traffic", () => {
    const health = spawnSync("sh", [portGate], {
      input: "GET /health HTTP/1.1\r\nHost: ping\r\n\r\n",
      encoding: "utf8",
      timeout: 1_000,
    });
    expect(health.status).toBe(0);
    expect(health.stdout).toBe("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

    const application = spawnSync("sh", [portGate], {
      input: "GET /ping HTTP/1.1\r\nHost: ping\r\n\r\n",
      encoding: "utf8",
      timeout: 1_000,
    });
    expect(application.status).toBe(0);
    expect(application.stdout).toBe("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

    const ready = spawnSync("sh", [portGate], {
      input: "GET /ready HTTP/1.1\r\nHost: ping\r\n\r\n",
      encoding: "utf8",
      timeout: 1_000,
    });
    expect(ready.status).toBe(0);
    expect(ready.stdout).toContain("HTTP/1.1 503 Service Unavailable");
  });

  it("keeps liveness green during provider startup and proxies only after application readiness", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "opentag-supermemory-gate-"));
    const r2ReadyFile = resolve(tempDir, "r2-ready");
    const providerReadyFile = resolve(tempDir, "provider-ready");
    try {
      writeFileSync(r2ReadyFile, "");
      const degraded = spawnSync("sh", [portGate], {
        input: "POST /ping HTTP/1.1\r\nHost: ping\r\nContent-Length: 4\r\n\r\nping",
        encoding: "utf8",
        env: { ...process.env, SUPERMEMORY_R2_READY_FILE: r2ReadyFile, SUPERMEMORY_PROVIDER_READY_FILE: providerReadyFile },
      });
      expect(degraded.status).toBe(0);
      expect(degraded.stdout).toContain("HTTP/1.1 503 Service Unavailable");

      const degradedHealth = spawnSync("sh", [portGate], {
        input: "GET /health HTTP/1.1\r\nHost: ping\r\n\r\n",
        encoding: "utf8",
        env: { ...process.env, SUPERMEMORY_R2_READY_FILE: r2ReadyFile, SUPERMEMORY_PROVIDER_READY_FILE: providerReadyFile },
      });
      expect(degradedHealth.status).toBe(0);
      expect(degradedHealth.stdout).toContain("HTTP/1.1 200 OK");

      writeFileSync(providerReadyFile, "");
      const healthy = spawnSync("sh", [portGate], {
        input: "GET /health HTTP/1.1\r\nHost: ping\r\n\r\n",
        encoding: "utf8",
        env: { ...process.env, SUPERMEMORY_R2_READY_FILE: r2ReadyFile, SUPERMEMORY_PROVIDER_READY_FILE: providerReadyFile, SUPERMEMORY_APPLICATION_PORT: "1" },
      });
      expect(healthy.status).toBe(0);
      expect(healthy.stdout).toContain("HTTP/1.1 200 OK");

      const ready = spawnSync("sh", [portGate], {
        input: "GET /ready HTTP/1.1\r\nHost: ping\r\n\r\n",
        encoding: "utf8",
        env: { ...process.env, SUPERMEMORY_R2_READY_FILE: r2ReadyFile, SUPERMEMORY_PROVIDER_READY_FILE: providerReadyFile },
      });
      expect(ready.status).toBe(0);
      expect(ready.stdout).toContain("HTTP/1.1 200 OK");

      const proxied = spawnSync("sh", [portGate], {
        input: "",
        encoding: "utf8",
        env: { ...process.env, SUPERMEMORY_R2_READY_FILE: r2ReadyFile, SUPERMEMORY_PROVIDER_READY_FILE: providerReadyFile, SUPERMEMORY_APPLICATION_PORT: "1" },
      });
      expect(proxied.status).not.toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts generated/provider/exact secrets while preserving the child exit status", () => {
    const runEnv = testEnv();
    try {
      const result = spawnSync("sh", [entrypoint], { env: runEnv, encoding: "utf8" });
      expect(result.status).toBe(17);
      const logs = `${result.stdout}${result.stderr}`;
      for (const secret of ["sm_fake_generated_key_123456", "sk-fake_provider_secret_123456", "sk-ant-fake_provider_secret_123456", "sm_fake_client_secret_654321"]) {
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
      await new Promise<void>((resolveReady) => {
        const timeout = setTimeout(() => {
          child.stdout?.off("data", onData);
          resolveReady();
        }, 1_000);
        const onData = (chunk: Buffer) => {
          if (!chunk.toString().includes("argv:")) return;
          clearTimeout(timeout);
          child.stdout?.off("data", onData);
          resolveReady();
        };
        child.stdout?.on("data", onData);
      });
      child.kill("SIGTERM");
      expect(await exited).toBe(42);
    } finally {
      rmSync(runEnv.SUPERMEMORY_DATA_DIR, { recursive: true, force: true });
    }
  });
});
