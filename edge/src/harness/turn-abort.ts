/** Per-thread AbortControllers for in-flight harness POST /turn requests. */
const inflight = new Map<string, AbortController>();

/** Register (or replace) the abort handle for a harness turn on `threadKey`. */
export function registerHarnessTurnAbort(threadKey: string): AbortSignal {
  inflight.get(threadKey)?.abort();
  const ac = new AbortController();
  inflight.set(threadKey, ac);
  return ac.signal;
}

/** Abort an in-flight harness turn, if any. Called from the stop-command path. */
export function abortHarnessTurn(threadKey: string): void {
  inflight.get(threadKey)?.abort();
  inflight.delete(threadKey);
}

/** Clear the registry entry after a turn finishes normally. */
export function clearHarnessTurnAbort(threadKey: string): void {
  inflight.delete(threadKey);
}
