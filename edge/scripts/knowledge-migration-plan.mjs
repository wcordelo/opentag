import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const edgeRoot = resolve(import.meta.dirname, "..");
const supported = new Set(["--source-dir"]);
const forwarded = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--live" || arg.startsWith("--deploy") || arg.startsWith("--cutover") ||
      arg.startsWith("--shutdown") || arg.startsWith("--delete") || arg.startsWith("--secret")) {
    process.stderr.write("knowledge migration dry-run refuses deployment, cutover, shutdown, deletion, and secret mutations\n");
    process.exitCode = 2;
    process.exit();
  }
  if (arg.startsWith("--source-dir=")) {
    forwarded.push(arg);
    continue;
  }
  if (arg.startsWith("--") && ![...supported].some((name) => arg.startsWith(`${name}=`))) {
    process.stderr.write(`unsupported dry-run option: ${arg}\n`);
    process.exitCode = 2;
    process.exit();
  }
}

process.stdout.write("Cloudflare-only knowledge migration dry-run\n");
process.stdout.write("No buckets, Workers, Containers, secrets, Railway services, or Queue messages will be changed.\n\n");
for (const [number, step] of [
  "Inventory the Railway release/volume/backup, representative search fixtures, and authoritative ledger revisions.",
  "Pause delivery for opentag-knowledge with `npx wrangler queues pause-delivery opentag-knowledge`; optionally set SUPERMEMORY_CONSUMER_MODE=paused as a bounded handler fence, knowing retryAll can exhaust the configured retry budget and reach the DLQ.",
  "Keep Railway read-only and retain rollback credentials during the staging and burn-in windows.",
  "Choose one immutable SUPERMEMORY_INDEX_GENERATION for the isolated Cloudflare state; seed a verified compatible Supermemory export, or run generation-aware bounded Queue reconciliation so even same-revision rows from the old generation are replayed and old provider IDs are never updated in the new store.",
  "Run the R2-FUSE mount/remount, key bootstrap, add/poll/search, update/delete/tombstone, restart, single-writer, ACL, redaction, and latency gates.",
  "Compare representative search results and ledger/index revisions while both read paths remain available.",
  "After the service gate passes, clear any handler fence and resume with `npx wrangler queues resume-delivery opentag-knowledge`; inspect and replay any durable DLQ records one at a time.",
  "Require named production cutover approval before enabling the binding for production, removing Railway credentials, or deleting legacy configuration.",
].entries()) {
  process.stdout.write(`${number + 1}. ${step}\n`);
}
process.stdout.write("\nStatic implementation preflight:\n");
const result = spawnSync(process.execPath, [resolve(edgeRoot, "scripts/check-knowledge-rollout.mjs"), ...forwarded], {
  cwd: edgeRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
