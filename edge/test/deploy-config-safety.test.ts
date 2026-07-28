import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const edgeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function visitFiles(root: string, visitor: (absolute: string) => void): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      ["node_modules", ".wrangler", "dist", "coverage"].includes(entry.name)
    ) {
      continue;
    }
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) visitFiles(absolute, visitor);
    else if (entry.isFile()) visitor(absolute);
  }
}

describe("deploy configuration safety", () => {
  it("has no package deploy script for a bot-store/test/debug config", () => {
    visitFiles(edgeRoot, (absolute) => {
      if (path.basename(absolute) !== "package.json") return;
      const packageJson = JSON.parse(
        fs.readFileSync(absolute, "utf8"),
      ) as { scripts?: Record<string, string> };
      for (const command of Object.values(packageJson.scripts ?? {})) {
        if (/\bwrangler\s+deploy\b/.test(command)) {
          expect(command, path.relative(edgeRoot, absolute)).not.toMatch(
            /(?:bot-store|(?:^|[./_-])(?:test|debug)(?:[./_-]|$)).*\.toml/i,
          );
        }
      }
    });
  });

  it("keeps admin credentials out of every deployable Wrangler TOML", () => {
    visitFiles(edgeRoot, (absolute) => {
      if (!/^wrangler.*\.toml$/i.test(path.basename(absolute))) return;
      const label = path.relative(edgeRoot, absolute);
      const live = fs.readFileSync(absolute, "utf8")
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(live, label).not.toMatch(/^\s*ADMIN_SECRET\s*=/mi);
      expect(live, label).not.toMatch(
        /(?:test|dev|default|sample|example)[-_]?admin[-_]?secret|change[-_]?me|password/i,
      );
    });
  });

  it("passes the standalone validator with its unsafe-fixture self-test", () => {
    expect(() =>
      execFileSync(process.execPath, [
        "scripts/validate-deploy-config.mjs",
      ], {
        cwd: edgeRoot,
        encoding: "utf8",
        stdio: "pipe",
      })
    ).not.toThrow();
  });
});
