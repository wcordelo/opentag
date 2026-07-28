import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_ADMIN_CREDENTIAL =
  /(?:test|dev|default|sample|example)[-_]?admin[-_]?secret|change[-_]?me|password/i;

export function findDeployConfigViolations(input) {
  const violations = [];
  for (const [name, command] of Object.entries(input.scripts ?? {})) {
    if (
      /\bwrangler\s+deploy\b/.test(command) &&
      /(?:bot-store|(?:^|[./_-])(?:test|debug)(?:[./_-]|$)).*\.toml/i.test(
        command,
      )
    ) {
      violations.push(
        `package script ${name} deploys a test/debug Wrangler TOML`,
      );
    }
  }
  for (const [name, raw] of Object.entries(input.tomls ?? {})) {
    const live = raw
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    if (/^\s*ADMIN_SECRET\s*=/mi.test(live)) {
      violations.push(`${name} embeds ADMIN_SECRET`);
    }
    if (KNOWN_ADMIN_CREDENTIAL.test(live)) {
      violations.push(`${name} embeds a known/default admin credential`);
    }
  }
  return violations;
}

function visitFiles(root, visitor) {
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

export function validateDeployConfiguration(edgeRoot) {
  const scripts = {};
  const tomls = {};
  visitFiles(edgeRoot, (absolute) => {
    const relative = path.relative(edgeRoot, absolute);
    const basename = path.basename(absolute);
    if (basename === "package.json") {
      const packageJson = JSON.parse(fs.readFileSync(absolute, "utf8"));
      for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
        scripts[`${relative}#${name}`] = command;
      }
    } else if (/^wrangler.*\.toml$/i.test(basename)) {
      tomls[relative] = fs.readFileSync(absolute, "utf8");
    }
  });
  return findDeployConfigViolations({
    scripts,
    tomls,
  });
}

const selfTest = findDeployConfigViolations({
  scripts: {
    unsafe: "wrangler deploy --config wrangler.bot-store.toml",
  },
  tomls: {
    "wrangler.fixture.toml":
      '[vars]\nADMIN_SECRET = "test-admin-secret"\n',
  },
});
if (selfTest.length !== 3) {
  throw new Error("deploy-config validator self-test failed");
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const edgeRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const violations = validateDeployConfiguration(edgeRoot);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`FAIL: ${violation}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      "PASS: no deploy script targets a test/debug TOML and no Wrangler TOML embeds an admin credential",
    );
  }
}
