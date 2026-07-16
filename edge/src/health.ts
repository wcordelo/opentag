import type { Env } from "./env.js";

export interface DurabilityHealth {
  ok: boolean;
  checks: {
    botState: "ok" | "timeout" | "error";
    sessionEvents: "ok" | "timeout" | "error";
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
  env: Pick<Env, "BOT_STATE" | "SESSION_EVENTS">,
  timeoutMs = 1_500,
): Promise<DurabilityHealth> {
  const botState = env.BOT_STATE.get(env.BOT_STATE.idFromName("__health")) as unknown as {
    healthCheck(): Promise<unknown>;
  };
  const sessionEvents = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName("__health"),
  ) as unknown as { healthCheck(): Promise<unknown> };
  const [bot, session] = await Promise.all([
    boundedCheck(() => botState.healthCheck(), timeoutMs),
    boundedCheck(() => sessionEvents.healthCheck(), timeoutMs),
  ]);
  return {
    ok: bot === "ok" && session === "ok",
    checks: { botState: bot, sessionEvents: session },
  };
}
