import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DATA_DIR = "/var/lib/cliproxy";
const AUTH_DIR = `${DATA_DIR}/auth`;
const AUTH_FILE = `${AUTH_DIR}/codex-primary.json`;
const CONFIG_FILE = `${DATA_DIR}/config.yaml`;
const INTERNAL_HEADER = "x-opentag-claudex-internal";
const MAX_AUTH_BYTES = 128 * 1024;
const API_METHODS = new Map([
  ["/v1/models", new Set(["GET"])],
  ["/v1/messages", new Set(["POST"])],
  ["/v1/messages/count_tokens", new Set(["POST"])],
]);

const clientKey = process.env.CLIPROXY_CLIENT_KEY ?? "";
const internalKey = process.env.CLIPROXY_INTERNAL_KEY ?? "";
if (clientKey.length < 32 || internalKey.length < 32) {
  throw new Error("CLIPROXY_CLIENT_KEY and CLIPROXY_INTERNAL_KEY must each be at least 32 characters");
}

function yamlString(value) {
  return JSON.stringify(value);
}

function secureEqual(actual, expected) {
  const left = Buffer.from(actual ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBounded(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AUTH_BYTES) throw new Error("auth payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function authConfigured() {
  try {
    const metadata = await stat(AUTH_FILE);
    return metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_AUTH_BYTES;
  } catch {
    return false;
  }
}

async function importAuth(request, response) {
  const body = await readBounded(request);
  const value = JSON.parse(body.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth payload must be a JSON object");
  const temporary = `${AUTH_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, AUTH_FILE);
  sendJson(response, 200, { ok: true });
}

async function exportAuth(response) {
  if (!await authConfigured()) return sendJson(response, 404, { ok: false, error: "auth_missing" });
  const metadata = await stat(AUTH_FILE);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(metadata.size),
    "cache-control": "no-store",
  });
  await pipeline(createReadStream(AUTH_FILE), response);
}

async function proxyReady() {
  try {
    const result = await fetch("http://127.0.0.1:8317/v1/models", {
      headers: { authorization: `Bearer ${clientKey}` },
      signal: AbortSignal.timeout(2_000),
    });
    return result.status < 500;
  } catch {
    return false;
  }
}

async function proxyApi(request, response, url) {
  if (API_METHODS.get(url.pathname)?.has(request.method ?? "") !== true) {
    return sendJson(response, 403, { ok: false, error: "endpoint_denied" });
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !["authorization", "x-api-key", "host", "connection", INTERNAL_HEADER].includes(name.toLowerCase())) {
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
  }
  headers.set("authorization", `Bearer ${clientKey}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(`http://127.0.0.1:8317${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request : undefined,
    duplex: hasBody ? "half" : undefined,
  });
  const outgoingHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (!["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "transfer-encoding", "upgrade"].includes(name.toLowerCase())) {
      outgoingHeaders[name] = value;
    }
  });
  response.writeHead(upstream.status, outgoingHeaders);
  if (!upstream.body) return response.end();
  await pipeline(Readable.fromWeb(upstream.body), response);
}

await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
const config = `host: "127.0.0.1"
port: 8317
auth-dir: ${yamlString(AUTH_DIR)}
api-keys:
  - ${yamlString(clientKey)}
debug: false
logging-to-file: false
usage-statistics-enabled: false
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
request-retry: 2
max-retry-credentials: 1
auth-auto-refresh-workers: 1
payload:
  override:
    - models:
        - name: "gpt-*"
          protocol: "codex"
      params:
        "reasoning.effort": "high"
`;
await writeFile(CONFIG_FILE, config, { mode: 0o600 });
await chmod(CONFIG_FILE, 0o600);

const proxy = spawn("/opt/cliproxy/cli-proxy-api", ["-config", CONFIG_FILE], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, HOME: DATA_DIR },
});
let proxyExitCode;
proxy.once("exit", (code) => { proxyExitCode = code ?? 1; });

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:8080");
    if (url.pathname === "/health" && request.method === "GET") {
      const ready = proxyExitCode === undefined && await proxyReady();
      return sendJson(response, ready ? 200 : 503, { ok: ready, proxy: ready ? "ready" : "unavailable" });
    }
    if (url.pathname.startsWith("/_internal/")) {
      if (!secureEqual(request.headers[INTERNAL_HEADER], internalKey)) {
        return sendJson(response, 401, { ok: false, error: "unauthorized" });
      }
      if (url.pathname === "/_internal/auth/status" && request.method === "GET") {
        return sendJson(response, 200, { configured: await authConfigured() });
      }
      if (url.pathname === "/_internal/auth" && request.method === "PUT") return await importAuth(request, response);
      if (url.pathname === "/_internal/auth" && request.method === "GET") return await exportAuth(response);
      return sendJson(response, 404, { ok: false, error: "not_found" });
    }
    return await proxyApi(request, response, url);
  } catch (error) {
    console.error(JSON.stringify({ event: "claudex_proxy_request_error", error: String(error) }));
    if (!response.headersSent) sendJson(response, 500, { ok: false, error: "proxy_error" });
    else response.destroy();
  }
});

server.listen(8080, "0.0.0.0");

function shutdown(signal) {
  server.close(() => process.exit(proxyExitCode ?? 0));
  proxy.kill(signal);
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
