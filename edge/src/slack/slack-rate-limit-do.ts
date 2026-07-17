import { DurableObject } from "cloudflare:workers";

type ReserveArgs = {
  minIntervalMs: number;
};

/**
 * One instance is named per Slack channel. Reservations are persisted before
 * the caller sleeps, so independently scheduled Worker isolates cannot dispatch
 * two writes inside the same per-channel interval.
 */
export class SlackRateLimitDO extends DurableObject {
  async reserve(args: ReserveArgs): Promise<{ delayMs: number; reservedAt: number }> {
    const minIntervalMs = Math.max(0, Math.floor(args.minIntervalMs));
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const nextAllowedAt = await txn.get<number>("nextAllowedAt") ?? 0;
      const reservedAt = Math.max(now, nextAllowedAt);
      await txn.put("nextAllowedAt", reservedAt + minIntervalMs);
      return { delayMs: Math.max(0, reservedAt - now), reservedAt };
    });
  }

  async healthCheck(): Promise<{ ok: true }> {
    await this.ctx.storage.get("nextAllowedAt");
    return { ok: true };
  }
}
