import { DurableObject } from "cloudflare:workers";

export type DeferredIngressJob = {
  id: string;
  kind: "quick_action" | "late_file" | "file_turn";
  payload: unknown;
  teamId: string;
};

type StoredJob = DeferredIngressJob & {
  status: "pending" | "running" | "completed" | "exhausted";
  attempt: number;
  lastError?: string;
  nextAttemptAt?: number;
};

type DeferredIngressEnv = {
  BOT_SELF?: Fetcher;
  ADMIN_SECRET?: string;
  ENVIRONMENT?: string;
};

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Durable owner for work that Slack has already handed to us but which must
 * finish after the request acknowledgement. The full immutable job is stored
 * and an alarm is armed before ingress returns 200.
 */
export class DeferredIngressDO extends DurableObject<DeferredIngressEnv> {
  async prepare(job: DeferredIngressJob): Promise<{
    accepted: boolean;
    status: StoredJob["status"];
  }> {
    const current = await this.ctx.storage.get<StoredJob>("job");
    if (current) {
      if (
        current.id !== job.id ||
        current.kind !== job.kind ||
        JSON.stringify(current.payload) !== JSON.stringify(job.payload)
      ) throw new Error("deferred_ingress_identity_conflict");
      if (current.status === "pending" || current.status === "running") {
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null) {
          await this.ctx.storage.setAlarm(
            Math.max(Date.now(), current.nextAttemptAt ?? Date.now()),
          );
        }
      }
      return { accepted: false, status: current.status };
    }
    const stored: StoredJob = {
      ...job,
      status: "pending",
      attempt: 0,
      nextAttemptAt: Date.now(),
    };
    await this.ctx.storage.put("job", stored);
    await this.ctx.storage.setAlarm(Date.now());
    return { accepted: true, status: "pending" };
  }

  async getState(): Promise<StoredJob | undefined> {
    return this.ctx.storage.get<StoredJob>("job");
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<StoredJob>("job");
    if (!job || job.status === "completed" || job.status === "exhausted") return;
    if (!this.env.BOT_SELF) {
      await this.retry(job, "bot_self_binding_unavailable");
      return;
    }
    const running: StoredJob = { ...job, status: "running" };
    await this.ctx.storage.put("job", running);
    try {
      const response = await this.env.BOT_SELF.fetch(
        "https://opentag-bot/internal/deferred-ingress",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.env.ADMIN_SECRET
              ? { authorization: `Bearer ${this.env.ADMIN_SECRET}` }
              : {}),
          },
          body: JSON.stringify({
            id: job.id,
            kind: job.kind,
            payload: job.payload,
            teamId: job.teamId,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`internal_handoff_http_${response.status}`);
      }
      await this.ctx.storage.put("job", {
        ...running,
        status: "completed",
        lastError: undefined,
        nextAttemptAt: undefined,
      } satisfies StoredJob);
    } catch (error) {
      await this.retry(
        running,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async retry(job: StoredJob, lastError: string): Promise<void> {
    const attempt = job.attempt + 1;
    if (attempt >= MAX_ATTEMPTS) {
      await this.ctx.storage.put("job", {
        ...job,
        status: "exhausted",
        attempt,
        lastError,
      } satisfies StoredJob);
      console.error(JSON.stringify({
        metric: "deferred_ingress_exhausted",
        jobId: job.id,
        kind: job.kind,
        attempt,
        lastError,
      }));
      return;
    }
    const delayMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (attempt - 1));
    const nextAttemptAt = Date.now() + delayMs;
    await this.ctx.storage.put("job", {
      ...job,
      status: "pending",
      attempt,
      lastError,
      nextAttemptAt,
    } satisfies StoredJob);
    await this.ctx.storage.setAlarm(nextAttemptAt);
  }

  async healthCheck(): Promise<{ ok: true }> {
    await this.ctx.storage.get("job");
    return { ok: true };
  }
}
