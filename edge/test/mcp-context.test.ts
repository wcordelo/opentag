/**
 * Unit coverage for runtime MCP context parsing (no live MCP servers).
 */
import { describe, expect, it } from "vitest";

/** Mirror of runtime.ts helpers — keep in sync. */
function extractContextValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (key in obj) return obj[key];
  const context = obj["context"] as
    | Array<{ description?: string; value?: unknown }>
    | undefined;
  if (context) {
    const entry = context.find((c) => c.description === key);
    if (entry) return entry.value;
  }
  return undefined;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
  return [];
}

describe("AG-UI context → MCP refs", () => {
  it("reads mcpEndpoints and secretRefs from context entries", () => {
    const input = {
      context: [
        {
          description: "mcpEndpoints",
          value: JSON.stringify(["https://mcp.linear.app/mcp"]),
        },
        {
          description: "secretRefs",
          value: JSON.stringify(["LINEAR_API_KEY"]),
        },
      ],
    };
    expect(parseJsonArray(extractContextValue(input, "mcpEndpoints"))).toEqual([
      "https://mcp.linear.app/mcp",
    ]);
    expect(parseJsonArray(extractContextValue(input, "secretRefs"))).toEqual([
      "LINEAR_API_KEY",
    ]);
  });
});
