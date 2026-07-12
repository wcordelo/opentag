import { describe, expect, it } from "vitest";
import {
  resolveAllowedTools,
  DEFAULT_BUNDLE,
} from "../src/config/access-bundle.js";
import { guardToolsByBundle } from "../src/tools/guard.js";
import { defineBotTool } from "@copilotkit/channels";
import { z } from "zod";

const sampleTools = [
  defineBotTool({
    name: "memory_search",
    description: "search",
    parameters: z.object({}),
    async handler() {
      return "ok";
    },
  }),
  defineBotTool({
    name: "memory_write",
    description: "write",
    parameters: z.object({}),
    async handler() {
      return "wrote";
    },
  }),
];

describe("bundle deny enforcement", () => {
  it("filters tool names to allowlist", () => {
    const restricted = {
      ...DEFAULT_BUNDLE,
      tools: ["memory_search"],
    };
    const allowed = resolveAllowedTools(
      ["memory_search", "memory_write", "start_task"],
      restricted,
    );
    expect(allowed).toEqual(["memory_search"]);
  });

  it("guardToolsByBundle refuses disallowed tool handlers", async () => {
    const allowed = new Set(["memory_search"]);
    const guarded = guardToolsByBundle(sampleTools, allowed);
    const denied = guarded.find((t) => t.name === "memory_write");
    expect(denied).toBeTruthy();
    const result = await denied!.handler({} as never, {
      thread: {} as never,
      platform: "slack",
    });
    expect(String(result)).toMatch(/not allowed/);
  });

  it("guardToolsByBundle leaves allowed tools intact", async () => {
    const allowed = new Set(["memory_search"]);
    const guarded = guardToolsByBundle(sampleTools, allowed);
    const ok = guarded.find((t) => t.name === "memory_search");
    await expect(
      ok!.handler({} as never, { thread: {} as never, platform: "slack" }),
    ).resolves.toBe("ok");
  });
});
