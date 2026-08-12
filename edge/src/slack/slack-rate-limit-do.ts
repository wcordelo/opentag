import { DurableObject } from "cloudflare:workers";

type ReserveArgs = {
  minIntervalMs: number;
  priority?: "normal" | "control";
};

type CommitArgs = {
  generation: number;
  minIntervalMs: number;
};

/**
 * One instance is named per Slack channel. Reservations are persisted before
 * the caller sleeps, so independently scheduled Worker isolates cannot dispatch
 * two writes inside the same per-channel interval.
 */
export class SlackRateLimitDO extends DurableObject {
  async reserve(args: ReserveArgs): Promise<{
    delayMs: number;
    reservedAt: number;
    generation: number;
  }> {
    const minIntervalMs = Math.max(0, Math.floor(args.minIntervalMs));
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const generation = await txn.get<number>("generation") ?? 0;
      const activeUntil = await txn.get<number>("activeUntil") ?? 0;
      const nextAllowedAt = args.priority === "control"
        ? activeUntil
        : await txn.get<number>("nextAllowedAt") ?? 0;
      const reservedAt = Math.max(now, nextAllowedAt);
      const nextGeneration = args.priority === "control"
        ? generation + 1
        : generation;
      if (args.priority === "control") {
        await txn.put("generation", nextGeneration);
      }
      await txn.put("nextAllowedAt", reservedAt + minIntervalMs);
      return {
        delayMs: Math.max(0, reservedAt - now),
        reservedAt,
        generation: nextGeneration,
      };
    });
  }

  async commit(args: CommitArgs): Promise<{ accepted: boolean }> {
    const minIntervalMs = Math.max(0, Math.floor(args.minIntervalMs));
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const generation = await txn.get<number>("generation") ?? 0;
      if (generation !== args.generation) return { accepted: false };
      const activeUntil = await txn.get<number>("activeUntil") ?? 0;
      await txn.put("activeUntil", Math.max(activeUntil, now + minIntervalMs));
      return { accepted: true };
    });
  }

  async preempt(): Promise<{ generation: number }> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const generation = (await txn.get<number>("generation") ?? 0) + 1;
      const activeUntil = await txn.get<number>("activeUntil") ?? 0;
      await txn.put("generation", generation);
      await txn.put("nextAllowedAt", Math.max(now, activeUntil));
      return { generation };
    });
  }

  async healthCheck(): Promise<{ ok: true }> {
    await this.ctx.storage.get("nextAllowedAt");
    return { ok: true };
  }
}
