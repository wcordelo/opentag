#!/usr/bin/env node
/**
 * agent-runner.js — minimal in-container HTTP server for OpenTag agent
 * sandboxes (pm/impl/verify flavors). Runs as the container's entrypoint
 * (see ./Dockerfile).
 *
 * Hard invariant (DECISIONS.md §2): this
 * process holds no API keys — only a short-lived AGENT_TOKEN. Every
 * outbound call to an external API MUST go through `proxiedFetch()` below,
 * which POSTs `{ url, method, headers, body }` to
 * `${EGRESS_PROXY_URL}/proxy` instead of calling the global `fetch()`
 * directly. The egress proxy Worker — not this container — owns real
 * secrets and injects `Authorization` headers server-side per destination
 * host. Transparent TCP interception is intentionally not attempted; this
 * is the application-level proxy contract agent code must follow.
 */
"use strict";

const http = require("http");

const PORT = Number(process.env.PORT || 8080);
const EGRESS_PROXY_URL = process.env.EGRESS_PROXY_URL || "";
const AGENT_FLAVOR = process.env.AGENT_FLAVOR || "unknown";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";

/**
 * The only sanctioned way for agent code in this container to reach the
 * outside world. Never call the global fetch() directly for external
 * hosts — route through the egress proxy so secrets stay server-side and
 * every call gets allowlist-checked and logged.
 */
async function proxiedFetch(url, { method = "GET", headers = {}, body } = {}) {
  if (!EGRESS_PROXY_URL) {
    throw new Error("EGRESS_PROXY_URL is not set; cannot make outbound calls");
  }
  return fetch(`${EGRESS_PROXY_URL}/proxy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(AGENT_TOKEN ? { "x-agent-token": AGENT_TOKEN } : {}),
    },
    body: JSON.stringify({ url, method, headers, body }),
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    sendJson(res, 500, {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, flavor: AGENT_FLAVOR });
    return;
  }

  if (url.pathname === "/run" && req.method === "POST") {
    const raw = await readBody(req);
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
    }
    // Echo endpoint for local smoke-testing of container boot + env wiring
    // before real agent-loop logic (Phase 4/5) lands here.
    sendJson(res, 200, {
      echo: payload,
      flavor: AGENT_FLAVOR,
      receivedAt: new Date().toISOString(),
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

server.listen(PORT, () => {
  console.log(`agent-runner listening on :${PORT} (flavor=${AGENT_FLAVOR})`);
});

module.exports = { proxiedFetch };
