/**
 * Unit tests for edge/workers/sandbox/tool-host.ts (GOAL.md Phase A5), the
 * TypeScript port of centaur's centaur_tool_host.py. Covers request parsing,
 * response envelope shaping, and an end-to-end run through a real spawned
 * process — a tiny Node "fake tool bin" script exercises the actual
 * `spawnSync` path without requiring a configured production CLI or Docker.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildResultEnvelope,
  buildToolCommand,
  handleRequestLine,
  parseToolCallRequest,
  runTool,
  toolBinName,
  type ToolCallResponse,
} from "../workers/sandbox/tool-host.js";

describe("parseToolCallRequest", () => {
  it("parses a well-formed request line", () => {
    const line = JSON.stringify({
      id: "turn-1",
      tool: "linear",
      method: "search",
      arguments: { query: "bug" },
      timeout_seconds: 30,
    });
    const result = parseToolCallRequest(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.tool).toBe("linear");
      expect(result.request.method).toBe("search");
      expect(result.request.arguments).toEqual({ query: "bug" });
    }
  });

  it("rejects malformed JSON without throwing", () => {
    const result = parseToolCallRequest("{not json");
    expect(result.ok).toBe(false);
  });

  it("rejects a request missing tool/method", () => {
    expect(parseToolCallRequest(JSON.stringify({ id: 1 })).ok).toBe(false);
    expect(parseToolCallRequest(JSON.stringify({ tool: "x" })).ok).toBe(false);
    expect(parseToolCallRequest("null").ok).toBe(false);
    expect(parseToolCallRequest('"a string"').ok).toBe(false);
  });
});

describe("buildToolCommand / toolBinName", () => {
  const originalBin = process.env.OPENTAG_TOOL_BIN;
  afterAll(() => {
    if (originalBin === undefined) delete process.env.OPENTAG_TOOL_BIN;
    else process.env.OPENTAG_TOOL_BIN = originalBin;
  });

  it("is disabled unless OPENTAG_TOOL_BIN is configured", () => {
    delete process.env.OPENTAG_TOOL_BIN;
    expect(toolBinName()).toBeUndefined();
    expect(() => buildToolCommand({ tool: "linear", method: "search" })).toThrow(
      "OPENTAG_TOOL_BIN is not configured",
    );
    const envelope = handleRequestLine(
      JSON.stringify({ id: "disabled", tool: "linear", method: "search" }),
    );
    const result = JSON.parse(envelope.result) as ToolCallResponse;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENTAG_TOOL_BIN is not configured");
  });

  it("honors OPENTAG_TOOL_BIN", () => {
    process.env.OPENTAG_TOOL_BIN = "/custom/path/tools-cli";
    expect(toolBinName()).toBe("/custom/path/tools-cli");
  });

  it("shapes argv as 'call <tool> <method> <json-args>'", () => {
    const { args } = buildToolCommand({
      tool: "linear",
      method: "search",
      arguments: { query: "bug" },
    });
    expect(args).toEqual(["call", "linear", "search", JSON.stringify({ query: "bug" })]);
  });

  it("defaults arguments to {} when omitted", () => {
    const { args } = buildToolCommand({ tool: "slack", method: "health" });
    expect(args).toEqual(["call", "slack", "health", "{}"]);
  });
});

describe("buildResultEnvelope", () => {
  it("wraps a response as a JSON-encoded 'result' envelope keyed by turn_id", () => {
    const response: ToolCallResponse = {
      id: "turn-7",
      status: 0,
      stdout: "ok",
      stderr: "",
      timed_out: false,
    };
    const envelope = buildResultEnvelope(response);
    expect(envelope.type).toBe("result");
    expect(envelope.turn_id).toBe("turn-7");
    expect(JSON.parse(envelope.result)).toEqual(response);
  });
});

describe("runTool / handleRequestLine — end-to-end via a fake tool bin process", () => {
  let fixtureDir: string;
  let fakeBinPath: string;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-tool-host-"));
    fakeBinPath = path.join(fixtureDir, "fake-opentag-tools");
    // A tiny Node "fake tool bin": echoes its argv back as JSON on stdout,
    // exits 0 unless the tool name is "boom" (nonzero exit + stderr) or
    // "hang" (sleeps past the caller's timeout).
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const [cmd, tool, method, argsJson] = args;
if (tool === "hang") {
  setTimeout(() => {}, 60000);
} else if (tool === "boom") {
  process.stderr.write("boom failed\\n");
  process.exit(3);
} else {
  process.stdout.write(JSON.stringify({ cmd, tool, method, argsJson }));
  process.exit(0);
}
`;
    fs.writeFileSync(fakeBinPath, script, { mode: 0o755 });
    process.env.OPENTAG_TOOL_BIN = fakeBinPath;
    // Sanity-check the fixture itself runs before relying on it in tests.
    execFileSync(fakeBinPath, ["call", "noop", "ping", "{}"], { encoding: "utf8" });
  });

  afterAll(() => {
    delete process.env.OPENTAG_TOOL_BIN;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("runs the fake tool bin and captures stdout/status", () => {
    const response = runTool({ tool: "linear", method: "search", arguments: { q: "x" } });
    expect(response.status).toBe(0);
    expect(response.timed_out).toBe(false);
    expect(JSON.parse(response.stdout)).toEqual({
      cmd: "call",
      tool: "linear",
      method: "search",
      argsJson: JSON.stringify({ q: "x" }),
    });
  });

  it("captures a nonzero exit and stderr", () => {
    const response = runTool({ tool: "boom", method: "anything" });
    expect(response.status).toBe(3);
    expect(response.stderr).toContain("boom failed");
    expect(response.timed_out).toBe(false);
  });

  it("reports a timeout without throwing", () => {
    const response = runTool({ tool: "hang", method: "anything", timeout_seconds: 1 });
    expect(response.timed_out).toBe(true);
    expect(response.status).toBeNull();
    expect(response.stderr).toContain("timed out after 1s");
  }, 10_000);

  it("handleRequestLine end-to-end: parses, runs, and shapes the envelope", () => {
    const line = JSON.stringify({
      id: "turn-99",
      tool: "linear",
      method: "search",
      arguments: { q: "y" },
    });
    const envelope = handleRequestLine(line);
    expect(envelope.type).toBe("result");
    expect(envelope.turn_id).toBe("turn-99");
    const result = JSON.parse(envelope.result) as ToolCallResponse;
    expect(result.id).toBe("turn-99");
    expect(result.status).toBe(0);
  });

  it("handleRequestLine on a malformed line still returns a result envelope, never throws", () => {
    expect(() => handleRequestLine("{not valid json")).not.toThrow();
    const envelope = handleRequestLine("{not valid json");
    expect(envelope.type).toBe("result");
    expect(envelope.turn_id).toBeNull();
    const result = JSON.parse(envelope.result) as ToolCallResponse;
    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
