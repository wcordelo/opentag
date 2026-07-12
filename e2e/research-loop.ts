/**
 * E2E research loop harness — runs orchestrator pipeline in-process (no Slack).
 *
 * Usage: DATABASE_URL=... tsx e2e/research-loop.ts
 *        RESEARCH_MOCK=1 tsx e2e/research-loop.ts  (no Postgres)
 */
import { MemoryStorageAdapter } from "../lib/research/adapters/storage-memory.js";
import { Orchestrator } from "../lib/research/orchestrator.js";
import { generateRequestId } from "../lib/research/fiber.js";

const MOCK = process.env["RESEARCH_MOCK"] === "1";

async function main() {
  const storage = new MemoryStorageAdapter();
  const llm = {
    complete: async () => ({
      content: JSON.stringify({ verdict: "pass", issues: [] }),
      model: "mock",
    }),
  };

  const orchestrator = new Orchestrator({
    storage,
    llm: llm as never,
  });

  const threadKey = "slack:CE2E:1234.5678";
  const start = Date.now();

  const result = await orchestrator.handleMention({
    threadKey,
    objective: "Summarize benefits of edge computing",
    eventId: `evt_${generateRequestId()}`,
  });

  console.log(`[e2e] startTask: ${result.status} taskId=${result.taskId}`);

  const researcher = orchestrator.getResearcher();
  let steps = 0;
  let done = false;

  while (!done && steps < 10) {
    const stepResult = await researcher.runFiberStep(result.taskId);
    await orchestrator.processOutbox(result.taskId);
    steps++;
    done = stepResult.done;
    console.log(`[e2e] fiber step ${steps}: done=${stepResult.done}`);
  }

  const elapsed = Date.now() - start;
  const task = await storage.getTask(result.taskId);
  const deliveries = await storage.getPendingDeliveries(threadKey);

  console.log(`[e2e] task status: ${task?.status}`);
  console.log(`[e2e] deliveries: ${deliveries.length}`);
  console.log(`[e2e] elapsed: ${elapsed}ms`);

  if (MOCK) {
    console.log("[e2e] MOCK mode — in-memory storage only");
  }

  const success = task?.status === "complete" || deliveries.some((d) => d.payload.type === "final");
  if (!success) {
    console.error("[e2e] FAILED — expected complete task or final delivery");
    process.exit(1);
  }
  console.log("[e2e] PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
