import type { Env } from "./env.js";

export interface DurabilityHealth {
  ok: boolean;
  checks: {
    botState: "ok" | "timeout" | "error";
    sessionEvents: "ok" | "timeout" | "error";
    deferredIngress: "ok" | "timeout" | "error";
    slackRateLimit: "ok" | "timeout" | "error";
  };
}

async function boundedCheck(call: () => Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call().then(() => "ok" as const).catch(() => "error" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Live, bounded readiness probes for both durability bindings. */
export async function probeDurabilityHealth(
  env: Pick<
    Env,
    "BOT_STATE" | "SESSION_EVENTS" | "DEFERRED_INGRESS" | "SLACK_RATE_LIMIT"
  >,
  timeoutMs = 1_500,
): Promise<DurabilityHealth> {
  const botState = env.BOT_STATE.get(env.BOT_STATE.idFromName("__health")) as unknown as {
    healthCheck(): Promise<unknown>;
  };
  const sessionEvents = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName("__health"),
  ) as unknown as { healthCheck(): Promise<unknown> };
  const deferredIngress = env.DEFERRED_INGRESS
    ? env.DEFERRED_INGRESS.get(
        env.DEFERRED_INGRESS.idFromName("__health"),
      ) as unknown as { healthCheck(): Promise<unknown> }
    : undefined;
  const slackRateLimit = env.SLACK_RATE_LIMIT
    ? env.SLACK_RATE_LIMIT.get(
        env.SLACK_RATE_LIMIT.idFromName("__health"),
      ) as unknown as { healthCheck(): Promise<unknown> }
    : undefined;
  const [bot, session, deferred, rateLimit] = await Promise.all([
    boundedCheck(() => botState.healthCheck(), timeoutMs),
    boundedCheck(() => sessionEvents.healthCheck(), timeoutMs),
    deferredIngress
      ? boundedCheck(() => deferredIngress.healthCheck(), timeoutMs)
      : Promise.resolve("error" as const),
    slackRateLimit
      ? boundedCheck(() => slackRateLimit.healthCheck(), timeoutMs)
      : Promise.resolve("error" as const),
  ]);
  return {
    ok:
      bot === "ok" &&
      session === "ok" &&
      deferred === "ok" &&
      rateLimit === "ok",
    checks: {
      botState: bot,
      sessionEvents: session,
      deferredIngress: deferred,
      slackRateLimit: rateLimit,
    },
  };
}
