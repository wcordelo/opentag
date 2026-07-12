/**
 * Async serializer — chains async work so only one Fiber/mutation runs at a time
 * per actor instance (mirrors Durable Object re-entrancy mitigation).
 */
export class AsyncMutex {
  private current: Promise<unknown> = Promise.resolve();

  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.current.then(fn) as Promise<T>;
    this.current = run.catch(() => {});
    return run;
  }
}

/** Per-session mutex registry for multi-session workers. */
const sessionMutexes = new Map<string, AsyncMutex>();

export function getSessionMutex(sessionId: string): AsyncMutex {
  let mutex = sessionMutexes.get(sessionId);
  if (!mutex) {
    mutex = new AsyncMutex();
    sessionMutexes.set(sessionId, mutex);
  }
  return mutex;
}
