import type { Context } from "hono";
import type { AppEnv } from "./env";

/**
 * Schedule background work. On Workers, uses `executionCtx.waitUntil`.
 * In unit tests (`app.request` without an ExecutionContext), falls back to
 * a detached promise so handlers stay non-blocking.
 */
export function fireAndForget(c: Context<AppEnv>, work: Promise<unknown>): void {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(work);
      return;
    }
  } catch {
    // executionCtx getter throws outside the Workers runtime
  }
  void work.catch((err) => console.error("background work failed", err));
}
