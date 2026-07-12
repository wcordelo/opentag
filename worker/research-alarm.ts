/**
 * Alarm queue worker — polls Postgres alarm_queue and runs Researcher fiber steps.
 *
 * Run: pnpm research:worker
 */
import "dotenv/config";
import { createResearchContext } from "../lib/research/index.js";
import { postToSlackThread } from "../lib/research/delivery/slack.js";

const POLL_INTERVAL_MS = Number(process.env["ALARM_POLL_MS"] ?? 2000);

async function main() {
  const ctx = await createResearchContext();
  const researcher = ctx.orchestrator.getResearcher();

  console.log(`[research-worker] polling alarm_queue every ${POLL_INTERVAL_MS}ms`);

  const tick = async () => {
    try {
      const now = Date.now();
      const due = await ctx.storage.getDueAlarms(now, 5);

      for (const alarm of due) {
        console.log(`[research-worker] ${alarm.kind} for ${alarm.sessionId}`);

        if (alarm.kind === "fiber_step" || alarm.kind === "external_poll") {
          const result = await researcher.runFiberStep(alarm.sessionId);
          await ctx.orchestrator.processOutbox(alarm.sessionId);
          await deliverPending(ctx);

          if (!result.done && result.nextAlarmMs) {
            await ctx.storage.enqueueAlarm({
              id: `alarm_${alarm.sessionId}_${Date.now()}`,
              sessionId: alarm.sessionId,
              kind: alarm.kind,
              runAtMs: Date.now() + result.nextAlarmMs,
              priority: 10,
            });
          }
        } else if (alarm.kind === "outbox_retry") {
          await ctx.orchestrator.processOutbox(alarm.sessionId);
        }

        await ctx.storage.deleteAlarm(alarm.id);
      }
    } catch (err) {
      console.error("[research-worker] tick error", err);
    }
  };

  setInterval(() => void tick(), POLL_INTERVAL_MS);
  await tick();
}

async function deliverPending(ctx: Awaited<ReturnType<typeof createResearchContext>>) {
  const deliveries = await ctx.orchestrator.getPendingDeliveries();
  for (const d of deliveries) {
    const posted = await postToSlackThread(d.threadKey, d.payload.text);
    if (posted) {
      await ctx.orchestrator.markDeliveryDelivered(d.id);
      console.log(`[research-worker] delivered ${d.payload.type} to ${d.threadKey}`);
    }
  }
}

main().catch((err) => {
  console.error("[research-worker] fatal", err);
  process.exit(1);
});
