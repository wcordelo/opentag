import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLAUDEX_INTERNAL_HEADER,
  authObjectKey,
  isAllowedClaudexRequest,
  readBoundedResponseBody,
  withoutCallerCredentials,
} from "../workers/claudex-proxy/src/policy.js";

describe("Claudex proxy boundary", () => {
  it("allows only the Claude-compatible endpoints and methods", () => {
    expect(isAllowedClaudexRequest(new Request("https://claudex.internal/v1/models"))).toBe(true);
    expect(isAllowedClaudexRequest(new Request("https://claudex.internal/v1/messages", { method: "POST" }))).toBe(true);
    expect(isAllowedClaudexRequest(new Request("https://claudex.internal/v1/messages/count_tokens", { method: "POST" }))).toBe(true);
    expect(isAllowedClaudexRequest(new Request("https://claudex.internal/v1/messages"))).toBe(false);
    expect(isAllowedClaudexRequest(new Request("https://claudex.internal/v0/management/config"))).toBe(false);
  });

  it("strips caller credentials and internal-header spoofing", () => {
    const request = withoutCallerCredentials(new Request("https://claudex.internal/v1/models", {
      headers: {
        authorization: "Bearer exposed",
        "x-api-key": "exposed",
        [CLAUDEX_INTERNAL_HEADER]: "spoofed",
        accept: "application/json",
      },
    }));
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get(CLAUDEX_INTERNAL_HEADER)).toBeNull();
    expect(request.headers.get("accept")).toBe("application/json");
  });

  it("keeps the R2 credential key bounded and traversal-free", () => {
    expect(authObjectKey(undefined)).toBe("codex-primary.json");
    expect(authObjectKey("accounts/codex.json")).toBe("accounts/codex.json");
    expect(() => authObjectKey("../codex.json")).toThrow("invalid CODEX_AUTH_OBJECT");
  });

  it("buffers only exact, bounded auth payloads before R2 persistence", async () => {
    const body = new TextEncoder().encode('{"token":"refreshed"}');
    const valid = new Response(body, {
      headers: { "content-length": String(body.byteLength) },
    });
    expect(await readBoundedResponseBody(valid, 128 * 1024)).toEqual(body);

    await expect(readBoundedResponseBody(new Response(body), 128 * 1024))
      .rejects.toThrow("response length unavailable");
    await expect(readBoundedResponseBody(new Response(body, {
      headers: { "content-length": String(body.byteLength + 1) },
    }), 128 * 1024)).rejects.toThrow("response length mismatch");
    await expect(readBoundedResponseBody(new Response(body, {
      headers: { "content-length": String(body.byteLength) },
    }), body.byteLength - 1)).rejects.toThrow("response length out of bounds");
  });

  it("pins the proxy binary and keeps OAuth state outside the image", () => {
    const dockerfile = fs.readFileSync(new URL("../../containers/claudex-proxy/Dockerfile", import.meta.url), "utf8");
    const server = fs.readFileSync(new URL("../../containers/claudex-proxy/server.mjs", import.meta.url), "utf8");
    expect(dockerfile).toContain("CLIProxyAPI_7.2.88_linux_amd64_no-plugin.tar.gz");
    expect(dockerfile).toContain("ADD --checksum=sha256:9ab153cf");
    expect(dockerfile).toContain("USER node");
    expect(server).toContain('"reasoning.effort": "high"');
    expect(server).not.toMatch(/refresh_token|access_token/);
  });
});
