const WRANGLER_COMMANDS = new Set([
  "deploy",
  "dev",
  "secret",
  "kv",
  "d1",
  "r2",
  "pages",
  "queues",
  "workflows",
  "tail",
  "whoami",
  "login",
  "logout",
  "types",
  "docs",
  "telemetry",
]);

/** @param {string[]} argv process.argv.slice(2) */
export function buildWranglerArgv(argv) {
  const firstPositional = argv.find((arg) => !arg.startsWith("-"));
  if (firstPositional && WRANGLER_COMMANDS.has(firstPositional)) {
    return argv;
  }
  return ["deploy", ...argv];
}
